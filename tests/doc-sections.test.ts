// The sections a document is cut into so its sticky headings can be released.
//
// The shape is what matters: a heading of a level at or above an open section's
// ENDS it, and only the sticky levels (h2, h3) open one. Asserted as a tree,
// because the failure this fixes is a heading whose block never ends.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect } from "bun:test";
import { sectionize, SECTION_CLASS } from "../src/html/doc-sections";

const build = (markup: string): Element => {
  const root = document.createElement("div");
  root.innerHTML = markup;
  return root;
};

// `h2 > p` for a section holding a paragraph; nesting shown by indentation-free
// parentheses so a whole document's shape fits on one line.
const shape = (el: Element): string =>
  [...el.children]
    .map((c) => (c.classList.contains(SECTION_CLASS) ? `(${shape(c)})` : c.tagName.toLowerCase()))
    .join(" ");

describe("cutting a flat document into sections", () => {
  it("gives the sticky heading a block that ends", () => {
    const root = build("<h1>a</h1><p>1</p><h2>b</h2><p>2</p><h3>c</h3><p>3</p><h2>d</h2><p>4</p>");
    sectionize(root);
    expect(shape(root)).toBe("h1 p (h2 p h3 p) (h2 p)");
  });

  // Only h2 sticks (styles.ts records why two levels cannot both be held), so
  // an h3 is content of its section and opens nothing of its own.
  it("leaves a subheading inside the section it was written in", () => {
    const root = build("<h2>a</h2><h3>b</h3><p>1</p><h2>c</h2><p>2</p>");
    sectionize(root);
    expect(shape(root)).toBe("(h2 h3 p) (h2 p)");
  });

  // A level at or above an open one ends it — including h1, which opens nothing
  // itself and so would otherwise leave the h2 above it running on.
  it("lets a heading of a higher level end a section", () => {
    const root = build("<h2>a</h2><p>1</p><h1>b</h1><p>2</p>");
    sectionize(root);
    expect(shape(root)).toBe("(h2 p) h1 p");
  });

  it("keeps a deeper heading inside its own section too", () => {
    const root = build("<h2>a</h2><h4>b</h4><p>1</p>");
    sectionize(root);
    expect(shape(root)).toBe("(h2 h4 p)");
  });

  it("keeps the document's own order", () => {
    const root = build("<p>1</p><h2>a</h2><p>2</p><h3>b</h3><p>3</p>");
    sectionize(root);
    expect((root.textContent ?? "").replace(/\s+/g, "")).toBe("1a2b3");
  });

  // The effect that calls this runs on every render of the body, and the body
  // is only replaced when its html changes — so a second call must not wrap
  // what is already wrapped.
  it("does nothing the second time", () => {
    const root = build("<h2>a</h2><p>1</p>");
    sectionize(root);
    const once = root.innerHTML;
    sectionize(root);
    expect(root.innerHTML).toBe(once);
  });

  it("leaves a document with no sticky heading alone", () => {
    const root = build("<p>1</p><h1>a</h1><p>2</p>");
    sectionize(root);
    expect(shape(root)).toBe("p h1 p");
  });
});
