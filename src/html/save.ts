// Writing the document back out with its edits in it.
//
// The generated HTML is the only place the maintainer's values live — they have
// no pipeline to re-run — so "save" has to produce a file that is still the
// whole document: same sheets, same styles, same app, plus the edit history.
// The page rewrites itself: the pristine markup is captured before the app
// touches the DOM, and saving is that markup with one <script> block swapped.
//
// Everything here is string in / string out except the download itself, so the
// part that can silently corrupt someone's document is testable.

import type { ReviewItem, SaveRecord } from "../prompt.js";

export const REVIEWS_SCRIPT_ID = "sheet-reviews";

// JSON inside <script> must not be able to close the tag. A recipient typing
// "</script>" into a remarks field would otherwise truncate the document at
// exactly the point where its own data starts.
export function embedJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

// What a saved document carries: the entries themselves, and one record per
// save — who wrote it and why.
export type EmbeddedHistory = { reviews: ReviewItem[]; saves: SaveRecord[] };

export const EMPTY_HISTORY: EmbeddedHistory = { reviews: [], saves: [] };

// Accepts the bare array the first version of this feature wrote, so a document
// saved by it keeps its history when opened by a later build. Dropping those
// entries would be the exact failure this whole design is about.
export function parseHistory(text: string): EmbeddedHistory {
  const body = text.trim();
  if (!body) return EMPTY_HISTORY;
  const parsed: unknown = JSON.parse(body);
  if (Array.isArray(parsed)) return { reviews: parsed as ReviewItem[], saves: [] };
  if (parsed !== null && typeof parsed === "object") {
    const o = parsed as { reviews?: unknown; saves?: unknown };
    return {
      reviews: Array.isArray(o.reviews) ? (o.reviews as ReviewItem[]) : [],
      saves: Array.isArray(o.saves) ? (o.saves as SaveRecord[]) : [],
    };
  }
  return EMPTY_HISTORY;
}

export function readEmbeddedHistory(doc: Document): EmbeddedHistory {
  const el = doc.getElementById(REVIEWS_SCRIPT_ID);
  if (!el) return EMPTY_HISTORY;
  try {
    return parseHistory(el.textContent ?? "");
  } catch {
    return EMPTY_HISTORY;
  }
}

export const REVIEWS_OPEN_TAG = `<script type="application/json" id="${REVIEWS_SCRIPT_ID}">`;

// Produce the file to write: `pristine` (the markup as loaded) with the history
// block swapped. Two indexOf calls and a concat — NOT a parse.
//
// It used to go through DOMParser, on the grounds that a regex rewrite could be
// broken by a "</script>" in the data or an attribute the browser reordered.
// Neither applies here: the exact opening tag is matched (it is emitted by
// generate.ts, so there is nothing to reorder), and the block it delimits
// cannot contain "</script>" because embedJson escapes every "<". What DID
// apply was the cost — parsing and re-serialising a 400 KB document on the main
// thread, which froze the page before the save dialog could even open.
//
// Ordering makes the tag match safe: the history block is written BEFORE the
// application bundle, so even if the bundle contained this literal, the first
// hit is the real one.
export function withEmbeddedHistory(pristine: string, history: EmbeddedHistory): string {
  const body = "\n" + embedJson(history) + "\n";
  const open = pristine.indexOf(REVIEWS_OPEN_TAG);
  if (open >= 0) {
    const start = open + REVIEWS_OPEN_TAG.length;
    const close = pristine.indexOf("</script>", start);
    if (close >= 0) return pristine.slice(0, start) + body + pristine.slice(close);
  }
  // A document generated without --allow edit has no slot. Rather than refuse,
  // add one: a lost history is the worse outcome.
  const block = `${REVIEWS_OPEN_TAG}${body}</script>\n`;
  const endBody = pristine.lastIndexOf("</body>");
  return endBody >= 0 ? pristine.slice(0, endBody) + block + pristine.slice(endBody) : pristine + block;
}

// "sheet.html" -> "sheet.html"; a path or a URL -> its last segment. Falls back
// to a neutral name when the document was not loaded from a file.
export function suggestedFileName(href: string, fallback: string): string {
  const path = href.split(/[?#]/)[0];
  const last = decodeURIComponent(path.split("/").pop() ?? "");
  return /\.html?$/i.test(last) ? last : fallback;
}
