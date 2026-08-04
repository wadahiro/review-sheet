// Pure, framework-free diff between two snapshots (versions). Produces a
// renderable diff model: per-sheet / per-category / per-parameter, and — the
// point of the whole feature — per-instance value cells, so a Pattern B
// comparison shows exactly which environment's value changed.
//
// Used by the browser viewer and (potentially) a CLI `diff`. No DOM/Node deps.

import type { SheetData, CategoryData, ParamData } from "./prompt.js";
import { pickLang } from "./types.js";

export type DiffStatus = "added" | "removed" | "changed" | "unchanged";

export type CellDiff = {
  instance?: string; // undefined for a Pattern A single value
  status: DiffStatus;
  from?: string;
  to?: string;
};

export type FieldDiff = { field: "description" | "default" | "remarks"; from?: string; to?: string };

export type ParamDiff = {
  key: string;
  status: DiffStatus;
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
  summary: { changed: number; added: number; removed: number; unchanged: number };
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

  let status: DiffStatus;
  if (!from) status = "added";
  else if (!to) status = "removed";
  else if (cells.some((c) => c.status !== "unchanged") || fields.length > 0) status = "changed";
  else status = "unchanged";

  return { key, status, cells, fields };
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

  const summary = { changed: 0, added: 0, removed: 0, unchanged: 0 };
  const countCat = (c: CategoryDiff): void => {
    for (const p of c.params) summary[p.status]++;
    c.categories.forEach(countCat);
  };
  for (const s of sheets) s.categories.forEach(countCat);

  return { sheets, summary, excluded, sheetsOnlyOnOneSide };
}
