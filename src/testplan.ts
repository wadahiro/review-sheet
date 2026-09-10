// The unit test's PLAN, derived from the sheet it tests.
//
// A unit-test specification enumerates its items under a classification with
// three levels: the unit under test, the software component inside it, and
// every setting the design records. The third is where such a document usually
// makes a promise it cannot keep — "every setting in the detailed design is
// covered" is a sentence, and a sentence is not a check.
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

import type { FunctionalItem, LangText, OutOfScope, ParameterSheetInput, Parameter, Sheet, SheetGroup, TestDeclaration } from "./types.js";

export type { TestDeclaration, FunctionalItem };

// One thing to check, once, in one environment.
export type TestItem = {
  // The row this item tests, spelled the way a result must answer it.
  target: { sheet: string; path: string[]; key: string; instance: string };
  // The unit and the sheet, resolved to what a reader sees.
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
  // is itself the reason such an item usually comes back not run. Usually the
  // sheet/category's own path (rowsOf), but a row's own deployed_file wins
  // when it has one — the row that does not follow its neighbours.
  file?: string;
  kind: TestKind;
  // WHO decided the expected value — a different question from what it is, and
  // from how it was checked. A record that answers only the first cannot say
  // whether `Listen 80` is this project's decision or a line it inherited
  // unchanged from the vendor's own configuration, and those are signed off
  // differently.
  decider: TestDecider;
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

// Who decided the value this item expects.
//
//   project         this project set it, and the vendor said nothing about it
//                   (or ships no configuration this sheet compares against)
//   vendor-kept     the vendor's own file carries it and this project deploys
//                   it unchanged — inherited, not chosen
//   vendor-changed  the vendor's file carries it and this project deploys
//                   something else
//   product-default nobody set it anywhere; the product's own default applies
//   vendor-removed  the vendor shipped it and this project does not deploy it
//
// Derived, never declared: `origin` says whether anything of ours sets the row,
// and `baseline` (ParameterBase.baseline) says what the vendor shipped — the
// two together answer this, and neither answers it alone.
export type TestDecider = "project" | "vendor-kept" | "vendor-changed" | "product-default" | "vendor-removed";

// A functional item, planned: once per environment, the same way every derived
// item is planned once per environment.
//
// It is IN THE PLAN rather than read straight from the declaration at render
// time, because the plan is what a run has to answer. Left out of it, "the
// console opens" was an item no coverage check could see missing — the one
// failure this whole file exists to refuse.
export type FunctionalTestItem = {
  unit: string;
  unitLabel?: LangText;
  // What a result names it by, and it is the id where the project gave one:
  // prose is a label, not a join. See FunctionalItem.
  id?: string;
  text: LangText;
  intrusive: boolean;
  instance: string;
};

// The declaration's two accepted shapes, read as one. A bare sentence is still
// a whole item — the id and the intrusive mark are for the items that need them.
export const functionalItemOf = (x: LangText | FunctionalItem): FunctionalItem =>
  typeof x === "string" || !("text" in x) ? { text: x as LangText } : x;

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
  functional: FunctionalTestItem[];
};

// Everything the derivation left out, and why. A plan that quietly held fewer
// items than the sheet has rows would be the promise this file refuses to make.
export type TestPlanReport = {
  // Rows the project itself put outside the review's remit.
  // `component` for the same reason the items carry one: two components of a
  // sheet share a key space by design, so `sheet > key` alone renders one
  // exclusion twice — two real rows, one label, and a reader with no way to
  // tell which provider's credential each line is about.
  excluded: { unit: string; sheet: string; component?: string; key: string; reason: LangText; owner?: string }[];
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
// sheets, which is the outermost level a reader sees.
const unitOf = (sheet: Sheet, byName: Map<string, SheetGroup>): { name: string; label?: LangText; group?: SheetGroup } => {
  const g = sheet.group === undefined ? undefined : byName.get(sheet.group);
  return g === undefined ? { name: sheet.name, label: sheet.label } : { name: g.name, label: g.label, group: g };
};

const kindOf = (p: Parameter): TestKind =>
  p.origin === "default" ? "default-in-force" : p.origin === "baseline" ? "absent" : "value";

const deciderOf = (p: Parameter, kind: TestKind, expected: string | undefined): TestDecider => {
  if (kind === "default-in-force") return "product-default";
  if (kind === "absent") return "vendor-removed";
  const shipped = "baseline" in p ? p.baseline : undefined;
  if (shipped === undefined) return "project";
  // Compared against THIS environment's expected value, not the row's, because
  // a Pattern B row can inherit the vendor's line in one environment and
  // override it in another.
  return shipped === expected ? "vendor-kept" : "vendor-changed";
};

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
      for (const p of c.params ?? []) {
        // A row's OWN deployed_file (sheet.yml, per-param) wins over the
        // category/sheet path: it is the stated, narrowest fact — the row
        // that does not follow its neighbours (a category reviewed mostly
        // through an API, one setting of which really is read from a file) —
        // the same "stated beats derived, narrowest first" order assemble.ts's
        // rawFileOf already applies when it names a category after this same
        // field. Never source.file: that is a REPO path (see resolveSource in
        // prompt.ts), while deployed_file is documented (types.ts) as always
        // the deployed file, the same address space item.file needs.
        const rowFile = p.deployed_file ?? where;
        out.push({ p, path: here, component: here[0], ...(rowFile === undefined ? {} : { file: rowFile }), outOfScope: p.out_of_scope ?? oos });
      }
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
          ...(row.component === undefined ? {} : { component: row.component }),
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
          decider: deciderOf(row.p, kind, expected),
          ...(row.p.secret === true ? { quiet: true as const } : expected === undefined ? {} : { expected }),
        });
      }
    }
  }

  // The functional items, once the units are known: they belong to a unit, and
  // the environments they are checked in are the ones that unit's rows name.
  // Derived from the items rather than from the sheets, so an environment no
  // row states anything in does not acquire functional items either.
  const functional: FunctionalTestItem[] = [];
  for (const unit of units.values()) {
    // No guard for a unit that says it is not tested in this phase: such a unit
    // pushed no items, so it names no environments, so this loop runs zero
    // times for it. A guard would have been a branch no test could ever see
    // taken (verifying.md R3).
    const instances = [...new Set(items.filter((i) => i.unit === unit.name).map((i) => i.target.instance))];
    for (const instance of instances) {
      for (const raw of unit.declaration.functional ?? []) {
        const f = functionalItemOf(raw);
        functional.push({
          unit: unit.name,
          ...(unit.label === undefined ? {} : { unitLabel: unit.label }),
          ...(f.id === undefined ? {} : { id: f.id }),
          text: f.text,
          intrusive: f.intrusive === true,
          instance,
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

  return { plan: { metadata: input.metadata, units: [...units.values()], items, functional }, report };
}

// What the derivation left out, for the CLI to print. Counts first, then the
// members, because a count nobody can read is not a report (verifying.md R4).
export function formatTestPlanReport(plan: TestPlan, report: TestPlanReport): string {
  const lines: string[] = [];
  const kinds = plan.items.reduce<Record<string, number>>((n, i) => ({ ...n, [i.kind]: (n[i.kind] ?? 0) + 1 }), {});
  lines.push(
    `test plan: ${plan.items.length + plan.functional.length} item(s) across ${plan.units.length} unit(s) — ` +
      [...Object.entries(kinds).map(([k, n]) => `${n} ${k}`), ...(plan.functional.length > 0 ? [`${plan.functional.length} functional`] : [])]
        .join(", ")
  );
  for (const u of plan.units) {
    const n = plan.items.filter((i) => i.unit === u.name).length;
    const fn = plan.functional.filter((i) => i.unit === u.name).length;
    const how =
      u.declaration.not_tested !== undefined
        ? "not tested in this phase"
        : `${n + fn} item(s)${fn > 0 ? ` (${fn} functional)` : ""}`;
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
