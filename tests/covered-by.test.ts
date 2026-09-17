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
import { renderExcluded, coveringVerdict } from "../src/testdoc";
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
  const results = (status: string): TestResults =>
    ({ runs: {}, results: [], functional: [{ unit: "u", instance: "local", id: "ldap-connection", item: "LDAP 疎通確認", status }] }) as never;
  const render = (r: TestResults): string => {
    const { plan } = planOf({ covered_by: COVER });
    return renderExcluded([], "u", "ja", { rows, verdict: coveringVerdict(plan, r, "ja") });
  };

  it("names the covering test by its own words, not by its id", () => {
    expect(render(results("pass"))).toContain("LDAP 疎通確認");
    expect(render(results("pass"))).not.toContain("ldap-connection");
  });

  // The hazard one level up: covered by a test that did not run is not covered,
  // and a record that prints only "covered by X" hides exactly that.
  it("prints the covering test's own verdict beside the claim", () => {
    expect(render(results("pass"))).toContain("（OK）");
    expect(render(results("not_run"))).toContain("（未実施）");
    expect(render(results("fail"))).toContain("（NG）");
  });

  it("reads a covering test nobody answered as not run", () => {
    expect(render({ runs: {}, results: [], functional: [] } as never)).toContain("（未実施）");
  });

  // One table with the others, told apart by what its reason column says —
  // which is the column a reader is reading for exactly that question.
  it("is a row of the same table, carrying its own reason", () => {
    const line = render(results("pass")).split("\n").find((l) => l.includes("bindCredential"))!;
    expect(line).toContain("ldap > corp > `bindCredential`");
    expect(line).toContain("管理 API はマスクして返す");
    expect(render(results("pass"))).not.toContain("###");
  });
});

// …and the field has to SURVIVE the trip. Every test above builds the model by
// hand; a project writes `covered_by` in sheet.yml, and between there and the
// model sits enrich, which copies the project's per-row metadata onto the row.
// It copied `out_of_scope` and not this one, so the whole feature above did
// nothing at all on a real build — found by running one.
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
