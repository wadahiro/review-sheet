// Edits made in a GENERATED sheet, by whoever maintains it afterwards.
//
// The premise: the recipient maintains values by hand (they have no automation
// to apply them), so the HTML is where the current value lives — but the
// original value is a checked fact, tied to a real line in a real config file
// through `source`. So an edit never overwrites a row. It is appended as an
// `applied` review item, and the list of them IS the history: the original
// value stays reachable underneath, and "what has this become, and when" is
// answerable years later. That is the one thing the spreadsheet it replaces
// structurally cannot do.
//
// Pure: no DOM, no storage. The viewer supplies the reviews and the language.

import type { SheetData, CategoryData, ParamData, ReviewItem } from "./prompt.js";
import type { Lang } from "./html/i18n.js";

// Only these two. `value` is what the sheet is for; `remarks` is where the
// operational note about it goes. Everything else on a row (key, description,
// default) is a statement about the product, not about this installation, and
// is not the recipient's to restate.
export const EDITABLE_FIELDS = ["value", "remarks"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const isEditableField = (field: string): field is EditableField =>
  (EDITABLE_FIELDS as readonly string[]).includes(field);

// An edit is an `applied` item: it has already taken effect in the sheet.
// A `pending` item is a review finding — a proposal — and does not move values.
export const isEdit = (r: ReviewItem): boolean => r.status === "applied";

export function targetKey(t: ReviewItem["target"]): string {
  let key = t.sheet;
  if (t.category) key += "::" + t.category;
  if (t.param) key += "::" + t.param;
  if (t.instance) key += "::" + t.instance;
  // Excludes field: cell-level lookup uses target.field separately.
  return key;
}

export const cellKey = (t: ReviewItem["target"], field: string): string => `${targetKey(t)}::${field}`;

// Chronological. Append order is the truth; `at` only breaks ties across files
// that were merged (an imported review.json lands at the end of the array
// regardless of when it was written).
export function sortEdits(edits: ReviewItem[]): ReviewItem[] {
  return edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const at = a.e.at ?? "";
      const bt = b.e.at ?? "";
      if (at !== bt && at !== "" && bt !== "") return at < bt ? -1 : 1;
      return a.i - b.i;
    })
    .map((x) => x.e);
}

// A prose edit is written in one language (the UI language at the time). Shown
// in the other language, it does not apply: the original text stands, so a
// Japanese note never surfaces inside an English document as if it were the
// translation. An edit with no language recorded applies to both.
const editApplies = (c: { lang?: string }, lang: Lang): boolean => c.lang === undefined || c.lang === lang;

export function editsForCell(reviews: ReviewItem[], t: ReviewItem["target"], field: string): ReviewItem[] {
  const k = targetKey(t);
  return sortEdits(reviews.filter((r) => isEdit(r) && targetKey(r.target) === k && (r.target.field ?? "") === field));
}

export type EditedSheets = {
  sheets: SheetData["sheets"];
  // The value the document was generated with, per edited cell (`cellKey`), so
  // the viewer can always show it next to what it has become.
  baseline: Map<string, string>;
  // Rows the recipient added whose category no longer exists — a regeneration
  // reorganised the sheet under them. Returned rather than dropped: a row that
  // vanishes from a maintained document is the failure this tool exists to
  // prevent, and it is no less a failure because the recipient wrote the row
  // rather than a config file.
  orphaned: ReviewItem[];
};

type EditIndex = Map<string, { suggested: string; count: number }>;

function indexEdits(reviews: ReviewItem[], lang: Lang): EditIndex {
  const byCell = new Map<string, ReviewItem[]>();
  for (const r of reviews) {
    if (!isEdit(r)) continue;
    const field = r.target.field ?? "";
    if (!isEditableField(field)) continue;
    const k = cellKey(r.target, field);
    const list = byCell.get(k);
    if (list) list.push(r); else byCell.set(k, [r]);
  }
  const out: EditIndex = new Map();
  for (const [k, list] of byCell) {
    const field = k.slice(k.lastIndexOf("::") + 2);
    // Newest first, so the current value is the first entry that applies in
    // this language.
    const ordered = sortEdits(list).reverse();
    for (const item of ordered) {
      const change = item.changes?.find((c) => c.field === field);
      if (change === undefined || !editApplies(change, lang)) continue;
      out.set(k, { suggested: change.suggested, count: list.length });
      break;
    }
  }
  return out;
}

// Rewrite the sheet tree so every cell shows its current value. Returns the
// input untouched (same object) when nothing was edited, so a document that
// nobody has edited costs nothing and behaves exactly as before.
// Whether each row is currently struck through. Both directions are recorded,
// so this is a FOLD over the chain, not a set of deleted keys: the newest entry
// that states either one wins, and a row deleted and later restored ends up
// present with both decisions still on record.
function indexDeletions(reviews: ReviewItem[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const r of sortEdits(reviews.filter((r) => isEdit(r) && r.deletes !== undefined))) {
    out.set(targetKey({ ...r.target, instance: undefined }), r.deletes === true);
  }
  return out;
}

// Every entry that struck this row through or put it back, oldest first.
export function deletionHistory(reviews: ReviewItem[], t: ReviewItem["target"]): ReviewItem[] {
  const k = targetKey({ ...t, instance: undefined });
  return sortEdits(reviews.filter((r) => isEdit(r) && r.deletes !== undefined && targetKey({ ...r.target, instance: undefined }) === k));
}

export function isDeleted(reviews: ReviewItem[], t: ReviewItem["target"]): boolean {
  const chain = deletionHistory(reviews, t);
  return chain.length > 0 && chain[chain.length - 1].deletes === true;
}

// Rows the recipient wrote, grouped by the category that must hold them.
function indexAdditions(reviews: ReviewItem[]): Map<string, ReviewItem[]> {
  const out = new Map<string, ReviewItem[]>();
  for (const r of sortEdits(reviews.filter((r) => isEdit(r) && r.creates === true && r.target.param))) {
    const k = `${r.target.sheet}::${r.target.category ?? ""}`;
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

// Environment names in the order the sheet declares them, falling back to the
// order a row happens to list. Used only when a SHARED row has to become a
// per-environment one.
const instanceNames = (sheet: SheetData["sheets"][number]): string[] => sheet.instances ?? [];

export function applyEdits(sheets: SheetData["sheets"], reviews: ReviewItem[], lang: Lang): EditedSheets {
  const index = indexEdits(reviews, lang);
  const additions = indexAdditions(reviews);
  const deletions = indexDeletions(reviews);
  const baseline = new Map<string, string>();
  const orphaned: ReviewItem[] = [];
  if (index.size === 0 && additions.size === 0 && deletions.size === 0) return { sheets, baseline, orphaned };

  const editParam = (sheet: string, path: string, p: ParamData, envs: string[]): ParamData => {
    const base = { sheet, category: path, param: p.key };
    let next: ParamData | undefined;
    const take = (field: EditableField, current: string, instance?: string): string => {
      const k = cellKey({ ...base, instance }, field);
      const hit = index.get(k);
      if (hit === undefined) return current;
      baseline.set(k, current);
      return hit.suggested;
    };

    // Struck through, never removed. A row that vanishes takes its history and
    // its source map with it, and leaves no way to ask what used to be here.
    const struck = deletions.get(targetKey(base));
    if (struck !== undefined && struck !== (p.deleted === true)) next = { ...p, deleted: struck };

    const value = take("value", p.value ?? "");
    if (value !== (p.value ?? "")) next = { ...(next ?? p), value };

    // `remarks` is already resolved to a plain string by the viewer's localize
    // pass, so it is compared and replaced as one.
    const remarks = take("remarks", typeof p.remarks === "string" ? p.remarks : "");
    if (remarks !== (typeof p.remarks === "string" ? p.remarks : "")) next = { ...(next ?? p), remarks };

    if (p.instances) {
      let touched = false;
      const instances = p.instances.map((inst) => {
        const v = take("value", inst.value, inst.name);
        if (v === inst.value) return inst;
        touched = true;
        return { ...inst, value: v };
      });
      if (touched) next = { ...(next ?? p), instances };
    } else if (envs.length > 0) {
      // A SHARED row — one stored value shown in every environment column —
      // with an edit naming a single environment. The configuration has one
      // line for all of them, so saying "production is 700 now" means the row
      // itself has to stop being shared. It is SPLIT here rather than refused:
      // the recipient applies configuration by hand, and a sheet that cannot
      // record what they did stops being a record of the system.
      //
      // The environments that did not change keep the shared row's `source`:
      // that common line still governs them, and it is still true. The one
      // that changed gets none, because no line for it exists yet — creating
      // it is the work this row is now asking for.
      const shared = p.value ?? "";
      const perEnv = envs.map((name) => {
        const v = take("value", shared, name);
        return v === shared ? { name, value: shared, source: p.source } : { name, value: v };
      });
      if (perEnv.some((e) => e.source === undefined)) {
        next = { ...(next ?? p), value: undefined, instances: perEnv };
      }
    }
    return next ?? p;
  };

  const placed = new Set<string>();

  // An added row is a real row from here on: it is edited, searched, exported
  // and rendered like any other. What it does NOT have is a `source` — nothing
  // in any config file backs it — and `added` is how every reader of this tree
  // can tell.
  const addedParams = (sheet: string, path: string, envs: string[]): ParamData[] => {
    const key = `${sheet}::${path}`;
    const items = additions.get(key);
    if (items === undefined) return [];
    placed.add(key);
    return items.map((r) => {
      const value = r.changes?.find((c) => c.field === "value")?.suggested ?? "";
      const remarksChange = r.changes?.find((c) => c.field === "remarks");
      const remarks = remarksChange !== undefined && editApplies(remarksChange, lang) ? remarksChange.suggested : undefined;
      const base: ParamData = { key: r.target.param!, value, added: true };
      // Later edits to the row apply on top of the values it was created with.
      return editParam(sheet, path, remarks === undefined ? base : { ...base, remarks }, envs);
    });
  };

  const editCategory = (sheet: string, parentPath: string, c: CategoryData, envs: string[]): CategoryData => {
    const path = parentPath ? `${parentPath}/${c.name}` : c.name;
    const own = (c.params ?? []).map((p) => editParam(sheet, path, p, envs));
    const extra = addedParams(sheet, path, envs);
    return {
      ...c,
      params: extra.length > 0 || c.params !== undefined ? [...own, ...extra] : undefined,
      categories: c.categories?.map((sc) => editCategory(sheet, path, sc, envs)),
    };
  };

  const out = sheets.map((s) => ({ ...s, categories: s.categories.map((c) => editCategory(s.name, "", c, instanceNames(s))) }));
  for (const [key, items] of additions) {
    if (!placed.has(key)) orphaned.push(...items);
  }
  return { sheets: out, baseline, orphaned };
}

// ============================================================
// Getting the edits back out
// ============================================================

// The saved HTML carries its history in a <script type="application/json">
// block. Read by scanning rather than parsing the page: the CLI has no DOM,
// and the block cannot contain "</script>" because every "<" in it was escaped
// when it was written (see html/save.ts's embedJson).
export function extractReviewsFromHtml(html: string): ReviewItem[] {
  const marker = html.indexOf('id="sheet-reviews"');
  if (marker < 0) return [];
  const open = html.indexOf(">", marker);
  const close = html.indexOf("</script>", open);
  if (open < 0 || close < 0) return [];
  const body = html.slice(open + 1, close).trim();
  if (!body) return [];
  const parsed: unknown = JSON.parse(body);
  // Two shapes: the bare array the first version wrote, and the current
  // { reviews, saves } document. Both are read, so a file saved by either build
  // keeps its history.
  if (Array.isArray(parsed)) return parsed as ReviewItem[];
  if (parsed !== null && typeof parsed === "object") {
    const list = (parsed as { reviews?: unknown }).reviews;
    if (Array.isArray(list)) return list as ReviewItem[];
  }
  throw new Error("the embedded edit history is not in a shape this version understands");
}

export type EditPlan = {
  // The NET change per cell, shaped like a review finding so it goes through
  // apply's ordinary path — source map, parser dispatch, verification and all.
  changes: ReviewItem[];
  // Rows no config file has a line for, and rows marked as no longer set.
  // Neither is an edit to an existing line, so neither can be applied
  // deterministically; both are real work and go to the AI prompt.
  added: ReviewItem[];
  struck: ReviewItem[];
};

// Collapse an edit history into what actually has to change in the files.
//
// A cell edited three times is ONE change to make: the file still holds the
// original value, so replaying the chain step by step would fail at the first
// step the moment anyone had already applied part of it by hand, and cascade
// from there. The pair that matters is (what the sheet was built with, what it
// says now).
export function planFromEdits(reviews: ReviewItem[]): EditPlan {
  const added = sortEdits(reviews.filter((r) => isEdit(r) && r.creates === true));
  const struck = deletionTargets(reviews);
  const addedKeys = new Set(added.map((r) => targetKey(r.target)));
  const struckKeys = new Set(struck.map((r) => targetKey({ ...r.target, instance: undefined })));

  const byCell = new Map<string, ReviewItem[]>();
  for (const r of sortEdits(reviews)) {
    if (!isEdit(r) || r.creates === true || r.deletes !== undefined) continue;
    const field = r.target.field ?? "";
    if (!isEditableField(field)) continue;
    // A row that was added here, or struck out, is not an edit to a line that
    // exists — its own entry already says what has to happen to it.
    if (addedKeys.has(targetKey(r.target)) || struckKeys.has(targetKey({ ...r.target, instance: undefined }))) continue;
    const k = cellKey(r.target, field);
    const list = byCell.get(k);
    if (list) list.push(r); else byCell.set(k, [r]);
  }

  const changes: ReviewItem[] = [];
  for (const [, list] of byCell) {
    const first = list[0];
    const last = list[list.length - 1];
    const field = first.target.field ?? "value";
    const from = first.changes?.find((c) => c.field === field)?.current;
    const to = last.changes?.find((c) => c.field === field)?.suggested;
    if (to === undefined || from === to) continue;
    changes.push({
      id: last.id,
      target: last.target,
      changes: [{ field, current: from, suggested: to }],
      comment: last.comment,
      status: "pending",
    });
  }
  return { changes, added, struck };
}

// Rows whose newest delete/restore entry says "no longer set".
function deletionTargets(reviews: ReviewItem[]): ReviewItem[] {
  const latest = new Map<string, ReviewItem>();
  for (const r of sortEdits(reviews.filter((r) => isEdit(r) && r.deletes !== undefined))) {
    latest.set(targetKey({ ...r.target, instance: undefined }), r);
  }
  return [...latest.values()].filter((r) => r.deletes === true);
}

// Shape an edit plan as the pending-style items the AI prompt is built from.
// Shared so the CLI and the viewer cannot describe the same change
// differently: the reason a row could not be applied deterministically is what
// tells the AI what kind of judgement it is being asked for.
export function promptItemsFromPlan(
  plan: EditPlan,
  reasons: { added: string; struck: string }
): ReviewItem[] {
  const withReason = (r: ReviewItem, reason: string): ReviewItem => ({
    ...r,
    status: "pending",
    comment: [r.comment, reason].filter(Boolean).join(" \u2014 "),
  });
  return [
    ...plan.changes,
    ...plan.added.map((r) => withReason(r, reasons.added)),
    ...plan.struck.map((r) => withReason(r, reasons.struck)),
  ];
}
