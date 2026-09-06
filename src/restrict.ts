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

import type { ParameterSheetInput, VersionedSheetInput, Sheet, Category, Parameter, ArtifactPreview } from "./types.js";

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
    if (done.emptied) emptied.push(label(sheet, here, p.key));
    return done.param;
  });
  return {
    ...c,
    ...(c.params === undefined ? {} : { params }),
    ...(c.categories === undefined ? {} : { categories: c.categories.map((x) => restrictCategory(x, keep, sheet, here, emptied)) }),
  };
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
  const apply = <S extends { sheets: Sheet[]; artifacts?: ArtifactPreview[]; groups?: { name: string }[] }>(doc: S): S => {
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
    const used = new Set(sheets.map((s) => s.group).filter((g): g is string => g !== undefined));
    return {
      ...doc,
      sheets,
      ...(doc.artifacts === undefined ? {} : { artifacts }),
      ...(doc.groups === undefined ? {} : { groups: doc.groups.filter((g) => used.has(g.name)) }),
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
  const apply = <S extends { sheets: Sheet[]; artifacts?: ArtifactPreview[] }>(doc: S): S => {
    const art = restrictPreviews(doc.artifacts, wanted);
    previews += art.dropped;
    return {
      ...doc,
      sheets: doc.sheets.map((s) => restrictSheet(s, wanted, emptied)),
      ...(doc.artifacts === undefined ? {} : { artifacts: art.previews }),
    };
  };
  const out =
    "versions" in input
      ? ({ ...input, versions: input.versions.map((v) => apply(v)) } as T)
      : (apply(input as ParameterSheetInput & { sheets: Sheet[] }) as unknown as T);
  return {
    input: out,
    report: { kept: [...keep], dropped: instancesOf(input).filter((i) => !wanted.has(i)), emptied, previews },
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
  if (r.previews > 0) lines.push(`  ${r.previews} previewed file(s) rendered only for those environments were left out`);
  return lines.join("\n");
}
