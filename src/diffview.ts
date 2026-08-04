// Build a render-ready diff overlay for the *normal* sheet view: instead of a
// separate diff layout, we produce a merged SheetData (the union of the two
// versions, full content, removed rows/instances kept in place) plus:
//   - synthetic "reviews" that encode each changed value/field as old -> new, so
//     the existing cell renderer shows the delta inline (the same strikethrough
//     + suggested styling reviewers already know);
//   - a status map (row / instance / category / sheet -> status) used only to
//     tint and badge, not to compute values.
// This keeps ONE table renderer (ParamTable) and the whole app chrome (tabs,
// outline, search, freeze, transpose) for the diff.

import type { SheetData, CategoryData, ParamData, ReviewItem } from "./prompt.js";
import { pickLang } from "./types.js";
import { alignValues, type DiffStatus } from "./diff.js";

export type DiffStatusMap = Map<string, DiffStatus>;

export type DiffModel = {
  sheets: SheetData["sheets"];
  reviews: ReviewItem[];
  status: DiffStatusMap;
  summary: { changed: number; added: number; removed: number; unchanged: number };
};

export const sheetKey = (sheet: string): string => `sheet:${sheet}`;
export const catKey = (sheet: string, path: string): string => `cat:${sheet}::${path}`;
export const rowKey = (sheet: string, path: string, key: string): string => `row:${sheet}::${path}::${key}`;
export const instKey = (sheet: string, path: string, key: string, inst: string): string => `inst:${sheet}::${path}::${key}::${inst}`;

function merge<T>(fromArr: T[], toArr: T[], keyOf: (t: T) => string): { from?: T; to?: T; key: string }[] {
  const fromByKey = new Map(fromArr.map((f) => [keyOf(f), f] as const));
  const out: { from?: T; to?: T; key: string }[] = [];
  const seen = new Set<string>();
  for (const t of toArr) {
    const k = keyOf(t);
    seen.add(k);
    out.push({ from: fromByKey.get(k), to: t, key: k });
  }
  for (const f of fromArr) {
    const k = keyOf(f);
    if (!seen.has(k)) out.push({ from: f, key: k });
  }
  return out;
}

const status4 = (from: string | undefined, to: string | undefined): DiffStatus =>
  from === undefined && to !== undefined ? "added"
  : from !== undefined && to === undefined ? "removed"
  : from !== to ? "changed"
  : "unchanged";

export function buildDiffModel(
  fromSheets: SheetData["sheets"],
  toSheets: SheetData["sheets"],
  changedOnly: boolean
): DiffModel {
  const status: DiffStatusMap = new Map();
  const reviews: ReviewItem[] = [];
  const summary = { changed: 0, added: 0, removed: 0, unchanged: 0 };

  const FIELDS = ["description", "default", "remarks"] as const;

  const mergeParam = (sheet: string, path: string, from: ParamData | undefined, to: ParamData | undefined): { param: ParamData; st: DiffStatus } => {
    const key = (to ?? from)!.key;
    // The rendered param shows the *old* value on every changed cell/field and a
    // synthetic review supplies the *new* one, so the existing cell renderer
    // draws "old -> new" in place. Unchanged cells show the current value;
    // added rows show the new value; removed rows show the old value.
    const param: ParamData = { ...(to ?? from)! };

    // Shared with the CLI/summary diff so the overlay and `review-sheet diff`
    // can never disagree — in particular on a row that is Pattern A on one side
    // and Pattern B on the other, where the single value is expanded across the
    // other side's instances rather than compared against a cell that is simply
    // absent (see alignValues).
    const { perInstance, cells } = alignValues(from, to);

    let cellChanged = false;
    if (perInstance) {
      param.instances = cells.map((c) => {
        const name = c.instance!;
        const cs = status4(c.from, c.to);
        if (cs !== "unchanged") { status.set(instKey(sheet, path, key, name), cs); cellChanged = true; }
        if (cs === "changed") {
          reviews.push({ id: `diff:${path}:${key}:${name}`, status: "pending", target: { sheet, category: path, param: key, instance: name, field: "value" }, changes: [{ field: "value", current: c.from, suggested: c.to! }] });
          return { name, value: c.from! }; // show old; the review supplies new
        }
        return { name, value: (c.to ?? c.from)! }; // added: new; removed: old; unchanged: new
      });
      // A side that was Pattern A is now rendered per instance; leaving its
      // single `value` set would make the row claim to be both shapes at once.
      param.value = undefined;
    } else {
      cellChanged = cells.some((c) => c.from !== c.to);
    }

    let st: DiffStatus;
    if (!from) st = "added";
    else if (!to) st = "removed";
    else {
      const fieldChanged = FIELDS.some((f) => from[f] !== to[f]);
      st = cellChanged || fieldChanged ? "changed" : "unchanged";
    }

    // For rows present in both, replace each changed value/field with its old
    // value and emit a synthetic review carrying the new one.
    if (from && to) {
      if (!perInstance && cellChanged) {
        param.value = from.value;
        reviews.push({ id: `diff:${path}:${key}:value`, status: "pending", target: { sheet, category: path, param: key, field: "value" }, changes: [{ field: "value", current: from.value, suggested: to.value! }] });
      }
      for (const f of FIELDS) {
        // Prose fields (description/remarks) are LangText; the sheets fed here are
        // already localized to a single language, so resolve to plain strings.
        const fromF = pickLang(from[f], "en");
        const toF = pickLang(to[f], "en");
        if (fromF !== toF) {
          param[f] = fromF;
          reviews.push({ id: `diff:${path}:${key}:${f}`, status: "pending", target: { sheet, category: path, param: key, field: f }, changes: [{ field: f, current: fromF, suggested: toF ?? "" }] });
        }
      }
    }

    status.set(rowKey(sheet, path, key), st);
    summary[st]++;
    return { param, st };
  };

  const mergeCategory = (sheet: string, parentPath: string, from: CategoryData | undefined, to: CategoryData | undefined): { cat: CategoryData; st: DiffStatus } | null => {
    const name = (to ?? from)!.name;
    const path = parentPath ? `${parentPath}/${name}` : name;
    const onlyAdded = !from;
    const onlyRemoved = !to;

    const params: ParamData[] = [];
    let anyChangedParam = false;
    for (const pair of merge(from?.params ?? [], to?.params ?? [], (p) => p.key)) {
      const { param, st } = mergeParam(sheet, path, pair.from, pair.to);
      if (st !== "unchanged") anyChangedParam = true;
      if (changedOnly && st === "unchanged") continue;
      params.push(param);
    }

    const categories: CategoryData[] = [];
    let anyChangedSub = false;
    for (const pair of merge(from?.categories ?? [], to?.categories ?? [], (c) => c.name)) {
      const sub = mergeCategory(sheet, path, pair.from, pair.to);
      if (sub) {
        if (sub.st !== "unchanged") anyChangedSub = true;
        categories.push(sub.cat);
      }
    }

    const st: DiffStatus = onlyAdded ? "added" : onlyRemoved ? "removed" : (anyChangedParam || anyChangedSub ? "changed" : "unchanged");
    status.set(catKey(sheet, path), st);
    if (changedOnly && st === "unchanged" && params.length === 0 && categories.length === 0) return null;
    return { cat: { name, params, categories }, st };
  };

  const sheets: SheetData["sheets"] = [];
  for (const pair of merge(fromSheets, toSheets, (s) => s.name)) {
    const name = (pair.to ?? pair.from)!.name;
    const onlyAdded = !pair.from;
    const onlyRemoved = !pair.to;
    const categories: CategoryData[] = [];
    let anyChanged = false;
    for (const cp of merge(pair.from?.categories ?? [], pair.to?.categories ?? [], (c) => c.name)) {
      const sub = mergeCategory(name, "", cp.from, cp.to);
      if (sub) {
        if (sub.st !== "unchanged") anyChanged = true;
        categories.push(sub.cat);
      }
    }
    const st: DiffStatus = onlyAdded ? "added" : onlyRemoved ? "removed" : (anyChanged ? "changed" : "unchanged");
    status.set(sheetKey(name), st);
    if (changedOnly && st === "unchanged") continue;
    sheets.push({ name, role: (pair.to ?? pair.from)!.role, file_path: (pair.to ?? pair.from)!.file_path, categories });
  }

  return { sheets, reviews, status, summary };
}
