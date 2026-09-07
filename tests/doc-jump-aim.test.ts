// Aiming a jump at a heading that STICKS.
//
// scrollIntoView aims at where a box IS, and a section heading's box is
// wherever the scroll has pushed it — a section left far above holds its
// heading at its own bottom edge, so a jump to it landed at the END of the
// section instead of its start (measured in a browser: 5.2k pixels past the
// target). The fix is to suspend the sticking for the aim, which is an ORDER —
// the class has to be on the document AT THE MOMENT the browser measures — so
// that is what is asserted here, from inside the call itself.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root } from "../src/html/app";

const doc = (name: string, id: string) => ({
  name,
  categories: [],
  document: {
    html: `<h2 id="${id}">ツリー</h2>\n<p>x</p>\n`,
    headings: [{ level: 2, text: "ツリー", id }],
  },
});

afterEach(() => {
  // UNMOUNTED, not just emptied: a Preact tree left mounted keeps its window
  // listeners, and this app's scroll-spy writes the fragment — so a root from
  // an earlier case would answer the next case's scroll event and overwrite
  // what it had just written.
  for (const el of [...document.body.children]) render(null, el as HTMLElement);
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("a jump aimed at a sticky heading", () => {
  it("suspends the sticking while the browser measures, and puts it back", async () => {
    const payload = {
      metadata: { title: "t" },
      versions: [{ version: "current", sheets: [doc("a", "h-a"), doc("b", "h-b")] }],
    };
    location.hash = "#1";
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, editEnabled: false, initialLang: "ja", server: false } as never), host);

    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
    const before = proto.scrollIntoView;
    const seen: boolean[] = [];
    proto.scrollIntoView = function (this: Element) {
      seen.push(this.closest(".rs-doc")?.classList.contains("rs-doc-unstuck") === true);
    };
    try {
      const outline = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
      (outline as HTMLElement).click();
      await Promise.resolve();
      const entry = [...host.querySelectorAll(".rs-outline-item")][0] as HTMLElement;
      entry.click();
      // The heading was measured with the sticking off…
      expect(seen).toEqual([true]);
    } finally {
      if (had) proto.scrollIntoView = before;
      else delete proto.scrollIntoView;
    }
    // …and the page is not left in that state, or nothing would stick again.
    expect(host.querySelector(".rs-doc")?.classList.contains("rs-doc-unstuck")).toBe(false);
  });
});

// Choosing a document from the navigation is not the same act as jumping to a
// place inside one, and the scroll is where they differ.
describe("arriving at a document", () => {
  const mount = (): HTMLElement => {
    location.hash = "#1";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const payload = {
      metadata: { title: "t" },
      versions: [{ version: "current", sheets: [doc("a", "h-a"), doc("b", "h-b")] }],
    };
    render(h(Root, { payload, reviewEnabled: true, editEnabled: false, initialLang: "ja", server: false } as never), host);
    return host;
  };

  const spyScroll = (): { tops: unknown[]; restore: () => void } => {
    const before = window.scrollTo;
    const tops: unknown[] = [];
    (window as unknown as { scrollTo: unknown }).scrollTo = (arg: unknown) => { tops.push(arg); };
    return { tops, restore: () => { (window as unknown as { scrollTo: unknown }).scrollTo = before; } };
  };

  // Switching sheets replaces what is on screen and leaves the scroll where it
  // was, so choosing a document while deep inside another one landed that far
  // down the new one — which reads as the click having changed nothing but the
  // header.
  it("opens it at the beginning", async () => {
    const host = mount();
    const spy = spyScroll();
    try {
      const other = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "b");
      (other as HTMLElement).click();
      // The state change renders on a microtask, and the scroll is in the
      // layout effect that render runs.
      await Promise.resolve();
      expect(spy.tops).toEqual([{ top: 0 }]);
    } finally {
      spy.restore();
    }
  });

  // The document ALREADY being read is the same request: a reader who jumped
  // into the middle of it and then clicks its name is asking to go back to the
  // top of it. Held separately from the case above, because the obvious way to
  // write this — scroll when the shown sheet CHANGES — passes that one and does
  // nothing at all here.
  it("opens it at the beginning even when it is the document already shown", async () => {
    const host = mount();
    const spy = spyScroll();
    try {
      const same = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "a");
      (same as HTMLElement).click();
      await Promise.resolve();
      expect(spy.tops).toEqual([{ top: 0 }]);
    } finally {
      spy.restore();
    }
  });

  // …but a jump names a place of its own, and must not be overruled by the
  // arrival: the two would fight, and the one that runs second would win.
  it("leaves the scroll alone when a jump is doing the switching", async () => {
    const host = mount();
    const spy = spyScroll();
    try {
      const outline = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
      (outline as HTMLElement).click();
      await Promise.resolve();
      const entries = [...host.querySelectorAll(".rs-outline-item")] as HTMLElement[];
      // the entry of the sheet that is NOT being shown
      entries[entries.length - 1].click();
      await Promise.resolve();
      expect(spy.tops).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});

// The fragment is this document's ADDRESS. A reload otherwise put the reader
// back at the top of the right sheet, which on a long one is not where they
// were — and the browser cannot help, since it restores a scroll before this
// page has built the content that would make that position exist. A path
// cannot do the job either: a delivered document is opened from a file:// URL,
// where pushState with a path is a SecurityError.
describe("the place inside the document, in the fragment", () => {
  const payload = {
    metadata: { title: "t" },
    versions: [{ version: "current", sheets: [doc("a", "h-a"), doc("b", "h-b")] }],
  };
  const mountAt = (hash: string): HTMLElement => {
    location.hash = hash;
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, editEnabled: false, initialLang: "ja", server: false } as never), host);
    return host;
  };
  // Preact defers an effect to after paint and falls back to a 100ms timer when
  // nothing paints, which is this DOM — so a shorter wait measures the timer,
  // not the app.
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 160));

  it("names the section the reader is in, without a history entry each time", async () => {
    mountAt("#1");
    const pushes: unknown[] = [];
    const push = history.pushState.bind(history);
    (history as unknown as { pushState: unknown }).pushState = (...a: unknown[]) => { pushes.push(a); };
    try {
      window.dispatchEvent(new Event("scroll"));
      await settle();
      expect(decodeURIComponent(location.hash)).toBe("#1/h-a");
      // Scrolling a long document must not fill the back button with sections.
      expect(pushes).toEqual([]);
    } finally {
      (history as unknown as { pushState: unknown }).pushState = push;
    }
  });

  it("lands on the section a fragment names", async () => {
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
    const before = proto.scrollIntoView;
    const hit: string[] = [];
    proto.scrollIntoView = function (this: Element) { hit.push(this.id); };
    try {
      mountAt("#1/h-a");
      await settle();
      expect(hit).toEqual(["h-a"]);
    } finally {
      if (had) proto.scrollIntoView = before;
      else delete proto.scrollIntoView;
    }
  });

  // A fragment naming something this document no longer has stays at the top,
  // which is what a stale link should do — never an error, and never a jump to
  // whatever happens to be first.
  it("does nothing for a section this document no longer has", async () => {
    const proto = Element.prototype as unknown as { scrollIntoView?: () => void };
    const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView");
    const before = proto.scrollIntoView;
    const hit: string[] = [];
    proto.scrollIntoView = function (this: Element) { hit.push(this.id); };
    try {
      mountAt("#1/h-gone");
      await settle();
      expect(hit).toEqual([]);
    } finally {
      if (had) proto.scrollIntoView = before;
      else delete proto.scrollIntoView;
    }
  });
});
