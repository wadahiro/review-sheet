// Editing the markdown a `recipe: document` sheet is rendered from.
//
// Rendering happens at BUILD time, so the generated file carries finished HTML
// and neither the source nor a renderer. Both now travel with a document that
// may be edited — including the images, which were embedded as data URIs at
// build time and so live in the HTML and not in the markdown. Re-rendering
// without them would quietly drop every picture, which is the case these pin.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { h, render } from "preact";
import { Root } from "../src/html/app";
import { setMarkdownRenderer } from "../src/html/markdown-runtime";
import { renderMarkdown } from "../src/markdown";
import { documentSource } from "../src/edits";
import type { ParameterSheetInput, ReviewItem } from "../src/types";

// app-md.ts does this in a real editable document; the test does it directly.
beforeAll(() => {
  setMarkdownRenderer((source, images, opts) =>
    renderMarkdown(
      source,
      (href) => {
        const uri = images[href];
        const m = uri === undefined ? null : /^data:([^;]+);base64,(.*)$/.exec(uri);
        return m === null ? null : { mime: m[1], base64: m[2] };
      },
      opts
    )
  );
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const SOURCE = "# 配置\n\n本文です。\n\n![図](./tree.png)\n";

const SHEET: ParameterSheetInput = {
  metadata: { title: "t" },
  sheets: [
    {
      name: "OS ディレクトリ",
      categories: [],
      document: {
        html: '<h1 id="rs-doc-OS-1">配置</h1><p>本文です。</p><img src="' + PNG + '" alt="図">',
        markdown: SOURCE,
        images: { "./tree.png": PNG },
      },
    },
  ],
};

const PAYLOAD = { metadata: SHEET.metadata, versions: [{ version: "current", sheets: SHEET.sheets }] };
const STORAGE_KEY = "review-sheet::current:";

const edit = (markdown: string): ReviewItem => ({
  id: "rev_doc",
  target: { sheet: "OS ディレクトリ", field: "document" },
  changes: [{ field: "document", current: SOURCE, suggested: markdown }],
  status: "applied",
  at: "2026-08-18T00:00:00Z",
  by: "田中",
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

function mount(opts: { editEnabled: boolean; reviews?: ReviewItem[] }): HTMLElement {
  location.hash = "#1";
  const host = document.createElement("div");
  document.body.appendChild(host);
  if (opts.reviews?.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(opts.reviews));
  render(
    h(Root, {
      payload: PAYLOAD,
      reviewEnabled: !opts.editEnabled,
      editEnabled: opts.editEnabled,
      initialLang: "ja",
      server: false,
      pristineHtml: '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
      embedded: { reviews: [], saves: [] },
    }),
    host
  );
  return host;
}

describe("a document sheet that may be edited", () => {
  it("shows the built html when nothing has been edited", () => {
    const host = mount({ editEnabled: true });
    expect(host.querySelector(".rs-doc")?.textContent).toContain("本文です。");
  });

  // In the sheet HEADING, at the right end, where a sheet's actions already
  // live — the comment button has sat there since before this existed.
  const editButton = (host: HTMLElement): Element | null => {
    const tools = [...host.querySelectorAll(".rs-sheet-header .rs-head-tool")];
    return tools.find((b) => (b.getAttribute("title") ?? "").includes("この文書")) ?? null;
  };

  it("offers the editor in the sheet heading, only when editing is on", () => {
    expect(editButton(mount({ editEnabled: true }))).not.toBeNull();
    document.body.innerHTML = "";
    expect(editButton(mount({ editEnabled: false }))).toBeNull();
  });

  it("renders the edited markdown instead of the built html", () => {
    const host = mount({ editEnabled: true, reviews: [edit("# 配置\n\n書き換えた本文。\n")] });
    const doc = host.querySelector(".rs-doc")!;
    expect(doc.textContent).toContain("書き換えた本文。");
    expect(doc.textContent).not.toContain("本文です。");
  });

  // The picture is in the built HTML, not in the markdown. Re-rendering without
  // carrying the images across would drop it, and nothing on screen would say
  // an edit had cost the document a figure.
  it("keeps an image the build embedded", () => {
    const host = mount({ editEnabled: true, reviews: [edit("# 配置\n\n新しい本文。\n\n![図](./tree.png)\n")] });
    const img = host.querySelector(".rs-doc img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(PNG);
  });

  it("says the document is no longer the built one", () => {
    const host = mount({ editEnabled: true, reviews: [edit("# 別の見出し\n")] });
    expect(host.querySelector(".rs-doc-edited-note")).not.toBeNull();
    // ...and the heading's own button carries the same state, the way the
    // comment button beside it does.
    expect(editButton(host)?.className).toContain("rs-head-tool-on");
  });

  it("leaves the document alone in a read-only copy, even with an edit in storage", () => {
    const host = mount({ editEnabled: false, reviews: [edit("# 書き換え\n")] });
    expect(host.querySelector(".rs-doc")?.textContent).toContain("本文です。");
  });
});

describe("documentSource", () => {
  it("returns the newest edit, and nothing when there is none", () => {
    const older = { ...edit("# 一回目\n"), id: "a", at: "2026-08-01T00:00:00Z" };
    const newer = { ...edit("# 二回目\n"), id: "b", at: "2026-09-01T00:00:00Z" };
    expect(documentSource([older, newer], "OS ディレクトリ")).toBe("# 二回目\n");
    expect(documentSource([], "OS ディレクトリ")).toBeUndefined();
  });

  // A document edit names no parameter; a cell edit does. Reading one as the
  // other would let a value change replace a whole page.
  it("ignores a cell edit on the same sheet", () => {
    const cell: ReviewItem = {
      id: "c",
      target: { sheet: "OS ディレクトリ", category: "x", param: "k", field: "document" },
      changes: [{ field: "document", suggested: "nope" }],
      status: "applied",
    };
    expect(documentSource([cell], "OS ディレクトリ")).toBeUndefined();
  });
});

// A pasted image is referenced by PATH and carried beside the markdown, not
// written into it as a data URI: 40 KB of base64 in the middle of a paragraph
// is unreadable in the editor and in the .md the change goes back to.
describe("images pasted into a document", () => {
  const PASTED = "data:image/png;base64,R0lGODlhAQABAAAAACw=";
  const withAsset: ReviewItem = {
    id: "rev_paste",
    target: { sheet: "OS ディレクトリ", field: "document" },
    changes: [{ field: "document", current: SOURCE, suggested: "# 配置\n\n![](images/deadbeef.png)\n" }],
    assets: { "images/deadbeef.png": PASTED },
    status: "applied",
    at: "2026-08-18T00:00:00Z",
  };

  it("renders from the path, resolving the image the edit carries", () => {
    const host = mount({ editEnabled: true, reviews: [withAsset] });
    expect(host.querySelector(".rs-doc img")?.getAttribute("src")).toBe(PASTED);
  });

  it("keeps the markdown itself readable — the base64 is not in it", () => {
    expect(documentSource([withAsset], "OS ディレクトリ")).not.toContain("base64");
  });

  // A picture pasted in one edit and still referenced by a later one belongs to
  // the later text too, so assets accumulate across the whole history.
  it("still resolves an image a previous edit brought", () => {
    const later: ReviewItem = {
      id: "rev_later",
      target: { sheet: "OS ディレクトリ", field: "document" },
      changes: [{ field: "document", suggested: "# 別の見出し\n\n![](images/deadbeef.png)\n" }],
      status: "applied",
      at: "2026-09-01T00:00:00Z",
    };
    const host = mount({ editEnabled: true, reviews: [withAsset, later] });
    expect(host.querySelector(".rs-doc")?.textContent).toContain("別の見出し");
    expect(host.querySelector(".rs-doc img")?.getAttribute("src")).toBe(PASTED);
  });

  it("still shows an image the build embedded, alongside a pasted one", () => {
    const both: ReviewItem = {
      ...withAsset,
      changes: [{ field: "document", suggested: "![](./tree.png)\n\n![](images/deadbeef.png)\n" }],
    };
    const srcs = [...mount({ editEnabled: true, reviews: [both] }).querySelectorAll(".rs-doc img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([PNG, PASTED]);
  });
});
