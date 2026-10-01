// WHO CITES THIS LINE — the inverse of the link a record carries.
//
// An observed document is reached from a verdict and from nowhere else, which
// is the one direction this tool has ever supported. Read from the other end
// that leaves a real question unanswered: a reader partway down a 5,000-line
// plan wants to know whether the line in front of them is one some test item
// was decided on, and which.
//
// NOT by giving the document's lines keys. A `key` on a line asserts "this line
// IS that row's value", and the no-keys invariant exists precisely so a row can
// never route to an observed copy of a file (evidence.ts, app.ts) — restoring
// one would bring back the wrong-document link those two guards stop. A
// CITATION is a different fact: it says a verdict pointed here, which is what
// the delivery already records, and it is naturally many-to-many where a key is
// one-to-one. So the many-citers case the request worried about needs no
// special handling; it is the shape.
//
// Built from the MODEL rather than from the rendered page: a document may be
// cited by a sheet the reader does not have open, and on one real delivery 498
// citations reach 30 documents, one of them on 175 separate lines.

import { paramAnchorId } from "./anchors.js";
import { EVIDENCE_SCHEME } from "../evidence.js";

export type Citation = {
  // Which sheet holds the citing row, and where in the document it is — the
  // same two things a jump needs, in the same spellings `resolveNavTarget`
  // already resolves: `rs-doc-line:<n>:<line>` for a block of prose, a row's
  // own DOM id for a sheet's table.
  sheet: string;
  sheetIndex: number;
  address: string;
  // What to call it where a reader has to choose between several. The item as
  // the record prints it, or the row's key — never the address, which is
  // machinery.
  label: string;
};

// Keyed by document AND line, since a verdict cites a line and not a file: the
// whole point is to answer for the line in front of the reader.
export type CitationIndex = ReadonlyMap<string, Citation[]>;

export const citationKey = (id: string, line: number | undefined): string => (line === undefined ? id : `${id}#L${line}`);

const REF = new RegExp(`${EVIDENCE_SCHEME}([^"'\\s)]+)`, "g");

// The reference as it was written, back to the document and line it names.
// `#L<n>` is appended by `evidenceCell`, and the id itself may hold anything a
// command does — so the line is taken off the END and the rest is the id.
function refOf(raw: string): { id: string; line?: number } {
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // A malformed escape is left as written: it will match no document, which is
    // the same answer as a citation naming something this delivery does not
    // carry.
  }
  const at = /^(.*)#L(\d+)$/.exec(text);
  if (at === null) return { id: text };
  return { id: at[1]!, line: Number(at[2]) };
}

const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// A RECORD'S OWN ROWS. Our table renderer stamps `data-rs-line` on every `<tr>`
// (markdown.ts), so the citing row is addressable — and the first two cells are
// the number and the item, which is how the record itself names the thing.
function fromDocument(html: string, sheet: string, sheetIndex: number, add: (ref: string, c: Citation) => void): void {
  for (const row of html.split(/<tr\b/i).slice(1)) {
    const at = /^[^>]*\bdata-rs-line="(\d+)"/i.exec(row);
    const refs = [...row.matchAll(REF)].map((m) => m[1]!);
    if (refs.length === 0) continue;
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => textOf(m[1]!));
    // The number and the item, which is what a reader recognises. A row with
    // neither falls back to the sheet's own name rather than to nothing.
    const label = cells.slice(0, 2).filter((x) => x !== "").join(" ") || sheet;
    // A row our own renderer did not stamp cannot be jumped to; the citation is
    // still worth knowing about, so it is kept and points at the sheet.
    const address = at === null ? `rs-doc-line:${sheetIndex}:1` : `rs-doc-line:${sheetIndex}:${at[1]}`;
    for (const ref of refs) add(ref, { sheet, sheetIndex, address, label: label.slice(0, 120) });
  }
}

type Cat = { name: string; params?: { key: string; [k: string]: unknown }[]; categories?: Cat[] };

// …AND AN ORDINARY VALUE SHEET'S CELLS, which cite evidence too: a judge
// answering a row from a collected document fills the verdict with a command
// and a line, and the cell is written as the same link. Its row is addressed by
// id rather than by line, which is the one difference.
function fromCategories(cats: Cat[] | undefined, path: string[], sheet: string, sheetIndex: number, add: (ref: string, c: Citation) => void): void {
  for (const c of cats ?? []) {
    const here = [...path, c.name];
    for (const p of c.params ?? []) {
      const refs = [...JSON.stringify(p).matchAll(REF)].map((m) => m[1]!);
      if (refs.length === 0) continue;
      // JSON-escaped, so a reference inside a cell arrives with its quotes and
      // backslashes doubled; only the escape of a quote can appear inside one.
      for (const ref of refs) {
        add(ref.replace(/\\"/g, '"'), {
          sheet,
          sheetIndex,
          address: paramAnchorId(sheetIndex, here.join(" / "), p.key),
          label: p.key,
        });
      }
    }
    fromCategories(c.categories, here, sheet, sheetIndex, add);
  }
}

export function buildCitationIndex(
  sheets: readonly { name: string; document?: { html?: string }; categories?: Cat[] }[]
): CitationIndex {
  const out = new Map<string, Citation[]>();
  const add = (ref: string, c: Citation): void => {
    const { id, line } = refOf(ref);
    const key = citationKey(id, line);
    const held = out.get(key);
    // The SAME row citing the same line twice is one citation: a record prints
    // every host that answered in one cell, and a reader choosing where to go
    // must not be offered the same place twice.
    if (held === undefined) out.set(key, [c]);
    else if (!held.some((x) => x.address === c.address && x.sheetIndex === c.sheetIndex)) held.push(c);
  };
  sheets.forEach((s, i) => {
    fromDocument(s.document?.html ?? "", s.name, i, add);
    fromCategories(s.categories, [], s.name, i, add);
  });
  return out;
}
