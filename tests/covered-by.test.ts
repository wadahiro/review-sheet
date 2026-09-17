// A ROW THAT IS REVIEWED AND CANNOT BE CHECKED.
//
// The measured case is an LDAP bind credential: the design says "use this Vault
// reference", which is exactly what a reviewer signs, and the product's admin
// API answers with a mask so nothing here can read the value back.
//
// `out_of_scope` was the only lever, and it says the wrong thing — it greys the
// row out as outside this review while the reason written in it explains that
// the reference IS reviewed. One row contradicting itself.

import { describe, it, expect } from "bun:test";
import { buildTestPlan, formatTestPlanReport } from "../src/testplan";
import { renderExcluded, coveringTestText } from "../src/testdoc";
import { validateInput } from "../src/validate";
import type { ParameterSheetInput } from "../src/types";
import type { TestResults } from "../src/testresults";

const COVER = {
  reason: { ja: "管理 API はマスクして返す", en: "the admin API answers with a mask" },
  functional: "ldap-connection",
};

const model = (over: Record<string, unknown> = {}): ParameterSheetInput =>
  ({
    metadata: { title: "t" },
    groups: [
      {
        name: "u",
        label: { ja: "U" },
        test: { method: { ja: "読む" }, functional: [{ id: "ldap-connection", text: { ja: "LDAP 疎通確認" } }] },
      },
    ],
    sheets: [
      {
        name: "ldap",
        group: "u",
        instances: ["local"],
        categories: [
          {
            name: "corp",
            params: [
              { key: "bindDn", instances: [{ name: "local", value: "cn=svc" }] },
              { key: "bindCredential", instances: [{ name: "local", value: "${vault.corp}" }], ...over },
            ],
          },
        ],
      },
    ],
  }) as never;

const planOf = (over: Record<string, unknown> = {}) => buildTestPlan(model(over));

describe("a row declared covered by a functional test", () => {
  // Not an item. An item is something that should have been answered, and this
  // cannot be — filing it as 未実施 reads as "not got to yet", which is the
  // misreading the field exists to remove.
  it("produces no test item", () => {
    const { plan } = planOf({ covered_by: COVER });
    expect(plan.items.map((i) => i.target.key)).toEqual(["bindDn"]);
  });

  it("is reported, with the test that covers it", () => {
    const { report } = planOf({ covered_by: COVER });
    expect(report.coveredElsewhere).toEqual([
      { unit: "u", sheet: "ldap", component: "corp", key: "bindCredential", reason: COVER.reason, functional: "ldap-connection" },
    ]);
  });

  // Undeclared, the row is an ordinary item — the field changes what the RECORD
  // says, never whether the row is in the sheet.
  it("is an ordinary item when nothing is declared", () => {
    const { plan, report } = planOf();
    expect(plan.items.map((i) => i.target.key)).toContain("bindCredential");
    expect(report.coveredElsewhere).toEqual([]);
  });

  // "Covered by X" where nothing is X reads as covered and is not.
  it("fails the build when the unit has no such functional test", () => {
    expect(() => planOf({ covered_by: { ...COVER, functional: "ldap-connexion" } })).toThrow(
      /covered_by "ldap-connexion"/
    );
  });

  it("names the ids the unit does have", () => {
    expect(() => planOf({ covered_by: { ...COVER, functional: "nope" } })).toThrow(/ldap-connection/);
  });

  it("leaves the model valid", () => {
    expect(() => validateInput(JSON.parse(JSON.stringify(model({ covered_by: COVER }))))).not.toThrow();
  });

  // The model's `parameter` is permissive, so a field the schema never learned
  // would pass — and so would every typo INSIDE it. What the schema entry buys
  // is the shape: a `covered_by` that names no test, or names it in a field
  // spelled wrong, is a row that reads as covered by nothing.
  it("refuses a covered_by that names no functional test", () => {
    expect(() => validateInput(JSON.parse(JSON.stringify(model({ covered_by: { reason: COVER.reason } }))))).toThrow();
  });

  it("refuses a misspelled field inside it", () => {
    const typo = { reason: COVER.reason, functional: "ldap-connection", owner: "x" };
    expect(() => validateInput(JSON.parse(JSON.stringify(model({ covered_by: typo }))))).toThrow();
  });

  // Inherited like out_of_scope: "read back masked" is usually true of a whole
  // credentials block rather than of one row in it.
  it("is inherited by every row of a category that declares it", () => {
    const m = model();
    (m.sheets[0].categories[0] as unknown as { covered_by: unknown }).covered_by = COVER;
    const { plan, report } = buildTestPlan(m);
    expect(plan.items).toEqual([]);
    expect(report.coveredElsewhere.map((c) => c.key)).toEqual(["bindDn", "bindCredential"]);
  });

  // Out of scope is the stronger claim: not reviewed at all. "What covers it"
  // is a question about a row that IS reviewed.
  it("yields to out_of_scope on a row carrying both", () => {
    const { report } = planOf({ covered_by: COVER, out_of_scope: { reason: { ja: "範囲外" } } });
    expect(report.coveredElsewhere).toEqual([]);
    expect(report.excluded.map((e) => e.key)).toEqual(["bindCredential"]);
  });

  it("is counted in the plan's own report", () => {
    const { plan, report } = planOf({ covered_by: COVER });
    expect(formatTestPlanReport(plan, report)).toContain("covered by a functional test (1)");
  });
});

describe("the covered row in the table", () => {
  const rows = [{ unit: "u", sheet: "ldap", component: "corp", key: "bindCredential", reason: COVER.reason, functional: "ldap-connection" }];
  const render = (): string => {
    const { plan } = planOf({ covered_by: COVER });
    return renderExcluded([], "u", "ja", { rows, test: coveringTestText(plan, "ja") });
  };

  // Its id is an address, not prose: "ldap-connection" in a record a reviewer
  // reads is the tool's filing system on the page.
  it("names the covering test by its own words, not by its id", () => {
    expect(render()).toContain("LDAP 疎通確認");
    expect(render()).not.toContain("ldap-connection");
  });

  // That test has its own row in the item table of this same record, and
  // printing its result here too is the duplication this section keeps losing.
  it("does not repeat the covering test's result", () => {
    expect(render()).not.toContain("未実施");
    expect(render()).not.toContain("OK");
  });

  // One table with the others, told apart by what its reason column says —
  // which is the column a reader is reading for exactly that question.
  it("is a row of the same table, carrying its own reason", () => {
    const line = render().split("\n").find((l) => l.includes("bindCredential"))!;
    expect(line).toContain("ldap > corp > `bindCredential`");
    expect(line).toContain("管理 API はマスクして返す");
    expect(render()).not.toContain("###");
  });

  // A covered_by naming a test the plan has no words for falls back to the id
  // rather than printing nothing — the check at plan time makes that
  // unreachable through the CLI, and a caller building a plan by hand can
  // still get here.
  it("falls back to the id when the plan has no such test", () => {
    const { plan } = planOf({ covered_by: COVER });
    const text = renderExcluded([], "u", "ja", {
      rows: [{ ...rows[0], functional: "elsewhere" }],
      test: coveringTestText(plan, "ja"),
    });
    expect(text).toContain("elsewhere");
  });
});

describe("from sheet.yml to the model", () => {
  it("is carried onto the row by enrich", async () => {
    const { enrich } = await import("../src/enrich");
    const { listMetadataProviders } = await import("../src/metadata");
    await import("../src/providers/index.js");
    const project = [
      "sheets:",
      "  ldap:",
      "    params:",
      "      bindCredential:",
      '        description: { ja: "バインド資格情報", en: "bind credential" }',
      "        covered_by:",
      '          reason: { ja: "マスクされる", en: "masked" }',
      "          functional: ldap-connection",
      "",
    ].join("\n");
    const { input } = enrich(
      {
        metadata: { title: "t" },
        sheets: [{ name: "ldap", categories: [{ name: "corp", params: [{ key: "bindCredential", value: "${vault.corp}" }] }] }],
      } as never,
      {
        readFile: (p: string) => (p === "sheet.yml" ? project : null),
        project: "sheet.yml",
        providers: listMetadataProviders(),
      } as never
    );
    const row = (input.sheets[0].categories[0].params ?? [])[0] as { covered_by?: unknown };
    expect(row.covered_by).toEqual({ reason: { ja: "マスクされる", en: "masked" }, functional: "ldap-connection" });
  });
});
