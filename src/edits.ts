// A review's decided items, collapsed into what has to change in the files.
//
// A review item marked `applied` is a decision: this value becomes that one.
// The items are APPENDED rather than written into the row, so the original
// value stays tied to its `source` — a real line in a real config file, which
// `verify` checks — and the chain between it and the current value stays
// readable. What this module does is fold that chain into a plan `apply` can
// carry out, which is not the same list: a cell decided three times is ONE
// change to make, and a row that was added or struck out is not an edit to a
// line that exists at all.
//
// Pure: no DOM, no storage, no file access.

import type { SheetData, CategoryData, ParamData, ReviewItem } from "./prompt.js";
import { HELD_REASON_NOTE } from "./prompt.js";
import type { Lang } from "./html/i18n.js";

// Only these two. `value` is what the sheet is for; `remarks` is where the
// operational note about it goes. Everything else on a row (key, description,
// default) is a statement about the product, not about this installation, and
// is not the recipient's to restate.
export const EDITABLE_FIELDS = ["value", "remarks"] as const;

// A document sheet has no rows, so its edit names no parameter: the target is
// the sheet, and the value is the markdown source. Kept out of EDITABLE_FIELDS
// because that set is about CELLS.
export const DOCUMENT_FIELD = "document";

export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const isEditableField = (field: string): field is EditableField =>
  (EDITABLE_FIELDS as readonly string[]).includes(field);

// An edit is an `applied` item: it has already taken effect in the sheet.
// A `pending` item is a review finding — a proposal — and does not move values.
// A section's own paragraph. Deliberately NOT "remarks": that name is an
// EDITABLE_FIELD, so a category-level item carrying it would be swept into the
// per-cell collapse `planFromEdits` does and travel apply's source-map path with
// no row to point at. A name of its own keeps it where it belongs.
export const NOTE_FIELD = "note";

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

// Rewrite the sheet tree so every cell shows its current value. Returns the
// input untouched (same object) when nothing was edited, so a document that
// nobody has edited costs nothing and behaves exactly as before.
// The newest entry that struck each row through or put it back.
//
// Both directions are recorded, so this is a FOLD over the chain rather than a
// set of deleted keys: striking a row out and restoring it months later are two
// decisions, and the second is not a correction of the first.
//
// ONE fold, read by everything. There were three — the sheet rendering, the
// per-row history, and the AI prompt each walked the same items their own way —
// which was harmless only while they all meant exactly the same thing by
// "deleted". They stop meaning the same thing the moment deletion applies to a
// block: strike a container and its contents go with it, and a fold that knows
// about ancestors in the viewer but not in the prompt would show a struck
// subtree on screen while telling the AI to remove one line.
function latestDeletions(reviews: ReviewItem[]): Map<string, ReviewItem> {
  const out = new Map<string, ReviewItem>();
  for (const r of sortEdits(reviews.filter((r) => isEdit(r) && r.deletes !== undefined))) {
    out.set(targetKey({ ...r.target, instance: undefined }), r);
  }
  return out;
}

// ============================================================
// Getting the edits back out
// ============================================================

export type EditPlan = {
  // Rewrites of a document sheet's markdown. Not a cell and not a row: the
  // whole page, going back to the markdown file it was rendered from.
  documents: ReviewItem[];
  // The NET change per cell, shaped like a review finding so it goes through
  // apply's ordinary path — source map, parser dispatch, verification and all.
  changes: ReviewItem[];
  // Rows no config file has a line for, and rows marked as no longer set.
  // Neither is an edit to an existing line, so neither can be applied
  // deterministically; both are real work and go to the AI prompt.
  added: ReviewItem[];
  struck: ReviewItem[];
  // Paragraphs written beside a table. Documentation, like a document sheet's
  // page: it is on the sheet already, and whether it belongs in the project's
  // own sheet.yml is a decision for whoever maintains it.
  notes: ReviewItem[];
};

// Collapse an edit history into what actually has to change in the files.
//
// A cell edited three times is ONE change to make: the file still holds the
// original value, so replaying the chain step by step would fail at the first
// step the moment anyone had already applied part of it by hand, and cascade
// from there. The pair that matters is (what the sheet was built with, what it
// says now).
// The newest rewrite per document sheet. A page edited three times is one file
// to write, for the same reason a cell edited three times is one change.
function documentRewrites(reviews: ReviewItem[]): ReviewItem[] {
  const latest = new Map<string, ReviewItem>();
  // Where the page STARTED: the first rewrite's own `current` is the document
  // as it was handed over. Keeping the newest item's instead would take the
  // second rewrite's starting point and call everything before it unchanged —
  // which is the same collapse a cell needs, and the same reason.
  const delivered = new Map<string, string>();
  for (const r of sortEdits(reviews)) {
    if (!isEdit(r) || r.target.param !== undefined || (r.target.field ?? "") !== DOCUMENT_FIELD) continue;
    const change = r.changes?.find((c) => c.field === DOCUMENT_FIELD);
    if (!delivered.has(r.target.sheet)) delivered.set(r.target.sheet, change?.current ?? "");
    latest.set(r.target.sheet, r);
  }
  return [...latest.entries()].map(([sheet, r]) => ({
    ...r,
    changes: (r.changes ?? []).map((c) =>
      c.field === DOCUMENT_FIELD ? { ...c, current: delivered.get(sheet) ?? c.current } : c
    ),
  }));
}

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
  // The newest paragraph per section: one note written three times is one note,
  // for the same reason a cell edited three times is one change.
  const latestNote = new Map<string, ReviewItem>();
  for (const r of sortEdits(reviews)) {
    if (!isEdit(r) || r.target.param !== undefined || (r.target.field ?? "") !== NOTE_FIELD) continue;
    latestNote.set(`${r.target.sheet}::${r.target.category ?? ""}`, r);
  }
  return { changes, added, struck, notes: [...latestNote.values()], documents: documentRewrites(reviews) };
}

// Rows whose newest delete/restore entry says "no longer set".
const deletionTargets = (reviews: ReviewItem[]): ReviewItem[] =>
  [...latestDeletions(reviews).values()].filter((r) => r.deletes === true);

// Shape an edit plan as the pending-style items the AI prompt is built from.
// Shared so the CLI and the viewer cannot describe the same change
// differently: the reason a row could not be applied deterministically is what
// tells the AI what kind of judgement it is being asked for.
// Every row of a struck BLOCK, and every struck target that is itself a block,
// resolved against the sheets as they are NOW.
//
// The extent is never stored on the review item. A frozen list of keys would go
// stale the moment a regeneration adds a setting to the block, and "remove this
// block" would then quietly mean "remove what it used to contain" — so it is
// derived, and deleting a block always means what it now holds.
function blockDeletions(
  sheets: SheetData["sheets"],
  struck: ReviewItem[]
): { extent: Map<string, ParamData[]>; covered: Set<string> } {
  const extent = new Map<string, ParamData[]>();
  const covered = new Set<string>();
  const blocks = new Map<string, ReviewItem>();
  for (const r of struck) if (r.target.param) blocks.set(targetKey({ ...r.target, instance: undefined }), r);
  if (blocks.size === 0) return { extent, covered };
  const walk = (sheet: string, cats: CategoryData[] | undefined, path: string): void => {
    for (const cat of cats ?? []) {
      const here = path ? `${path}/${cat.name}` : cat.name;
      for (const p of cat.params ?? []) {
        for (const anc of p.container_path ?? []) {
          const k = targetKey({ sheet, category: here, param: anc.path });
          if (!blocks.has(k)) continue;
          (extent.get(k) ?? extent.set(k, []).get(k)!).push(p);
          // Its own item, if it has one, is the block's decision restated.
          covered.add(targetKey({ sheet, category: here, param: p.key }));
        }
      }
      walk(sheet, cat.categories, here);
    }
  };
  for (const sheet of sheets) walk(sheet.name, sheet.categories, "");
  return { extent, covered };
}

export function promptItemsFromPlan(
  plan: EditPlan,
  reasons: { added: string; struck: string; document: string },
  // The current sheets, when the caller has them. Without them a struck block
  // reads as one deleted line, which is a different statement: an emptied
  // grouper is not an absent one, and only the second is what was asked for.
  sheets?: SheetData["sheets"]
): ReviewItem[] {
  const withReason = (r: ReviewItem, reason: string): ReviewItem => ({
    ...r,
    status: "pending",
    comment: [r.comment, reason].filter(Boolean).join(" \u2014 "),
  });
  const { extent, covered } = sheets ? blockDeletions(sheets, plan.struck) : { extent: new Map<string, ParamData[]>(), covered: new Set<string>() };
  const struck = plan.struck
    // A row inside a struck block is not its own decision — the block's item
    // already says it, and repeating it per row loses the fact that a STRUCTURE
    // was removed rather than a handful of settings.
    .filter((r) => !covered.has(targetKey({ ...r.target, instance: undefined })))
    .map((r) => {
      const inside = extent.get(targetKey({ ...r.target, instance: undefined }));
      if (!inside?.length) return withReason(r, reasons.struck);
      return withReason(
        { ...r, comment: [r.comment, `this block and everything in it (${inside.map((p) => p.key).join(", ")})`].filter(Boolean).join(" \u2014 ") },
        reasons.struck
      );
    });
  const notes = plan.notes.map((r) => withReason(r, HELD_REASON_NOTE));
  return [
    ...plan.changes,
    ...plan.added.map((r) => withReason(r, reasons.added)),
    ...notes,
    ...struck,
    ...plan.documents.map((r) => withReason(r, reasons.document)),
  ];
}
