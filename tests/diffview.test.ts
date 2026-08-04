import { describe, it, expect } from "bun:test";
import { buildDiffModel, rowKey, instKey, catKey, sheetKey } from "../src/diffview";
import type { SheetData } from "../src/prompt";

type Sheets = SheetData["sheets"];
const sheet = (params: Record<string, unknown>[]): Sheets => [{ name: "S", categories: [{ name: "C", params: params as never }] }];

describe("buildDiffModel — overlay model", () => {
  it("shows the OLD value in the cell and supplies the NEW via a synthetic review", () => {
    const m = buildDiffModel(sheet([{ key: "a", value: "10" }]), sheet([{ key: "a", value: "20" }]), false);
    const a = m.sheets[0].categories[0].params![0];
    expect(a.value).toBe("10"); // rendered cell shows old
    const rev = m.reviews.find((r) => r.target.param === "a" && r.target.field === "value")!;
    expect(rev.changes![0]).toMatchObject({ current: "10", suggested: "20" }); // review supplies new
    expect(m.status.get(rowKey("S", "C", "a"))).toBe("changed");
    expect(m.summary).toMatchObject({ changed: 1 });
  });

  it("keeps added rows (new value, no review) and removed rows (old value) in place", () => {
    const m = buildDiffModel(
      sheet([{ key: "keep", value: "1" }, { key: "gone", value: "x" }]),
      sheet([{ key: "keep", value: "1" }, { key: "new", value: "y" }]),
      false
    );
    const keys = m.sheets[0].categories[0].params!.map((p) => p.key);
    expect(keys).toEqual(["keep", "new", "gone"]); // union, removed appended in place
    expect(m.status.get(rowKey("S", "C", "new"))).toBe("added");
    expect(m.status.get(rowKey("S", "C", "gone"))).toBe("removed");
    expect(m.reviews).toHaveLength(0); // add/remove are not old->new reviews
  });

  it("encodes per-instance status and unions instance columns (removed kept)", () => {
    const from = sheet([{ key: "p", instances: [{ name: "web", value: "8080" }, { name: "cache", value: "6379" }] }]);
    const to = sheet([{ key: "p", instances: [{ name: "web", value: "8888" }, { name: "db", value: "5432" }] }]);
    const m = buildDiffModel(from, to, false);
    const p = m.sheets[0].categories[0].params![0];
    expect(p.instances!.map((i) => i.name)).toEqual(["web", "db", "cache"]);
    expect(m.status.get(instKey("S", "C", "p", "web"))).toBe("changed");
    expect(m.status.get(instKey("S", "C", "p", "db"))).toBe("added");
    expect(m.status.get(instKey("S", "C", "p", "cache"))).toBe("removed");
    // changed instance shows old value; review supplies new
    expect(p.instances!.find((i) => i.name === "web")!.value).toBe("8080");
    expect(m.reviews.find((r) => r.target.instance === "web")!.changes![0].suggested).toBe("8888");
  });

  it("emits a field review with the old value shown in the cell", () => {
    const m = buildDiffModel(
      sheet([{ key: "a", value: "1", description: "old" }]),
      sheet([{ key: "a", value: "1", description: "new" }]),
      false
    );
    const a = m.sheets[0].categories[0].params![0];
    expect(a.description).toBe("old");
    expect(m.reviews.find((r) => r.target.field === "description")!.changes![0]).toMatchObject({ current: "old", suggested: "new" });
  });

  // The overlay must agree with diffSheets on a row whose shape changed — see
  // alignValues in diff.ts, which both sides now share.
  it("expands a Pattern A value across the other side's instances", () => {
    const from = sheet([{ key: "p", value: "8080" }]);
    const to = sheet([{ key: "p", instances: [{ name: "web", value: "8080" }, { name: "api", value: "9090" }] }]);
    const m = buildDiffModel(from, to, false);
    const p = m.sheets[0].categories[0].params![0];
    expect(m.status.get(instKey("S", "C", "p", "web"))).toBeUndefined(); // unchanged
    expect(m.status.get(instKey("S", "C", "p", "api"))).toBe("changed");
    expect(p.instances!.find((i) => i.name === "api")!.value).toBe("8080"); // old shared value
    expect(m.reviews.find((r) => r.target.instance === "api")!.changes![0]).toMatchObject({
      current: "8080",
      suggested: "9090",
    });
    // A row rendered per instance must not also claim a single shared value.
    expect(p.value).toBeUndefined();
  });

  it("reports a row unchanged when the shared value matches every instance", () => {
    const from = sheet([{ key: "p", value: "8080" }]);
    const to = sheet([{ key: "p", instances: [{ name: "web", value: "8080" }, { name: "api", value: "8080" }] }]);
    const m = buildDiffModel(from, to, false);
    expect(m.status.get(rowKey("S", "C", "p"))).toBe("unchanged");
    expect(m.reviews).toHaveLength(0);
    expect(m.summary).toMatchObject({ changed: 0, unchanged: 1 });
  });

  it("drops unchanged rows/categories/sheets under changedOnly", () => {
    const base = sheet([{ key: "a", value: "1" }]);
    const m = buildDiffModel(base, base, true);
    expect(m.sheets).toHaveLength(0);
    const m2 = buildDiffModel(base, base, false);
    expect(m2.sheets[0].categories[0].params!).toHaveLength(1);
    expect(m2.status.get(catKey("S", "C"))).toBe("unchanged");
    expect(m2.status.get(sheetKey("S"))).toBe("unchanged");
  });
});
