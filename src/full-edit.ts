// The sheet, handed over as a document somebody maintains by hand.
//
// A generated sheet is a VIEW of a model: the model decides what a row is, and
// every edit has to become something the model can hold. That is right while a
// sheet is being reviewed — it is what makes a change deterministic, verifiable
// and applicable — and it is the wrong trade the moment the sheet is delivered
// and its recipient is the one maintaining it. What they will want to change
// cannot be specified in advance, so the artifact has to be text.
//
// So in full-edit mode the markdown IS the model. Each sheet is rendered once,
// in one language, and that text is what the page shows, what the editor edits
// and what travels back. Nothing is projected back into a model in the browser;
// the mapping happens at APPLY time, in the repository, where the model and its
// source maps still are — and there it is a best-effort hint rather than a
// mapping that must account for everything, which is what made the earlier
// browser-side attempt constrain the editing it was meant to enable.
//
// What this costs is stated in the design notes and not hidden: a sheet with no
// model behind it has no per-cell review target, no origin, and no dictionary.
// What it buys is that anything a person can write, they can write.

import type { ParameterSheetInput, Sheet, Category, VersionedSheetInput } from "./types.js";
import type { SheetData } from "./prompt.js";
import { toMarkdownSheet, renderSheetMarkdown } from "./sheet-markdown.js";
import { modelRowIndex } from "./full-edit-apply.js";
import type { Lang } from "./html/i18n.js";

// One sheet's rows, as the text a person maintains. Written with the projection
// options full-edit mode needs: the parent/child indent a paper sheet has, and
// an empty value cell for a row nobody set (see `ProjectionOptions`).
export function sheetToMarkdown(sheet: Sheet, lang: Lang): string {
  return renderSheetMarkdown(
    toMarkdownSheet(sheet as unknown as SheetData["sheets"][number], lang, { indent: true, markUnset: true })
  );
}

// A sheet whose categories are gone and whose text is everything. `document`
// carries it, because that is already the shape this project uses for "a sheet
// whose content is markdown" — the editor, the history, the save and apply's
// held-document path all key off it, and none of them needed changing.
//
// `mode: "sheet"` is what tells the viewer to render the tables as the sheet's
// own tables rather than as prose: same columns, same indent, same look.
function convertSheet(sheet: Sheet, lang: Lang): Sheet {
  if (sheet.document) return sheet; // already a document — a `recipe: document` page
  const hasRows = (cats: Category[] | undefined): boolean =>
    (cats ?? []).some((c) => (c.params ?? []).length > 0 || hasRows(c.categories));
  if (!hasRows(sheet.categories)) return sheet;
  const markdown = sheetToMarkdown(sheet, lang);
  // Which model row each document row came from. Kept so the preview panel
  // still opens from a row — see `SheetDocument.row_keys`. Written once, here,
  // where both are in hand.
  const rowKeys: Record<string, string> = {};
  for (const [address, row] of modelRowIndex(sheet as unknown as SheetData["sheets"][number])) {
    rowKeys[address] = row.key;
  }
  return {
    ...sheet,
    categories: [],
    document: { html: "", markdown, mode: "sheet", row_keys: rowKeys },
  };
}

export function toFullEditInput<T extends ParameterSheetInput | VersionedSheetInput>(input: T, lang: Lang): T {
  if ("versions" in input) {
    return {
      ...input,
      versions: input.versions.map((v) => ({ ...v, sheets: v.sheets.map((s) => convertSheet(s, lang)) })),
    };
  }
  return { ...input, sheets: input.sheets.map((s) => convertSheet(s, lang)) };
}
