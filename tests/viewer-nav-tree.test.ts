// The chapter tree, in the real app: what a reader sees and can operate.
//
// The structure is pinned in nav-tree.test.ts. What is here is the part only a
// rendered page can answer — that the tree replaces the strip, that entries are
// LINKS (so ⌘-click opens a second copy where the reader is), that the current
// chapter is open however it was left, and that a document that says nothing
// keeps the tab strip it has always had.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { Root, navStateKey, getStorageKey } from "../src/html/app";
import { customStyles } from "../src/html/styles";
import type { ParameterSheetInput } from "../src/types";

const sheet = (name: string, group: string) => ({
  name,
  group,
  instances: [],
  categories: [{ name: "c", params: [{ key: `${name}-k`, description: { ja: "d", en: "d" }, value: "1" }] }],
});

const MODEL = {
  metadata: { title: "t" },
  nav: "book",
  groups: [
    { name: "requirements", label: { ja: "要件定義", en: "Requirements" } },
    {
      name: "build",
      label: { ja: "構築", en: "Build" },
      groups: [{ name: "params", label: { ja: "パラメータ", en: "Parameters" } }],
    },
  ],
  sheets: [sheet("要件一覧", "requirements"), sheet("構築手順", "build"), sheet("OS 設定", "params")],
} as unknown as ParameterSheetInput;

// Carried per version, the way `groups` and `columns` are (generate.ts).
const payload = (input: ParameterSheetInput) => ({
  metadata: input.metadata,
  versions: [
    {
      version: "current",
      sheets: input.sheets,
      groups: input.groups,
      nav: (input as { nav?: string }).nav,
      numbering: (input as { numbering?: boolean }).numbering,
    },
  ],
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  // UNMOUNTED, not just emptied: a tree left mounted keeps its listeners and
  // its pending effects, and the next case's act() flushes those too — which
  // showed up here as one extra write to a panel that is no longer on screen.
  for (const el of [...document.body.children]) render(null, el as HTMLElement);
  document.body.innerHTML = "";
  localStorage.clear();
});

const mount = (input: ParameterSheetInput, hash = "#1"): HTMLElement => {
  location.hash = hash;
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(h(Root, { payload: payload(input) as never, reviewEnabled: true, editEnabled: false, initialLang: "ja", server: false }), host);
  return host;
};

// The chapters and sheets. The current sheet's own headings hang under it in
// the same panel and are asserted on their own.
//
// Remembered per DOCUMENT: every copy of every generated file opened from a
// file:// URL shares one storage area, so a single key let one document's
// collapsed chapters apply to the next one opened — under names that repeat
// across documents. The key is project : version : title (navStateKey), with
// no generated_at and no save revision in it: those identify a REVISION, which
// is right for an unsaved edit and wrong for how a reader has arranged the
// room — keyed that way, every rebuild threw the arrangement away.
const collapseKey = (): string => "rs-nav-collapsed:review-sheet::current:t";
const closedNow = (): string[] => JSON.parse(localStorage.getItem(collapseKey()) ?? "{}").closed ?? [];

// The whole ROW: the fold is a button beside the link rather than inside it (a
// button cannot live inside an anchor), so the row's text is the fold's label
// plus the name — number included, since the number is part of the name.
const rows = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".rs-navtree-row:not(.rs-navtree-heading)")].map((e) => (e.textContent ?? "").trim());

describe("a document set read as chapters", () => {
  it("draws the chapters instead of a strip of tabs", () => {
    const host = mount(MODEL);
    // Booleans, not the nodes: a failed toBeNull on a DOM node prints the whole
    // element, which for a rendered page is a dump nothing can read.
    expect(host.querySelector(".rs-navtree") !== null).toBe(true);
    // The bar stays (it holds the toolbar); what goes is the strip of tabs.
    expect(host.querySelector(".rs-tabs-left") !== null).toBe(false);
    expect(host.querySelector(".rs-tabs-book") !== null).toBe(true);
    expect(rows(host)).toEqual(["1 要件定義", "1.1 要件一覧", "2 構築", "2.1 構築手順", "2.2 パラメータ", "2.2.1 OS 設定"]);
  });

  // A link, not a div with a handler: the hash IS the document's state, so
  // ⌘-click and middle-click open a second copy where the reader is.
  it("makes every entry a link to the sheet's own hash", () => {
    const host = mount(MODEL);
    const os = [...host.querySelectorAll("a.rs-navtree-item")].find((a) => (a.textContent ?? "").includes("OS 設定"))!;
    expect(os.getAttribute("href")).toBe("#3");
  });

  it("marks where the reader is", () => {
    const host = mount(MODEL, "#3");
    const current = host.querySelector(".rs-navtree-current .rs-navtree-label");
    expect((current?.textContent ?? "").trim()).toBe("2.2.1 OS 設定");
  });

  // Collapsing is the reader's and is remembered — but a jump into a collapsed
  // chapter must open it, or the highlight is somewhere nobody can see and the
  // jump reads as broken.
  it("opens the chapter a jump lands in, whatever was collapsed", async () => {
    localStorage.setItem(collapseKey(), JSON.stringify({ closed: ["group:build", "group:params"] }));
    const host = mount(MODEL, "#3");
    await new Promise((r) => setTimeout(r, 150));
    expect(rows(host)).toContain("2.2.1 OS 設定");
    expect(closedNow()).toEqual([]);
  });

  it("hides what a collapsed chapter holds, at any depth", async () => {
    localStorage.setItem(collapseKey(), JSON.stringify({ closed: ["group:build"] }));
    const host = mount(MODEL, "#1");
    await new Promise((r) => setTimeout(r, 150));
    expect(rows(host)).toEqual(["1 要件定義", "1.1 要件一覧", "2 構築"]);
  });

  it("leaves the numbers out when the document declines them", () => {
    const host = mount({ ...MODEL, numbering: false } as unknown as ParameterSheetInput);
    expect(rows(host)).toEqual(["要件定義", "要件一覧", "構築", "構築手順", "パラメータ", "OS 設定"]);
  });

  // Every document that predates this says nothing and keeps its strip.
  // ONE panel: the tree carries the current sheet's own headings, and the
  // outline drawer — the same list, also fixed to the left edge — is not
  // offered in a book document, because two of them cannot be told apart.
  it("carries the sheets' headings, and offers no second outline", () => {
    const host = mount(MODEL, "#3");
    expect([...host.querySelectorAll(".rs-navtree-heading")].length).toBeGreaterThan(0);
    expect(host.querySelector(".rs-outline") !== null).toBe(false);
  });

  // Hiding the tree gives the space back. Keyed on the mode alone, the margin
  // the tree occupied stayed behind as an empty column.
  it("takes its width back with it when it is hidden", async () => {
    const { customStyles } = await import("../src/html/styles");
    const rule = customStyles.slice(customStyles.indexOf(".rs-app.rs-book"));
    expect(rule.slice(0, rule.indexOf("{"))).toContain("rs-outline-open");
  });

  // Taking the panel away is not clearing the search. The filter lives on the
  // page, not inside the tree — hiding the tree unmounts it, and typing the
  // filter again every time is what charged the reader for reclaiming the space.
  it("keeps what it was filtered to when it is hidden and brought back", async () => {
    const host = mount(MODEL);
    const field = host.querySelector(".rs-navtree-filter") as HTMLInputElement;
    field.value = "構築";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    expect(rows(host)).toEqual(["2 構築", "2.1 構築手順"]);

    const toggle = [...host.querySelectorAll("button")].find(
      (b) => (b.getAttribute("aria-label") ?? "").includes("目次")
    )!;
    (toggle as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(host.querySelector(".rs-navtree") !== null).toBe(false);
    (toggle as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
    expect((host.querySelector(".rs-navtree-filter") as HTMLInputElement).value).toBe("構築");
    expect(rows(host)).toEqual(["2 構築", "2.1 構築手順"]);
  });

  // WHERE THE READER IS, including which document. The leaf was left out at
  // first, reasoning from the top of a page — where the tree and the page's own
  // heading both show the name. Scrolled, neither does: the heading has gone by
  // and the sticky category headers name sections with no document above them.
  // The bar is the sticky one, so it carries the whole path.
  // The chapters and the sheet. The document's own name is the path's ROOT and
  // a link to the front matter — asserted on its own below.
  const crumbs = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-tabs-book .rs-crumb:not(.rs-crumb-root)")].map((e) => (e.textContent ?? "").trim());
  const root = (host: HTMLElement): HTMLAnchorElement | null =>
    host.querySelector(".rs-tabs-book .rs-crumb-root");

  it("shows the chapters above the sheet AND the sheet, in that order", () => {
    const host = mount(MODEL, "#3");
    expect(crumbs(host)).toEqual(["2 構築", "2.2 パラメータ", "2.2.1 OS 設定"]);
  });

  it("marks the sheet itself as where the reader is", () => {
    const host = mount(MODEL, "#3");
    const last = [...host.querySelectorAll(".rs-tabs-book .rs-crumb")].pop()!;
    expect(last.getAttribute("aria-current")).toBe("page");
    expect((last.textContent ?? "").trim()).toBe("2.2.1 OS 設定");
  });

  it("shows two segments for a sheet directly under a chapter", () => {
    const host = mount(MODEL, "#1");
    expect(crumbs(host)).toEqual(["1 要件定義", "1.1 要件一覧"]);
  });

  // A document with no chapters still says which of its sheets is open — that
  // is the sticky cue, not a duplicate of a path that does not exist.
  it("shows the sheet alone in a document with no chapters", () => {
    const { groups: _g, ...flat } = MODEL as unknown as Record<string, unknown>;
    const host = mount(flat as unknown as ParameterSheetInput, "#1");
    expect(crumbs(host)).toEqual(["1 要件一覧"]);
  });

  it("shows no chapters on the front matter, which is under none", () => {
    const host = mount(MODEL, "#overview");
    expect(crumbs(host)).toEqual([]);
  });

  // The front matter was reachable only from the tree — so with the tree hidden
  // it was a page with no way in. The path's root is the document itself, and a
  // link, which is the convention every docs site already taught the reader.
  it("roots the path in the document, as a link to its front matter", () => {
    const host = mount({ ...MODEL, metadata: { title: "業務システム" } } as unknown as ParameterSheetInput, "#3");
    expect((root(host)?.textContent ?? "").trim()).toBe("業務システム");
    expect(root(host)?.getAttribute("href")).toBe("#overview");
    expect(root(host)?.tagName).toBe("A");
  });

  it("marks the root as where the reader is, on the front matter itself", () => {
    const host = mount(MODEL, "#overview");
    expect(root(host)?.getAttribute("aria-current")).toBe("page");
  });

  it("falls back to the word for the page when the document has no title", () => {
    const { metadata: _m, ...untitled } = MODEL as unknown as Record<string, unknown>;
    const host = mount(untitled as unknown as ParameterSheetInput, "#3");
    expect((root(host)?.textContent ?? "").trim()).toBe("概要");
  });

  it("drops the numbers with the rest when the document declines them", () => {
    const host = mount({ ...MODEL, numbering: false } as unknown as ParameterSheetInput, "#3");
    expect(crumbs(host)).toEqual(["構築", "パラメータ", "OS 設定"]);
  });

  // The row of the current chapter's sheets is a subset of the tree, flat and
  // unnumbered — a second chooser answering no question the first does not.
  it("offers no second sheet chooser in the header", () => {
    const host = mount(MODEL, "#3");
    expect(host.querySelector(".rs-subtabs") !== null).toBe(false);
  });

  it("keeps that row in a tabbed document, where it is the only one", () => {
    const { nav: _nav, ...tabs } = MODEL as unknown as Record<string, unknown>;
    const host = mount(tabs as unknown as ParameterSheetInput, "#3");
    expect(host.querySelector(".rs-subtabs") !== null).toBe(true);
  });

  // Nothing on paper needs a panel, and the space it held is a third of the
  // page.
  it("prints without the tree or the margin it held", async () => {
    const { customStyles } = await import("../src/html/styles");
    // The selector list itself: there is more than one @media print block, and
    // the tree is named twice inside the one that matters, so a search scoped
    // by position passes on the wrong occurrence.
    expect(customStyles).toContain(".rs-outline,\n  .rs-navtree,\n  .rs-palette-overlay {");
    expect(customStyles).toContain(".rs-app.rs-book.rs-outline-open .rs-main { margin-left: 0; }");
  });

  // The front matter is NOT a line of the tree: the path's root goes there,
  // from the sticky bar, which works with this panel hidden. Two entries to one
  // page under two different names is the duplication this document keeps
  // shedding.
  it("lists the chapters and their documents, and nothing else", () => {
    const host = mount({ ...MODEL, metadata: { title: "t", project: "p", version: "1" } } as unknown as ParameterSheetInput, "#overview");
    expect(rows(host)).not.toContain("概要");
  });

  // With a hundred entries the current one is often outside the panel's own
  // scroll: a jump then lands on a highlight nobody can see, which is the same
  // failure as landing in a collapsed chapter, one scroll further out.
  it("brings the current entry into view", async () => {
    const seen: unknown[] = [];
    const host = mount(MODEL, "#1");
    await new Promise((r) => setTimeout(r, 60));
    const current = host.querySelector(".rs-navtree-current") as HTMLElement & { scrollIntoView: unknown };
    // happy-dom has no scrolling; what is pinned is that the tree ASKS for it.
    (current as unknown as { scrollIntoView: (o: unknown) => void }).scrollIntoView = (o: unknown) => seen.push(o);
    const os = [...host.querySelectorAll("a.rs-navtree-item")].find((a) => (a.textContent ?? "").includes("OS 設定"))!;
    (os as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 60));
    const next = host.querySelector(".rs-navtree-current");
    expect((next?.textContent ?? "").includes("OS 設定")).toBe(true);
  });

  // Every copy of every generated file opened from a file:// URL shares one
  // storage area. Under one key, the chapters a reader collapsed in one
  // document silently applied to the next one they opened — and chapter names
  // repeat across documents, so what it collapsed there was arbitrary.
  it("remembers what was collapsed per document, not per browser", async () => {
    const host = mount(MODEL, "#1");
    await new Promise((r) => setTimeout(r, 60));
    // By its row, since sheets carry a caret too now (their own headings).
    const row = [...host.querySelectorAll(".rs-navtree-row")].find((r) => (r.textContent ?? "").includes("構築") && !(r.textContent ?? "").includes("手順"))!;
    const caret = row.querySelector("button.rs-navtree-caret") as HTMLElement;
    caret.click();
    await new Promise((r) => setTimeout(r, 60));
    // Written under THIS document's key, and under no shared one.
    expect(closedNow()).toContain("group:build");
    expect(localStorage.getItem("rs-nav-collapsed")).toBeNull();
  });

  // What a document CONTAINS is visible without going to it: every sheet shows
  // its own sections, folded only where the reader folded them — the way a
  // navigation pane behaves everywhere else.
  const headings = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-navtree-heading .rs-navtree-label")].map((e) => (e.textContent ?? "").trim());

  it("shows every sheet's sections, not only those of the one being read", () => {
    const host = mount(MODEL, "#3");
    expect(headings(host)).toHaveLength(3); // one per sheet in the fixture
  });

  it("folds one sheet's sections where the reader folds it, and no other's", async () => {
    const host = mount(MODEL, "#3");
    const row = [...host.querySelectorAll(".rs-navtree-row")].find((r) => (r.textContent ?? "").includes("要件一覧"))!;
    (row.querySelector("button.rs-navtree-caret") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 60));
    expect(headings(host)).toHaveLength(2);
    expect(closedNow()).toEqual(["sheet:要件一覧"]);
    // …and the reader has not left the sheet they were on.
    expect(host.querySelector(".rs-navtree-current .rs-navtree-label")?.textContent).toContain("OS 設定");
  });

  // Folded or not, the sheet being READ shows its sections — the same rule that
  // opens the chapter a jump lands in.
  it("shows the sections of the sheet being read even when it was folded", async () => {
    localStorage.setItem(collapseKey(), JSON.stringify({ closed: ["sheet:OS 設定"] }));
    const host = mount(MODEL, "#3");
    await new Promise((r) => setTimeout(r, 60));
    // All three, not two: the folded one is the one being read, and it shows.
    expect(headings(host)).toHaveLength(3);
  });

  it("stays a tab strip for a document that does not say otherwise", () => {
    const { nav: _nav, ...tabs } = MODEL as unknown as Record<string, unknown>;
    const host = mount(tabs as unknown as ParameterSheetInput);
    expect(host.querySelector(".rs-navtree") !== null).toBe(false);
    expect(host.querySelector(".rs-tabs-left") !== null).toBe(true);
  });
});

// The panel is 19rem wide and the tree is four levels deep before a heading
// starts, so what an indent costs is the width the words have left.
describe("what the tree spends on indenting", () => {
  // The indent is what carries the hierarchy now that the number is part of the
  // name — the way a word processor's navigation pane sets a numbered outline —
  // so it is a character a level again, not the half-step it was shrunk to when
  // a number column was also paying for depth.
  it("indents by about a character a level", async () => {
    const { customStyles } = await import("../src/html/styles");
    const rule = customStyles.slice(customStyles.indexOf(".rs-navtree-row {"));
    // The step, read past the var() the calc is built from — its own closing
    // paren is what a lazier pattern stops at.
    const step = Number(/--rs-nav-depth[^)]*\)\s*\*\s*([\d.]+)rem/.exec(rule.slice(0, rule.indexOf("}")))?.[1] ?? "9");
    expect(step).toBeGreaterThanOrEqual(0.7);
    expect(step).toBeLessThanOrEqual(1);
  });

  // The fold control is a control, not punctuation: a text triangle repeated
  // down a hundred rows is what a reader called ・.
  it("folds with a drawn chevron, not a text triangle", () => {
    const host = mount(MODEL, "#1");
    const tree = host.querySelector(".rs-navtree")!;
    expect((tree.textContent ?? "").includes("▾")).toBe(false);
    expect((tree.textContent ?? "").includes("▸")).toBe(false);
    expect(tree.querySelectorAll("button.rs-navtree-caret svg.rs-caret").length).toBeGreaterThan(0);
  });

  // A heading has nothing to fold, so the room a caret would take is the room
  // its words get instead.
  it("gives a heading no room for a caret it does not have", async () => {
    const { customStyles } = await import("../src/html/styles");
    expect(customStyles).toContain(".rs-navtree-heading .rs-navtree-caret { display: none; }");
  });

  // A document's fourth-level heading is still a heading of THIS document.
  it("stops indenting a document's own sections after two levels", () => {
    const deep = {
      ...MODEL,
      sheets: [
        {
          name: "OS 設定",
          group: "params",
          instances: [],
          categories: [
            {
              name: "a",
              params: [{ key: "k1", description: { ja: "d", en: "d" }, value: "1" }],
              categories: [
                {
                  name: "b",
                  params: [{ key: "k2", description: { ja: "d", en: "d" }, value: "1" }],
                  categories: [{ name: "c", params: [{ key: "k3", description: { ja: "d", en: "d" }, value: "1" }] }],
                },
              ],
            },
          ],
        },
      ],
    } as unknown as ParameterSheetInput;
    const host = mount(deep, "#1");
    const depthOf = (e: Element): number => Number(/--rs-nav-depth:\s*(\d+)/.exec(e.getAttribute("style") ?? "")?.[1] ?? "-1");
    // Counted from the DOCUMENT, not from the panel: the block already begins
    // where the document's own name does. Three levels of section in the
    // fixture, and the third indents no further than the second.
    expect([...host.querySelectorAll(".rs-navtree-heading")].map(depthOf)).toEqual([0, 1, 2]);
  });
});

// Folding a chapter is not going anywhere. The panel brings the sheet being
// READ into view, which is right on a jump and wrong on a fold: a reader who
// has scrolled down to chapter 5 and opens one of its chapters was thrown back
// to wherever chapter 1 is, every time — measured in a real browser as a
// scrollTop of 4546 becoming 49.
describe("what the panel scrolls for", () => {
  // The panel scrolls ITSELF now — never scrollIntoView, which would take the
  // page behind it along — so what is watched is what it writes to its own
  // scrollTop. Rects are all zero in this DOM, so the two elements the decision
  // is made from are given the geometry the case is about.
  type Rect = { top: number; bottom: number };
  const rect = (el: Element, r: Rect): void => {
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ top: r.top, bottom: r.bottom, height: r.bottom - r.top, left: 0, right: 0, width: 0, x: 0, y: r.top, toJSON: () => ({}) }) as DOMRect;
  };
  const watch = (host: HTMLElement, rowRect: Rect): number[] => {
    const body = host.querySelector(".rs-navtree-body") as HTMLElement;
    rect(body, { top: 0, bottom: 400 });
    // EVERY row, not the one that is current now: arriving somewhere makes a
    // different row the current one, and a rect given only to today's would
    // leave tomorrow's at zero — which is "already visible" by accident. The
    // wrapper each row sits in gets the same, since that BLOCK is what the
    // decision is made on.
    for (const row of host.querySelectorAll(".rs-navtree-row")) {
      rect(row, rowRect);
      if (row.parentElement !== null) rect(row.parentElement, rowRect);
    }
    const writes: number[] = [];
    Object.defineProperty(body, "scrollTop", { configurable: true, get: () => 0, set: (v: number) => { writes.push(v); } });
    return writes;
  };

  it("does not chase the current sheet when a reader folds a chapter", () => {
    let host!: HTMLElement;
    act(() => { host = mount(MODEL, "#1"); });
    // Far below the panel, so nothing but the rule itself decides.
    const writes = watch(host, { top: 900, bottom: 920 });
    const caret = host.querySelectorAll("button.rs-navtree-caret")[1] as HTMLElement;
    act(() => { caret.click(); });
    expect(closedNow()).not.toEqual([]);
    expect(writes).toEqual([]);
  });

  // …and the other half, or "does not chase" would be satisfied by a panel that
  // never scrolls at all: arriving at a sheet still brings its row into view.
  it("brings the sheet a reader arrives at into view", () => {
    let host!: HTMLElement;
    act(() => { host = mount(MODEL, "#1"); });
    const writes = watch(host, { top: 900, bottom: 920 });
    const other = [...host.querySelectorAll(".rs-navtree-item")].find((a) => (a.textContent ?? "").includes("OS 設定")) as HTMLElement;
    act(() => { other.click(); });
    expect(writes.length).toBeGreaterThan(0);
  });

  // A row already on screen is left alone — the panel is where the reader put
  // it, and moving it to say something they can already see is the fold case
  // over again.
  it("leaves the panel alone when the row is already visible", () => {
    let host!: HTMLElement;
    act(() => { host = mount(MODEL, "#1"); });
    const writes = watch(host, { top: 10, bottom: 30 });
    const other = [...host.querySelectorAll(".rs-navtree-item")].find((a) => (a.textContent ?? "").includes("OS 設定")) as HTMLElement;
    act(() => { other.click(); });
    expect(writes).toEqual([]);
  });
});

// Where the panel goes on a load. ONE source of truth: the address, which
// app.ts keeps current as `#<sheet>/<section>` while the reader reads. Four
// earlier rounds kept a second one — a stored panel position — and every load
// then had to choose between them; each rule for choosing was right about one
// case and wrong about the next.
describe("what the panel is aimed at", () => {
  const rectOf = (t: number, b: number): DOMRect =>
    ({ top: t, bottom: b, height: b - t, left: 0, right: 0, width: 0, x: 0, y: t, toJSON: () => ({}) }) as DOMRect;

  // The document's own row sits at 300, its sections at 900, so which one the
  // panel aimed at is readable from the number it wrote.
  const mountAimed = (hash: string): number[] => {
    const writes: number[] = [];
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this.classList.contains("rs-navtree-body")) return rectOf(0, 400);
      if (this.classList.contains("rs-navtree-heading")) return rectOf(900, 920);
      if (this.classList.contains("rs-navtree-row")) return rectOf(300, 320);
      return origRect.call(this);
    };
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true, get: () => 0, set: (v: number) => { writes.push(v); },
    });
    try {
      act(() => { mount(MODEL, hash); });
    } finally {
      Element.prototype.getBoundingClientRect = origRect;
      if (orig) Object.defineProperty(HTMLElement.prototype, "scrollTop", orig);
      else delete (HTMLElement.prototype as unknown as { scrollTop?: unknown }).scrollTop;
    }
    return writes;
  };

  // The id a section row answers to, taken from the tree itself rather than
  // guessed: it is whatever the document's own heading produced.
  const someSectionId = (): string => {
    const host = mount(MODEL, "#1");
    const id = host.querySelector(".rs-navtree-heading[data-nav-id]")?.getAttribute("data-nav-id") ?? "";
    render(null, host);
    host.remove();
    return id;
  };

  it("puts the section the address names as near the top as it goes", () => {
    const id = someSectionId();
    expect(id).not.toBe("");
    // 900 (the section row) - 0 (the panel) - 8 of air.
    expect(mountAimed(`#1/${encodeURIComponent(id)}`)).toEqual([892]);
  });

  it("aims at the document when the address names only a document", () => {
    expect(mountAimed("#1")).toEqual([292]);
  });

  // A section the document no longer has is a stale link: it falls back to the
  // document rather than leaving the panel wherever it happened to be.
  it("falls back to the document for a section that is gone", () => {
    expect(mountAimed("#1/nothing-here")).toEqual([292]);
  });

  it("keeps nothing about where the panel is scrolled", async () => {
    const host = mount(MODEL, "#1");
    const body = host.querySelector(".rs-navtree-body") as HTMLElement;
    Object.defineProperty(body, "scrollTop", { configurable: true, get: () => 640, set: () => {} });
    body.dispatchEvent(new Event("scroll"));
    await new Promise((r) => setTimeout(r, 300));
    expect(JSON.parse(localStorage.getItem(collapseKey()) ?? "{}")).not.toHaveProperty("scroll");
  });
});

// The panel does not move on a resume, so something else has to answer "where
// am I" when the document being read is off this panel. A marker on the edge it
// went past: it costs the reader nothing, and pressing it is an explicit act,
// which is the only kind of act that may move the list.
describe("the marker at the panel's edge", () => {
  const withBlock = (top: number, bottom: number): { host: HTMLElement; writes: number[]; restore: () => void } => {
    const rectOf = (t: number, b: number): DOMRect =>
      ({ top: t, bottom: b, height: b - t, left: 0, right: 0, width: 0, x: 0, y: t, toJSON: () => ({}) }) as DOMRect;
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this.classList.contains("rs-navtree-body")) return rectOf(0, 400);
      if (this.firstElementChild?.classList.contains("rs-navtree-row")) return rectOf(top, bottom);
      if (this.classList.contains("rs-navtree-row")) return rectOf(top, top + 20);
      return origRect.call(this);
    };
    const writes: number[] = [];
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true, get: () => 0, set: (v: number) => { writes.push(v); },
    });
    let host!: HTMLElement;
    act(() => { host = mount(MODEL, "#1"); });
    return {
      host, writes,
      restore: () => {
        Element.prototype.getBoundingClientRect = origRect;
        if (orig) Object.defineProperty(HTMLElement.prototype, "scrollTop", orig);
        else delete (HTMLElement.prototype as unknown as { scrollTop?: unknown }).scrollTop;
      },
    };
  };
  const marker = (host: HTMLElement): string | null => host.querySelector(".rs-navtree-away")?.className ?? null;

  it("points down when the document is below the panel", () => {
    const w = withBlock(900, 1200);
    try { expect(marker(w.host)).toContain("rs-navtree-away-down"); } finally { w.restore(); }
  });

  it("points up when the document is above it", () => {
    const w = withBlock(-800, -400);
    try { expect(marker(w.host)).toContain("rs-navtree-away-up"); } finally { w.restore(); }
  });

  it("is not there at all while the document is in view", () => {
    const w = withBlock(50, 300);
    try { expect(marker(w.host)).toBeNull(); } finally { w.restore(); }
  });

  // Labelled with what pressing it DOES, not with the name of a document: every
  // row around it carries a document's name, and the first version of this —
  // full-width, left-aligned, tinted, carrying the name — was a tree row in
  // every respect a reader judges by, so the one thing it had to say was the
  // one thing it did not.
  it("is labelled as the act, not as another row", () => {
    const w = withBlock(900, 1200);
    try {
      const label = w.host.querySelector(".rs-navtree-away-label")?.textContent ?? "";
      expect(label).toBe("現在位置へ");
      expect(label).not.toContain("要件一覧");
    } finally { w.restore(); }
  });

  it("moves the panel when it is pressed, and only then", () => {
    const w = withBlock(900, 1200);
    try {
      // The load aims at the address (the row, less a little air); pressing the
      // marker is a different act, and puts it a third of the way down.
      expect(w.writes).toEqual([892]);          // 900, less a little air
      act(() => { (w.host.querySelector(".rs-navtree-away") as HTMLElement).click(); });
      expect(w.writes).toEqual([892, 900 - 400 / 3]);
    } finally { w.restore(); }
  });
});

// The arrangement survives a rebuild. Folds and a scroll position are not
// edits: an unsaved edit belongs to the copy it was typed into and is keyed to
// a REVISION for that reason, but a reader who folded four chapters and
// scrolled to the ninth has arranged the room, and a regenerated sheet is the
// same room. Keyed to the revision, every rebuild swept it — which while a
// sheet is being built is many times an hour.
describe("what the panel's state is keyed to", () => {
  const meta = (generated: string, rev?: string) => ({
    metadata: { project: "p", version: "current", title: "t", generated_at: generated },
  } as never);

  it("does not change when the document is generated again", () => {
    expect(navStateKey(meta("2026-09-07T00:00:00Z"))).toBe(navStateKey(meta("2026-09-07T09:30:00Z")));
  });

  it("still tells two documents of one project apart", () => {
    const other = { metadata: { project: "p", version: "current", title: "another" } } as never;
    expect(navStateKey(meta("x"))).not.toBe(navStateKey(other));
  });

  // …and it is NOT the key the unsaved edits use, which must keep the revision.
  it("is not the key an edit hangs on", () => {
    const data = meta("2026-09-07T00:00:00Z");
    expect(navStateKey(data)).not.toBe(getStorageKey(data));
  });
});

// WHOSE position the marker is about. A reader inside a long document could
// scroll the section they were reading off the panel and be told nothing,
// because the document's title was still on screen — and the button, when it
// did appear, went to that title rather than to where they had been. Both are
// the same defect: two definitions of "your place".
describe("the place the marker is about", () => {
  const rectOf = (t: number, b: number): DOMRect =>
    ({ top: t, bottom: b, height: b - t, left: 0, right: 0, width: 0, x: 0, y: t, toJSON: () => ({}) }) as DOMRect;

  // The document's title on screen, the section being read far below it.
  const withSectionOffPanel = (): { host: HTMLElement; restore: () => void } => {
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element): DOMRect {
      if (this.classList.contains("rs-navtree-body")) return rectOf(0, 400);
      if (this.classList.contains("rs-navtree-here")) return rectOf(900, 920);
      if (this.classList.contains("rs-navtree-current")) return rectOf(100, 120);
      if (this.firstElementChild?.classList.contains("rs-navtree-row")) return rectOf(100, 1200);
      return origRect.call(this);
    };
    let host!: HTMLElement;
    act(() => { host = mount(MODEL, "#1"); });
    // The scroll-spy marks a section once it has run.
    act(() => { window.dispatchEvent(new Event("scroll")); });
    return { host, restore: () => { Element.prototype.getBoundingClientRect = origRect; } };
  };

  it("appears when the section being read leaves, not when the title does", () => {
    const w = withSectionOffPanel();
    try {
      expect(w.host.querySelector(".rs-navtree-here")).not.toBeNull();
      expect(w.host.querySelector(".rs-navtree-away")?.className ?? "").toContain("rs-navtree-away-down");
    } finally { w.restore(); }
  });
});
