import { describe, it, expect } from "bun:test";
import { verifySources } from "../src/verify";
import { computeApply } from "../src/apply";
import { buildPromptText } from "../src/prompt";
import type { SheetData, ReviewItem } from "../src/prompt";

function reader(map: Record<string, string>) {
  return (p: string): string | null => (p in map ? map[p] : null);
}

// One value defined in three YAML files (defaults + two group_vars), kept in
// sync via additional_sources.
function data(): SheetData {
  return {
    sheets: [
      {
        name: "S",
        file_path: "/opt/keycloak/conf/keycloak.conf", // display only (deployed)
        source_file: "defaults.yml", // primary source fallback
        categories: [
          {
            name: "C",
            params: [
              {
                key: "db_url",
                value: "t=50",
                source: { path: "db_url", anchor: "db_url:" },
                additional_sources: [
                  { file: "prod.yml", path: "db_url", anchor: "db_url:" },
                  { file: "dev.yml", path: "db_url", anchor: "db_url:" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const review: ReviewItem[] = [
  {
    id: "rev_1",
    target: { sheet: "S", category: "C", param: "db_url" },
    changes: [{ field: "value", current: "t=50", suggested: "t=10" }],
    status: "pending",
  },
];

describe("additional_sources — verify", () => {
  it("checks the primary source and every additional source", () => {
    const out = verifySources(
      data(),
      reader({ "defaults.yml": "db_url: t=50\n", "prod.yml": "db_url: t=50\n", "dev.yml": "db_url: t=50\n" })
    );
    expect(out.ok).toBe(3);
    expect(out.error).toBe(0);
    const files = out.checks.map((c) => c.file).sort();
    expect(files).toEqual(["defaults.yml", "dev.yml", "prod.yml"]);
  });

  it("flags a single drifted site while the others stay ok", () => {
    const out = verifySources(
      data(),
      reader({ "defaults.yml": "db_url: t=50\n", "prod.yml": "db_url: t=50\n", "dev.yml": "db_url: t=99\n" })
    );
    expect(out.ok).toBe(2);
    expect(out.error).toBe(1);
    expect(out.checks.find((c) => c.file === "dev.yml")?.status).toBe("error");
  });
});

describe("additional_sources — apply", () => {
  it("edits the primary source and every additional source", () => {
    const out = computeApply(
      data(),
      review,
      reader({ "defaults.yml": "db_url: t=50\n", "prod.yml": "db_url: t=50\n", "dev.yml": "db_url: t=50\n" })
    );
    expect(out.applied).toBe(3);
    expect(out.held).toBe(0);
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual(["defaults.yml", "dev.yml", "prod.yml"]);
    for (const f of out.files) expect(f.content).toContain("t=10");
  });

  it("applies the reachable sites and holds the change when one site fails", () => {
    // dev.yml is missing from the reader → that site is held.
    const out = computeApply(
      data(),
      review,
      reader({ "defaults.yml": "db_url: t=50\n", "prod.yml": "db_url: t=50\n" })
    );
    expect(out.applied).toBe(2);
    expect(out.held).toBe(1);
    // The held change is carried into the prompt, listing the extra sites.
    expect(out.heldPrompt).toContain("Also update the same value in:");
    expect(out.heldPrompt).toContain("dev.yml");
  });
});

describe("additional_sources — prompt", () => {
  it("lists every additional site under the value change", () => {
    const text = buildPromptText(review, data());
    expect(text).toContain("Also update the same value in:");
    expect(text).toContain("prod.yml");
    expect(text).toContain("dev.yml");
  });
});

// A `ref` entry holds a reference EXPRESSION to the value (e.g.
// `$(env:db_url)` in a static config file), not the value itself — a
// different claim from the plain additional_sources above. It is never a
// write target for apply, and the prompt renders it as context rather than
// as another site to edit.
function dataWithRef(): SheetData {
  return {
    sheets: [
      {
        name: "S",
        source_file: "defaults.yml",
        categories: [
          {
            name: "C",
            params: [
              {
                key: "db_url",
                value: "t=50",
                source: { path: "db_url", anchor: "db_url:" },
                additional_sources: [
                  { file: "prod.yml", path: "db_url", anchor: "db_url:" },
                  { file: "poc.yml", path: "database.url", anchor: "$(env:db_url)", ref: "$(env:db_url)" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const reviewRef: ReviewItem[] = [
  {
    id: "rev_1",
    target: { sheet: "S", category: "C", param: "db_url" },
    changes: [{ field: "value", current: "t=50", suggested: "t=10" }],
    status: "pending",
  },
];

describe("additional_sources — ref entries are never write targets (apply)", () => {
  it("edits the value site(s) but never the ref site, and holds nothing for it", () => {
    const out = computeApply(
      dataWithRef(),
      reviewRef,
      reader({
        "defaults.yml": "db_url: t=50\n",
        "prod.yml": "db_url: t=50\n",
        "poc.yml": "database:\n  url: $(env:db_url)\n",
      })
    );
    // Two value sites (primary + prod.yml) applied; the ref site is excluded
    // entirely — not applied, not held.
    expect(out.applied).toBe(2);
    expect(out.held).toBe(0);
    const paths = out.files.map((f) => f.path).sort();
    expect(paths).toEqual(["defaults.yml", "prod.yml"]);
    // poc.yml was never touched, and its reference text is untouched too.
    expect(out.files.some((f) => f.path === "poc.yml")).toBe(false);
  });

  it("still holds the change for other reasons without ever touching the ref site", () => {
    // prod.yml is missing from the reader → that value site is held; the ref
    // site (poc.yml) must not appear as a reason it was held.
    const out = computeApply(
      dataWithRef(),
      reviewRef,
      reader({ "defaults.yml": "db_url: t=50\n", "poc.yml": "database:\n  url: $(env:db_url)\n" })
    );
    expect(out.applied).toBe(1);
    expect(out.held).toBe(1);
    expect(out.results.some((r) => r.file === "poc.yml")).toBe(false);
  });
});

describe("additional_sources — ref entries render as context in the prompt", () => {
  it("renders the ref site separately, with the reference text, not under 'Also update the same value in:'", () => {
    const text = buildPromptText(reviewRef, dataWithRef());
    expect(text).toContain("Also update the same value in:");
    expect(text).toContain("prod.yml");
    expect(text).toContain("Referenced from");
    expect(text).toContain("poc.yml");
    expect(text).toContain("`$(env:db_url)`");
    expect(text).toContain("edit only the variable definition");
    // The ref site must not be listed as another site to edit: everything
    // between the "Also update" heading and the "Referenced from" heading is
    // the value-site list, and poc.yml must not appear in it.
    const alsoUpdateBlock = text.split("Also update the same value in:")[1]?.split("Referenced from")[0] ?? "";
    expect(alsoUpdateBlock).not.toContain("poc.yml");
  });
});
