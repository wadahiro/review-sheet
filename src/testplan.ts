// The unit test's PLAN, derived from the sheet it tests.
//
// A Japanese unit-test document (単体テスト仕様書兼成績書) enumerates its items
// under a three-level classification: 大項目 the unit under test, 中項目 the
// software component inside it, 小項目 every setting the design records. The
// third of those is where such a document usually makes a promise it cannot
// keep — "詳細設計書に記載されている設定の確認を網羅する" is a sentence, and a
// sentence is not a check.
//
// Here it is not a promise. The items ARE the rows: what to test is derived
// from the same model the parameter sheet is rendered from, so an item cannot
// be missing for a row that exists, and the coverage sentence in the document
// says what the build enforces. This is the same stance the rest of the tool
// takes about losing a row — reported, or the build fails, never quietly.
//
// What the tool does NOT decide is anything that needs a live system: how a
// host is reached, what command asks a product for its effective configuration,
// how two values are compared. The plan says WHAT to check and what is expected;
// a collector and a judge outside answer it. See the `test` declaration below
// for the part a project writes, which is the part nothing can derive.

import type { LangText, OutOfScope, ParameterSheetInput, Parameter, Sheet, SheetGroup, TestDeclaration } from "./types.js";

export type { TestDeclaration };

// One thing to check, once, in one environment.
export type TestItem = {
  // The row this item tests, spelled the way a result must answer it.
  target: { sheet: string; path: string[]; key: string; instance: string };
  // 大項目 / 中項目, resolved to what a reader sees.
  unit: string;
  unitLabel?: LangText;
  sheetLabel?: LangText;
  // The deployed file the row belongs to, when the sheet says which — the
  // component is what a document sub-heads its items with.
  component?: string;
  // …and WHERE that file lands on the host. What a collector needs in order to
  // answer this item at all: the plan says what to check and where to look, and
  // the thing that looks is outside. Absent where the sheet describes no
  // deployed file (a product's API-side configuration, a cloud resource), which
  // is itself the reason such an item usually comes back not run.
  file?: string;
  kind: TestKind;
  // Absent on a `quiet` item and on `absent` items, which expect no value.
  expected?: string;
  // A value that must not be written into a record. The item is still tested;
  // the document prints the verdict without the value.
  quiet?: boolean;
};

// What kind of claim this item checks.
//
//   value             this project set it, and the deployed system must say so
//   default-in-force  nobody set it, so the product's own default must still be
//                     what applies — the assertion an unset row IS
//   absent            the vendor shipped it and this project removed it, so no
//                     line of the deployed file may carry it
export type TestKind = "value" | "default-in-force" | "absent";

export type TestUnit = {
  name: string;
  label?: LangText;
  declaration: TestDeclaration;
  sheets: string[];
};

export type TestPlan = {
  metadata: ParameterSheetInput["metadata"];
  units: TestUnit[];
  items: TestItem[];
};

// Everything the derivation left out, and why. A plan that quietly held fewer
// items than the sheet has rows would be the promise this file refuses to make.
export type TestPlanReport = {
  // Rows the project itself put outside the review's remit.
  excluded: { unit: string; sheet: string; key: string; reason: LangText; owner?: string }[];
  // A per-environment row that says nothing about an environment: no value for
  // it, so there is nothing to expect and nothing to check.
  unstated: { unit: string; sheet: string; key: string; instance: string }[];
};

const walkGroups = (groups: SheetGroup[] | undefined, visit: (g: SheetGroup) => void): void => {
  for (const g of groups ?? []) {
    visit(g);
    walkGroups(g.groups, visit);
  }
};

// The unit a sheet is tested as: the chapter it belongs to, or itself when it
// belongs to none. Not the chapter's PARENT — a unit is the level that holds
// sheets, which is what a reader sees as 大項目.
const unitOf = (sheet: Sheet, byName: Map<string, SheetGroup>): { name: string; label?: LangText; group?: SheetGroup } => {
  const g = sheet.group === undefined ? undefined : byName.get(sheet.group);
  return g === undefined ? { name: sheet.name, label: sheet.label } : { name: g.name, label: g.label, group: g };
};

const kindOf = (p: Parameter): TestKind =>
  p.origin === "default" ? "default-in-force" : p.origin === "baseline" ? "absent" : "value";

const expectedOf = (p: Parameter, instance: string, kind: TestKind): string | undefined => {
  if (kind === "absent") return undefined;
  if (kind === "default-in-force") return p.default;
  const per = "instances" in p ? p.instances : undefined;
  return per === undefined ? ("value" in p ? p.value : undefined) : per.find((i) => i.name === instance)?.value;
};

type Row = { p: Parameter; path: string[]; component?: string; file?: string; outOfScope?: OutOfScope };

const rowsOf = (sheet: Sheet): Row[] => {
  const out: Row[] = [];
  // The deployed path is the top-level category's own when it has one (a sheet
  // covering several artifacts names each of them), and the sheet's otherwise.
  const walk = (cats: NonNullable<Sheet["categories"]>, path: string[], inherited?: OutOfScope, file?: string): void => {
    for (const c of cats) {
      const oos = c.out_of_scope ?? inherited;
      const here = [...path, c.name];
      const where = path.length === 0 ? (c.file_path ?? sheet.file_path) : file;
      for (const p of c.params ?? []) out.push({ p, path: here, component: here[0], ...(where === undefined ? {} : { file: where }), outOfScope: p.out_of_scope ?? oos });
      walk(c.categories ?? [], here, oos, where);
    }
  };
  walk(sheet.categories ?? [], []);
  return out;
};

// The plan, and everything it left out.
//
// Throws when a unit that HAS testable rows declares nothing. That gate is the
// whole reason the declaration exists: a unit nobody wrote a method for is
// either untested by accident or untested on purpose, and only one of those is
// allowed to be silent — the one that says so.
export function buildTestPlan(input: ParameterSheetInput): { plan: TestPlan; report: TestPlanReport } {
  const byName = new Map<string, SheetGroup>();
  walkGroups(input.groups, (g) => byName.set(g.name, g));

  const units = new Map<string, TestUnit>();
  const items: TestItem[] = [];
  const report: TestPlanReport = { excluded: [], unstated: [] };
  const bare: string[] = [];

  for (const sheet of input.sheets) {
    // A document sheet is prose; it has no rows and nothing to test.
    if (sheet.document !== undefined) continue;
    const rows = rowsOf(sheet);
    if (rows.length === 0) continue;
    const u = unitOf(sheet, byName);
    const declaration: TestDeclaration = u.group?.test ?? sheet.test ?? {};
    const unit = units.get(u.name) ?? { name: u.name, label: u.label, declaration, sheets: [] };
    unit.sheets.push(sheet.name);
    units.set(u.name, unit);
    if (declaration.method === undefined && declaration.not_tested === undefined && !bare.includes(u.name)) {
      bare.push(u.name);
    }
    // A unit that says it is not tested here still HAS its rows; what it does
    // not have is items. The statement stands in for them, in one place, where
    // the items would have been.
    if (declaration.not_tested !== undefined) continue;

    for (const row of rows) {
      if (row.outOfScope !== undefined) {
        report.excluded.push({
          unit: u.name,
          sheet: sheet.name,
          key: row.p.key,
          reason: row.outOfScope.reason,
          ...(row.outOfScope.owner === undefined ? {} : { owner: row.outOfScope.owner }),
        });
        continue;
      }
      const kind = kindOf(row.p);
      for (const instance of sheet.instances ?? []) {
        const expected = expectedOf(row.p, instance, kind);
        if (kind === "value" && expected === undefined) {
          // Pattern B, and this environment is not among the ones it names:
          // the row states nothing here, so there is nothing to check.
          report.unstated.push({ unit: u.name, sheet: sheet.name, key: row.p.key, instance });
          continue;
        }
        items.push({
          target: { sheet: sheet.name, path: row.path, key: row.p.key, instance },
          unit: u.name,
          ...(u.label === undefined ? {} : { unitLabel: u.label }),
          ...(sheet.label === undefined ? {} : { sheetLabel: sheet.label }),
          ...(row.component === undefined ? {} : { component: row.component }),
          ...(row.file === undefined ? {} : { file: row.file }),
          kind,
          ...(row.p.secret === true ? { quiet: true as const } : expected === undefined ? {} : { expected }),
        });
      }
    }
  }

  if (bare.length > 0) {
    throw new Error(
      `no test declaration for ${bare.length} unit(s): ${bare.join(", ")} — ` +
        `each unit under test needs a \`test:\` in the project metadata, saying either how it is tested ` +
        `(\`method:\`) or that it is not tested in this phase and why (\`not_tested:\`). A unit nobody wrote ` +
        `either for is untested by accident or on purpose, and only the second may be silent.`
    );
  }

  return { plan: { metadata: input.metadata, units: [...units.values()], items }, report };
}

// What the derivation left out, for the CLI to print. Counts first, then the
// members, because a count nobody can read is not a report (verifying.md R4).
export function formatTestPlanReport(plan: TestPlan, report: TestPlanReport): string {
  const lines: string[] = [];
  const kinds = plan.items.reduce<Record<string, number>>((n, i) => ({ ...n, [i.kind]: (n[i.kind] ?? 0) + 1 }), {});
  lines.push(
    `test plan: ${plan.items.length} item(s) across ${plan.units.length} unit(s) — ` +
      Object.entries(kinds)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ")
  );
  for (const u of plan.units) {
    const n = plan.items.filter((i) => i.unit === u.name).length;
    const how = u.declaration.not_tested !== undefined ? "not tested in this phase" : `${n} item(s)`;
    lines.push(`  ${u.name}: ${how} [${u.sheets.join(", ")}]`);
  }
  if (report.excluded.length > 0) {
    lines.push(`  out of scope (${report.excluded.length}): ${report.excluded.slice(0, 3).map((e) => `${e.sheet} > ${e.key}`).join(", ")}${report.excluded.length > 3 ? ", …" : ""}`);
  }
  if (report.unstated.length > 0) {
    lines.push(`  states nothing in that environment (${report.unstated.length}): ${report.unstated.slice(0, 3).map((e) => `${e.sheet} > ${e.key} [${e.instance}]`).join(", ")}${report.unstated.length > 3 ? ", …" : ""}`);
  }
  return lines.join("\n");
}
