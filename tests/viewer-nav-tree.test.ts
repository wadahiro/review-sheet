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
import { Root } from "../src/html/app";
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
// Remembered per DOCUMENT: every copy of every generated file opened from a
// file:// URL shares one storage area, so a single key let one document's
// collapsed chapters apply to the next one opened — under names that repeat
// across documents. Same key as the unsaved edits (getStorageKey).
// The payload's version label reaches the key (getStorageKey reads
// metadata.version, which Root fills from the shown version).
const collapseKey = (): string => "rs-nav-collapsed:review-sheet::current:";
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
  const scrolls = (): { calls: number; restore: () => void } => {
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
    const before = proto.scrollIntoView;
    const state = { calls: 0, restore: () => { if (had) proto.scrollIntoView = before; else delete proto.scrollIntoView; } };
    proto.scrollIntoView = () => { state.calls += 1; };
    return state;
  };

  it("does not chase the current sheet when a reader folds a chapter", () => {
    const spy = scrolls();
    try {
      // Preact defers an effect to after paint, so the baseline is taken only
      // once act() has flushed the mount's own — otherwise the assertion would
      // compare against a count nothing had reached yet.
      let host!: HTMLElement;
      act(() => { host = mount(MODEL, "#1"); });
      const first = spy.calls;
      expect(first).toBeGreaterThan(0);
      // Another chapter's fold — it says nothing about which sheet is read.
      const caret = host.querySelectorAll("button.rs-navtree-caret")[1] as HTMLElement;
      act(() => { caret.click(); });
      expect(closedNow()).not.toEqual([]);
      expect(spy.calls).toBe(first);
    } finally {
      spy.restore();
    }
  });

  // …and the other half, or "does not chase" would be satisfied by a panel that
  // never scrolls at all: arriving at a sheet still brings its row into view.
  it("brings the sheet a reader arrives at into view", () => {
    const spy = scrolls();
    try {
      let host!: HTMLElement;
      act(() => { host = mount(MODEL, "#1"); });
      const first = spy.calls;
      const other = [...host.querySelectorAll(".rs-navtree-item")].find((a) => (a.textContent ?? "").includes("OS 設定")) as HTMLElement;
      act(() => { other.click(); });
      expect(spy.calls).toBeGreaterThan(first);
    } finally {
      spy.restore();
    }
  });
});
