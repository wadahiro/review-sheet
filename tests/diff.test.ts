import { describe, it, expect } from "bun:test";
import { diffSheets } from "../src/diff";
import diffDemo from "./fixtures/diff-demo.json";
import type { SheetData } from "../src/prompt";

type Sheets = SheetData["sheets"];

function sheets(params: Record<string, unknown>[]): Sheets {
  return [{ name: "S", categories: [{ name: "C", params: params as never }] }];
}

describe("diffSheets — Pattern A", () => {
  it("detects a changed value", () => {
    const from = sheets([{ key: "a", value: "1" }]);
    const to = sheets([{ key: "a", value: "2" }]);
    const d = diffSheets(from, to);
    const p = d.sheets[0].categories[0].params[0];
    expect(p.status).toBe("changed");
    expect(p.cells[0]).toMatchObject({ status: "changed", from: "1", to: "2" });
    expect(d.summary).toMatchObject({ changed: 1, added: 0, removed: 0 });
  });

  it("detects added and removed parameters", () => {
    const from = sheets([{ key: "keep", value: "x" }, { key: "gone", value: "y" }]);
    const to = sheets([{ key: "keep", value: "x" }, { key: "new", value: "z" }]);
    const d = diffSheets(from, to);
    const byKey = Object.fromEntries(d.sheets[0].categories[0].params.map((p) => [p.key, p.status]));
    expect(byKey).toEqual({ keep: "unchanged", new: "added", gone: "removed" });
    expect(d.summary).toMatchObject({ added: 1, removed: 1, unchanged: 1 });
  });

  it("flags documentation-field changes as changed", () => {
    const from = sheets([{ key: "a", value: "1", description: "old" }]);
    const to = sheets([{ key: "a", value: "1", description: "new" }]);
    const p = diffSheets(from, to).sheets[0].categories[0].params[0];
    expect(p.status).toBe("changed");
    expect(p.cells[0].status).toBe("unchanged");
    expect(p.fields).toEqual([{ field: "description", from: "old", to: "new" }]);
  });
});

describe("diffSheets — Pattern B (per-instance cells)", () => {
  const mk = (web: string, api: string, extra?: { name: string; value: string }[]) =>
    sheets([
      {
        key: "port",
        instances: [{ name: "web", value: web }, { name: "api", value: api }, ...(extra ?? [])],
      },
    ]);

  it("reports per-instance change, leaving the others unchanged", () => {
    const d = diffSheets(mk("8080", "9090"), mk("8888", "9090"));
    const cells = d.sheets[0].categories[0].params[0].cells;
    const byInst = Object.fromEntries(cells.map((c) => [c.instance, c.status]));
    expect(byInst).toEqual({ web: "changed", api: "unchanged" });
    expect(cells.find((c) => c.instance === "web")).toMatchObject({ from: "8080", to: "8888" });
  });

  it("detects an added instance column", () => {
    const d = diffSheets(mk("8080", "9090"), mk("8080", "9090", [{ name: "stg", value: "7070" }]));
    const stg = d.sheets[0].categories[0].params[0].cells.find((c) => c.instance === "stg");
    expect(stg).toMatchObject({ status: "added", from: undefined, to: "7070" });
    expect(d.sheets[0].categories[0].params[0].status).toBe("changed");
  });

  it("detects a removed instance column", () => {
    const d = diffSheets(mk("8080", "9090", [{ name: "stg", value: "7070" }]), mk("8080", "9090"));
    const stg = d.sheets[0].categories[0].params[0].cells.find((c) => c.instance === "stg");
    expect(stg).toMatchObject({ status: "removed", from: "7070", to: undefined });
  });
});

describe("diffSheets — structure", () => {
  it("rolls category and sheet status up from children", () => {
    const from: Sheets = [
      { name: "S", categories: [{ name: "C1", params: [{ key: "a", value: "1" } as never] }, { name: "C2", params: [{ key: "b", value: "1" } as never] }] },
    ];
    const to: Sheets = [
      { name: "S", categories: [{ name: "C1", params: [{ key: "a", value: "2" } as never] }, { name: "C2", params: [{ key: "b", value: "1" } as never] }] },
    ];
    const d = diffSheets(from, to);
    expect(d.sheets[0].status).toBe("changed");
    const cats = Object.fromEntries(d.sheets[0].categories.map((c) => [c.name, c.status]));
    expect(cats).toEqual({ C1: "changed", C2: "unchanged" });
  });

  it("marks a whole added sheet", () => {
    const d = diffSheets([], sheets([{ key: "a", value: "1" }]));
    expect(d.sheets[0].status).toBe("added");
    expect(d.sheets[0].categories[0].params[0].status).toBe("added");
  });

  it("reports an all-unchanged diff", () => {
    const s = sheets([{ key: "a", value: "1" }]);
    const d = diffSheets(s, s);
    expect(d.summary).toMatchObject({ changed: 0, added: 0, removed: 0, unchanged: 1 });
    expect(d.sheets[0].status).toBe("unchanged");
  });
});

// Pattern A means "this one value applies to every instance", so a row that is
// Pattern A on one side and Pattern B on the other must be compared by expanding
// the single value — not by unioning "the shared value" with the instance names,
// which made every cell of such a row added/removed and the row falsely changed.
describe("diffSheets — Pattern A against Pattern B", () => {
  const patternA = (value: string) => sheets([{ key: "port", value }]);
  const patternB = (web: string, api: string) =>
    sheets([{ key: "port", instances: [{ name: "web", value: web }, { name: "api", value: api }] }]);

  it("reports unchanged when the shared value matches every instance", () => {
    const d = diffSheets(patternA("8080"), patternB("8080", "8080"));
    const p = d.sheets[0].categories[0].params[0];
    expect(p.status).toBe("unchanged");
    expect(Object.fromEntries(p.cells.map((c) => [c.instance, c.status]))).toEqual({
      web: "unchanged",
      api: "unchanged",
    });
    expect(d.summary).toMatchObject({ changed: 0, unchanged: 1 });
  });

  it("reports only the instance that actually diverged", () => {
    const d = diffSheets(patternA("8080"), patternB("8080", "9090"));
    const p = d.sheets[0].categories[0].params[0];
    expect(p.status).toBe("changed");
    expect(Object.fromEntries(p.cells.map((c) => [c.instance, c.status]))).toEqual({
      web: "unchanged",
      api: "changed",
    });
    // The old shared value is what `api` changed FROM — not an absent cell.
    expect(p.cells.find((c) => c.instance === "api")).toMatchObject({ from: "8080", to: "9090" });
  });

  it("expands in the other direction too (Pattern B collapsing to Pattern A)", () => {
    const d = diffSheets(patternB("8080", "9090"), patternA("8080"));
    const p = d.sheets[0].categories[0].params[0];
    expect(Object.fromEntries(p.cells.map((c) => [c.instance, c.status]))).toEqual({
      web: "unchanged",
      api: "changed",
    });
    expect(p.cells.find((c) => c.instance === "api")).toMatchObject({ from: "9090", to: "8080" });
  });

  it("still reports a genuinely absent side as added/removed", () => {
    const d = diffSheets(sheets([{ key: "port" }]), patternB("8080", "9090"));
    const p = d.sheets[0].categories[0].params[0];
    expect(Object.fromEntries(p.cells.map((c) => [c.instance, c.status]))).toEqual({
      web: "added",
      api: "added",
    });
  });
});

// The mode built for comparing two DIFFERENT sheets (e.g. two deployment
// platforms mid-migration) for equivalence — see DiffOptions in src/diff.ts.
describe("diffSheets — equivalence options", () => {
  describe("excludeDefaultOrigin", () => {
    it("excludes a materialize-derived row present only on one side, and counts it", () => {
      const from = sheets([
        { key: "a", value: "1" },
        { key: "b", value: "product-default", origin: "default" },
      ]);
      const to = sheets([{ key: "a", value: "1" }]);

      const withoutOpt = diffSheets(from, to);
      expect(withoutOpt.summary).toMatchObject({ removed: 1, unchanged: 1 });
      expect(withoutOpt.excluded).toEqual({ defaultOrigin: 0 });

      const d = diffSheets(from, to, { excludeDefaultOrigin: true });
      const keys = d.sheets[0].categories[0].params.map((p) => p.key);
      expect(keys).toEqual(["a"]); // "b" dropped entirely, not just hidden
      expect(d.summary).toMatchObject({ removed: 0, unchanged: 1 });
      expect(d.excluded).toEqual({ defaultOrigin: 1 });
    });

    it("also excludes when the default-origin row exists only on the 'to' side", () => {
      const from = sheets([{ key: "a", value: "1" }]);
      const to = sheets([
        { key: "a", value: "1" },
        { key: "b", value: "product-default", origin: "default" },
      ]);
      const d = diffSheets(from, to, { excludeDefaultOrigin: true });
      expect(d.sheets[0].categories[0].params.map((p) => p.key)).toEqual(["a"]);
      expect(d.excluded).toEqual({ defaultOrigin: 1 });
    });

    it("does not exclude a param whose origin is not default", () => {
      const from = sheets([{ key: "a", value: "1", origin: "overlay" }]);
      const to = sheets([]);
      const d = diffSheets(from, to, { excludeDefaultOrigin: true });
      expect(d.sheets[0].categories[0].params.map((p) => p.key)).toEqual(["a"]);
      expect(d.excluded).toEqual({ defaultOrigin: 0 });
    });
  });

  describe("sheetPresence", () => {
    const sheetOf = (name: string, params: Record<string, unknown>[]): Sheets => [
      { name, categories: [{ name: "C", params: params as never }] },
    ];

    it("collapses a sheet present only on one side into one fact instead of N removed rows", () => {
      const from = [...sheetOf("shared", [{ key: "a", value: "1" }]), ...sheetOf("httpd", [{ key: "x", value: "1" }, { key: "y", value: "2" }])];
      const to = sheetOf("shared", [{ key: "a", value: "1" }]);

      const withoutOpt = diffSheets(from, to);
      expect(withoutOpt.summary).toMatchObject({ removed: 2, unchanged: 1 });

      const d = diffSheets(from, to, { sheetPresence: true });
      expect(d.summary).toMatchObject({ removed: 0, unchanged: 1 }); // the 2 httpd params no longer inflate `removed`
      expect(d.sheetsOnlyOnOneSide).toEqual([{ name: "httpd", onlyIn: "from", paramCount: 2 }]);
      const httpd = d.sheets.find((s) => s.name === "httpd")!;
      expect(httpd.status).toBe("removed");
      expect(httpd.categories).toEqual([]); // recorded once above, not walked into rows
    });

    it("reports a sheet present only on the 'to' side as onlyIn: 'to'", () => {
      const from = sheetOf("shared", [{ key: "a", value: "1" }]);
      const to = [...sheetOf("shared", [{ key: "a", value: "1" }]), ...sheetOf("ecs-native", [{ key: "z", value: "1" }])];
      const d = diffSheets(from, to, { sheetPresence: true });
      expect(d.sheetsOnlyOnOneSide).toEqual([{ name: "ecs-native", onlyIn: "to", paramCount: 1 }]);
    });

    it("does not affect a category removed within a sheet present on both sides", () => {
      const from: Sheets = [
        { name: "S", categories: [{ name: "C1", params: [{ key: "a", value: "1" } as never] }, { name: "C2", params: [{ key: "b", value: "1" } as never] }] },
      ];
      const to: Sheets = [{ name: "S", categories: [{ name: "C1", params: [{ key: "a", value: "1" } as never] }] }];
      const d = diffSheets(from, to, { sheetPresence: true });
      expect(d.sheetsOnlyOnOneSide).toEqual([]); // sheet "S" exists on both sides
      expect(d.summary).toMatchObject({ removed: 1, unchanged: 1 }); // "C2 > b" is a real removed row
    });
  });

  it("combines both options: only the genuine cross-platform differences remain", () => {
    const from = [
      ...sheets([{ key: "shared", value: "1" }, { key: "default-only", value: "d", origin: "default" }]),
      ...([{ name: "httpd", categories: [{ name: "C", params: [{ key: "vhost", value: "x" } as never] }] }] as Sheets),
    ];
    const to = sheets([{ key: "shared", value: "1" }]);
    const d = diffSheets(from, to, { excludeDefaultOrigin: true, sheetPresence: true });
    expect(d.summary).toMatchObject({ changed: 0, added: 0, removed: 0, unchanged: 1 });
    expect(d.excluded).toEqual({ defaultOrigin: 1 });
    expect(d.sheetsOnlyOnOneSide).toEqual([{ name: "httpd", onlyIn: "from", paramCount: 1 }]);
  });
});

describe("diffSheets — diff-demo fixture (all patterns)", () => {
  const [v1, v2] = diffDemo.versions as { sheets: SheetData["sheets"] }[];
  const d = diffSheets(v1.sheets, v2.sheets);

  it("summarizes the combined add/update/remove patterns", () => {
    expect(d.summary).toMatchObject({ changed: 5, added: 6, removed: 6 });
  });

  it("treats an instance rename as a removed + added instance column", () => {
    const cluster = d.sheets.find((s) => s.name === "Instances")!.categories.find((c) => c.name === "Cluster")!;
    const host = cluster.params.find((p) => p.key === "svc.host")!;
    const byInst = Object.fromEntries(host.cells.map((c) => [c.instance, c.status]));
    expect(byInst).toMatchObject({ web: "removed", "web-1": "added", api: "unchanged" });
  });

  it("flags a default-value change (value unchanged) as changed", () => {
    const stable = d.sheets.find((s) => s.name === "Kept Sheet")!.categories.find((c) => c.name === "Stable")!;
    const dc = stable.params.find((p) => p.key === "p.defaultchg")!;
    expect(dc.status).toBe("changed");
    expect(dc.fields).toContainEqual({ field: "default", from: "60", to: "120" });
  });

  it("treats sheet/category/key renames as remove + add", () => {
    const byName = Object.fromEntries(d.sheets.map((s) => [s.name, s.status]));
    expect(byName["Renamed Sheet (old)"]).toBe("removed");
    expect(byName["Renamed Sheet (new)"]).toBe("added");
    expect(byName["Added Sheet"]).toBe("added");
    expect(byName["Removed Sheet"]).toBe("removed");
  });

  it("diffs Pattern B per instance, including added/removed instance columns", () => {
    const cluster = d.sheets.find((s) => s.name === "Instances")!.categories.find((c) => c.name === "Cluster")!;
    const port = cluster.params.find((p) => p.key === "svc.port")!;
    const byInst = Object.fromEntries(port.cells.map((c) => [c.instance, c.status]));
    expect(byInst).toEqual({ web: "changed", api: "unchanged", db: "added", cache: "removed" });
  });
});

// What KIND of thing changed, which is the whole difference between an upgrade
// review that can be signed and one that cannot.
//
// The motivating measurement, from a real Keycloak 19.0.2 -> 26.7.0 comparison
// of one unchanged LDAP configuration: 6 rows came out "changed", 4 of them
// because the newer dictionary carries a Japanese translation the older one
// lacks. The one that mattered — `useTruststoreSpi`, whose product default
// moved from `ldapsOnly` to `always` under a value nobody touched — sat in the
// same undifferentiated count as the four.
describe("diffSheets — what kind of change", () => {
  const doc = (d: string) => ({ key: "k", value: "1", description: { en: d } });

  it("separates a value change from prose", () => {
    const from = sheets([{ key: "k", value: "1", description: { en: "old words" } }]);
    const to = sheets([{ key: "k", value: "2", description: { en: "new words" } }]);
    const p = diffSheets(from, to).sheets[0].categories[0].params[0];
    expect(p.status).toBe("changed");
    expect(p.changed).toEqual(["value", "doc"]);
  });

  it("calls a prose-only difference doc-only, and counts it as such", () => {
    const r = diffSheets(sheets([doc("was")]), sheets([doc("is")]));
    const p = r.sheets[0].categories[0].params[0];
    expect(p.changed).toEqual(["doc"]);
    // Still "changed" — the field really did change, and hiding that would be
    // the opposite failure. It is the SHARE that has to be visible.
    expect(p.status).toBe("changed");
    expect(r.summary).toMatchObject({ changed: 1, docOnly: 1 });
  });

  it("treats a moved product default as a finding, not as prose", () => {
    // The real case: the configuration is identical and the ground moved.
    const from = sheets([{ key: "k", value: "1", default: "ldapsOnly" }]);
    const to = sheets([{ key: "k", value: "1", default: "always" }]);
    const r = diffSheets(from, to);
    const p = r.sheets[0].categories[0].params[0];
    expect(p.changed).toEqual(["default"]);
    // Not doc-only: a reviewer must not be able to filter this away with the
    // translation churn.
    expect(r.summary.docOnly).toBe(0);
  });

  it("gives a row present on one side no kind at all", () => {
    const r = diffSheets(sheets([]), sheets([doc("new row")]));
    const p = r.sheets[0].categories[0].params[0];
    expect(p.status).toBe("added");
    expect(p.changed).toEqual([]);
    expect(r.summary.docOnly).toBe(0);
  });

  it("leaves an unchanged row with no kinds and no doc-only count", () => {
    const r = diffSheets(sheets([doc("same")]), sheets([doc("same")]));
    expect(r.sheets[0].categories[0].params[0].changed).toEqual([]);
    expect(r.summary).toMatchObject({ changed: 0, docOnly: 0, unchanged: 1 });
  });
});
