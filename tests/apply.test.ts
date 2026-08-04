import { describe, it, expect } from "bun:test";
import { computeApply } from "../src/apply";
import { HELD_REASON_GENERATED, HELD_REASON_DEFAULT, HELD_REASON_SHARED_INSTANCE, type SheetData, type ReviewItem } from "../src/prompt";

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
