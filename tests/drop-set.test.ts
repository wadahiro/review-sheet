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

  // The sheets AND what they link to, because a page that embeds the set has to
  // be able to open those — a link into the folder resolves by itself only
  // while the folder is beside the page. The page itself is not read: it is
  // what is doing the reading.
  it("reads the whole folder except the page itself", async () => {
    const files = await filesFromDrop(dropOf([entryOf("sheet", { ...set, "artifacts": { "etc/x": "x" } })]));
    expect(files.some((f) => f.path.endsWith(".html"))).toBe(false);
    expect(files.map((f) => f.path)).toContain("artifacts/etc/x");
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
    const files = await filesFromDrop(dropOf([], [new File(["# a"], "a.md"), new File(["x"], "b.txt"), new File(["<p>"], "c.html")]));
    expect(files.map((f) => f.path)).toEqual(["a.md", "b.txt"]);
  });
});

// A failure has to say WHICH file, and reach the caller at all.
//
// The entry API rejects with a bare DOMException naming nothing, and the drop
// handler had no catch — so a refusal surfaced as an unhandled promise in a
// devtools tab and as NOTHING on the page. The reader drags the folder, it does
// not move, and the only thing that knows why is somewhere they are not looking.
describe("a folder the browser refuses", () => {
  const failing = (name: string, err: Error): unknown => ({
    isFile: true,
    isDirectory: false,
    name,
    file: (_cb: (f: File) => void, no: (e: unknown) => void) => no(err),
  });

  it("names the file it could not read", async () => {
    const bad = new Error("A URI supplied to the API was malformed");
    bad.name = "EncodingError";
    const dir = {
      isFile: false,
      isDirectory: true,
      name: "sheet",
      createReader: () => {
        let done = false;
        return {
          readEntries: (cb: (es: unknown[]) => void) => {
            // Marked BEFORE the callback: the walk asks again from inside it,
            // and a flag set afterwards never gets there.
            const first = !done;
            done = true;
            cb(first ? [failing("Keycloak (レルム).md", bad)] : []);
          },
        };
      },
    };
    const drop = { items: [{ kind: "file", webkitGetAsEntry: () => dir }], files: [] } as unknown as DataTransfer;
    await expect(filesFromDrop(drop)).rejects.toThrow(/Keycloak \(レルム\)\.md: EncodingError/);
  });

  it("names the directory it could not list", async () => {
    const bad = new Error("refused");
    bad.name = "SecurityError";
    const dir = {
      isFile: false,
      isDirectory: true,
      name: "詳細設計",
      createReader: () => ({ readEntries: (_cb: unknown, no: (e: unknown) => void) => no(bad) }),
    };
    const drop = { items: [{ kind: "file", webkitGetAsEntry: () => dir }], files: [] } as unknown as DataTransfer;
    await expect(filesFromDrop(drop)).rejects.toThrow(/詳細設計\/: SecurityError/);
  });
});
