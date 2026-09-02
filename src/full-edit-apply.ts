// Reading back a sheet that was handed over as markdown.
//
// The browser side of full-edit mode deliberately maps nothing: what the
// recipient edits is text, and forcing every keystroke through a model is what
// constrained the earlier attempt. The mapping happens HERE instead — in the
// repository, at apply time, where the model and its source maps still are —
// and it is a HINT, not a contract: whatever lines up becomes an ordinary value
// edit and is applied deterministically, and whatever does not is reported as
// the diff it is, for a person or an AI to act on.
//
// Nothing is refused and nothing is dropped: the two halves together are the
// whole change, and the second half is text, which can carry anything.

import type { SheetData, ReviewItem, CategoryData, ParamData } from "./prompt.js";
import { markdownChangeReport, type MarkdownChange } from "./markdown-changes.js";
import { DOCUMENT_FIELD, isEdit, sortEdits } from "./edits.js";
import type { Lang } from "./html/i18n.js";

// A row, as this document addresses it: the heading path it is under, and the
// chain of key cells that leads to it (`Service` then `Restart`). The chain is
// what a reader sees, and it is what makes the row findable again after an
// edit — the model's own key (`Service.Restart`, or an address with a predicate
// inside it) is not written in the document at all.
type RowAddress = { path: string[]; chain: string[] };

const addressKey = (a: RowAddress): string => `${a.path.join("/")} ${a.chain.join(".")}`;

// The last identity-bearing segment of a container's address: `Directory` for
// `Directory["/var/www"]`, `Service` for `Service`. A document names a block by
// what KIND of block it is, which is what the sheet's key column shows.
const leafOfPath = (path: string): string => {
  const last = path.split(".").pop() ?? path;
  return last.replace(/\[.*\]$/, "");
};

const leafOf = (p: ParamData): string => {
  if (p.container) return p.container.name ?? p.key;
  const parent = (p.container_path ?? [])[(p.container_path ?? []).length - 1];
  const key = p.key.startsWith("@") ? p.key.slice(1) : p.key;
  return parent && key.startsWith(`${parent.path}.`) ? key.slice(parent.path.length + 1) : key;
};

// The model's rows, each under the address the document knows it by.
export function modelRowIndex(
  sheet: SheetData["sheets"][number]
): Map<string, { category: string; key: string; param: ParamData }> {
  const out = new Map<string, { category: string; key: string; param: ParamData }>();
  const walk = (cats: CategoryData[] | undefined, path: string[]): void => {
    for (const c of cats ?? []) {
      const here = [...path, c.name];
      for (const p of c.params ?? []) {
        const chain = [...(p.container_path ?? []).map((b) => leafOfPath(b.path)), leafOf(p)];
        out.set(addressKey({ path: here, chain }), { category: here.join("/"), key: p.key, param: p });
      }
      walk(c.categories, here);
    }
  };
  walk(sheet.categories, []);
  return out;
}

export type FullEditChange = {
  sheet: string;
  // Row-level changes that resolved to a row of the model, ready for the
  // ordinary source-mapped apply.
  edits: ReviewItem[];
  // Everything else, as statements rather than as a diff — see
  // `markdown-changes.ts` for why the reader of this is better served by
  // "this cell, this column, these two values" than by two reprinted lines.
  residue: MarkdownChange[];
  // Changed text no statement covered. Empty on every document these rules
  // cover; shown when it is not, because a report that omits what it could not
  // name is worse than a long one.
  unaccounted: string;
};

let counter = 0;
const nextId = (at: string): string => `fe_${at.replace(/[^0-9]/g, "")}_${++counter}`;

// A shared row holds ONE value shown in every column; naming an environment on
// it would ask apply to split the row, which is a structural change and not
// what typing over the value in a document says.
const isShared = (p: ParamData): boolean => !(p.instances && p.instances.length > 0);

// What one edited sheet asks for. `before` is the document as it was HANDED
// OVER (the first edit's own `current`), never a fresh render of the model: the
// repository may have moved since delivery, and the reviewer edited what they
// were given.
export function fullEditChanges(
  sheet: SheetData["sheets"][number],
  before: string,
  after: string,
  lang: Lang,
  at: string
): FullEditChange {
  const instances = sheet.instances ?? [];
  const cols = instances.length > 0 ? instances : [""];
  const model = modelRowIndex(sheet);
  const report = markdownChangeReport(before, after, instances, lang);
  const edits: ReviewItem[] = [];
  const residue: MarkdownChange[] = [];

  // A value cell of a row the model still has is the one thing that can be
  // written back deterministically. Everything else — a row added, a section
  // written, a description, a column — is a decision, and decisions are
  // reported.
  const valueChanges = new Map<string, { row: RowAddress; column: string; before: string; after: string }[]>();
  for (const c of report.changes) {
    if (c.kind !== "cell" || !cols.includes(c.column)) {
      residue.push(c);
      continue;
    }
    const key = addressKey(c.row);
    valueChanges.set(key, [...(valueChanges.get(key) ?? []), { row: c.row, column: c.column, before: c.before, after: c.after }]);
  }

  for (const [key, changed] of valueChanges) {
    const target = model.get(key);
    if (target === undefined) {
      // The document says a value moved on a row the model does not have — the
      // reader will have to place it themselves.
      residue.push(...changed.map((c) => ({ kind: "cell" as const, row: c.row, column: c.column, before: c.before, after: c.after })));
      continue;
    }
    const shared = isShared(target.param);
    // A shared row is ONE value in every column. Changing one of them asks for
    // a line that does not exist yet — a structural change no source map can
    // make — so it is reported rather than applied to the shared line, which
    // would move every environment at once.
    if (shared && changed.length !== cols.length) {
      residue.push(...changed.map((c) => ({ kind: "cell" as const, row: c.row, column: c.column, before: c.before, after: c.after })));
      continue;
    }
    if (shared && new Set(changed.map((c) => c.after)).size !== 1) {
      residue.push(...changed.map((c) => ({ kind: "cell" as const, row: c.row, column: c.column, before: c.before, after: c.after })));
      continue;
    }
    for (const c of changed) {
      edits.push({
        id: nextId(at),
        target: {
          sheet: sheet.name,
          category: target.category,
          param: target.key,
          ...(instances.length > 0 && !shared ? { instance: c.column } : {}),
          field: "value",
        },
        changes: [{ field: "value", current: c.before, suggested: c.after }],
        status: "applied",
        at,
      } as ReviewItem);
      // One shared value moved is ONE change, however many columns show it.
      if (shared) break;
    }
  }

  return { sheet: sheet.name, edits, residue, unaccounted: report.unaccounted };
}

// The document edits in a returned sheet, per sheet: what it looked like when it
// was handed over, and what it says now. A page edited three times is ONE
// change — the same collapse `planFromEdits` does for a cell.
export function documentEditRange(reviews: ReviewItem[]): Map<string, { before: string; after: string }> {
  const out = new Map<string, { before: string; after: string }>();
  for (const r of sortEdits(reviews)) {
    if (!isEdit(r) || r.target.param !== undefined || (r.target.field ?? "") !== DOCUMENT_FIELD) continue;
    const change = r.changes?.find((c) => c.field === DOCUMENT_FIELD);
    if (change === undefined) continue;
    const seen = out.get(r.target.sheet);
    out.set(r.target.sheet, { before: seen?.before ?? change.current ?? "", after: change.suggested });
  }
  return out;
}
