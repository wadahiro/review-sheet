// The order of the toolbar, pinned as GROUPS.
//
// Frequency and consequence run outward-in: the tools for reading sit nearest
// the content, the actions on the document next, the display toggles at the
// edge, and the one action with consequences last — the slot a dialog puts its
// primary button in. Nothing here asserted order at all before, so a reorder
// (or an accidental one, while adding a button) was invisible.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root } from "../src/html/app";
import { getMessages } from "../src/html/i18n";

const t = getMessages("ja");
const PAYLOAD = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "os",
          instances: ["staging"],
          categories: [{ name: "c", params: [{ key: "k", description: { ja: "d", en: "d" }, value: "1" }] }],
        },
      ],
    },
  ],
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

// What the bar holds, left to right, by what each control SAYS it is.
const order = (opts: { review: boolean }): string[] => {
  location.hash = "#1";
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    h(Root, {
      payload: PAYLOAD as never,
      reviewEnabled: opts.review,
      initialLang: "ja",
      server: false,
    }),
    host
  );
  const said = (el: Element): string =>
    el.getAttribute("title") ?? el.getAttribute("aria-label") ?? (el.textContent ?? "").trim();
  return [...(host.querySelector(".rs-tabs-right")?.children ?? [])].flatMap((el) =>
    el.classList.contains("rs-tabs-sep") ? ["|"] : [label(said(el))]
  );
};

// A control's label without the shortcut a title tacks on — the same trim
// applied on both sides of every comparison below, so this file compares what a
// control IS rather than how its tooltip happens to be punctuated. It used to
// cut at an em dash too, which is what a label listing what it searched had;
// that list is gone (see search-label.test.ts) and so is the cut.
const label = (said: string): string => said.split(" (")[0];

describe("the toolbar's order", () => {
  it("reads: what to show, then what to do, then how it looks", () => {
    const seen = order({ review: false });
    // Filters keep the fixed slot (they carry a count); search sits beside them.
    expect(seen.indexOf(t.filterMenu)).toBeLessThan(seen.indexOf(label(t.navSearchTip)));
    // How it LOOKS comes last: the theme and the language are about the page,
    // not about the document, and they sit after everything that is.
    expect(seen.indexOf(label(t.navSearchTip))).toBeLessThan(seen.indexOf(t.themeToggle));
    // …and the groups are separated, not merely ordered.
    expect(seen.filter((x) => x === "|").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the reading tools first in a review document too", () => {
    const seen = order({ review: true });
    expect(seen.indexOf(t.filterMenu)).toBeLessThan(seen.indexOf(label(t.navSearchTip)));
    expect(seen.indexOf(label(t.navSearchTip))).toBeLessThan(seen.indexOf(t.themeToggle));
  });
});
