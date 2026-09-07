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

// h2 is the one heading that sticks (styles.ts), so it is the one that needs a
// block of its own. Anything at or above an open section's level ENDS it — an
// h1 opens nothing and closes everything, which keeps an h2's section from
// running on through the next h1's territory.
const WRAPS = new Set([2]);

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
      into.appendChild(section);
      open.push({ level, el: section });
      section.appendChild(child);
    } else {
      into.appendChild(child);
    }
  }
};
