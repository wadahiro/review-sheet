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

// The markdown a document sheet should show now, or undefined for the one it
// was built with. Same fold as everywhere else: entries are appended, the
// newest wins, and the original stays reachable underneath.
// Every image any edit to this document has brought with it, newest last, laid
// over the ones the build embedded. Kept across the WHOLE history rather than
// read off the newest edit: a picture pasted in August and still referenced in
// September belongs to the September text too.
export function documentAssets(reviews: ReviewItem[], sheet: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of sortEdits(reviews)) {
    if (!isEdit(r) || r.target.sheet !== sheet || r.target.param !== undefined) continue;
    if ((r.target.field ?? "") !== DOCUMENT_FIELD) continue;
    for (const [path, uri] of Object.entries(r.assets ?? {})) out[path] = uri;
  }
  return out;
}

export function documentSource(reviews: ReviewItem[], sheet: string): string | undefined {
  const chain = sortEdits(
    reviews.filter(
      (r) => isEdit(r) && r.target.sheet === sheet && r.target.param === undefined && (r.target.field ?? "") === DOCUMENT_FIELD
    )
  );
  const last = chain[chain.length - 1];
  return last?.changes?.find((c) => c.field === DOCUMENT_FIELD)?.suggested;
}
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

// The environments a hand-maintained document knows about: its columns' names,
// as a set, decided once for the whole document.
//
// A document-level entry — `target.sheet` is empty, because it is about no
// sheet in particular — and the newest one states the whole list, so reading it
// is one lookup rather than a fold. Which sheets USE which of them is not
// stated here at all: a table has the column or it does not.
export const ENVIRONMENTS_FIELD = "environments";

export function documentEnvironments(reviews: ReviewItem[], fallback: string[]): string[] {
  for (const r of sortEdits(reviews).reverse()) {
    if (!isEdit(r) || r.target.sheet !== "" || (r.target.field ?? "") !== ENVIRONMENTS_FIELD) continue;
    const change = r.changes?.find((c) => c.field === ENVIRONMENTS_FIELD);
    if (change === undefined) continue;
    return change.suggested
      .split(",")
      .map((n) => n.trim())
      .filter((n) => n !== "");
  }
  return fallback;
}

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

const indexDeletions = (reviews: ReviewItem[]): Map<string, boolean> =>
  new Map([...latestDeletions(reviews)].map(([k, r]) => [k, r.deletes === true]));

// Every entry that struck this row through or put it back, oldest first.
export function deletionHistory(reviews: ReviewItem[], t: ReviewItem["target"]): ReviewItem[] {
  const k = targetKey({ ...t, instance: undefined });
  return sortEdits(reviews.filter((r) => isEdit(r) && r.deletes !== undefined && targetKey({ ...r.target, instance: undefined }) === k));
}

export function isDeleted(reviews: ReviewItem[], t: ReviewItem["target"]): boolean {
  return latestDeletions(reviews).get(targetKey({ ...t, instance: undefined }))?.deletes === true;
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

// The newest note per section, in the language being displayed. `indexEdits`
// cannot carry these: it only indexes EDITABLE_FIELDS, and a note is not a cell
// — it has no row, and nothing in a config file backs it.
function indexNotes(reviews: ReviewItem[], lang: Lang): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of sortEdits(reviews).reverse()) {
    if (!isEdit(r) || r.target.param !== undefined || (r.target.field ?? "") !== NOTE_FIELD) continue;
    const key = `${r.target.sheet}::${r.target.category ?? ""}`;
    if (out.has(key)) continue;
    const change = r.changes?.find((c) => c.field === NOTE_FIELD);
    if (change === undefined || !editApplies(change, lang)) continue;
    out.set(key, change.suggested);
  }
  return out;
}

export function applyEdits(sheets: SheetData["sheets"], reviews: ReviewItem[], lang: Lang): EditedSheets {
  const index = indexEdits(reviews, lang);
  const notes = indexNotes(reviews, lang);
  const additions = indexAdditions(reviews);
  const deletions = indexDeletions(reviews);
  const baseline = new Map<string, string>();
  const orphaned: ReviewItem[] = [];
  if (index.size === 0 && additions.size === 0 && deletions.size === 0 && notes.size === 0) {
    return { sheets, baseline, orphaned };
  }

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
    //
    // A row inside a struck BLOCK is struck too, derived here rather than
    // written down: one decision stays one entry, restoring the block is one
    // action, and a child struck on its own merits keeps that state when the
    // block comes back, because its own entry is its own. Writing an entry per
    // descendant instead would make restoring a six-item undo and would let
    // half-restored states exist that nobody decided.
    const own = deletions.get(targetKey(base));
    const inStruckBlock = (p.container_path ?? []).some((c) => deletions.get(targetKey({ ...base, param: c.path })) === true);
    const struck = own === true || inStruckBlock ? true : own;
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
    const note = notes.get(`${sheet}::${path}`);
    return {
      ...c,
      // Written in one language, and shown as one: a note is prose, so it
      // carries the language it was typed in exactly as `remarks` does — and
      // clearing it (a suggestion of "") removes it rather than leaving an
      // empty paragraph behind.
      // Stored as a plain string, which `LangText` allows: WHICH language it is
      // was already decided by `editApplies` when the note was chosen, so
      // tagging it again would only invite a second, disagreeing answer.
      ...(note === undefined ? {} : { note: note === "" ? undefined : note }),
      params: extra.length > 0 || c.params !== undefined ? [...own, ...extra] : undefined,
      categories: c.categories?.map((sc) => editCategory(sheet, path, sc, envs)),
    };
  };

  const out = sheets.map((s) => ({
    ...s,
    categories: s.categories.map((c) => editCategory(s.name, "", c, instanceNames(s))),
  }));
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
