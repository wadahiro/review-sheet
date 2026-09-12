// The whole point of the edit model is that it ACCUMULATES: the delivered value
// stays reachable and every step between it and the current one is on record.
// These pin that down, because a "simplification" that keeps only the newest
// entry would still look correct on screen.

import { describe, it, expect } from "bun:test";
import { sortEdits, isEditableField, targetKey, planFromEdits, promptItemsFromPlan } from "../src/edits";
import { HELD_REASON_NOTE } from "../src/prompt";
import type { SheetData, ReviewItem } from "../src/prompt";

const sheets = (): SheetData["sheets"] => [
  {
    name: "DB",
    categories: [
      {
        name: "接続",
        params: [
          { key: "max_connections", value: "500", remarks: "納品時のまま" },
          { key: "shared_buffers", value: "4GB" },
        ],
        categories: [],
      },
    ],
  },
];

const edit = (o: Partial<ReviewItem> & { param: string; suggested: string; field?: string; at?: string; by?: string; lang?: "ja" | "en"; instance?: string }): ReviewItem => ({
  id: o.id ?? `rev_${o.param}_${o.at ?? o.suggested}`,
  target: { sheet: "DB", category: "接続", param: o.param, instance: o.instance, field: o.field ?? "value" },
  changes: [{ field: o.field ?? "value", suggested: o.suggested, lang: o.lang }],
  status: "applied",
  at: o.at,
  by: o.by,
});

describe("sortEdits", () => {
  // An imported review.json lands at the end of the array whatever its dates
  // say, so append order alone would misreport the history.
  it("orders by timestamp, falling back to append order when undated", () => {
    const a = edit({ param: "p", suggested: "a" });
    const b = edit({ param: "p", suggested: "b" });
    expect(sortEdits([a, b]).map((e) => e.changes![0].suggested)).toEqual(["a", "b"]);
  });
});

describe("field policy", () => {
  it("allows only value and remarks", () => {
    expect(isEditableField("value")).toBe(true);
    expect(isEditableField("remarks")).toBe(true);
    for (const f of ["key", "description", "default"]) expect(isEditableField(f)).toBe(false);
  });
});

describe("targetKey", () => {
  it("excludes the field", () => {
    expect(targetKey({ sheet: "S", category: "C", param: "p", field: "value" })).toBe("S::C::p");
  });
});

// A paragraph written beside a section is documentation, not a value: nothing
// can apply it deterministically, so it travels to whoever holds the project's
// own sheet.yml — through the prompt, like every other held item.
describe("a note in an edit plan", () => {
  const note = (text: string): ReviewItem => ({
    id: "n1",
    target: { sheet: "db", category: "メモリ", field: "note" },
    changes: [{ field: "note", current: "", suggested: text }],
    status: "applied",
    at: "2026-01-01T00:00:00Z",
  });

  it("reaches whoever applies the sheet", () => {
    const items = promptItemsFromPlan(planFromEdits([note("この節は本番だけ効く。")]), {
      added: "A",
      struck: "S",
      document: "D",
    });
    expect(items.map((i) => i.comment).join("\n")).toContain(HELD_REASON_NOTE);
    expect(items[0].changes?.[0].suggested).toBe("この節は本番だけ効く。");
  });
});
