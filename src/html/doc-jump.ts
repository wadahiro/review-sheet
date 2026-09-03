// WHERE the editor should open, read off the page rather than searched for in
// the text afterwards.
//
// The page knows it: the markdown renderer stamps every rendered block with the
// line it was written on (`data-rs-line`, markdown.ts), a table cell carries its
// column (`data-rs-cell`), and a body that renders one block at a time stamps
// the block's own first line on the container (`data-rs-base`) so the numbers
// inside it can stay relative. Matching the RENDERED text back against the
// markdown is a search, and a search over prose lands on the wrong paragraph
// often enough to be untrustworthy — a heading loses its backticks, a wrapped
// paragraph loses its newline, a common word occurs three times.
//
// A LEAF (browser APIs only), because every reader of it needs the same answer:
// the double click, the `e` key, both renderers.

// One end of a jump. `text` is the run of RENDERED text at that point — it can
// only ever move the caret inside the block the line already named, so a run
// whose markers the source spells differently leaves the landing where it was.
export type DocPoint = { line: number; cell?: number; text?: string };

// …and the jump itself: one point, or two when the reader had something
// selected. The selection is carried across so the editor opens with the same
// words highlighted — the ones somebody selected in order to change them.
export type DocJump = DocPoint & { end?: DocPoint };

// Long enough to be findable in the source, short enough to still be there
// after the markdown's own markers are taken out of it.
const RUN = 30;

const elementOf = (node: Node | null): Element | null =>
  node === null ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;

// The line and column an element sits on, in the markdown the page was drawn
// from. `null` when nothing above it says — a sheet that is not a document, or
// a page built before the renderer stamped its lines.
export function addressOf(node: Node | null): { line: number; cell?: number } | null {
  const el = elementOf(node);
  const marked = el?.closest("[data-rs-line]") ?? null;
  if (marked === null) return null;
  const own = Number(marked.getAttribute("data-rs-line"));
  if (!Number.isInteger(own) || own < 1) return null;
  // A body that renders one block at a time (a hand-maintained sheet's prose)
  // hands the renderer that block alone, so what it stamps is counted from the
  // block's first line. Absent = the whole document was rendered at once, and
  // the number is already the answer.
  const base = Number(marked.closest("[data-rs-base]")?.getAttribute("data-rs-base") ?? "");
  const line = Number.isInteger(base) && base >= 1 ? base + own - 1 : own;
  const column = el?.closest("[data-rs-cell]")?.getAttribute("data-rs-cell");
  const cell = column === null || column === undefined ? -1 : Number(column);
  return { line, ...(Number.isInteger(cell) && cell >= 0 ? { cell } : {}) };
}

// A boundary of a selection, as a NODE. In a text node the offset counts
// characters; in an element it counts CHILDREN — which is where a selection made
// by triple-clicking a heading, or dragged across a whole block, puts its ends.
// Read as characters, such a boundary addresses the container (which carries no
// line of its own) instead of the block inside it, and the keystroke did
// nothing at all — reported on a heading.
function boundary(node: Node | null, offset: number, dir: "from" | "to"): { node: Node; offset: number } | null {
  if (node === null) return null;
  if (node.nodeType !== 1) return { node, offset };
  const kids = [...node.childNodes];
  // The child the boundary sits before, or — at the closing end — the one it
  // sits after. An empty element has nothing to descend to and stays itself.
  const child = dir === "from" ? (kids[offset] ?? kids[kids.length - 1]) : (kids[offset - 1] ?? kids[0]);
  if (child === undefined) return { node, offset: 0 };
  return boundary(child, dir === "from" ? 0 : (child.textContent ?? "").length, dir);
}

// One end of a jump, from a node and an offset in it. `from` takes the run that
// FOLLOWS the point (where a landing begins), `to` the run that precedes it
// (where a selection ends).
export function pointAt(node: Node | null, offset: number, dir: "from" | "to"): DocPoint | null {
  const edge = boundary(node, offset, dir);
  const at = addressOf(edge?.node ?? node);
  if (at === null) return null;
  const whole = edge?.node.textContent ?? "";
  const here = edge?.offset ?? offset;
  const text = (dir === "from" ? whole.slice(here, here + RUN) : whole.slice(Math.max(0, here - RUN), here)).trim();
  return { ...at, ...(text === "" ? {} : { text }) };
}

// What the reader has selected, as a jump. `null` when there is no selection, or
// when it is somewhere this document cannot address.
//
// The RANGE is used rather than the anchor and focus, so a selection made
// backwards reads the same as one made forwards. A collapsed selection — a
// plain click, which is what a reader who only wants the editor opened here
// does — is one point and no end.
export function jumpFromSelection(root: Element | null): DocJump | null {
  const sel = typeof window === "undefined" ? null : window.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (root !== null && !root.contains(range.startContainer)) return null;
  const start = pointAt(range.startContainer, range.startOffset, "from");
  if (start === null) return null;
  if (range.collapsed) return start;
  const end = pointAt(range.endContainer, range.endOffset, "to");
  return end === null ? start : { ...start, end };
}
