// Sections, cut into a rendered document by the viewer.
//
// A document's headings STICK while their section is being read (styles.ts's
// .rs-doc h2/h3) — and a sticky element is released by the end of its
// containing block, which in a flat run of markdown is the whole document. So
// nothing was ever released: measured on a real page, six h2 headings were
// stuck at one offset with only the last of them visible, and an h3 from a
// section that had ended thousands of pixels earlier stayed pinned under
// whatever was being read.
//
// Cutting the flat run into nested sections gives each heading a containing
// block that ENDS, which is the whole mechanism — no script measures anything
// or listens to a scroll.
//
// Done to the rendered DOM rather than by the renderer, for the same reason the
// edit buttons are (app.ts): what a renderer produces travels back into the .md
// file an edit is written to, and a wrapper this page needs in order to lay
// itself out is not part of anybody's document.

const LEVEL = /^H([1-6])$/;

// The levels that STICK (styles.ts) are the ones that need a block of their
// own. Anything at or above an open section's level ENDS it — an h1 opens
// nothing and closes everything, which keeps an h2's section from running on
// through the next h1's territory.
//
// h2 alone at first, because two levels held at two offsets CROSS: both are
// released by the same edge when a subsection is the last thing in its section,
// and the lower one starts moving first. What was missing was not an offset but
// a PAINTING ORDER — the deeper band has to pass UNDER the shallower one, which
// is what the parameter sheet's own stacked category headings have always done
// (`.rs-category-header`'s descending z-index). With that, the levels a record
// is actually built of can hold: a unit heading over a sheet heading over a
// table of several screens, where before only the outermost stayed and the
// reader lost which item table they were in.
//
// Stops at h4, deliberately: three bands is already a sixth of a laptop's
// viewport, and h5/h6 inside a record are a step within a table's prose rather
// than a section anybody scrolls through.
const WRAPS = new Set([2, 3, 4]);

// HOW DEEP the band sits, counted over the sections that actually opened rather
// than over heading levels — a record goes h2 -> h4 with no h3 between (the
// sheet headings sit one level under the unit's, and markdown's levels are the
// document's own business), so a depth read off the tag name would leave a gap
// in the stack and hold the second band a whole band lower than the first.
// Read by styles.ts for both the offset and the painting order.
const DEPTH_VAR = "--rs-doc-depth";

export const SECTION_CLASS = "rs-doc-section";
const DONE = "data-rs-sectioned";

const levelOf = (el: Element): number => Number(LEVEL.exec(el.tagName)?.[1] ?? 0);

export const sectionize = (root: Element): void => {
  if (root.getAttribute(DONE) !== null) return;
  root.setAttribute(DONE, "");
  const open: { level: number; el: Element }[] = [];
  // A snapshot, because every child is about to be moved: appended in the order
  // it is read, so the document reads exactly as it did before.
  for (const child of [...root.children]) {
    const level = levelOf(child);
    while (open.length > 0 && level > 0 && open[open.length - 1]!.level >= level) open.pop();
    const into = open[open.length - 1]?.el ?? root;
    if (WRAPS.has(level)) {
      const section = root.ownerDocument.createElement("section");
      section.className = SECTION_CLASS;
      // Set on the SECTION and inherited by its heading, so a nested section
      // overrides it for its own.
      section.setAttribute("style", `${DEPTH_VAR}: ${open.length + 1}`);
      into.appendChild(section);
      open.push({ level, el: section });
      section.appendChild(child);
    } else {
      into.appendChild(child);
    }
  }
};
