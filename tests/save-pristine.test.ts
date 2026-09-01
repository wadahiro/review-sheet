// What a saved file contains, once the payload travels compressed.
//
// Saving is the document AS LOADED with one block swapped, so the app captured
// it by serializing the DOM. That stopped being the document the moment the
// bootstrap started inflating into the page: by the time the app runs, the tree
// ALSO holds an inflated <style> and an inflated data block, on top of the
// compressed blocks they came from. Measured before the fix: a 105 KB file
// saved as 219 KB, carrying both copies of everything — and the reopened copy
// would inflate a second data block over the first.
//
// The bootstrap captures it instead, because the bootstrap is the last thing
// that sees the document as it was loaded.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect } from "bun:test";
import { generateHtml } from "../src/html/generate";
import { BOOTSTRAP } from "../src/html/compress";
import { withEmbeddedHistory } from "../src/html/save";
import type { ParameterSheetInput, ReviewItem } from "../src/types";
import simple from "./fixtures/simple.json";

// The bootstrap, run over a freshly loaded document — everything it does except
// importing the app module, which is not this file's subject.
async function load(html: string): Promise<{ pristine: string }> {
  document.documentElement.innerHTML = html.slice(html.indexOf("<head"), html.lastIndexOf("</html>"));
  const g = globalThis as unknown as {
    URL: { createObjectURL: (b: unknown) => string; revokeObjectURL: (u: string) => void };
    __rsPristine?: string;
  };
  g.URL.createObjectURL = () => "blob:x";
  g.URL.revokeObjectURL = () => {};
  g.__rsPristine = undefined;
  new Function(BOOTSTRAP.replace("import(url).then(function () { URL.revokeObjectURL(url); });", "void url;"))();
  // The inflate is asynchronous (DecompressionStream through a Response).
  for (let i = 0; i < 40 && g.__rsPristine === undefined; i++) await new Promise((r) => setTimeout(r, 5));
  return { pristine: g.__rsPristine! };
}

const EDIT: ReviewItem = {
  id: "rev_saved",
  target: { sheet: "s", field: "value" },
  changes: [],
  status: "pending",
  at: "2026-01-01T00:00:00Z",
} as ReviewItem;

describe("saving a document whose payload is compressed", () => {
  it("writes a file the size of the one it opened, not the inflated DOM", async () => {
    const html = await generateHtml(simple as ParameterSheetInput, { edit: true } as never);
    const { pristine } = await load(html);
    const saved = withEmbeddedHistory(pristine, { reviews: [EDIT], saves: [] } as never);
    // The history block grows by one entry; nothing else may.
    expect(saved.length).toBeLessThan(html.length * 1.05);
  });

  it("keeps the compressed blocks and adds no inflated copy of them", async () => {
    const html = await generateHtml(simple as ParameterSheetInput, { edit: true } as never);
    const { pristine } = await load(html);
    for (const id of ["sheet-style-gz", "sheet-data-gz", "sheet-app-gz"]) {
      expect(pristine).toContain(id);
    }
    // The inflated data block is appended to <body> by the bootstrap; a saved
    // file carrying one would inflate a second over it on the next open.
    expect(pristine).not.toContain('id="sheet-data"');
  });

  it("is still a whole document, and still takes the edit", async () => {
    const html = await generateHtml(simple as ParameterSheetInput, { edit: true } as never);
    const { pristine } = await load(html);
    expect(pristine.startsWith("<!DOCTYPE html>\n<html")).toBe(true);
    expect(pristine.trimEnd().endsWith("</html>")).toBe(true);
    expect(withEmbeddedHistory(pristine, { reviews: [EDIT], saves: [] } as never)).toContain("rev_saved");
  });
});
