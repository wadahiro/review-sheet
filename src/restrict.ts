// A delivery names the environments it covers.
//
// Not every environment a build knows is part of the same handover: one of them
// is usually the one an engineer keeps in order to build the others, and its
// values are nobody's acceptance evidence — a customer's document should not
// have to explain why a column called `local` is in it.
//
// Filtered HERE, at generate time, and deliberately NOT by narrowing the build:
// a build that never reads an environment's overlay never creates the rows only
// that environment sets, so a row would simply cease to exist, unreported —
// the one failure this whole area is organized against. Filtering the finished
// model instead keeps ONE model behind every delivery (the internal document
// and the customer's are provably the same content minus a column), and makes
// every loss countable, which is what the report below is for.
//
// A pure core: it takes a model and returns a model, and says what it dropped.

import type { ParameterSheetInput, VersionedSheetInput, Sheet, Category, Parameter, ArtifactPreview, SheetGroup } from "./types.js";
import { effectiveOrigin } from "./prompt.js";

export type RestrictReport = {
  kept: string[];
  dropped: string[];
  // Rows whose every value lived in an environment that is not being delivered.
  // KEPT, with nothing in their cells: the parameter is still part of the
  // system, and a document that removed the row would say it does not exist.
  // Named here, because "this row is blank" and "this row was emptied by the
  // delivery" are different facts and only one of them is visible on the page.
  emptied: string[];
  // Previews rendered per environment, for environments nobody is delivering.
  previews: number;
  // Environments a COMPARISON sheet kept although the delivery did not name
  // them — see keepFor. Reported per sheet, because "the delivery is prod" and
  // "this sheet also has dev in it" are two facts and only the first was asked
  // for. `paired`: the sheet declares which environment answers which, so the
  // partner of a delivered one came with it. `unpaired`: it declares that it
  // compares but not what against what, so nothing here can narrow it honestly.
  compared: { sheet: string; kept: string[]; why: "paired" | "unpaired" }[];
};

const label = (sheet: string, path: string[], key: string): string => [sheet, ...path, key].join(" > ");

function restrictParam(p: Parameter, keep: ReadonlySet<string>): { param: Parameter; emptied: boolean } {
  // A shared value (Pattern A) claims to hold in EVERY environment, so there is
  // nothing per-environment to take out of it.
  if (!("instances" in p) || p.instances === undefined) return { param: p, emptied: false };
  const instances = p.instances.filter((i) => keep.has(i.name));
  return { param: { ...p, instances }, emptied: instances.length === 0 && p.instances.length > 0 };
}

function restrictCategory(c: Category, keep: ReadonlySet<string>, sheet: string, path: string[], emptied: string[]): Category {
  const here = [...path, c.name];
  const params = (c.params ?? []).map((p) => {
    const done = restrictParam(p, keep);
    // Once per VERSION, deliberately — see restrict.test.ts. This counts empty
    // CELLS, and a version history renders the row once per version, so both
    // are really blank. `compared` above dedupes for the opposite reason: it
    // names a SHEET, and a versioned document has one sheet per name.
    if (done.emptied) emptied.push(label(sheet, here, p.key));
    return done.param;
  });
  return {
    ...c,
    ...(c.params === undefined ? {} : { params }),
    ...(c.categories === undefined ? {} : { categories: c.categories.map((x) => restrictCategory(x, keep, sheet, here, emptied)) }),
  };
}

// THE ENVIRONMENTS THIS SHEET KEEPS, which is not always the ones asked for.
//
// A comparison sheet's claim is that a row can be read ACROSS: `prod` beside
// `poc` is the whole of what an upgrade sheet says. Where the two sides have
// DIFFERENT environments, narrowing the delivery to one side's leaves a column
// of values facing a column of blanks — a sheet that has lost the only thing it
// was for, which is worse than one environment more than was asked for.
//
// Measured, not declared. The condition is "would this narrowing leave some
// component with no environments at all", which the rows themselves answer —
// on a comparing sheet the top-level categories ARE the components. Most
// comparison sheets are not affected: components that SHARE their environments
// (two realms, each configured in staging and production) all survive a
// narrowing to staging and production, and asking one of them to keep `local`
// would put back the environment `--instances` exists to remove.
//
// Nothing new is declared for the ones that are. `compare_instances` already
// states which environment answers which, so the partner of a delivered
// environment is a fact the sheet carries; a per-sheet "keep these too" would
// be a third place to write a name already written twice, free to contradict
// both. A sheet that says it compares but not WHAT AGAINST WHAT keeps the
// emptied component's environments whole: there is no correspondence to follow,
// so any subset would be a guess. Said out loud either way — see
// RestrictReport.compared.
function componentEnvs(s: Sheet): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const component of s.categories ?? []) {
    const envs = new Set<string>();
    const walk = (c: Category): void => {
      for (const p of c.params ?? []) for (const i of p.instances ?? []) envs.add(i.name);
      for (const inner of c.categories ?? []) walk(inner);
    };
    walk(component);
    out.set(component.name, envs);
  }
  return out;
}

function keepFor(
  s: Sheet,
  keep: ReadonlySet<string>
): { keep: ReadonlySet<string>; also?: { kept: string[]; why: "paired" | "unpaired" } } {
  if (s.compare_components === undefined) return { keep };
  const byComponent = componentEnvs(s);
  // A component with no per-environment values at all is a component this
  // narrowing cannot empty — it has nothing to lose.
  const withEnvs = [...byComponent].filter(([, envs]) => envs.size > 0);
  const emptied = withEnvs.filter(([, envs]) => ![...envs].some((e) => keep.has(e)));
  if (emptied.length === 0) return { keep };
  // Nothing of this sheet survives the delivery anyway, so there is no
  // comparison left to protect. Widening here would put back a sheet the
  // environment filter had emptied.
  if (emptied.length === withEnvs.length) return { keep };
  const needed = new Set(emptied.flatMap(([, envs]) => [...envs]));
  const add = new Set<string>();
  for (const pair of s.compare_instances ?? []) {
    if (!pair.some((i) => keep.has(i))) continue;
    for (const i of pair) if (!keep.has(i) && needed.has(i)) add.add(i);
  }
  let why: "paired" | "unpaired" = "paired";
  for (const [, envs] of emptied) {
    if ([...envs].some((e) => add.has(e))) continue;
    why = "unpaired";
    for (const e of envs) if (!keep.has(e)) add.add(e);
  }
  if (add.size === 0) return { keep };
  return { keep: new Set([...keep, ...add]), also: { kept: [...add], why } };
}

function restrictSheet(s: Sheet, keep: ReadonlySet<string>, emptied: string[]): Sheet {
  return {
    ...s,
    // The sheet's own order is kept — which environments it has is the sheet's
    // business, and this only removes.
    ...(s.instances === undefined ? {} : { instances: s.instances.filter((i) => keep.has(i)) }),
    categories: (s.categories ?? []).map((c) => restrictCategory(c, keep, s.name, [], emptied)),
  };
}

// A preview with no `instances` is one rendering that stands for the file, not
// a per-environment variant, and it stays. One that names environments keeps
// only the delivered ones — and belongs to nobody once they are all gone.
function restrictPreviews(previews: ArtifactPreview[] | undefined, keep: ReadonlySet<string>): { previews: ArtifactPreview[] | undefined; dropped: number } {
  if (previews === undefined) return { previews, dropped: 0 };
  let dropped = 0;
  const out: ArtifactPreview[] = [];
  for (const a of previews) {
    if (a.instances === undefined) {
      out.push(a);
      continue;
    }
    const instances = a.instances.filter((i) => keep.has(i));
    if (instances.length === 0) {
      dropped += 1;
      continue;
    }
    out.push({ ...a, instances });
  }
  return { previews: out, dropped };
}

// One document out of a build that produced several.
//
// The same decision as the environments above, one level up: a requirements
// note, a parameter sheet and a test record are separate documents in the
// world — approved separately, revised on their own cycles, sometimes handed to
// different people — and a delivery says which sheets it is made of. And the
// same shape: the model is not narrowed, so ONE build stands behind every
// document and nothing is lost unreported.
//
// The order is the document's own. A delivery only ever removes; rearranging
// the sheets would make two deliveries of the same build read differently.
export type SheetSelection = { kept: string[]; dropped: string[]; rows: number; previews: number; groups: string[] };

const countRows = (cats: Category[] | undefined): number =>
  (cats ?? []).reduce((n, c) => n + (c.params?.length ?? 0) + countRows(c.categories), 0);

export function sheetsOf(input: ParameterSheetInput | VersionedSheetInput): string[] {
  const sheets = "versions" in input ? input.versions.flatMap((v) => v.sheets) : input.sheets;
  const out: string[] = [];
  for (const s of sheets) if (!out.includes(s.name)) out.push(s.name);
  return out;
}

export function selectSheets<T extends ParameterSheetInput | VersionedSheetInput>(
  input: T,
  keep: readonly string[]
): { input: T; report: SheetSelection } {
  const wanted = new Set(keep);
  let rows = 0;
  let previews = 0;
  const dropped: string[] = [];
  const apply = <S extends { sheets: Sheet[]; artifacts?: ArtifactPreview[]; groups?: SheetGroup[] }>(doc: S): S => {
    const sheets = doc.sheets.filter((s) => {
      if (wanted.has(s.name)) return true;
      if (!dropped.includes(s.name)) dropped.push(s.name);
      rows += countRows(s.categories);
      return false;
    });
    // A preview belongs to the sheet it was built for; without that sheet it is
    // a file nobody in this document can open.
    const artifacts = doc.artifacts?.filter((a) => {
      const stays = a.sheet === undefined || wanted.has(a.sheet);
      if (!stays) previews += 1;
      return stays;
    });
    // …and a group nothing is left under is a heading over nothing.
    //
    // Asked of the whole SUBTREE, not of the entry itself. A chapter tree is
    // three or four levels deep on a real document and a sheet names the LEAF
    // it sits in, never the chapter above it — so testing a top-level entry
    // against the sheets' own group names is a test no ancestor can ever pass,
    // and the branch went with every kept sheet under it. At its worst that
    // fired with nothing dropped at all: naming every sheet still emptied the
    // tree. The same recursion `assemble.ts`'s `holdsSomething` already makes
    // for the mirror check — a declared group no sheet belongs to.
    const used = new Set(sheets.map((s) => s.group).filter((g): g is string => g !== undefined));
    const holdsSomething = (g: SheetGroup): boolean => used.has(g.name) || (g.groups ?? []).some(holdsSomething);
    // Pruned at every level, so a chapter that survives because ONE of its
    // children does is not left holding the siblings that did not.
    const prune = (gs: SheetGroup[]): SheetGroup[] => {
      const out: SheetGroup[] = [];
      for (const g of gs) {
        if (!holdsSomething(g)) continue;
        if (g.groups === undefined) {
          out.push(g);
          continue;
        }
        const inner = prune(g.groups);
        // The SAME object back when nothing beneath it moved: a selection that
        // keeps every sheet has to be the identity, and rebuilding each entry
        // would rewrite the document to say exactly what it already said.
        if (inner.length === g.groups.length && inner.every((x, i) => x === g.groups![i])) out.push(g);
        // A chapter kept for its own sheets, whose every child chapter went.
        // The key goes rather than standing as an empty list — `groups: []` is
        // a heading over nothing, which is the thing being removed here.
        else if (inner.length === 0) {
          const { groups: _dropped, ...rest } = g;
          out.push(rest);
        } else out.push({ ...g, groups: inner });
      }
      return out;
    };
    return {
      ...doc,
      sheets,
      ...(doc.artifacts === undefined ? {} : { artifacts }),
      ...(doc.groups === undefined ? {} : { groups: prune(doc.groups) }),
    };
  };
  const out =
    "versions" in input
      ? ({ ...input, versions: input.versions.map((v) => apply(v as never)) } as T)
      : (apply(input as never) as unknown as T);
  const groups = ("versions" in out ? out.versions[0]?.groups : (out as ParameterSheetInput).groups) ?? [];
  return { input: out, report: { kept: [...keep], dropped, rows, previews, groups: groups.map((g) => g.name) } };
}

export function formatSheetSelection(r: SheetSelection): string {
  const lines = [`This document is made of ${r.kept.length} sheet(s): ${r.kept.join(", ")}`];
  if (r.dropped.length > 0) {
    lines.push(`  left out (${r.rows} row(s)): ${r.dropped.slice(0, 6).join(", ")}${r.dropped.length > 6 ? `, … and ${r.dropped.length - 6} more` : ""}`);
  }
  if (r.previews > 0) lines.push(`  ${r.previews} previewed file(s) belonging to them were left out`);
  return lines.join("\n");
}

// The environments a model HAS, in the order it states them, so a caller can
// check a `--instances` list against something real before restricting.
export function instancesOf(input: ParameterSheetInput | VersionedSheetInput): string[] {
  const sheets = "versions" in input ? input.versions.flatMap((v) => v.sheets) : input.sheets;
  const out: string[] = [];
  for (const s of sheets) for (const i of s.instances ?? []) if (!out.includes(i)) out.push(i);
  return out;
}

export function restrictInstances<T extends ParameterSheetInput | VersionedSheetInput>(
  input: T,
  keep: readonly string[]
): { input: T; report: RestrictReport } {
  const wanted = new Set(keep);
  const emptied: string[] = [];
  let previews = 0;
  const compared: RestrictReport["compared"] = [];
  // A preview belongs to a sheet, so it is kept by that sheet's own set — the
  // rendering of the old release's file is exactly what a comparison sheet's
  // extra environment is FOR, and dropping it would leave the kept column
  // pointing at a preview nobody delivered.
  const previewKeep = new Set(wanted);
  const apply = <S extends { sheets: Sheet[]; artifacts?: ArtifactPreview[] }>(doc: S): S => {
    const sheets = doc.sheets.map((s) => {
      const per = keepFor(s, wanted);
      if (per.also) {
        // Once per SHEET, not once per version. A version history holds the
        // same sheet N times, and the report describes the document: "also kept
        // prod" said three times reads as three sheets having done it.
        if (!compared.some((c) => c.sheet === s.name)) {
          compared.push({ sheet: s.name, kept: per.also.kept, why: per.also.why });
        }
        for (const i of per.also.kept) previewKeep.add(i);
      }
      return restrictSheet(s, per.keep, emptied);
    });
    const art = restrictPreviews(doc.artifacts, previewKeep);
    previews += art.dropped;
    return {
      ...doc,
      sheets,
      ...(doc.artifacts === undefined ? {} : { artifacts: art.previews }),
    };
  };
  const out =
    "versions" in input
      ? ({ ...input, versions: input.versions.map((v) => apply(v)) } as T)
      : (apply(input as ParameterSheetInput & { sheets: Sheet[] }) as unknown as T);
  return {
    input: out,
    report: {
      kept: [...keep],
      // An environment a comparison sheet kept is IN the delivery — listing it
      // as left out would be the report contradicting the document it
      // describes. It is still named, on the sheet's own line below.
      dropped: instancesOf(input).filter((i) => !wanted.has(i) && !compared.some((c) => c.kept.includes(i))),
      emptied,
      previews,
      compared,
    },
  };
}

// What the delivery left out, said out loud. A count carries its first few
// members: "12 rows" is unreviewable, and three names refute it at a glance.
export function formatRestrictReport(r: RestrictReport): string {
  const lines = [`Delivering ${r.kept.join(", ")}${r.dropped.length > 0 ? ` — left out: ${r.dropped.join(", ")}` : ""}`];
  if (r.emptied.length > 0) {
    lines.push(
      `  ${r.emptied.length} row(s) have a value only in an environment that is not delivered; they are shown with empty cells:`
    );
    for (const e of r.emptied.slice(0, 5)) lines.push(`    ${e}`);
    if (r.emptied.length > 5) lines.push(`    … and ${r.emptied.length - 5} more`);
  }
  for (const c of r.compared) {
    lines.push(
      c.why === "paired"
        ? `  sheet "${c.sheet}" also kept ${c.kept.join(", ")} — what the delivered environment(s) are compared against`
        : `  sheet "${c.sheet}" also kept ${c.kept.join(", ")} — the delivery would have left one of its ` +
          `components with no environment at all, and it declares no "compare_instances" to say which one ` +
          `answers which`
    );
  }
  if (r.previews > 0) lines.push(`  ${r.previews} previewed file(s) rendered only for those environments were left out`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// A delivery is the rows somebody DECIDED.
//
// A sheet materialized from a dictionary is an exhaustive ledger: every option
// the product has, with the ones nobody set carrying the product's own default
// and `origin: "default"`. That is the right shape for the document an engineer
// keeps — "did we mean to leave this alone" is a question only an exhaustive
// list can be asked — and it is 55% of the rows on one real delivery.
//
// For a recipient it is usually the wrong shape. The page already knows this:
// the viewer hides those rows unless a filter is turned on, and collapses a
// category made of nothing else. This takes the same cut one stage earlier, so
// they are not in the file at all — which is the difference between a reader
// who must not turn a filter on and a document that does not carry them.
//
// THE SAME PREDICATE AS THE FILTER, read from the same function (`prompt.ts`'s
// `effectiveOrigin`) rather than re-derived here: a second spelling of "is this
// row unset" is a second answer, and the two would part company on the first
// row that carries no `origin` of its own.
//
// What it does NOT touch: a `baseline` row (the vendor shipped it and this
// project removed it — a decision, and one of the more interesting ones), and
// an `out_of_scope` row (a different filter, a different claim). Only `default`.
export type UnsetReport = {
  // Per sheet, what fell: how many rows, and the first few by name.
  sheets: { sheet: string; rows: number; some: string[]; categories: number }[];
  rows: number;
  categories: number;
  // Sheets the cut was not applied to, because the caller named them. Said
  // back, so a list that names a sheet this document does not have, or one that
  // had no unset rows to keep, is visible rather than assumed to have worked.
  kept: string[];
  // Sheets left holding NOTHING — every row of them was unset, and they carry
  // no prose either. A whole page of the delivery that says only its own title,
  // which is not a thing to find out by opening it. Measured on a real
  // delivery: the two sheets describing the product's own default clients, a
  // subject that project never touches, which is exactly why every row of them
  // is unset. NAMED, never dropped: whether a page belongs in a handover is
  // `--sheets`' question and this one has no business answering it.
  emptied: string[];
};

// A category with nothing left under it goes — unless somebody wrote a note
// into it, or into one below it. The filter keeps a noted section for the same
// reason: hiding a section because every row in it is unset is right, hiding
// what a person wrote there is not.
function notedAnywhere(c: Category): boolean {
  if (typeof c.note === "string" && c.note !== "") return true;
  return (c.categories ?? []).some(notedAnywhere);
}

function holdsAnything(c: Category): boolean {
  return (c.params ?? []).length > 0 || (c.categories ?? []).some(holdsAnything);
}

// `keep` names the sheets the cut does NOT apply to.
//
// A sheet whose whole subject IS the product's defaults — the clients Keycloak
// ships with, which a project never touches and therefore never sets — is not
// an exhaustive ledger with some noise in it. Its unset rows are its content,
// and a delivery that cuts them delivers a page with nothing on it.
//
// By sheet and not by row: what a sheet is ABOUT is the sheet's own property,
// and a per-row exception would be a second sheet definition living in a
// delivery script. Named sheets are excluded rather than an allow-list given,
// so a sheet added later gets the cut — which is the safer default for a
// handover, and the one that does not go wrong by omission.
export function dropUnset<T extends ParameterSheetInput | VersionedSheetInput>(
  input: T,
  keep: readonly string[] = []
): { input: T; report: UnsetReport } {
  const spared = new Set(keep);
  const report: UnsetReport = { sheets: [], rows: 0, categories: 0, kept: [...keep], emptied: [] };

  const prune = (cats: Category[], sheet: string, path: string[], seen: { rows: number; some: string[]; categories: number }): Category[] => {
    const out: Category[] = [];
    for (const c of cats) {
      const here = [...path, c.name];
      const params = (c.params ?? []).filter((p) => {
        if (effectiveOrigin(p) !== "default") return true;
        seen.rows++;
        if (seen.some.length < 3) seen.some.push(label(sheet, here, p.key));
        return false;
      });
      const categories = prune(c.categories ?? [], sheet, here, seen);
      const kept: Category = { ...c, ...(c.params === undefined ? {} : { params }), ...(c.categories === undefined ? {} : { categories }) };
      if (!holdsAnything(kept) && !notedAnywhere(kept)) {
        seen.categories++;
        continue;
      }
      out.push(kept);
    }
    return out;
  };

  const apply = <S extends { sheets: Sheet[] }>(doc: S): S => ({
    ...doc,
    sheets: doc.sheets.map((s) => {
      // Spared, and MARKED. The two are one decision — this sheet's unset rows
      // are its content — and a sheet that keeps them without saying so is
      // delivered with the viewer's filter still hiding every one of them: the
      // rows are in the file and the page is blank, which is the worst of both.
      if (spared.has(s.name)) return { ...s, unset_is_content: true };
      const seen = { rows: 0, some: [] as string[], categories: 0 };
      const categories = prune(s.categories ?? [], s.name, [], seen);
      if (seen.rows > 0 || seen.categories > 0) {
        report.sheets.push({ sheet: s.name, rows: seen.rows, some: seen.some, categories: seen.categories });
        report.rows += seen.rows;
        report.categories += seen.categories;
      }
      // A prose sheet holds no rows by nature and is not emptied by anything
      // here; one that held only unset rows now holds none.
      if (seen.rows > 0 && !categories.some(holdsAnything) && (s as { document?: unknown }).document === undefined) {
        report.emptied.push(s.name);
      }
      return { ...s, ...(s.categories === undefined ? {} : { categories }) };
    }),
  });

  const out =
    "versions" in input
      ? ({ ...input, versions: input.versions.map(apply) } as T)
      : (apply(input as ParameterSheetInput) as T);
  return { input: out, report };
}

// Always printed when the flag was passed: a delivery that quietly left half
// its rows out is the thing this must never be used to do by accident.
export function formatUnsetReport(r: UnsetReport): string {
  const spared =
    r.kept.length === 0 ? "" : `\n  kept in full, as named: ${r.kept.join(", ")}`;
  if (r.rows === 0 && r.categories === 0) {
    return `unset rows: none to leave out — every row of this document was set by somebody${spared}`;
  }
  const lines = [
    `Leaving out ${r.rows} unset row(s)${r.categories > 0 ? ` and ${r.categories} category(ies) left holding none` : ""} — ` +
      `rows nobody set, carrying the product's own default:`,
  ];
  for (const s of r.sheets.slice(0, 8)) {
    lines.push(`  ${s.sheet}: ${s.rows} row(s)${s.categories > 0 ? `, ${s.categories} category(ies)` : ""} — ${s.some.join(", ")}${s.rows > s.some.length ? ", …" : ""}`);
  }
  if (r.sheets.length > 8) lines.push(`  … and ${r.sheets.length - 8} more sheet(s)`);
  if (r.emptied.length > 0) {
    lines.push(
      `  ${r.emptied.length} sheet(s) are left holding nothing at all — every row of them was unset, so the ` +
        `delivery carries a page that says only its own title: ${r.emptied.join(", ")}. ` +
        `Leave them out with --sheets if they do not belong in this handover, or keep their rows with ` +
        `--keep-unset if the product's own defaults are what those sheets are ABOUT.`
    );
  }
  if (spared !== "") lines.push(spared.replace(/^\n/, ""));
  return lines.join("\n");
}
