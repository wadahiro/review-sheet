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

  // The rendered page and the markdown are not the same string: `**bold**`
  // renders without its markers, and a paragraph wrapped over two lines renders
  // as one. The LINE is still exact, because the page carries it rather than
  // the text being searched for.
  it("finds the line even when the rendering is not the source", async () => {
    const source = "# 配置\n\n## 運用\n\n**強調**した文と、折り返した\n続きの行。\n";
    const host = mount({ editEnabled: true, reviews: [edit(source)] });
    await settled();
    const target = [...host.querySelectorAll(".rs-doc p")].find((e) => (e.textContent ?? "").includes("強調"))!;
    select(target.firstChild!, 0, 0);
    pressE();
    const area = await opened(host);
    const from = area.value.indexOf("**強調**");
    const to = area.value.indexOf("続きの行。") + "続きの行。".length;
    expect(area.selectionStart).toBeGreaterThanOrEqual(from);
    expect(area.selectionStart).toBeLessThan(to);
  });

  // A paragraph beginning "`keycloak.conf` は …" shares the word `keycloak` with
  // half the document, and the search this replaced opened the editor on an
  // unrelated line for exactly that reason — measured on a real page.
  it("lands on the paragraph itself, not on an earlier one that shares its words", async () => {
    const source = [
      "# 配置",
      "",
      "## 構成",
      "",
      "keycloak の配備は keycloak-config-cli で流し込む。",
      "",
      "`keycloak.conf` は `db-password=${KC_DB_PASSWORD}`。local と AWS でコードパスが同一。",
      "",
    ].join("\n");
    const host = mount({ editEnabled: true, reviews: [edit(source)] });
    await settled();
    const target = [...host.querySelectorAll(".rs-doc p")].find((e) => (e.textContent ?? "").includes("コードパス"))!;
    const node = [...target.childNodes].find((n) => (n.textContent ?? "").includes("コードパス"))!;
    select(node, 0, 0);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toContain("コードパスが同一");
    // …and not on the earlier line that merely says `keycloak`.
    expect(area.value.slice(area.selectionStart)).not.toContain("keycloak-config-cli");
  });

  // Either rule alone saves this case; together they are what makes the landing
  // trustworthy on a real page. Watched failing with both switched off.

  // Where the CARET was, not merely which paragraph it was in. A paragraph of
  // four sentences is one block, so landing "at that paragraph" puts the caret
  // on its first line however far down somebody was reading.
  it("lands where the caret was inside a long paragraph", async () => {
    const source = [
      "# 配置",
      "",
      "## 構成",
      "",
      "`keycloak.conf` は `db-password=${KC_DB_PASSWORD}`（環境変数展開）。local と AWS でコードパスが完全に同一で、差分は `kc_aws_endpoint_url` だけ。",
      "",
    ].join("\n");
    const host = mount({ editEnabled: true, reviews: [edit(source)] });
    await settled();
    const para = [...host.querySelectorAll(".rs-doc p")].find((e) => (e.textContent ?? "").includes("コードパス"))!;
    const node = [...para.childNodes].find((n) => (n.textContent ?? "").includes("コードパス"))!;
    const at = (node.textContent ?? "").indexOf("コードパス");
    select(node, at, at);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("コードパスが完全に同一");
  });

  // A paragraph WRAPPED over several source lines is one block, and the
  // sentence somebody pointed at is as likely to be on its second line as on
  // its first — this is the shape a real page is written in, a list item whose
  // continuation carries the emphasis. The block is what the page can name;
  // finding the run inside it is what puts the caret on the right line of it.
  it("lands on the wrapped line of a block, not on the line the block starts", async () => {
    const source = [
      "# 配置",
      "",
      "## 構成",
      "",
      "- `keycloak.conf` は `db-password=${KC_DB_PASSWORD}`（環境変数展開）。",
      "  **local と AWS でコードパスが完全に同一**で、差分は `kc_aws_endpoint_url` だけ。",
      "- `db-password` 自体は `sheet.yml` で out_of_scope。",
      "",
    ].join("\n");
    const host = mount({ editEnabled: true, reviews: [edit(source)] });
    await settled();
    const strong = [...host.querySelectorAll(".rs-doc li strong")].find((e) => (e.textContent ?? "").includes("コードパス"))!;
    select(strong.firstChild!, 0, 0);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("local と AWS でコードパスが完全に同一");
  });

  // A table ROW is one line, so the line alone cannot say which of its cells
  // was pointed at — and the run under the pointer is no answer either, since
  // an earlier column can hold the same words. Reported on a real page: a cell
  // reading "AWS Secrets Manager" opened on the "Secrets Manager" column
  // beside it.
  it("lands in the cell that was clicked, not in an earlier one that reads alike", async () => {
    const source = [
      "# 配置",
      "",
      "## 秘密",
      "",
      "| 保管先 | 内容 |",
      "| --- | --- |",
      "| Secrets Manager | AWS Secrets Manager |",
      "",
    ].join("\n");
    const host = mount({ editEnabled: true, reviews: [edit(source)] });
    await settled();
    const cell = [...host.querySelectorAll(".rs-doc td")].find((e) => (e.textContent ?? "").includes("AWS"))!;
    const node = cell.firstChild!;
    // On the word itself, as a reader selecting it would be: the run is
    // "Secrets Manager", which the FIRST column holds in full — the reported
    // failure.
    const at = (node.textContent ?? "").indexOf("Secrets");
    select(node, at, at + "Secrets Manager".length);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("Secrets Manager |");
    // …the second column's, so the first column's own is behind the caret.
    expect(area.value.slice(0, area.selectionStart)).toContain("| Secrets Manager | AWS ");
  });

  it("opens the editor at the caret when `e` is pressed", async () => {
    const host = mount({ editEnabled: true });
    await settled();
    // The SECOND "本文です。" — the same words as the first, under a different
    // heading, which is exactly what a search cannot tell apart.
    const para = [...host.querySelectorAll(".rs-doc p")].filter((e) => (e.textContent ?? "").trim() === "本文です。")[1]!;
    select(para.firstChild!, 0, 0);
    pressE();
    await new Promise((r) => setTimeout(r, 120));
    const area = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.value.slice(area.selectionStart)).toStartWith("本文です。");
    expect(area.value.slice(0, area.selectionStart)).toContain("## 運用");
  });

  // A page is read section by section, so every heading carries the way in —
  // the way a parameter sheet's categories do. The one button in the sheet's
  // own header meant scrolling back to the top to change the paragraph in front
  // of you, and then finding it again in a thousand lines of source.
  it("offers the editor on every heading of the document", async () => {
    const host = mount({ editEnabled: true });
    const buttons = [...host.querySelectorAll(".rs-doc .rs-doc-head-tool")];
    // The document's own h1 is its title and is not rendered into the body
    // (markdown.ts), so what is left is the one h2 this fixture writes.
    expect(buttons).toHaveLength(1);
    (buttons[0] as HTMLElement).click();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("## 運用");
  });

  it("offers none of them in a copy that may not be edited", () => {
    const host = mount({ editEnabled: false });
    expect(host.querySelectorAll(".rs-doc .rs-doc-head-tool")).toHaveLength(0);
  });

  // Selecting a whole heading — a triple click, or dragging across the line —
  // puts the selection's ends on the CONTAINER, counted in children rather than
  // in characters. Read as characters that addresses the container, which
  // carries no line, and the keystroke did nothing at all. Reported on a
  // heading, where a reader is most likely to select the whole line.
  it("opens on a heading selected whole", async () => {
    const host = mount({ editEnabled: true });
    await settled();
    const heading = host.querySelector(".rs-doc h2")!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNode(heading); // ends on the parent, in child counts
    sel.removeAllRanges();
    sel.addRange(range);
    pressE();
    const area = await opened(host);
    expect(area.value.slice(area.selectionStart)).toStartWith("## 運用");
  });

  // The page's own title. markdown.ts drops the source's first `#` from the
  // body — the page already carries its name in the sheet header, in the
  // reader's language — so line 1 has no other element on the page, and the one
  // heading a reader is most likely to select was the one the keystroke could
  // not address.
  it("opens at the top when the page's own title is selected", async () => {
    const host = mount({ editEnabled: true });
    await settled();
    const title = host.querySelector(".rs-sheet-header h2")!;
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(title);
    sel.removeAllRanges();
    sel.addRange(range);
    pressE();
    const area = await opened(host);
    expect(area.selectionStart).toBe(0);
    expect(area.value).toStartWith("# 配置");
  });

  // A double click is for selecting a word, and that is what it is left to do —
  // so the pair works: double click the word, press `e`, and the editor opens
  // with that word selected. Taking the gesture for the editor cost both halves
  // (the word could not be selected, and the editor could only be told where).
  it("leaves a double click to select a word", async () => {
    const host = mount({ editEnabled: true });
    await settled();
    const para = [...host.querySelectorAll(".rs-doc p")].find((e) => (e.textContent ?? "").includes("systemctl"))!;
    para.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("opens with what was selected selected, so typing replaces it", async () => {
    const host = mount({ editEnabled: true });
    await settled();
    const para = [...host.querySelectorAll(".rs-doc p")].find((e) => (e.textContent ?? "").includes("systemctl"))!;
    const node = para.firstChild!;
    const at = (node.textContent ?? "").indexOf("systemctl stop");
    select(node, at, at + "systemctl stop".length);
    pressE();
    await new Promise((r) => setTimeout(r, 120));
    const area = host.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("systemctl stop");
  });

  // `e` is a letter. A reader typing one into a field is not asking for the
  // editor, and neither is a reader of a copy that may not be edited.
  it("stays out of the way of a field, and of a read-only copy", async () => {
    const host = mount({ editEnabled: true });
    await settled();
    const para = [...host.querySelectorAll(".rs-doc p")].find((e) => (e.textContent ?? "").includes("systemctl"))!;
    select(para.firstChild!, 0, 0);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    expect(host.querySelector("textarea")).toBeNull();

    document.body.innerHTML = "";
    const readOnly = mount({ editEnabled: false });
    await settled();
    const p2 = [...readOnly.querySelectorAll(".rs-doc p")].find((e) => (e.textContent ?? "").includes("systemctl"))!;
    select(p2.firstChild!, 0, 0);
    pressE();
    await new Promise((r) => setTimeout(r, 80));
    expect(readOnly.querySelector("textarea")).toBeNull();
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
      // A SECTION heading, not the page's title: a title h1 is the sheet's own
      // heading and is not rendered into the body.
      changes: [{ field: "document", suggested: "## 別の見出し\n\n![](images/deadbeef.png)\n" }],
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


// The title h1 is still IN the markdown — that is the point of keeping it — so
// the source editor shows it and it can be edited, while the body it renders to
// does not change. Nothing warns you of that at the moment you are typing into
// it, so the editor says it.
describe("the document editor and the page's title", () => {
  const open = async (source: string): Promise<HTMLElement> => {
    const host = mount({ editEnabled: true, reviews: [{
      id: "rev_src",
      target: { sheet: "OS ディレクトリ", field: "document" },
      changes: [{ field: "document", suggested: source }],
      status: "applied",
      at: "2026-09-01T00:00:00Z",
    } as ReviewItem] });
    const tools = [...host.querySelectorAll(".rs-sheet-header .rs-head-tool")];
    (tools.find((b) => (b.getAttribute("title") ?? "").includes("この文書")) as HTMLElement | undefined)?.click();
    await Promise.resolve();
    return host;
  };

  // The editor says nothing above the text at all now — neither about the
  // leading h1 nor about pasting a picture. A standing explanation is read once
  // and is in the way of the thing somebody came here to edit every time after
  // that, and this editor is opened often.
  it("says nothing above the text", async () => {
    const host = await open("# ページ名\n\n## セクションA\n");
    expect(host.querySelectorAll(".rs-doc-modal .rs-edit-note")).toHaveLength(0);
  });

  // …and it is the same editor the sheets use: one design, one size.
  it("is the same wide editor a sheet is edited in", async () => {
    const host = await open("## セクションA\n\n本文。\n");
    expect(host.querySelector(".rs-doc-modal")?.className).toContain("rs-doc-modal-wide");
    expect(host.querySelector(".rs-doc-modal textarea")?.className).toContain("rs-sheet-source");
  });
});

// A HAND-MAINTAINED sheet (`--full-edit`) draws its own tables from the same
// markdown, and its prose is rendered PER BLOCK — so the line the renderer
// stamps is counted from the block's own first line, not the document's. That
// arithmetic is the whole jump on such a page, and only a page with a real
// markdown renderer behind it exercises it.
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
