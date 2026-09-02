import { describe, it, expect } from "bun:test";
import { computeApply } from "../src/apply";
import { HELD_REASON_GENERATED, HELD_REASON_DEFAULT, HELD_REASON_SHARED_INSTANCE, HELD_REASON_DOCUMENTATION, type SheetData, type ReviewItem } from "../src/prompt";

// A small sheet whose values map to two in-memory files.
const data: SheetData = {
  sheets: [
    {
      name: "OS",
      file_path: "/etc/sysctl.conf",
      categories: [
        {
          name: "Network",
          params: [
            { key: "net.ipv4.tcp_fin_timeout", value: "60", source: { line: 3, anchor: "net.ipv4.tcp_fin_timeout" } },
            { key: "drift.key", value: "100", source: { line: 1, anchor: "drift.key" } },
            { key: "dup.key", value: "1", source: { anchor: "dup.key" } },
            { key: "nofile.key", value: "x" },
          ],
        },
      ],
    },
    {
      name: "App",
      categories: [
        {
          name: "Server",
          params: [
            {
              key: "server.port",
              instances: [
                { name: "prod", value: "8080", source: { file: "/app/prod.yaml", line: 2, anchor: "port:" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const sysctl = [
  "# header",
  "drift.key = 100", // line 2 in file, but source says line 1 -> drift
  "net.ipv4.tcp_fin_timeout = 60",
  "dup.key = 1",
  "dup.key = 1",
].join("\n");

const prodYaml = ["server:", "  port: 8080"].join("\n");

function files(map: Record<string, string>) {
  return (path: string): string | null => (path in map ? map[path] : null);
}

function review(p: Partial<ReviewItem> & { target: ReviewItem["target"] }): ReviewItem {
  return { id: "r", status: "pending", ...p };
}

describe("computeApply", () => {
  it("applies a verified value change at the exact line", () => {
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "value" },
        changes: [{ field: "value", current: "60", suggested: "30" }],
      }),
    ];
    const out = computeApply(data, reviews, files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(1);
    const file = out.files.find((f) => f.path === "/etc/sysctl.conf")!;
    expect(file.content).toContain("net.ipv4.tcp_fin_timeout = 30");
    expect(file.content).not.toContain("net.ipv4.tcp_fin_timeout = 60");
  });

  it("re-locates by anchor when the given line has drifted", () => {
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "drift.key", field: "value" },
        changes: [{ field: "value", current: "100", suggested: "200" }],
      }),
    ];
    const out = computeApply(data, reviews, files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("drift.key = 200");
  });

  it("holds an ambiguous anchor (multiple matches)", () => {
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "dup.key", field: "value" },
        changes: [{ field: "value", current: "1", suggested: "2" }],
      }),
    ];
    const out = computeApply(data, reviews, files({ "/etc/sysctl.conf": sysctl }));
    expect(out.held).toBe(1);
    expect(out.results[0].reason).toContain("ambiguous");
    expect(out.files.length).toBe(0);
  });

  it("holds a value with no mapped file and includes it in the prompt", () => {
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "nofile.key", field: "value" },
        changes: [{ field: "value", current: "x", suggested: "y" }],
        comment: "please change",
      }),
    ];
    const out = computeApply(data, reviews, files({ "/etc/sysctl.conf": sysctl }));
    // sheet file_path makes the file known, but with no anchor it cannot verify.
    expect(out.held).toBe(1);
    expect(out.heldPrompt).toContain("nofile.key");
  });

  it("skips idempotently when already at the suggested value", () => {
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "value" },
        changes: [{ field: "value", current: "999", suggested: "60" }],
      }),
    ];
    const out = computeApply(data, reviews, files({ "/etc/sysctl.conf": sysctl }));
    expect(out.skipped).toBe(1);
    expect(out.files.length).toBe(0);
  });

  it("applies per-instance source in its own file", () => {
    const reviews = [
      review({
        target: { sheet: "App", category: "Server", param: "server.port", instance: "prod", field: "value" },
        changes: [{ field: "value", current: "8080", suggested: "9090" }],
      }),
    ];
    const out = computeApply(data, reviews, files({ "/app/prod.yaml": prodYaml }));
    expect(out.applied).toBe(1);
    expect(out.files[0].path).toBe("/app/prod.yaml");
    expect(out.files[0].content).toContain("port: 9090");
  });

  it("holds a value whose source is a generated build artifact instead of editing it", () => {
    const generatedData: SheetData = {
      sheets: [
        {
          name: "OS",
          categories: [
            {
              name: "Network",
              params: [
                {
                  key: "gen.key",
                  value: "60",
                  source: { file: "/etc/sysctl.conf", line: 3, anchor: "gen.key", generated: true },
                },
              ],
            },
          ],
        },
      ],
    };
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "gen.key", field: "value" },
        changes: [{ field: "value", current: "60", suggested: "30" }],
      }),
    ];
    const out = computeApply(generatedData, reviews, files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(0);
    expect(out.held).toBe(1);
    expect(out.results[0].reason).toBe(HELD_REASON_GENERATED);
    expect(out.files.length).toBe(0);
    expect(out.heldPrompt).toContain("gen.key");
  });

  it("still applies a value whose source is not generated", () => {
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "value" },
        changes: [{ field: "value", current: "60", suggested: "30" }],
      }),
    ];
    const out = computeApply(data, reviews, files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(1);
    expect(out.held).toBe(0);
  });

  it("never applies documentation-field changes; defers them to the prompt", () => {
    const reviews = [
      review({
        target: { sheet: "OS", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "description" },
        changes: [{ field: "description", current: "old", suggested: "new" }],
      }),
    ];
    const out = computeApply(data, reviews, files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(0);
    expect(out.files.length).toBe(0);
    expect(out.heldPrompt).toContain("Documentation");
  });
});

// A finding aimed at ONE environment on a row that stores a single shared value.
// The deterministic core must refuse: editing the shared definition would move
// every environment, and splitting it into a per-environment override is a
// structural decision, not an edit.
// Same brittleness verify now reports (see verify.test.ts): a dotted key whose
// structural path cannot resolve is edited by line match instead. The edit is
// correct — apply verified the current value on that line — so it stays
// "applied", but the reason has to say which mechanism did the work.
describe("computeApply: edit that fell back from an unresolved structural path", () => {
  const dotted: SheetData = {
    sheets: [{ name: "Realm", file_path: "/realm.yaml", categories: [{ name: "C", params: [
      { key: "saml.client.signature", value: "true", source: { line: 2, anchor: "saml.client.signature:", path: "attributes.saml.client.signature" } },
      { key: "host", value: "db", source: { line: 4, anchor: "host:", path: "database.host" } },
    ] }] }],
  };
  const content = ["attributes:", '  saml.client.signature: "true"', "database:", "  host: db"].join("\n");
  const changeOf = (param: string, current: string, suggested: string) => [
    review({ target: { sheet: "Realm", category: "C", param, field: "value" }, changes: [{ field: "value", current, suggested }] }),
  ];

  it("applies it, and says the line fallback did the work", () => {
    const out = computeApply(dotted, changeOf("saml.client.signature", "true", "false"), files({ "/realm.yaml": content }));
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain('saml.client.signature: "false"');
    const res = out.results.find((r) => r.target.param === "saml.client.signature")!;
    expect(res.status).toBe("applied");
    expect(res.reason).toContain("line fallback");
  });

  it("leaves the reason alone when the structural path resolves", () => {
    const out = computeApply(dotted, changeOf("host", "db", "pg"), files({ "/realm.yaml": content }));
    expect(out.applied).toBe(1);
    expect(out.results.find((r) => r.target.param === "host")!.reason).not.toContain("fallback");
  });
});

describe("computeApply: per-environment change on a shared row", () => {
  const shared: SheetData = {
    sheets: [
      {
        name: "App",
        instances: ["staging", "production"],
        categories: [
          {
            name: "Server",
            params: [
              { key: "workers", value: "4", source: { file: "/app/defaults.yml", line: 1, anchor: "workers:" } },
              { key: "unset_knob", value: "off", default: "off", origin: "default" },
            ],
          },
        ],
      },
    ],
  };
  const defaults = "workers: 4\n";
  const read = files({ "/app/defaults.yml": defaults });

  it("holds it, naming the shared definition without touching it", () => {
    const out = computeApply(
      shared,
      [review({ target: { sheet: "App", category: "Server", param: "workers", instance: "production", field: "value" }, changes: [{ field: "value", current: "4", suggested: "16" }] })],
      read
    );

    expect(out.applied).toBe(0);
    expect(out.files.length).toBe(0); // the shared file is never rewritten
    expect(out.results.map((r) => [r.status, r.reason])).toEqual([["held", HELD_REASON_SHARED_INSTANCE]]);
    expect(out.results[0].file).toBe("/app/defaults.yml"); // context only
  });

  it("still applies the same change at shared scope (no instance)", () => {
    const out = computeApply(
      shared,
      [review({ target: { sheet: "App", category: "Server", param: "workers", field: "value" }, changes: [{ field: "value", current: "4", suggested: "16" }] })],
      read
    );

    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("workers: 16");
  });

  it("keeps the product-default reason for an unset row, per environment or not", () => {
    for (const target of [
      { sheet: "App", category: "Server", param: "unset_knob", instance: "staging", field: "value" },
      { sheet: "App", category: "Server", param: "unset_knob", field: "value" },
    ]) {
      const out = computeApply(shared, [review({ target, changes: [{ field: "value", current: "off", suggested: "on" }] })], read);
      expect(out.results.map((r) => r.reason)).toEqual([HELD_REASON_DEFAULT]);
    }
  });
});

// A category is display structure — most of them come from a product
// dictionary's own grouping — so upgrading a dictionary can move a row to
// another screen. A finding filed against it used to resolve to nothing, and
// say nothing.
describe("a finding survives its row moving to another category", () => {
  const sheetWith = (categoryName: string): SheetData => ({
    sheets: [
      {
        name: "keycloak realm",
        categories: [
          {
            name: "poc",
            categories: [
              {
                name: categoryName,
                params: [{ key: "accessTokenLifespan", value: "300", source: { file: "poc.yml", line: 3, anchor: "300" } }],
              },
            ],
          },
        ],
      },
    ],
  });
  const review = (category: string): ReviewItem => ({
    id: "r1",
    status: "pending",
    target: { sheet: "keycloak realm", category, param: "accessTokenLifespan" },
    changes: [{ field: "value", current: "300", suggested: "60" }],
  });
  const files: Record<string, string> = { "poc.yml": "realm: poc\naccessTokenLifespan: 300\n" };
  const read = (p: string): string | null => files[p] ?? null;

  it("applies the change after the dictionary moved the row", () => {
    // Written when the row was under "Sessions"; the sheet now files it under
    // "Tokens/Access tokens" because the product's own grouping changed.
    const out = computeApply(sheetWith("Tokens/Access tokens"), [review("poc/Sessions")], read);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("accessTokenLifespan: 60");
  });

  it("reports the move rather than following it silently", () => {
    const out = computeApply(sheetWith("Tokens/Access tokens"), [review("poc/Sessions")], read);
    expect(out.moved).toEqual([
      { target: { sheet: "keycloak realm", category: "poc/Sessions", param: "accessTokenLifespan" }, from: "poc/Sessions", to: "poc/Tokens/Access tokens" },
    ]);
  });

  it("says nothing when nothing moved", () => {
    const out = computeApply(sheetWith("Sessions"), [review("poc/Sessions")], read);
    expect(out.applied).toBe(1);
    expect(out.moved).toEqual([]);
  });

  it("refuses to guess when two components share the key and the component is gone too", () => {
    // Two realms both have accessTokenLifespan — which is what components are
    // for. With the stored component matching neither, attaching the finding to
    // one of them would be a coin flip, so it resolves to nothing instead.
    const data: SheetData = {
      sheets: [
        {
          name: "keycloak realm",
          categories: ["poc", "master"].map((c) => ({
            name: c,
            categories: [{ name: "Tokens", params: [{ key: "accessTokenLifespan", value: "300", source: { file: "poc.yml", line: 3, anchor: "300" } }] }],
          })),
        },
      ],
    };
    const out = computeApply(data, [review("gone/Sessions")], read);
    expect(out.applied).toBe(0);
    expect(out.moved).toEqual([]);
  });

  it("uses the component to disambiguate when only the inner category moved", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "keycloak realm",
          categories: ["poc", "master"].map((c) => ({
            name: c,
            categories: [{ name: "Tokens/Access tokens", params: [{ key: "accessTokenLifespan", value: c === "poc" ? "300" : "60", source: { file: "poc.yml", line: 3, anchor: "300" } }] }],
          })),
        },
      ],
    };
    const out = computeApply(data, [review("poc/Sessions")], read);
    expect(out.applied).toBe(1);
    expect(out.moved[0].to).toBe("poc/Tokens/Access tokens");
  });
});

// Edits made in the sheet itself arrive in the same file as review findings.
// They are the same kind of work — change this line to that value — so they go
// through the same path, with one difference: an edit history is COLLAPSED to
// its net change first. Replaying 500 -> 600 -> 700 step by step would fail at
// the first step the moment anyone had applied part of it by hand.
describe("edits made in the sheet itself", () => {
  const edit = (id: string, from: string, to: string, at: string): ReviewItem => ({
    id,
    target: { sheet: "OS", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "value" },
    changes: [{ field: "value", current: from, suggested: to }],
    status: "applied",
    at,
    by: "田中",
  });
  const added: ReviewItem = {
    id: "rev_add",
    target: { sheet: "OS", category: "Network", param: "brand.new", field: "value" },
    changes: [{ field: "value", suggested: "1" }],
    status: "applied",
    creates: true,
    at: "2026-08-18T00:00:00Z",
  };
  const struck: ReviewItem = {
    id: "rev_del",
    target: { sheet: "OS", category: "Network", param: "drift.key" },
    status: "applied",
    deletes: true,
    at: "2026-08-18T00:00:00Z",
  };

  it("writes a single edit to the file", () => {
    const out = computeApply(data, [edit("rev_a", "60", "30", "2026-08-18T00:00:00Z")], files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("net.ipv4.tcp_fin_timeout = 30");
  });

  // The file still holds the ORIGINAL value, so the pair that matters is
  // (what the sheet was built with, what it says now) — not each step.
  it("collapses a chain of edits into one change", () => {
    const out = computeApply(
      data,
      [edit("rev_a", "60", "45", "2026-08-18T00:00:00Z"), edit("rev_b", "45", "30", "2026-09-02T00:00:00Z")],
      files({ "/etc/sysctl.conf": sysctl })
    );
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("net.ipv4.tcp_fin_timeout = 30");
  });

  it("does nothing when the chain ends where it started", () => {
    const out = computeApply(
      data,
      [edit("rev_a", "60", "30", "2026-08-18T00:00:00Z"), edit("rev_b", "30", "60", "2026-09-02T00:00:00Z")],
      files({ "/etc/sysctl.conf": sysctl })
    );
    expect(out.applied).toBe(0);
    expect(out.files).toHaveLength(0);
  });

  // Neither is an edit to a line that exists, so neither can be written by a
  // source map — and going quiet about them would leave the most consequential
  // half of a returned sheet unmentioned.
  it("holds an added row for the prompt instead of guessing where it goes", () => {
    const out = computeApply(data, [added], files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(0);
    expect(out.held).toBe(1);
    expect(out.results[0].reason).toContain("no config file has a line for it");
    expect(out.heldPrompt).toContain("brand.new");
  });

  it("holds a struck-out row rather than deciding how a line disappears", () => {
    const out = computeApply(data, [struck], files({ "/etc/sysctl.conf": sysctl }));
    expect(out.held).toBe(1);
    expect(out.results[0].reason).toContain("no longer used");
    expect(out.heldPrompt).toContain("drift.key");
  });

  it("does not also try to edit a row it is about to strike out", () => {
    const valueEdit: ReviewItem = {
      id: "rev_v",
      target: { sheet: "OS", category: "Network", param: "drift.key", field: "value" },
      changes: [{ field: "value", current: "100", suggested: "200" }],
      status: "applied",
      at: "2026-08-18T00:00:00Z",
    };
    const out = computeApply(data, [valueEdit, struck], files({ "/etc/sysctl.conf": sysctl }));
    expect(out.applied).toBe(0);
    expect(out.results.map((r) => r.reason)).toEqual([expect.stringContaining("no longer used")]);
  });

  it("still reports every edit it saw", () => {
    const out = computeApply(data, [edit("rev_a", "60", "30", "2026-08-18T00:00:00Z"), added, struck], files({ "/etc/sysctl.conf": sysctl }));
    expect(out.edits.map((e) => e.id)).toEqual(["rev_a", "rev_add", "rev_del"]);
  });

  it("leaves a review finding on the same document unaffected", () => {
    const finding: ReviewItem = {
      id: "rev_pending",
      target: { sheet: "OS", category: "Network", param: "dup.key", field: "value" },
      changes: [{ field: "value", current: "1", suggested: "2" }],
      status: "pending",
    };
    const out = computeApply(data, [edit("rev_a", "60", "30", "2026-08-18T00:00:00Z"), finding], files({ "/etc/sysctl.conf": sysctl }));
    expect(out.edits).toHaveLength(1);
    expect(out.applied).toBeGreaterThan(0);
  });
});


// A documentation edit — `remarks`, one of the two fields a sheet lets its owner
// change. It has no line in any config file to rewrite, so it is held and goes
// to the prompt, which is right. What was wrong is that it reached NOTHING
// ELSE: every other hold on that path pushes a result beside the prompt entry,
// and this one did not, so `apply` reported "1 applied" for a sheet carrying two
// edits and the second one's existence was known only to whoever opened the
// prompt.
describe("an edit to a row's documentation", () => {
  const data: SheetData = {
    sheets: [
      {
        name: "s",
        categories: [
          {
            name: "c",
            params: [
              {
                key: "Timeout",
                value: "60",
                description: "d",
                source: { file: "/f.conf", line: 1, anchor: "Timeout" },
              },
            ],
          },
        ],
      },
    ],
  } as SheetData;

  const edit = (field: string, current: string, suggested: string): ReviewItem =>
    ({
      id: "e_" + field,
      target: { sheet: "s", category: "c", param: "Timeout", field },
      status: "applied",
      changes: [{ field, current, suggested }],
      at: "2026-01-01T00:00:00Z",
    }) as ReviewItem;

  const run = (): ReturnType<typeof computeApply> =>
    computeApply(data, [edit("value", "60", "90"), edit("remarks", "before", "after")], (p) =>
      p === "/f.conf" ? "Timeout 60\n" : null
    );

  it("is reported as held, beside the value that applied", () => {
    const out = run();
    expect(out.results.map((r) => [r.target.field, r.status])).toEqual([
      ["value", "applied"],
      ["remarks", "held"],
    ]);
  });

  it("is counted, so the summary cannot say one edit when there were two", () => {
    const out = run();
    expect(out.applied).toBe(1);
    expect(out.held).toBe(1);
  });

  it("says where such an edit belongs, since no config file holds it", () => {
    expect(run().results.find((r) => r.target.field === "remarks")?.reason).toBe(HELD_REASON_DOCUMENTATION);
  });

  // Unchanged: it was already reaching the prompt, and the value beside it was
  // already applying.
  it("still reaches the prompt, and does not disturb the value", () => {
    const out = run();
    expect(out.heldPrompt).toContain("after");
    expect(out.files).toEqual([{ path: "/f.conf", content: "Timeout 90\n" }]);
  });
});
