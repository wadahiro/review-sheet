// One file, with the folder inside it.
//
// The delivery is two things with one role each: the page you open and the
// folder you drag. Dragging is a gesture to repeat after every edit, so the
// page can write what it is holding into a copy of itself — and from then on
// there is no folder and no gesture. A document that has to be assembled
// before it can be read is one nobody assembles.

import { describe, it, expect } from "bun:test";
import { SET_BLOCK_ID, SET_BLOCK_OPEN, SET_DIR, setBlockJson, spliceSetBlock } from "../src/set-block";

const page = (block = "null"): string =>
  `<!DOCTYPE html>\n<html><body>\n${SET_BLOCK_OPEN}\n${block}\n</script>\n<p>after</p>\n</body></html>`;

describe("the block a page carries", () => {
  it("puts the files where the page looks for them", () => {
    const out = spliceSetBlock(page(), setBlockJson([{ path: "a.md", text: "# a" }]));
    const held = new RegExp(`id="${SET_BLOCK_ID}">\\n(.*)\\n</script>`).exec(out)![1]!;
    expect(JSON.parse(held.replace(/\\u003c/g, "<"))).toEqual([{ path: "a.md", text: "# a" }]);
    expect(out).toContain("<p>after</p>");
  });

  // A `<` anywhere in the text would end the element early and the rest of the
  // page would become markup — which reads as a blank document, not an error.
  it("cannot be ended by the text it carries", () => {
    const json = setBlockJson([{ path: "a.md", text: "</script><script>alert(1)</script>" }]);
    expect(json).not.toContain("<");
    const out = spliceSetBlock(page(), json);
    expect(out.match(/<\/script>/g)).toHaveLength(1);
  });

  // Written over and over as the recipient edits: the second write must replace
  // the first, not nest inside it.
  it("replaces a block that is already filled", () => {
    const once = spliceSetBlock(page(), setBlockJson([{ path: "a.md", text: "one" }]));
    const twice = spliceSetBlock(once, setBlockJson([{ path: "a.md", text: "two" }]));
    expect(twice).toContain("two");
    expect(twice).not.toContain("one");
    expect(twice.match(new RegExp(SET_BLOCK_ID, "g"))).toHaveLength(1);
  });

  // Found by the ID, not by the whole opening tag: an attribute written in
  // another order would otherwise be a tag this does not recognise.
  it("finds the block however its tag is written", () => {
    const odd = `<script id="${SET_BLOCK_ID}" type="application/json">\nnull\n</script>`;
    expect(spliceSetBlock(odd, '[{"path":"a"}]')).toContain('[{"path":"a"}]');
  });

  it("says so rather than guessing, on a page that carries none", () => {
    expect(() => spliceSetBlock("<html><body>nothing</body></html>", "[]")).toThrow(/does not carry a set/);
  });

  // A role, not a chapter — so it is named in neither of the document's
  // languages, and the three things at the top of a delivery have one job each:
  // the page you open, the note that says what this is, and the folder you edit.
  it("names the folder the document is in", () => {
    expect(SET_DIR).toBe("docs");
  });
});
