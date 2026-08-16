// Pure, framework-free diff between two snapshots (versions). Produces a
// renderable diff model: per-sheet / per-category / per-parameter, and — the
// point of the whole feature — per-instance value cells, so a Pattern B
// comparison shows exactly which environment's value changed.
//
// Used by the browser viewer and (potentially) a CLI `diff`. No DOM/Node deps.

import { effectiveOrigin, type SheetData, type CategoryData, type ParamData } from "./prompt.js";
import { pickLang } from "./types.js";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export type CellDiff = {
  instance?: string; // undefined for a Pattern A single value
  status: DiffStatus;
  from?: string;
  to?: string;
};

export type FieldDiff = { field: "description" | "default" | "remarks"; from?: string; to?: string };

// WHAT KIND of thing changed about a row, which "changed" alone cannot say and
// a cross-version comparison desperately needs it to.
//
// Measured on one real upgrade (Keycloak 19.0.2 -> 26.7.0, same configuration
// read under each release's dictionary): of the 19 settings the project sets,
// ZERO values differ and 14 descriptions do. Across the whole dictionary the
// figure is 67-74% of shared keys. Worse, the prose churn is mostly not the
// product changing: 32 of 115 are a Japanese translation the newer dictionary
// has and the older one lacks, and 20 are a description the newer one LOST.
//
// Reported as one "changed" count, an upgrade review reads "115 changed" when
// the true finding is "nothing you set has moved" — a sign-off number that is
// wrong in the direction that matters. So:
//
//   value      a configured value differs. The finding.
//   effective  the PRODUCT's default differs on a row NOBODY SETS — so the
//              default IS the value in force, and it moved without anyone
//              editing anything. The loudest thing a version comparison can
//              say, and the reason to run one at all.
//   default    the product's default differs on a row the project DOES set.
//              Worth recording (an explicit value may now agree, or newly
//              disagree, with the product) but the deployment behaves the same.
//   doc        description/remarks differ. Between two dictionary versions this
//              is dominated by extraction and translation coverage, not by the
//              product, so it earns a quiet indicator rather than a tint.
//
// The effective/default split is not cosmetic. A materialized row carries NO
// value (measured: all 668 `origin: default` rows in one project have
// `value: undefined`, with the product's default beside them), so when its
// default moves nothing else about the row changes — without this split it
// reports exactly like the harmless case above it.
//
// `baseline` counts as unset alongside `default`, and this was got wrong once:
// such a row says "the vendor's shipped file had this directive and ours does
// not". Having removed the line, what governs is the product's built-in
// default — so those rows are MORE exposed to a default moving, not less.
export type ParamChangeKind = "value" | "effective" | "default" | "doc";

export type ParamDiff = {
  key: string;
  // Unchanged in meaning: "changed" still covers every kind, so every existing
  // consumer keeps working. `changed` below says WHICH kinds, and a caller that
  // wants the honest headline reads that instead.
  status: DiffStatus;
  // Which kinds changed, in the order above. Empty for added/removed/unchanged
  // — a row that is only on one side has no kind of change, it has a presence.
  changed: ParamChangeKind[];
  cells: CellDiff[];
  fields: FieldDiff[];
};

export type CategoryDiff = {
  name: string;
  path: string;
  status: DiffStatus;
  params: ParamDiff[];
  categories: CategoryDiff[];
};

export type SheetDiff = {
  name: string;
  status: DiffStatus;
  categories: CategoryDiff[];
};

// A sheet present on only one side, when `sheetPresence` collapses it to one
// fact instead of exploding every one of its parameters into removed/added
// rows (see `DiffOptions`). `paramCount` is how many parameters were folded
// into this one entry, so nothing is silently dropped — it is just reported
// once instead of once per row.
export type SheetPresence = { name: string; onlyIn: "from" | "to"; paramCount: number };

export type DiffOptions = {
  // Comparing two DIFFERENT sheets for equivalence (e.g. two deployment
  // platforms of the same system) routinely has one side materialized into a
  // full product inventory (`origin: "default"` rows, see assemble.ts) that
  // the other side never was. That asymmetry is correct, but left in the
  // comparison it buries the rows that are actually different. When true, a
  // param whose EITHER side is `origin: "default"` is excluded from the
  // comparison entirely (not counted, not printed) — the count is reported in
  // `DiffResult.excluded.defaultOrigin` so the exclusion is never silent.
  excludeDefaultOrigin?: boolean;
  // A sheet that exists on only one side is a structural fact (that
  // deployment layer isn't part of this platform at all — e.g. no httpd sheet
  // once an ALB terminates TLS directly), not per-parameter drift. When true,
  // such a sheet is reported once in `DiffResult.sheetsOnlyOnOneSide` instead
  // of every one of its parameters coming out `added`/`removed` in `summary`.
  sheetPresence?: boolean;
};

export type DiffResult = {
  sheets: SheetDiff[];
  // `changed` still counts every kind, so a consumer that only knew this field
  // reads the same number it always did. `docOnly` is the part of it that is
  // nothing but prose — subtract it for the number an upgrade review signs off
  // on. Reported rather than hidden: dictionary churn IS information about the
  // dictionaries, just not about the deployment.
  summary: { changed: number; docOnly: number; added: number; removed: number; unchanged: number };
  // Always present (zero/empty when the corresponding DiffOptions flag is
  // off) so a JSON consumer never has to branch on whether a field exists.
  excluded: { defaultOrigin: number };
  sheetsOnlyOnOneSide: SheetPresence[];
};

// Order-preserving outer join: yields { from?, to? } pairs in `to` order, then
// any `from`-only entries (removed) appended in their original order.
function mergeByKey<T>(fromArr: T[], toArr: T[], keyOf: (t: T) => string): { from?: T; to?: T }[] {
  const fromByKey = new Map<string, T>();
  for (const f of fromArr) fromByKey.set(keyOf(f), f);
  const out: { from?: T; to?: T }[] = [];
  const seen = new Set<string>();
  for (const t of toArr) {
    const k = keyOf(t);
    seen.add(k);
    out.push({ from: fromByKey.get(k), to: t });
  }
  for (const f of fromArr) {
    const k = keyOf(f);
    if (!seen.has(k)) out.push({ from: f });
  }
  return out;
}

function cellStatus(from: string | undefined, to: string | undefined): DiffStatus {
  if (from === undefined && to !== undefined) return "added";
  if (from !== undefined && to === undefined) return "removed";
  if (from !== to) return "changed";
  return "unchanged";
}

// One comparable value cell. `instance` is set only when the comparison is
// per-instance (see alignValues).
export type AlignedCell = { instance?: string; from?: string; to?: string };

function instanceMap(p: ParamData | undefined): Map<string, string> | undefined {
  if (!p?.instances || p.instances.length === 0) return undefined;
  return new Map(p.instances.map((i) => [i.name, i.value] as const));
}

// Pair up the two sides' values into cells that can be compared directly.
//
// A parameter is either Pattern A (one value shared by every instance) or
// Pattern B (one value per instance), and the same parameter can be one on one
// side and the other on the other — the deployment changed shape, or two sheets
// built from different platforms are being checked for equivalence. Keying
// Pattern A as its own cell and taking the union made EVERY cell of such a row
// come out added/removed, so the row read as changed even when the values agreed.
//
// `origin: "common"` states that the single value applies to every instance, so
// the faithful comparison expands it across the other side's instances. A row
// that genuinely says the same thing on both sides then comes out unchanged, and
// a cell that differs is reported against the instance it differs in.
export function alignValues(
  from: ParamData | undefined,
  to: ParamData | undefined
): { perInstance: boolean; cells: AlignedCell[] } {
  const fromInst = instanceMap(from);
  const toInst = instanceMap(to);

  if (!fromInst && !toInst) {
    const f = from?.value;
    const t = to?.value;
    return { perInstance: false, cells: f === undefined && t === undefined ? [] : [{ from: f, to: t }] };
  }

  // Instance order follows `to` (the current version), then any instance only
  // the baseline had — the same order the union used to produce.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of [toInst, fromInst]) {
    for (const n of m?.keys() ?? []) {
      if (seen.has(n)) continue;
      seen.add(n);
      names.push(n);
    }
  }

  // A side that is Pattern A contributes its one value to every instance.
  const fromShared = fromInst ? undefined : from?.value;
  const toShared = toInst ? undefined : to?.value;

  return {
    perInstance: true,
    cells: names.map((name) => ({
      instance: name,
      from: fromInst ? fromInst.get(name) : fromShared,
      to: toInst ? toInst.get(name) : toShared,
    })),
  };
}

function diffParam(from: ParamData | undefined, to: ParamData | undefined): ParamDiff {
  const key = (to ?? from)!.key;

  const cells: CellDiff[] = alignValues(from, to).cells.map((c) => ({
    instance: c.instance,
    status: cellStatus(c.from, c.to),
    from: c.from,
    to: c.to,
  }));

  // Non-value field changes.
  const fields: FieldDiff[] = [];
  (["description", "default", "remarks"] as const).forEach((field) => {
    // description/remarks may be a LangText map; compare on a canonical language
    // so structurally-equal prose from a shared dictionary isn't flagged changed.
    const f = pickLang(from?.[field], "en");
    const t = pickLang(to?.[field], "en");
    if (f !== t) fields.push({ field, from: f, to: t });
  });

  // `default` is deliberately NOT prose: it is what the product says the value
  // would be if nobody set it, so it moving is a statement about the deployment
  // even when every configured value held still.
  // Nobody set it: the product's default is what is in force. `baseline` joins
  // `default` here — see ParamChangeKind — and an absent side counts as unset
  // because there is no project value on it to be in force instead.
  const unset = (p: ParamData | undefined): boolean =>
    p === undefined || effectiveOrigin(p) === "default" || effectiveOrigin(p) === "baseline";

  const changed: ParamChangeKind[] = [];
  if (cells.some((c) => c.status !== "unchanged")) changed.push("value");
  if (fields.some((f) => f.field === "default")) changed.push(unset(from) && unset(to) ? "effective" : "default");
  if (fields.some((f) => f.field !== "default")) changed.push("doc");

  let status: DiffStatus;
  if (!from) status = "added";
  else if (!to) status = "removed";
  else if (changed.length > 0) status = "changed";
  else status = "unchanged";

  // Only a two-sided row has kinds: `changed` describes a difference, and a row
  // present on one side alone differs in presence, which `status` already says.
  return { key, status, changed: status === "changed" ? changed : [], cells, fields };
}

function rollup(
  childStatuses: DiffStatus[],
  onlyIn: "from" | "to" | "both"
): DiffStatus {
  if (onlyIn === "to") return "added";
  if (onlyIn === "from") return "removed";
  return childStatuses.some((s) => s !== "unchanged") ? "changed" : "unchanged";
}

function diffCategory(
  from: CategoryData | undefined,
  to: CategoryData | undefined,
  parentPath: string,
  opts: DiffOptions,
  excluded: { defaultOrigin: number }
): CategoryDiff {
  const name = (to ?? from)!.name;
  const path = parentPath ? `${parentPath}/${name}` : name;
  const onlyIn = !from ? "to" : !to ? "from" : "both";

  const params: ParamDiff[] = [];
  for (const pair of mergeByKey(from?.params ?? [], to?.params ?? [], (p) => p.key)) {
    if (opts.excludeDefaultOrigin && (pair.from?.origin === "default" || pair.to?.origin === "default")) {
      excluded.defaultOrigin++;
      continue;
    }
    params.push(diffParam(pair.from, pair.to));
  }
  const categories = mergeByKey(from?.categories ?? [], to?.categories ?? [], (c) => c.name).map((pair) =>
    diffCategory(pair.from, pair.to, path, opts, excluded)
  );

  const status = rollup([...params.map((p) => p.status), ...categories.map((c) => c.status)], onlyIn);
  return { name, path, status, params, categories };
}

// How many parameters a sheet carries in total, used to report a sheet-only
// entry's size without walking it into the comparison (see `sheetPresence`).
function countParams(categories: CategoryData[] | undefined): number {
  if (!categories) return 0;
  let n = 0;
  for (const c of categories) {
    n += c.params?.length ?? 0;
    n += countParams(c.categories);
  }
  return n;
}

export function diffSheets(
  fromSheets: SheetData["sheets"],
  toSheets: SheetData["sheets"],
  opts: DiffOptions = {}
): DiffResult {
  const excluded = { defaultOrigin: 0 };
  const sheetsOnlyOnOneSide: SheetPresence[] = [];

  const sheets: SheetDiff[] = mergeByKey(fromSheets, toSheets, (s) => s.name).map((pair) => {
    const onlyIn = !pair.from ? "to" : !pair.to ? "from" : "both";

    if (opts.sheetPresence && onlyIn !== "both") {
      const only = (pair.to ?? pair.from)!;
      sheetsOnlyOnOneSide.push({ name: only.name, onlyIn, paramCount: countParams(only.categories) });
      // Recorded once above instead of walked into categories/params, so it
      // never inflates `summary.added`/`summary.removed`.
      return { name: only.name, status: onlyIn === "to" ? "added" : "removed", categories: [] };
    }

    const categories = mergeByKey(pair.from?.categories ?? [], pair.to?.categories ?? [], (c) => c.name).map((cp) =>
      diffCategory(cp.from, cp.to, "", opts, excluded)
    );
    const name = (pair.to ?? pair.from)!.name;
    return { name, status: rollup(categories.map((c) => c.status), onlyIn), categories };
  });

  const summary = { changed: 0, docOnly: 0, added: 0, removed: 0, unchanged: 0 };
  const countCat = (c: CategoryDiff): void => {
    for (const p of c.params) {
      summary[p.status]++;
      if (p.changed.length > 0 && p.changed.every((k) => k === "doc")) summary.docOnly++;
    }
    c.categories.forEach(countCat);
  };
  for (const s of sheets) s.categories.forEach(countCat);

  return { sheets, summary, excluded, sheetsOnlyOnOneSide };
}
