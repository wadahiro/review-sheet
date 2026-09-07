// The chapters of a document SET, beside the text.
//
// The unit under test is the TREE the viewer draws: which lines it has, in what
// order, at what depth, numbered how. The rendering is checked through the real
// app (viewer tests) — this pins the structure, because the structure is what a
// reader navigates by and what the numbers are derived from.

import { describe, it, expect } from "bun:test";
import { treeEntries } from "../src/html/nav-tree";
import { customStyles } from "../src/html/styles";
import type { SheetData, SheetGroupData } from "../src/prompt";

const sheet = (name: string, group?: string) => ({ name, ...(group ? { group } : {}), categories: [] });
const sheets = [
  sheet("要件一覧", "requirements"),
  sheet("OS 設定", "params"),
  sheet("SSO 設定", "params"),
  sheet("構築手順", "build"),
] as unknown as SheetData["sheets"];

const GROUPS: SheetGroupData[] = [
  { name: "requirements", label: { ja: "要件定義", en: "Requirements" } },
  { name: "build", label: { ja: "構築", en: "Build" }, groups: [{ name: "params", label: { ja: "パラメータ", en: "Parameters" } }] },
];

describe("the chapter tree", () => {
  const entries = treeEntries(GROUPS, sheets, "ja");

  // A chapter's own sheets come FIRST, before its child chapters: that is the
  // order a document is written in — an introduction, then the sections.
  it("reads a chapter's own sheets before the chapters inside it", () => {
    expect(entries.map((e) => `${e.number} ${e.label}`)).toEqual([
      "1 要件定義",
      "1.1 要件一覧",
      "2 構築",
      "2.1 構築手順",
      "2.2 パラメータ",
      "2.2.1 OS 設定",
      "2.2.2 SSO 設定",
    ]);
  });

  it("indents by the depth it sits at", () => {
    expect(entries.map((e) => e.depth)).toEqual([0, 1, 0, 1, 1, 2, 2]);
  });

  it("carries which sheet each line opens, and nothing on a chapter", () => {
    expect(entries.filter((e) => e.kind === "sheet").map((e) => e.index)).toEqual([0, 3, 1, 2]);
    expect(entries.filter((e) => e.kind === "group").every((e) => e.index === undefined)).toBe(true);
  });

  // Collapsing a chapter hides everything beneath it, at any depth — so each
  // one knows what is inside it, not merely what is directly under it.
  it("knows everything a chapter holds, however deep", () => {
    const build = entries.find((e) => e.label === "構築")!;
    expect(build.contains).toEqual(["sheet:構築手順", "group:params", "sheet:OS 設定", "sheet:SSO 設定"]);
  });

  it("takes each sheet's own label in the reader's language", () => {
    expect(treeEntries(GROUPS, sheets, "en").map((e) => e.label)).toContain("Parameters");
  });

  // A document that declares no chapters is still a list, and still reads
  // better as one than as a strip once it is long.
  it("lists the sheets flat when the document has no chapters", () => {
    const flat = treeEntries(undefined, sheets, "ja");
    expect(flat.map((e) => e.number)).toEqual(["1", "2", "3", "4"]);
    expect(flat.every((e) => e.kind === "sheet")).toBe(true);
  });

  // Impossible while assemble checks both directions — and listed rather than
  // dropped if it ever becomes possible, because a sheet that is in the
  // document and in no chapter is a sheet nobody can reach.
  it("still lists a sheet whose chapter is not in the tree", () => {
    const stray = [...sheets, sheet("迷子", "nowhere")] as unknown as SheetData["sheets"];
    expect(treeEntries(GROUPS, stray, "ja").map((e) => e.label)).toContain("迷子");
  });
});

// Every entry is an anchor, so pressing on a chapter's name and sweeping it
// made the browser DRAG THE LINK and select nothing — and the names are the one
// thing in this panel a reader copies out of it, into a ticket or a search box.
//
// A PAIR, not two ideas: measured in Chromium against a page of link variants,
// `-webkit-user-drag: none` alone still refuses to select and `user-select:
// text` alone still drags, and only both together restore the selection. So the
// pair is what is guarded here — the failure this catches is somebody deleting
// one of them as redundant, which is exactly what each looks like beside the
// other.
describe("a name a reader can select", () => {
  // Anchored: `.rs-navtree-heading .rs-navtree-item {` ends with the same text,
  // and an unanchored match reads that one instead.
  const ruleFor = (selector: string): string =>
    new RegExp(`^\\${selector} \\{([^}]*)\\}`, "m").exec(customStyles)?.[1] ?? "";

  // The sticky path bar carries the document's own name and is the same kind of
  // row, so it answers to the same pair.
  for (const selector of [".rs-navtree-item", ".rs-crumb"]) {
    it(`keeps both halves of what makes ${selector}'s text selectable`, () => {
      expect(ruleFor(selector)).toContain("-webkit-user-drag: none");
      expect(ruleFor(selector)).toContain("user-select: text");
    });
  }
});
