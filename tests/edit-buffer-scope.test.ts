// Which document a browser's unsaved work belongs to.
//
// Unsaved edits live in localStorage until the file is written. The key was
// derived from the document's METADATA — project, version, generated_at — which
// is identical in every copy of one generated document. Two copies of the same
// sheet therefore shared one buffer: edit one without saving, open the other,
// and the first one's work is sitting in it, ready to be saved into the wrong
// file.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root, getStorageKey } from "../src/html/app";
import type { ParameterSheetInput, ReviewItem, SaveRecord } from "../src/types";

const SHEET: ParameterSheetInput = {
  metadata: { title: "t", project: "p", version: "1", generated_at: "2026-08-18T00:00:00Z" },
  sheets: [{ name: "db", categories: [{ name: "接続", params: [{ key: "max_connections", value: "500" }] }] }],
};
const PAYLOAD = { metadata: SHEET.metadata, versions: [{ version: "current", sheets: SHEET.sheets }] };

const edit = (id: string, suggested: string): ReviewItem => ({
  id,
  target: { sheet: "db", category: "接続", param: "max_connections", field: "value" },
  changes: [{ field: "value", suggested }],
  status: "applied",
  at: "2026-08-18T01:00:00Z",
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

// One "file": what it carries embedded, and what it renders.
function open_(embedded: { reviews: ReviewItem[]; saves: SaveRecord[] }): HTMLElement {
  location.hash = "#1";
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    h(Root, {
      payload: PAYLOAD,
      reviewEnabled: false,
      editEnabled: true,
      initialLang: "ja",
      server: false,
      pristineHtml: '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
      embedded,
    }),
    host
  );
  return host;
}

const valueShown = (host: HTMLElement): string => {
  const rows = [...host.querySelectorAll("tbody tr")];
  const row = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === "max_connections");
  return row?.querySelector(".rs-col-value")?.textContent ?? "";
};

const save = (id: string, at: string): SaveRecord => ({ id, at, changes: 1 });

// What a session leaves behind: the app writes its reviews to localStorage on
// every change, so an edit made and NOT saved sits there under this document's
// key. Seeded directly, because that is exactly the state the next `open_` has
// to survive — and driving the dialog to produce it would test the dialog, not
// the scoping.
function leaveUnsavedWork(item: ReviewItem, key: string): void {
  localStorage.setItem(key, JSON.stringify([item]));
}

// The key the running app uses, asked of the app itself rather than spelled out
// here: the viewer rewrites version/generated_at per displayed version, so a
// hand-written key would pass while testing nothing.
const keyFor = (rev: string): string =>
  getStorageKey(
    { metadata: { ...SHEET.metadata, version: "current", generated_at: undefined }, sheets: [] },
    [save(rev, "2026-08-18T02:00:00Z")]
  );

const A = { reviews: [] as ReviewItem[], saves: [save("r1", "2026-08-18T02:00:00Z")] };
const B = { reviews: [] as ReviewItem[], saves: [save("r2", "2026-09-02T02:00:00Z")] };

describe("unsaved work belongs to one file", () => {

  it("does not carry one copy's unsaved edit into another", () => {
    leaveUnsavedWork(edit("rev_a", "700"), keyFor("r1"));
    // The second copy of the same generated document — same project, version
    // and generated_at, a different file with its own history.
    expect(valueShown(open_(B))).toContain("500");
  });

  it("gives a copy its own work back when it is reopened", () => {
    leaveUnsavedWork(edit("rev_a", "700"), keyFor("r1"));
    expect(valueShown(open_(A))).toContain("700");
  });
});

// Loading it is not a choice — offering to restore or discard was tried and is
// worse, because a discard button is an irreversible action beside the safe one
// and "later" lets two working states exist at once. What is left is to SAY the
// document is not what the file says.
describe("the document says what it is holding", () => {
  const overview = (embedded: { reviews: ReviewItem[]; saves: SaveRecord[] }): HTMLElement => {
    location.hash = "#overview";
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: PAYLOAD, reviewEnabled: false, editEnabled: true, initialLang: "ja", server: false,
        pristineHtml: '<!DOCTYPE html><html><body><div id="app"></div></body></html>',
        embedded,
      }),
      host
    );
    return host;
  };

  it("says on open how much came from this browser rather than the file", () => {
    leaveUnsavedWork(edit("rev_a", "700"), keyFor("r1"));
    const host = overview({ reviews: [], saves: [save("r1", "2026-08-18T02:00:00Z")] });
    expect(host.querySelector(".rs-toast")?.textContent).toContain("読み込みました");
  });

  it("says nothing on open when the file and the screen agree", () => {
    const carried = edit("rev_a", "700");
    const host = overview({ reviews: [carried], saves: [save("r1", "2026-08-18T02:00:00Z")] });
    expect(host.querySelector(".rs-toast")).toBeNull();
  });

  // Below 960px the toolbar labels collapse. The word goes with them; the count
  // must not — it is the one thing on the bar saying the file is behind.
  it("keeps the count beside the save icon, where the collapsing label cannot take it", () => {
    leaveUnsavedWork(edit("rev_a", "700"), keyFor("r1"));
    const host = overview({ reviews: [], saves: [save("r1", "2026-08-18T02:00:00Z")] });
    expect(host.querySelector(".rs-btn-count")?.textContent).toBe("(1)");
  });

  it("shows no count when the file is up to date", () => {
    const carried = edit("rev_a", "700");
    const host = overview({ reviews: [carried], saves: [save("r1", "2026-08-18T02:00:00Z")] });
    expect(host.querySelector(".rs-btn-count")).toBeNull();
  });
});
