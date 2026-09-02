// The whole point of the edit model is that it ACCUMULATES: the delivered value
// stays reachable and every step between it and the current one is on record.
// These pin that down, because a "simplification" that keeps only the newest
// entry would still look correct on screen.

import { describe, it, expect } from "bun:test";
import { applyEdits, editsForCell, sortEdits, isEditableField, targetKey, deletionHistory, isDeleted, planFromEdits, promptItemsFromPlan } from "../src/edits";
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

describe("applyEdits", () => {
  it("shows the newest value, not the delivered one", () => {
    const r = applyEdits(sheets(), [edit({ param: "max_connections", suggested: "700" })], "ja");
    expect(r.sheets[0].categories[0].params![0].value).toBe("700");
  });

  it("keeps the delivered value reachable as the baseline", () => {
    const r = applyEdits(sheets(), [edit({ param: "max_connections", suggested: "700" })], "ja");
    expect(r.baseline.get("DB::接続::max_connections::value")).toBe("500");
  });

  it("takes the LAST of several edits to one cell, in time order", () => {
    const r = applyEdits(sheets(), [
      edit({ param: "max_connections", suggested: "700", at: "2026-09-02T00:00:00Z" }),
      edit({ param: "max_connections", suggested: "600", at: "2026-08-18T00:00:00Z" }),
    ], "ja");
    expect(r.sheets[0].categories[0].params![0].value).toBe("700");
    // ...and the baseline is still what was delivered, not the intermediate step
    expect(r.baseline.get("DB::接続::max_connections::value")).toBe("500");
  });

  it("never mutates the delivered sheets", () => {
    const original = sheets();
    applyEdits(original, [edit({ param: "max_connections", suggested: "700" })], "ja");
    expect(original[0].categories[0].params![0].value).toBe("500");
  });

  // A document nobody has edited must be byte-identical in behaviour to one
  // built before this feature existed.
  it("returns the same object when there is nothing to apply", () => {
    const original = sheets();
    expect(applyEdits(original, [], "ja").sheets).toBe(original);
  });

  it("ignores pending review findings — a proposal is not a value", () => {
    const proposal: ReviewItem = { ...edit({ param: "max_connections", suggested: "9999" }), status: "pending" };
    const r = applyEdits(sheets(), [proposal], "ja");
    expect(r.sheets[0].categories[0].params![0].value).toBe("500");
  });

  it("applies a remarks edit written in the same language", () => {
    const r = applyEdits(sheets(), [edit({ param: "max_connections", field: "remarks", suggested: "増設のため変更", lang: "ja" })], "ja");
    expect(r.sheets[0].categories[0].params![0].remarks).toBe("増設のため変更");
  });

  // Design decision: a note written in Japanese is not a translation, so the
  // English document keeps the delivered text rather than showing Japanese.
  it("leaves the delivered prose alone when the document is shown in another language", () => {
    const r = applyEdits(sheets(), [edit({ param: "max_connections", field: "remarks", suggested: "増設のため変更", lang: "ja" })], "en");
    expect(r.sheets[0].categories[0].params![0].remarks).toBe("納品時のまま");
  });

  it("edits one environment of a per-instance row without touching the others", () => {
    const s: SheetData["sheets"] = [{
      name: "DB", categories: [{ name: "接続", categories: [], params: [
        { key: "max_connections", instances: [{ name: "本番", value: "500" }, { name: "検証", value: "100" }] },
      ] }],
    }];
    const r = applyEdits(s, [edit({ param: "max_connections", suggested: "700", instance: "本番" })], "ja");
    const insts = r.sheets[0].categories[0].params![0].instances!;
    expect(insts.map((i) => i.value)).toEqual(["700", "100"]);
  });
});

describe("editsForCell", () => {
  it("returns the whole chain, oldest first", () => {
    const reviews = [
      edit({ param: "max_connections", suggested: "700", at: "2026-09-02T00:00:00Z", by: "田中" }),
      edit({ param: "max_connections", suggested: "600", at: "2026-08-18T00:00:00Z", by: "田中" }),
      edit({ param: "shared_buffers", suggested: "8GB", at: "2026-08-20T00:00:00Z" }),
    ];
    const chain = editsForCell(reviews, { sheet: "DB", category: "接続", param: "max_connections" }, "value");
    expect(chain.map((e) => e.changes![0].suggested)).toEqual(["600", "700"]);
  });
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

describe("rows the recipient added", () => {
  const added = (param: string, value: string, category = "接続"): ReviewItem => ({
    id: `rev_add_${param}`,
    target: { sheet: "DB", category, param, field: "value" },
    changes: [{ field: "value", suggested: value }],
    status: "applied",
    creates: true,
    at: "2026-08-18T00:00:00Z",
  });

  it("appears in its category", () => {
    const r = applyEdits(sheets(), [added("work_mem", "64MB")], "ja");
    const keys = r.sheets[0].categories[0].params!.map((p) => p.key);
    expect(keys).toEqual(["max_connections", "shared_buffers", "work_mem"]);
  });

  // No config file backs it, so it must not read as a checked value.
  it("is marked as added and carries no source", () => {
    const r = applyEdits(sheets(), [added("work_mem", "64MB")], "ja");
    const row = r.sheets[0].categories[0].params!.find((p) => p.key === "work_mem")!;
    expect(row.added).toBe(true);
    expect(row.source).toBeUndefined();
    expect(row.value).toBe("64MB");
  });

  it("can be edited afterwards like any other row", () => {
    const later: ReviewItem = {
      id: "rev_later",
      target: { sheet: "DB", category: "接続", param: "work_mem", field: "value" },
      changes: [{ field: "value", suggested: "128MB" }],
      status: "applied",
      at: "2026-09-01T00:00:00Z",
    };
    const r = applyEdits(sheets(), [added("work_mem", "64MB"), later], "ja");
    expect(r.sheets[0].categories[0].params!.find((p) => p.key === "work_mem")!.value).toBe("128MB");
  });

  // A regeneration can reorganise the sheet under a row somebody added. Losing
  // it quietly is the one outcome that is not allowed — and it is told apart
  // from the case above by the DECLARATION, never by "the category does not
  // resolve", which is what both look like from here.
  it("is reported, not dropped, when its category is gone", () => {
    const r = applyEdits(sheets(), [added("work_mem", "64MB", "存在しないカテゴリ")], "ja");
    expect(r.orphaned.map((o) => o.target.param)).toEqual(["work_mem"]);
    const allKeys = r.sheets[0].categories.flatMap((c) => c.params!.map((p) => p.key));
    expect(allKeys).not.toContain("work_mem");
  });
});

// A paragraph beside a section. `remarks` at the level of a category: the
// recipient's own annotation, so it takes effect on the sheet — unlike a
// description or a default, which are the PRODUCT's words and stay requests.
describe("a note written beside a section", () => {
  const note = (suggested: string, lang?: "ja" | "en"): ReviewItem => ({
    id: `rev_note_${suggested}_${lang ?? ""}`,
    target: { sheet: "DB", category: "接続", field: "note" },
    changes: [{ field: "note", current: "", suggested, lang }],
    status: "applied",
    at: "2026-08-18T00:00:00Z",
  });

  it("appears on its category", () => {
    const r = applyEdits(sheets(), [note("この節は本番だけ効く。")], "ja");
    expect(r.sheets[0].categories[0].note).toBe("この節は本番だけ効く。");
  });

  it("is the newest one, not every one", () => {
    const r = applyEdits(sheets(), [note("ふるい"), { ...note("あたらしい"), at: "2026-09-01T00:00:00Z" }], "ja");
    expect(r.sheets[0].categories[0].note).toBe("あたらしい");
  });

  // Clearing it removes the paragraph rather than leaving an empty one.
  it("goes away when it is emptied", () => {
    const r = applyEdits(sheets(), [note("いちど書いた"), { ...note(""), at: "2026-09-01T00:00:00Z" }], "ja");
    expect(r.sheets[0].categories[0].note).toBeUndefined();
  });

  // Prose carries the language it was written in — a Japanese note must not
  // stand in for a translation nobody made, exactly as `remarks` does not.
  it("does not stand in for the language it was not written in", () => {
    const r = applyEdits(sheets(), [note("日本語のメモ", "ja")], "en");
    expect(r.sheets[0].categories[0].note).toBeUndefined();
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

// A shared row stores ONE value shown in every environment column. Editing it
// for a single environment is a change of shape, not just of value: the sheet
// stops saying "all environments are this" and starts saying "production is
// this, the rest are still the shared value". The configuration has one line
// for all of them, so the changed environment is asking for a line that does
// not exist yet — and the sheet has to be able to say so.
describe("editing one environment of a shared row", () => {
  const sharedSheet = (): SheetData["sheets"] => [
    {
      name: "DB",
      instances: ["本番", "検証"],
      categories: [
        { name: "接続", categories: [], params: [
          { key: "max_connections", value: "500", source: { file: "common.yml", line: 3, anchor: "max_connections" } },
        ] },
      ],
    },
  ];

  const perEnv = (instance: string, suggested: string): ReviewItem => ({
    id: `rev_${instance}`,
    target: { sheet: "DB", category: "接続", param: "max_connections", instance, field: "value" },
    changes: [{ field: "value", suggested }],
    status: "applied",
    at: "2026-08-18T00:00:00Z",
  });

  it("splits the row into one value per environment", () => {
    const r = applyEdits(sharedSheet(), [perEnv("本番", "700")], "ja");
    const p = r.sheets[0].categories[0].params![0];
    expect(p.instances?.map((i) => [i.name, i.value])).toEqual([["本番", "700"], ["検証", "500"]]);
    // The row is no longer a single shared value, and must not claim to be both.
    expect(p.value).toBeUndefined();
  });

  // The common line still governs the environments nobody changed, so they keep
  // pointing at it. The changed one points at nothing, because nothing is there
  // yet — which is exactly the work the row is now asking someone to do.
  it("keeps the shared source on the environments that did not change", () => {
    const r = applyEdits(sharedSheet(), [perEnv("本番", "700")], "ja");
    const insts = r.sheets[0].categories[0].params![0].instances!;
    expect(insts.find((i) => i.name === "本番")!.source).toBeUndefined();
    expect(insts.find((i) => i.name === "検証")!.source?.file).toBe("common.yml");
  });

  it("leaves the row shared when the edit names no environment", () => {
    const all: ReviewItem = {
      id: "rev_all",
      target: { sheet: "DB", category: "接続", param: "max_connections", field: "value" },
      changes: [{ field: "value", suggested: "700" }],
      status: "applied",
    };
    const p = applyEdits(sharedSheet(), [all], "ja").sheets[0].categories[0].params![0];
    expect(p.value).toBe("700");
    expect(p.instances).toBeUndefined();
  });

  it("splits once for several environments edited separately", () => {
    const r = applyEdits(sharedSheet(), [perEnv("本番", "700"), perEnv("検証", "200")], "ja");
    const insts = r.sheets[0].categories[0].params![0].instances!;
    expect(insts.map((i) => [i.name, i.value])).toEqual([["本番", "700"], ["検証", "200"]]);
  });

  it("records the shared value as the baseline of the environment that changed", () => {
    const r = applyEdits(sharedSheet(), [perEnv("本番", "700")], "ja");
    expect(r.baseline.get("DB::接続::max_connections::本番::value")).toBe("500");
  });
});

// Deleting a row does not remove it: it is struck through. A row that vanishes
// takes its history and its source map with it, and leaves nobody able to ask
// what used to be there — which is the failure this whole tool exists around.
describe("rows struck through", () => {
  const strike = (id: string, at: string, deletes: boolean, param = "max_connections"): ReviewItem => ({
    id,
    target: { sheet: "DB", category: "接続", param },
    status: "applied",
    deletes,
    at,
  });

  it("marks the row instead of removing it", () => {
    const r = applyEdits(sheets(), [strike("rev_d", "2026-08-18T00:00:00Z", true)], "ja");
    const params = r.sheets[0].categories[0].params!;
    expect(params.map((p) => p.key)).toContain("max_connections");
    expect(params.find((p) => p.key === "max_connections")!.deleted).toBe(true);
    expect(params.find((p) => p.key === "shared_buffers")!.deleted).toBeUndefined();
  });

  // Deleting a row and putting it back are two decisions. The second must not
  // erase the first.
  it("keeps both decisions and lets the newest one win", () => {
    const chain = [strike("rev_d", "2026-08-18T00:00:00Z", true), strike("rev_r", "2026-09-02T00:00:00Z", false)];
    const r = applyEdits(sheets(), chain, "ja");
    // Restored: the row carries no strike-through mark at all, rather than
    // carrying one set to false.
    expect(r.sheets[0].categories[0].params![0].deleted).toBeFalsy();
    expect(deletionHistory(chain, { sheet: "DB", category: "接続", param: "max_connections" }).map((e) => e.deletes))
      .toEqual([true, false]);
    expect(isDeleted(chain, { sheet: "DB", category: "接続", param: "max_connections" })).toBe(false);
  });

  it("reads the state out of order-independent timestamps", () => {
    const chain = [strike("rev_r", "2026-09-02T00:00:00Z", false), strike("rev_d", "2026-08-18T00:00:00Z", true)];
    expect(isDeleted(chain, { sheet: "DB", category: "接続", param: "max_connections" })).toBe(false);
  });

  it("keeps the row's value readable while it is struck through", () => {
    const r = applyEdits(sheets(), [strike("rev_d", "2026-08-18T00:00:00Z", true)], "ja");
    expect(r.sheets[0].categories[0].params![0].value).toBe("500");
  });
});
