// Saving rewrites the delivered document in place. If this is wrong, the
// recipient loses either the history or the whole file, and finds out later.

// The same registration the viewer tests use. Assigning only DOMParser/document
// onto globalThis left a half-built environment behind for whatever file bun
// ran next in the same process — localStorage and location were missing, and
// the viewer tests failed with no connection to what broke them.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect } from "bun:test";
import { withEmbeddedHistory, readEmbeddedHistory, parseHistory, embedJson, suggestedFileName } from "../src/html/save";
import type { ReviewItem } from "../src/prompt";

const PAGE = `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>シート</title><style>.a{color:red}</style></head>
<body>
<div id="app"></div>
<script type="application/json" id="sheet-data">
{"metadata":{"title":"シート"}}
</script>
<script type="application/json" id="sheet-reviews">
[]
</script>
<script type="module">console.log("app")</script>
</body>
</html>`;

const withHistory = (pristine: string, reviews: ReviewItem[]): string => withEmbeddedHistory(pristine, { reviews, saves: [] });

const edit = (id: string, suggested: string): ReviewItem => ({
  id,
  target: { sheet: "DB", category: "接続", param: "max_connections", field: "value" },
  changes: [{ field: "value", current: "500", suggested }],
  status: "applied",
  at: "2026-08-18T00:00:00Z",
  by: "田中",
});

describe("withEmbeddedReviews", () => {
  it("round-trips the history through the saved file", () => {
    const saved = withHistory(PAGE, [edit("rev_a", "700")]);
    const doc = new DOMParser().parseFromString(saved, "text/html");
    expect(readEmbeddedHistory(doc).reviews.map((r: ReviewItem) => r.changes![0].suggested)).toEqual(["700"]);
  });

  it("keeps the rest of the document — it is still the whole sheet", () => {
    const saved = withHistory(PAGE, [edit("rev_a", "700")]);
    expect(saved).toContain("<!DOCTYPE html>");
    expect(saved).toContain('lang="ja"');
    expect(saved).toContain(".a{color:red}");
    expect(saved).toContain('console.log("app")');
    expect(saved).toContain('"metadata"');
  });

  it("saves again over an already-saved file without doubling the block", () => {
    const once = withHistory(PAGE, [edit("rev_a", "700")]);
    const twice = withHistory(once, [edit("rev_a", "700"), edit("rev_b", "800")]);
    expect(twice.split("sheet-reviews").length - 1).toBe(1);
    const doc = new DOMParser().parseFromString(twice, "text/html");
    expect(readEmbeddedHistory(doc).reviews).toHaveLength(2);
  });

  // A remarks field is free text. Typing a closing script tag into one must not
  // be able to cut the document in half at the point its data begins.
  it("cannot be broken by a closing script tag in the data", () => {
    const nasty = edit("rev_a", "</script><h1>gotcha</h1>");
    const saved = withHistory(PAGE, [nasty]);
    expect(saved).not.toContain("<h1>gotcha</h1>");
    const doc = new DOMParser().parseFromString(saved, "text/html");
    expect(readEmbeddedHistory(doc).reviews[0].changes![0].suggested).toBe("</script><h1>gotcha</h1>");
  });

  it("adds the slot when the document was generated without editing", () => {
    const noSlot = PAGE.replace(/<script type="application\/json" id="sheet-reviews">\n\[\]\n<\/script>\n/, "");
    expect(noSlot).not.toContain("sheet-reviews");
    const doc = new DOMParser().parseFromString(withHistory(noSlot, [edit("rev_a", "700")]), "text/html");
    expect(readEmbeddedHistory(doc).reviews).toHaveLength(1);
  });
});

describe("readEmbeddedReviews", () => {
  it("returns nothing rather than throwing on a corrupted block", () => {
    const doc = new DOMParser().parseFromString(PAGE.replace("[]", "{not json"), "text/html");
    expect(readEmbeddedHistory(doc).reviews).toEqual([]);
  });
});

describe("embedJson", () => {
  it("escapes every < so no tag can be closed from inside the data", () => {
    expect(embedJson({ a: "<b>" })).not.toContain("<");
  });
});

describe("suggestedFileName", () => {
  it("keeps the name the recipient already has", () => {
    expect(suggestedFileName("file:///Users/x/パラメータ.html", "sheet.html")).toBe("パラメータ.html");
    expect(suggestedFileName("https://example.com/a/b/sheet.html?v=2", "sheet.html")).toBe("sheet.html");
    expect(suggestedFileName("https://example.com/", "sheet.html")).toBe("sheet.html");
  });
});

describe("the save log", () => {
  const rec = { at: "2026-08-18T00:00:00Z", by: "田中", comment: "接続上限に達したため", changes: 2 };

  it("travels with the document", () => {
    const saved = withEmbeddedHistory(PAGE, { reviews: [edit("rev_a", "700")], saves: [rec] });
    const doc = new DOMParser().parseFromString(saved, "text/html");
    expect(readEmbeddedHistory(doc).saves).toEqual([rec]);
  });

  it("accumulates across saves", () => {
    const once = withEmbeddedHistory(PAGE, { reviews: [], saves: [rec] });
    const twice = withEmbeddedHistory(once, { reviews: [], saves: [rec, { ...rec, at: "2026-09-02T00:00:00Z", comment: "戻した" }] });
    const doc = new DOMParser().parseFromString(twice, "text/html");
    expect(readEmbeddedHistory(doc).saves.map((s) => s.comment)).toEqual(["接続上限に達したため", "戻した"]);
  });
});

// A file saved by the first version of this feature holds a bare array. Reading
// it as "no history" would throw away exactly what the feature exists to keep.
describe("older saved files", () => {
  it("still yields their edits", () => {
    const h = parseHistory(JSON.stringify([edit("rev_a", "700")]));
    expect(h.reviews).toHaveLength(1);
    expect(h.saves).toEqual([]);
  });
});

// The rewrite is a splice, not a parse — that is what stopped the page freezing
// on a large document — so the cheap-but-wrong failure modes get pinned here.
describe("rewriting is exact", () => {
  const rec = { at: "2026-08-18T00:00:00Z", by: "田中", comment: "接続上限に達したため", changes: 2 };

  it("does not disturb a single byte outside the block", () => {
    const saved = withEmbeddedHistory(PAGE, { reviews: [], saves: [] });
    const before = PAGE.slice(0, PAGE.indexOf('id="sheet-reviews"'));
    expect(saved.startsWith(before)).toBe(true);
    expect(saved.endsWith(PAGE.slice(PAGE.indexOf("</script>\n<script type=\"module\">")))).toBe(true);
  });

  it("stays fast on a document the size of a real sheet", () => {
    const big = PAGE.replace("<div id=\"app\"></div>", "<div id=\"app\"></div>" + "<!-- " + "x".repeat(400_000) + " -->");
    const start = performance.now();
    const saved = withEmbeddedHistory(big, { reviews: [edit("rev_a", "700")], saves: [rec] });
    // Generous by two orders of magnitude: this is a regression guard against
    // going back to parsing the document, not a benchmark.
    expect(performance.now() - start).toBeLessThan(150);
    expect(saved.length).toBeGreaterThan(400_000);
  });
});
