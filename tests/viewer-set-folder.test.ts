// THE FOLDER THE READER IS TOLD TO CHOOSE, and the name the page saves under.
//
// Both are about the same delivery: it unpacks to `viewer.html` beside a `docs`
// folder holding the markdown. The tooltip named the page, which is the one
// thing in there that is NOT what the picker wants, and the save came down as
// `sheet.html`, which lands beside the page it came from instead of replacing
// it.

import { describe, it, expect } from "bun:test";
import { readMarkdownSet } from "../src/md-read";
import { getMessages } from "../src/html/i18n";
import { SET_DIR, savedAs } from "../src/set-block";

const SET = [
  { path: "index.md", text: "# Index\n\n- [S](./S.md)\n" },
  {
    path: "S.md",
    text: ["# S", "", "| 設定項目 | local |", "| --- | --- |", "| `Listen` | 80 |", ""].join("\n"),
  },
];

describe("choosing the folder", () => {
  // The picker strips the chosen folder's own name from every path, so the two
  // differ by exactly the `docs/` prefix — and the model has to come out the
  // same either way, or the tooltip would be sending readers somewhere that
  // half-works.
  it("reads the same set whether the root or docs/ was chosen", () => {
    const fromRoot = readMarkdownSet(SET.map((f) => ({ ...f, path: `${SET_DIR}/${f.path}` })));
    const fromDocs = readMarkdownSet(SET);
    expect(JSON.stringify(fromDocs)).toBe(JSON.stringify(fromRoot));
    expect((fromDocs.sheets ?? []).length).toBeGreaterThan(0);
  });

  // …so it names the folder by what is IN it, which is what a reader can see
  // in the file dialog. `viewer.html` is not in that folder at all.
  it("is described by the markdown it holds, not by the page beside it", () => {
    for (const lang of ["ja", "en"] as const) {
      expect(getMessages(lang).pickFolderTip).toContain(SET_DIR);
      expect(getMessages(lang).pickFolderTip).not.toContain("viewer.html");
      expect(getMessages(lang).dropNoSheets).toContain(SET_DIR);
      expect(getMessages(lang).dropNoSheets).not.toContain("viewer.html");
    }
  });
});

// …and the name it comes down as. A delivery unpacks to `viewer.html` beside
// that folder, and the page writing the set into itself IS that viewer — so a
// save that is not called `viewer.html` lands beside it and leaves the original
// empty, which is what "sheet (1).html" was.
describe("the name a save comes down as", () => {
  it("is the page's own name", () => {
    expect(savedAs("/out/delivery/viewer.html")).toBe("viewer.html");
  });

  // A recipient who renamed it will look for the name they gave it.
  it("keeps a name the recipient chose", () => {
    expect(savedAs("/x/%E3%83%91%E3%83%A9%E3%82%B7.html")).toBe("パラシ.html");
    expect(savedAs("/x/Sheet.HTML")).toBe("Sheet.HTML");
  });

  // Somewhere with no file name at all — a blob URL, a route ending in `/`.
  it("falls back to the name a delivery unpacks to", () => {
    expect(savedAs("/")).toBe("viewer.html");
    expect(savedAs("")).toBe("viewer.html");
    expect(savedAs("/reviews/2026/")).toBe("viewer.html");
  });

  it("is never the old constant", () => {
    expect(savedAs("/out/delivery/viewer.html")).not.toBe("sheet.html");
  });
});
