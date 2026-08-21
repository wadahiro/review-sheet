// The markdown core (src/markdown.ts): the part of a document sheet that has
// no I/O — headings out, images in, and the line between markup a project
// writes and markup that would reach the rest of the page.

import { describe, it, expect } from "bun:test";
import { renderMarkdown, imageRefs, type ImageResolver } from "../src/markdown";

const noImages: ImageResolver = () => null;
const oneRedDot: ImageResolver = (href) =>
  href === "img/diagram.png" ? { mime: "image/png", base64: "AAAA" } : null;

describe("markdown: headings and the outline", () => {
  // No leading h1 in this fixture: a document's title is not an outline entry
  // at all (see "the document's own title" below), and mixing that rule in here
  // would be testing two things at once.
  it("lists headings down to the declared depth, and no deeper", () => {
    const md = "## B\n\n### C\n\n#### D\n";
    expect(renderMarkdown(md, noImages, { navDepth: 3 }).headings.map((h) => h.text)).toEqual(["B", "C"]);
    expect(renderMarkdown(md, noImages, { navDepth: 2 }).headings.map((h) => h.text)).toEqual(["B"]);
    expect(renderMarkdown(md, noImages, { navDepth: 0 }).headings).toEqual([]);
  });

  it("anchors EVERY heading, including the ones the outline skips", () => {
    // Search can land on a heading the outline chose not to show; without an
    // id that jump goes nowhere. (The document's TITLE is a different case: it
    // is not rendered at all — see "the document's own title" below.)
    const { html } = renderMarkdown("## A\n\n#### D\n", noImages, { navDepth: 2 });
    expect(html).toContain('<h2 id="rs-doc-A">');
    expect(html).toContain('<h4 id="rs-doc-D">');
  });

  it("keeps a Japanese heading's own text in its id", () => {
    const { headings } = renderMarkdown("## 移行方針\n", noImages);
    expect(headings[0].id).toBe("rs-doc-移行方針");
  });

  it("gives two headings of the same name two ids", () => {
    // Both are on the page, so an outline that pointed both entries at one
    // anchor would send half its clicks to the wrong place.
    const { headings } = renderMarkdown("## 前提\n\n### x\n\n## 前提\n", noImages, { navDepth: 2 });
    expect(headings.map((h) => h.id)).toEqual(["rs-doc-前提", "rs-doc-前提-2"]);
  });

  it("names a heading by its text, not by its markup", () => {
    const { headings } = renderMarkdown("## `http-port` の変更\n", noImages);
    expect(headings[0].text).toBe("http-port の変更");
  });

  it("still anchors a heading made only of punctuation", () => {
    const { headings } = renderMarkdown("## ---\n\n### ???\n", noImages, { navDepth: 3 });
    expect(headings.map((h) => h.id)).toEqual(["rs-doc-h1", "rs-doc-h2"]);
  });
});

describe("markdown: images become bytes", () => {
  it("inlines a markdown image as a data URI", () => {
    const { html } = renderMarkdown("![構成](img/diagram.png)", oneRedDot);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('alt="構成"');
  });

  it("inlines a raw <img> too", () => {
    const { html } = renderMarkdown('<img src="img/diagram.png" alt="x" width="200">', oneRedDot);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain('width="200"');
  });

  it("leaves an already-inline data: URI alone", () => {
    const { html } = renderMarkdown("![x](data:image/gif;base64,ZZ)", noImages);
    expect(html).toContain('src="data:image/gif;base64,ZZ"');
  });

  it("drops a raw <img> the resolver cannot embed, rather than shipping a broken link", () => {
    // The recipe fails the build before this is ever reached; the core still
    // must not emit a tag that would fetch over the network when opened.
    const { html } = renderMarkdown('<img src="https://example.com/x.png">', noImages);
    expect(html).not.toContain("https://example.com/x.png\"");
    expect(html).toContain("&lt;img");
  });

  it("reports every image it needs, raw tags included, before anything renders", () => {
    const md = "![a](one.png)\n\n<img src='two.png'>\n\n![b](one.png)\n\n![c](data:image/gif;base64,ZZ)";
    expect(imageRefs(md)).toEqual(["one.png", "two.png"]);
  });
});

describe("markdown: raw HTML is display-only", () => {
  it("keeps a line break in a table cell", () => {
    // The reason raw HTML is not simply escaped: GFM has no other way to write
    // one, and these documents are full of tables.
    const { html } = renderMarkdown("| a |\n|---|\n| x<br>y |\n", noImages);
    expect(html).toContain("x<br>y");
  });

  it("keeps a details/summary block", () => {
    const { html } = renderMarkdown("<details>\n<summary>補足</summary>\nz\n</details>\n", noImages);
    expect(html).toContain("<details>");
    expect(html).toContain("<summary>");
  });

  it("escapes a script tag instead of running it", () => {
    const { html } = renderMarkdown("<script>alert(1)</script>\n", noImages);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a tag that could lay itself over the page", () => {
    const { html } = renderMarkdown('<div style="position:fixed">x</div>\n', noImages);
    expect(html).not.toContain("<div");
    expect(html).toContain("&lt;div");
  });

  it("drops id, class and style from a tag it does keep", () => {
    // `id` above all: a document is not allowed to collide with a nav anchor.
    const { html } = renderMarkdown('<kbd id="rs-doc-A" class="x" style="color:red">Esc</kbd>\n', noImages);
    expect(html).toContain("<kbd>Esc</kbd>");
    expect(html).not.toContain("rs-doc-A");
  });

  it("drops an event handler from a tag it does keep", () => {
    const { html } = renderMarkdown('<img src="img/diagram.png" onerror="alert(1)">\n', oneRedDot);
    expect(html).not.toContain("onerror");
    expect(html).toContain("data:image/png;base64,AAAA");
  });

  it("refuses a javascript: src", () => {
    const { html } = renderMarkdown('<img src="javascript:alert(1)">\n', noImages);
    expect(html).not.toContain("javascript:alert(1)\"");
    expect(html).toContain("&lt;img");
  });
});

describe("markdown: GFM", () => {
  it("renders a table", () => {
    const { html } = renderMarkdown("| キー | 旧 |\n|---|---|\n| http-port | 8080 |\n", noImages);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>キー</th>");
  });

  it("renders a fenced code block without treating it as markup", () => {
    const { html } = renderMarkdown("```yaml\nfoo: <bar>\n```\n", noImages);
    expect(html).toContain("<pre>");
    expect(html).toContain("&lt;bar&gt;");
  });
});

// A source line break between two Japanese characters is not a space. Markdown
// folds a single newline into one, which is right for English and wrong here:
// Japanese does not separate words that way, so the fold drops a gap into the
// middle of a sentence at whatever column the author's editor wrapped.
describe("markdown: a wrapped Japanese paragraph", () => {
  const noImages: ImageResolver = () => null;

  it("does not gain a space where the source wrapped", () => {
    const { html } = renderMarkdown("ここに無いパスは\n「触っていない」という意味で読むこと。\n", noImages);
    expect(html).toContain("ここに無いパスは「触っていない」という意味で読むこと。");
  });

  it("folds every break in the paragraph, not every other one", () => {
    // A naive replace consumes the character after the newline, so the next
    // break has nothing to match against and survives.
    const { html } = renderMarkdown("あ\nい\nう\nえ\n", noImages);
    expect(html).toContain("<p>あいうえ</p>");
  });

  it("keeps the break — and so the space — between Japanese and a Latin word", () => {
    // A Latin word set against Japanese does want one. The newline survives
    // into the HTML, which is how it becomes a space when the page renders.
    const { html } = renderMarkdown("並べたもの。\nOS が持つものは載せていない。\n", noImages);
    expect(html).toContain("並べたもの。\nOS が持つものは載せていない。");
  });

  it("still separates English words wrapped across lines", () => {
    const { html } = renderMarkdown("the files this\nrepository replaces\n", noImages);
    expect(html).toContain("the files this\nrepository replaces");
  });

  it("leaves a fenced block's own line breaks alone", () => {
    // A directory tree is the common case, and it is only a tree because of
    // where its lines end.
    const { html } = renderMarkdown("```\n├── 設定/\n│   └── ファイル\n```\n", noImages);
    expect(html).toContain("├── 設定/\n│   └── ファイル");
  });

  it("keeps a hard break where the author asked for one", () => {
    // Two trailing spaces is markdown's own way to say "break here"; folding
    // that away would take away the one way to ask.
    const { html } = renderMarkdown("一行目  \n二行目\n", noImages);
    expect(html).toContain("<br>");
  });

  it("folds inside a table cell too", () => {
    const { html } = renderMarkdown("| 説明 |\n|---|\n| 決めて<br>いる |\n", noImages);
    expect(html).toContain("決めて<br>いる");
  });
});


// A document sheet is named after its page, and a markdown file worth reading
// on its own writes that name as its h1. Listing both nested the page under
// itself — "Page name > Page name > Section A" — and the two ways out both cost
// something: deleting the h1 leaves a file that opens with no title, and
// nav_depth: 1 drops the sections that are the reason for having an outline.
describe("markdown: the document's own title", () => {
  it("is not an outline entry", () => {
    const { headings } = renderMarkdown("# Page name\n\n## Section A\n\n## Section B\n", () => null, {});
    expect(headings.map((h) => h.text)).toEqual(["Section A", "Section B"]);
  });

  // Nor is it written into the body: the sheet's own heading already shows the
  // page's name, in the reader's language, with the sheet-level controls on it.
  // Rendering the h1 under that put the same words twice, one line apart.
  it("is not rendered in the body either", () => {
    const { html } = renderMarkdown("# Page name\n\n## Section A\n", () => null, {});
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("Page name");
    expect(html).toContain("Section A");
  });

  // A file that opens at h2 has no title to drop.
  it("drops nothing when the document does not open with an h1", () => {
    const { headings } = renderMarkdown("## Section A\n\n## Section B\n", () => null, {});
    expect(headings.map((h) => h.text)).toEqual(["Section A", "Section B"]);
  });

  // A later h1 is a section of a flat document, not its name.
  it("keeps an h1 that is not the first heading", () => {
    const { headings } = renderMarkdown("# Title\n\n## A\n\n# Part two\n", () => null, {});
    expect(headings.map((h) => h.text)).toEqual(["A", "Part two"]);
  });
});
