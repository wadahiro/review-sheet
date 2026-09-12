// A sheet whose model IS its markdown, rendered as the sheet.
//
// The tables are laid out the way the sheet lays its own out — same columns,
// same indent, same code face on a key — rather than as a markdown renderer
// would produce them. See src/html/md-sheet.ts.

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
const SOURCE =
  "# 配置\n\n本文です。\n\n![図](./tree.png)\n\n## 運用\n\n本文です。\n\n止めるときは systemctl stop。\n";

const SHEET: ParameterSheetInput = {
  metadata: { title: "t" },
  sheets: [
    {
      name: "OS ディレクトリ",
      categories: [],
      document: {
        // Built the way the real build builds it, from this very source: the
        // html carries the ids AND the line each block was written on, which is
        // what a double click resolves against. Hand-writing it here let the
        // fixture claim a shape the build does not produce.
        html: renderMarkdown(SOURCE, (href) => (href === "./tree.png" ? { mime: "image/png", base64: "iVBORw0KGgo=" } : null)).html,
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
  // The history the FILE carries — see viewer-edit.test.ts's mount for why
  // this is no longer seeded through localStorage.
  render(
    h(Root, {
      payload: PAYLOAD,
      reviewEnabled: !opts.editEnabled,
      editEnabled: opts.editEnabled,
      initialLang: "ja",
      server: false,
      pristineHtml: '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
      embedded: { reviews: opts.editEnabled ? (opts.reviews ?? []) : [], saves: [] },
    }),
    host
  );
  return host;
}

// Opening the editor is the reader's own gesture: put the caret (or a
// selection) in the text and press `e`. A double click is left alone — it
// selects a word, and `e` then opens the editor on exactly that word.
const select = (node: Node, from: number, to: number): void => {
  const sel = window.getSelection()!;
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  sel.removeAllRanges();
  sel.addRange(range);
};
const pressE = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
};
// The key listener is installed by an effect, and preact flushes those on a
// frame this environment does not paint — so they land on the timer behind it.
// A press before that reaches nobody.
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 150));
// …and the caret is placed on a timer of its own, once the editor exists.
const opened = (host: HTMLElement): Promise<HTMLTextAreaElement> =>
  new Promise((r) => setTimeout(() => r(host.querySelector("textarea") as HTMLTextAreaElement), 150));

describe("a sheet whose model is the markdown", () => {
  const MD = [
    "# os",           // 1
    "",               // 2
    "## firewalld",   // 3
    "",               // 4
    "本番のみ有効。", // 5
    "",               // 6
    "止めるときは `systemctl stop firewalld`。", // 7
    "",               // 8
    "| 設定項目 | 説明 | デフォルト値 | 設定値 |", // 9
    "| --- | --- | --- | --- |",                  // 10
    "| `state` |  | stopped | running |",          // 11
    "",
  ].join("\n");

  const mountSheet = (): HTMLElement => {
    location.hash = "#1";
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: {
          metadata: { title: "t" },
          versions: [{ version: "current", sheets: [{ name: "os", instances: [], categories: [], document: { html: "", markdown: MD, mode: "sheet" } }] }],
        } as never,
        reviewEnabled: false,
        editEnabled: true,
        initialLang: "ja",
        server: false,
        embedded: { reviews: [], saves: [] },
      }),
      host
    );
    return host;
  };

  // The second paragraph of ONE prose block: its line is the block's plus the
  // renderer's own offset within it. Taking the block's line alone would open
  // two lines above, on a page where every note is two paragraphs long.
  it("opens at the paragraph inside the block, not at the block", async () => {
    const host = mountSheet();
    await settled();
    const para = [...host.querySelectorAll(".rs-md-prose p")].find((e) => (e.textContent ?? "").includes("止めるとき"))!;
    select(para.firstChild!, 0, 0);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("止めるときは `systemctl stop firewalld`。");
  });

  it("opens at the first paragraph of that same block", async () => {
    const host = mountSheet();
    await settled();
    const para = [...host.querySelectorAll(".rs-md-prose p")].find((e) => (e.textContent ?? "").includes("本番のみ"))!;
    select(para.firstChild!, 0, 0);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("本番のみ有効。");
  });

  // A row is one line, and the column somebody was reading is a cell of it —
  // which the sheet's own table says, the same way the renderer's does.
  it("opens at the cell the caret was in", async () => {
    const host = mountSheet();
    await settled();
    const row = [...host.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes("state"))!;
    const cell = row.querySelector("td.rs-col-value") as HTMLElement;
    const node = [...cell.querySelectorAll("span")].map((e) => e.firstChild).find((n) => n !== null) ?? cell.firstChild!;
    select(node, 0, 0);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("running |");
  });
});
