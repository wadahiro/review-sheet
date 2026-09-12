// A folder dropped on the page.
//
// The entry API is what a browser gives for a dropped DIRECTORY, and it has two
// edges that are invisible until a real folder is dropped: a directory reader
// hands back a BATCH and must be asked again until it is empty, and every path
// starts with the dragged folder's own name. Both are exercised here against a
// stand-in for the API rather than a browser, because what is being pinned is
// the walk, not the browser.

import { describe, it, expect } from "bun:test";
import { filesFromDrop } from "../src/html/drop-set";

type Tree = { [name: string]: string | Tree };

// A stand-in for `webkitGetAsEntry`'s entries. `batch` is how many a reader
// hands back at a time — Chrome's is a hundred, and reading once looks correct
// until a chapter has more files than that.
function entryOf(name: string, node: string | Tree, batch = 100): unknown {
  if (typeof node === "string") {
    return {
      isFile: true,
      isDirectory: false,
      name,
      file: (cb: (f: File) => void) => cb(new File([node], name)),
    };
  }
  const children = Object.entries(node).map(([n, v]) => entryOf(n, v, batch));
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (cb: (es: unknown[]) => void) => {
          const slice = children.slice(at, at + batch);
          at += slice.length;
          cb(slice);
        },
      };
    },
  };
}

const dropOf = (entries: unknown[], files: File[] = []): DataTransfer =>
  ({
    items: entries.length > 0
      ? entries.map((e) => ({ kind: "file", webkitGetAsEntry: () => e }))
      : files.map(() => ({ kind: "file" })),
    files,
  }) as unknown as DataTransfer;

describe("reading a dropped folder", () => {
  const set: Tree = {
    "README.md": "# doc",
    "詳細設計": { "OS.md": "# OS", "HTTPD.md": "# HTTPD" },
    "viewer.html": "<html></html>",
  };

  it("walks the tree and keeps the path within the folder", async () => {
    const files = await filesFromDrop(dropOf([entryOf("sheet", set)]));
    expect(files.map((f) => f.path).sort()).toEqual(["README.md", "詳細設計/HTTPD.md", "詳細設計/OS.md"]);
  });

  // Only the markdown. The artifacts and the evidence beside it are opened by
  // following a link, which the browser does itself — reading them here would
  // put a megabyte of configuration into memory for nothing.
  it("reads the markdown and leaves everything else alone", async () => {
    const files = await filesFromDrop(dropOf([entryOf("sheet", set)]));
    expect(files.some((f) => f.path.endsWith(".html"))).toBe(false);
  });

  // A reader hands back a batch at a time and has to be asked again. Reading
  // once passes on a small folder and loses the rest of a real one.
  it("asks the reader again until it is empty", async () => {
    const many: Tree = {};
    for (let i = 0; i < 250; i++) many[`s${i}.md`] = `# ${i}`;
    const files = await filesFromDrop(dropOf([entryOf("sheet", many, 100)]));
    expect(files).toHaveLength(250);
  });

  it("keeps the folder's name when more than one thing was dragged", async () => {
    const files = await filesFromDrop(dropOf([entryOf("a", { "x.md": "# x" }), entryOf("b", { "y.md": "# y" })]));
    expect(files.map((f) => f.path).sort()).toEqual(["a/x.md", "b/y.md"]);
  });

  // No entry API at all — a plain multi-file drop. The names are all there is,
  // which is a flat document rather than nothing.
  it("falls back to the names when there are no entries", async () => {
    const files = await filesFromDrop(dropOf([], [new File(["# a"], "a.md"), new File(["x"], "b.png")]));
    expect(files.map((f) => f.path)).toEqual(["a.md"]);
  });
});
