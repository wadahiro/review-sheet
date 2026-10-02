// The sections a document is cut into so its sticky headings can be released.
//
// The shape is what matters: a heading of a level at or above an open section's
// ENDS it, and only the sticky levels (h2 to h4) open one. Asserted as a tree,
// because the failure this fixes is a heading whose block never ends.
//
// The DEPTH each section carries is the other half: the band's offset and its
// painting order are computed from it (styles.ts), and it counts the sections
// that actually opened rather than heading levels — a record goes h2 -> h4 with
// no h3 between.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect } from "bun:test";
import { sectionize, SECTION_CLASS } from "../src/html/doc-sections";
import { customStyles } from "../src/html/styles";

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
    expect(shape(root)).toBe("h1 p (h2 p (h3 p)) (h2 p)");
  });

  // A SUBHEADING holds too, so it gets a block of its own — and it ends where
  // its own subsection does, not where the section around it does.
  it("gives a subheading a block of its own", () => {
    const root = build("<h2>a</h2><h3>b</h3><p>1</p><h2>c</h2><p>2</p>");
    sectionize(root);
    expect(shape(root)).toBe("(h2 (h3 p)) (h2 p)");
  });

  // A record's own shape: the unit's heading, the sheet's heading one level
  // further in with nothing between, and a table of several screens under it.
  it("holds a deeper heading that skips a level", () => {
    const root = build("<h2>a</h2><h4>b</h4><table></table><h4>c</h4><p>1</p>");
    sectionize(root);
    expect(shape(root)).toBe("(h2 (h4 table) (h4 p))");
  });

  // …and that is why the depth is counted over the SECTIONS: read off the tag
  // name, this h4 would be depth 3 and its band would be held a whole band
  // below the one above it, with a gap nothing fills.
  it("counts the depth over the sections that opened", () => {
    const root = build("<h2>a</h2><h4>b</h4><p>1</p>");
    sectionize(root);
    const depths = [...root.querySelectorAll("section")].map((el) => el.getAttribute("style"));
    expect(depths).toEqual(["--rs-doc-depth: 1", "--rs-doc-depth: 2"]);
  });

  it("starts the next section's count again", () => {
    const root = build("<h2>a</h2><h3>b</h3><h2>c</h2>");
    sectionize(root);
    const depths = [...root.querySelectorAll("section")].map((el) => el.getAttribute("style"));
    expect(depths).toEqual(["--rs-doc-depth: 1", "--rs-doc-depth: 2", "--rs-doc-depth: 1"]);
  });

  // A level at or above an open one ends it — including h1, which opens nothing
  // itself and so would otherwise leave the h2 above it running on.
  it("lets a heading of a higher level end a section", () => {
    const root = build("<h2>a</h2><p>1</p><h1>b</h1><p>2</p>");
    sectionize(root);
    expect(shape(root)).toBe("(h2 p) h1 p");
  });

  // Past the levels that hold, a heading is content of the section it was
  // written in: three bands is as much of the viewport as this spends.
  it("leaves a heading below the holding levels where it was written", () => {
    const root = build("<h2>a</h2><h5>b</h5><p>1</p>");
    sectionize(root);
    expect(shape(root)).toBe("(h2 h5 p)");
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

// THE TWO FILES HOLDING ONE MECHANISM, pinned to each other.
//
// The wrapping is here and the band that stands on it is in styles.ts, and
// neither can see the other: a level added to `WRAPS` with no rule for it gets a
// block and no band (nothing holds, and nothing says so), while the offset reads
// a custom property through `var(..., 1)` — which falls back silently, so the
// stylesheet's own "nobody defines this" check cannot see a rename either.
describe("the sections and the bands that stand on them", () => {
  // Which levels open a section is asked of the wrapper itself rather than
  // restated, so this cannot agree with a stale copy of the list.
  const wrapped = (): string[] => {
    const root = build([2, 3, 4, 5, 6].map((n) => `<h${n}>h</h${n}><p>x</p>`).join(""));
    sectionize(root);
    const out: string[] = [];
    for (const el of root.querySelectorAll("section")) {
      const head = el.firstElementChild;
      if (head !== null) out.push(head.tagName.toLowerCase());
    }
    return out;
  };

  const stickyRules = (): { selector: string; body: string }[] =>
    [...customStyles.matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter((m) => /position:\s*sticky/.test(m[2]!))
      .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));

  it("gives every level that opens a section a band of its own", () => {
    const rules = stickyRules();
    const unheld = wrapped().filter((tag) => !rules.some((r) => r.selector.includes(`.rs-doc-section > ${tag}:first-child`)));
    expect(unheld).toEqual([]);
  });

  // The offset and the painting order are computed from the depth this file
  // writes, under the name it writes it under.
  it("reads the depth under the name the section carries", () => {
    const root = build("<h2>a</h2><p>1</p>");
    sectionize(root);
    const name = (root.querySelector("section")!.getAttribute("style") ?? "").split(":")[0]!.trim();
    const band = stickyRules().find((r) => r.selector.includes(".rs-doc-section > h2:first-child"))!;
    expect(band.body).toContain(`var(${name},`);
    expect(band.body).toMatch(new RegExp(`z-index:[^;]*${name.replace(/[-]/g, "\\-")}`));
  });
});

// THE TABLE HEADER STANDS ON THE SAME STACK.
//
// It sticks under whatever the page already holds at the top, which used to be
// one heading whose height the viewer measured. With two bands above it the
// measured offset put it behind the second one — on screen, a header that had
// simply stopped sticking. So it is computed from the same two things the bands
// are: the depth its section carries, and the one band height.
describe("a document table's own header", () => {
  const ruleFor = (needle: string): string => {
    const found = [...customStyles.matchAll(/([^{}]+)\{([^}]*)\}/g)].find(
      (m) => m[1]!.includes(needle) && /position:\s*sticky|top:/.test(m[2]!)
    );
    return found?.[2] ?? "";
  };
  // The offset alone, which is the claim — the two rules differ in everything
  // else (one is a cell, the other the box lifted out of the scroller).
  const offset = (needle: string): string => /top:([^;]*);/.exec(ruleFor(needle))?.[1]?.trim() ?? "";

  it("stands under one band per section it is inside", () => {
    const head = offset(".rs-doc .rs-table-wrapper:not(.rs-overflowing) thead th");
    expect(head).toContain("var(--rs-doc-depth, 0)");
    expect(head).toContain("var(--rs-cat-h)");
  });

  // The header lifted out of a table too wide to fit is the same header; an
  // offset that agreed with the other one only by being written twice is one
  // that will stop agreeing.
  it("lifts the wide table's header to the same place", () => {
    expect(offset(".rs-doc .rs-doc-sticky-head")).toBe(offset(".rs-doc .rs-table-wrapper:not(.rs-overflowing) thead th"));
    expect(offset(".rs-doc .rs-doc-sticky-head")).not.toBe("");
  });

  // The band height the offset multiplies has to be the band's OWN height.
  it("multiplies the height the bands actually have", () => {
    const band = [...customStyles.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((m) =>
      m[1]!.includes(".rs-doc-section > h2:first-child") && /position:\s*sticky/.test(m[2]!)
    );
    expect(band?.[2]).toContain("height: var(--rs-cat-h)");
  });
});
