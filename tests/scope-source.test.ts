import { describe, it, expect } from "bun:test";
import { verifySources } from "../src/verify";
import { computeApply } from "../src/apply";
import { buildPromptText } from "../src/prompt";
import type { SheetData, ReviewItem } from "../src/prompt";

function reader(map: Record<string, string>) {
  return (p: string): string | null => (p in map ? map[p] : null);
}

// ---- source_file: display path vs verify/apply source ------------------------

describe("source_file (display path vs source)", () => {
  it("verify resolves against source_file, not the deployed file_path", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          file_path: "/opt/keycloak/conf/keycloak.conf", // deployed path (unreadable locally)
          source_file: "roles/keycloak/defaults/main.yml", // local source
          categories: [
            {
              name: "C",
              params: [
                { key: "hostname", value: "sso", source: { anchor: "keycloak_hostname:", path: "keycloak_hostname" } },
              ],
            },
          ],
        },
      ],
    };
    const out = verifySources(data, reader({ "roles/keycloak/defaults/main.yml": "keycloak_hostname: sso\n" }));
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
    expect(out.checks[0].file).toBe("roles/keycloak/defaults/main.yml");
  });

  it("a category source_file overrides the sheet source_file", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          file_path: "/deployed",
          source_file: "sheet.yml",
          categories: [
            {
              name: "C",
              source_file: "cat.yml",
              params: [{ key: "hostname", value: "sso", source: { path: "keycloak_hostname", anchor: "keycloak_hostname:" } }],
            },
          ],
        },
      ],
    };
    const out = verifySources(data, reader({ "cat.yml": "keycloak_hostname: sso\n", "sheet.yml": "x: 1\n" }));
    expect(out.ok).toBe(1);
    expect(out.checks[0].file).toBe("cat.yml");
  });

  it("an explicit source.file still wins over source_file", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          source_file: "default.yml",
          categories: [
            {
              name: "C",
              params: [{ key: "k", value: "v", source: { file: "explicit.yml", path: "k", anchor: "k:" } }],
            },
          ],
        },
      ],
    };
    const out = verifySources(data, reader({ "explicit.yml": "k: v\n", "default.yml": "k: other\n" }));
    expect(out.ok).toBe(1);
    expect(out.checks[0].file).toBe("explicit.yml");
  });

  it("falls back to file_path when no source_file is set (backward compatible)", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          file_path: "conf.yml",
          categories: [{ name: "C", params: [{ key: "k", value: "v", source: { path: "k", anchor: "k:" } }] }],
        },
      ],
    };
    const out = verifySources(data, reader({ "conf.yml": "k: v\n" }));
    expect(out.ok).toBe(1);
    expect(out.checks[0].file).toBe("conf.yml");
  });

  it("apply edits the source_file, leaving the deployed file_path untouched", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          file_path: "/opt/keycloak/conf/keycloak.conf",
          source_file: "vars.yml",
          categories: [
            {
              name: "C",
              params: [{ key: "hostname", value: "sso", source: { path: "keycloak_hostname", anchor: "keycloak_hostname:" } }],
            },
          ],
        },
      ],
    };
    const reviews: ReviewItem[] = [
      {
        id: "r1",
        target: { sheet: "S", category: "C", param: "hostname" },
        changes: [{ field: "value", current: "sso", suggested: "sso.example.co.jp" }],
        status: "pending",
      },
    ];
    const out = computeApply(data, reviews, reader({ "vars.yml": "keycloak_hostname: sso\n" }));
    expect(out.applied).toBe(1);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe("vars.yml");
    expect(out.files[0].content).toContain("sso.example.co.jp");
  });
});

// ---- out_of_scope ------------------------------------------------------------

describe("out_of_scope", () => {
  it("verify marks an out-of-scope category as out_of_scope (not error/unmapped)", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          categories: [
            {
              name: "/etc/resolv.conf",
              out_of_scope: { reason: "事業部側が担当" },
              params: [{ key: "nameserver", value: "10.0.0.1" }],
            },
          ],
        },
      ],
    };
    const out = verifySources(data, reader({}));
    expect(out.out_of_scope).toBe(1);
    expect(out.error).toBe(0);
    expect(out.unmapped).toBe(0);
    expect(out.checks[0].status).toBe("out_of_scope");
    expect(out.checks[0].message).toContain("事業部側が担当");
  });

  it("out_of_scope cascades to descendant params (a child param need not repeat it)", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          categories: [
            {
              name: "C",
              out_of_scope: { reason: "not applicable" },
              params: [{ key: "a", value: "1" }, { key: "b", value: "2" }],
            },
          ],
        },
      ],
    };
    const out = verifySources(data, reader({}));
    expect(out.out_of_scope).toBe(2);
  });

  it("a param-level out_of_scope flag excludes only that param", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          file_path: "conf.yml",
          categories: [
            {
              name: "C",
              params: [
                { key: "a", value: "1", source: { path: "a", anchor: "a:" } },
                { key: "b", value: "2", out_of_scope: { reason: "OS基盤設定" } },
              ],
            },
          ],
        },
      ],
    };
    const out = verifySources(data, reader({ "conf.yml": "a: 1\n" }));
    expect(out.ok).toBe(1);
    expect(out.out_of_scope).toBe(1);
  });

  it("apply skips out-of-scope targets (out_of_scope status, not held, not prompted)", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "S",
          file_path: "conf.yml",
          categories: [
            {
              name: "C",
              out_of_scope: { reason: "対象外" },
              params: [{ key: "k", value: "v" }],
            },
          ],
        },
      ],
    };
    const reviews: ReviewItem[] = [
      {
        id: "r1",
        target: { sheet: "S", category: "C", param: "k" },
        changes: [{ field: "value", current: "v", suggested: "w" }],
        status: "pending",
      },
    ];
    const out = computeApply(data, reviews, reader({ "conf.yml": "k = v\n" }));
    expect(out.out_of_scope).toBe(1);
    expect(out.held).toBe(0);
    expect(out.applied).toBe(0);
    expect(out.results[0].status).toBe("out_of_scope");
    // Excluded from the AI prompt entirely.
    expect(buildPromptText(reviews, data)).toBe("");
  });
});
