// A DELIVERY CANNOT NARROW A COMPARISON TO ONE SIDE.
//
// `--instances poc` says which environment the handover covers, and for an
// ordinary sheet that is the whole answer. A sheet whose two sides have
// DIFFERENT environments is not: its claim is that a row reads ACROSS, so
// taking one side away leaves a column of values facing a column of blanks — a
// sheet that has lost the only thing it was for.
//
// The condition is measured, not declared: would this narrowing leave some
// component with no environments at all. Most comparison sheets are not
// affected — components that SHARE their environments (two realms, each
// configured in staging and production) all survive a narrowing to those two,
// and widening them would put back the environment `--instances` exists to
// remove. That case is a real one; it is the last describe() below.
//
// For the ones that are affected, nothing new is declared. `compare_instances`
// already says which environment answers which; the partner of a delivered
// environment is a fact the sheet carries. A per-sheet "keep these too" would
// be a third place to write a name already written twice, free to contradict
// both.

import { describe, it, expect } from "bun:test";
import { restrictInstances, formatRestrictReport } from "../src/restrict";
import type { ParameterSheetInput, Sheet } from "../src/types";

const row = (key: string, values: Record<string, string>): Sheet["categories"][number]["params"] extends undefined
  ? never
  : NonNullable<Sheet["categories"][number]["params"]>[number] => ({
  key,
  instances: Object.entries(values).map(([name, value]) => ({ name, value })),
});

// On a sheet that compares its components the TOP-LEVEL categories ARE the
// components (app.ts's pivotSheet reads them that way), and each side holds
// only its own environments — which is the shape this is all about.
const sheet = (over: Partial<Sheet>): Sheet => ({
  name: "upgrade",
  instances: ["dev", "prod", "local", "poc"],
  categories: [
    { name: "old", categories: [{ name: "Network", params: [row("listen", { dev: "9090", prod: "80" })] }] },
    { name: "new", categories: [{ name: "Network", params: [row("listen", { local: "8081", poc: "443" })] }] },
  ],
  ...over,
});

// An ordinary sheet beside it, so every assertion below also says that this
// changes nothing for the sheets a delivery is normally made of.
// It HAS `prod` too — otherwise a comparison sheet's extra environment leaking
// into every other sheet would be invisible here, and the test that says it
// does not could never fail.
const plain = (): Sheet => ({
  name: "database",
  instances: ["prod", "local", "poc"],
  categories: [{ name: "Connection", params: [row("host", { prod: "db.prod", local: "db.local", poc: "db.poc" })] }],
});

const model = (s: Sheet): ParameterSheetInput => ({ sheets: [s, plain()] } as never);

// Every environment the sheet's rows still carry, in the order they appear.
const instancesOfRow = (input: ParameterSheetInput, sheetName: string): string[] => {
  const s = input.sheets.find((x) => x.name === sheetName)!;
  const out: string[] = [];
  const walk = (c: (typeof s.categories)[number]): void => {
    for (const p of c.params ?? []) for (const i of p.instances ?? []) if (!out.includes(i.name)) out.push(i.name);
    for (const inner of c.categories ?? []) walk(inner);
  };
  for (const c of s.categories) walk(c);
  return out;
};

describe("a sheet that says which environment answers which", () => {
  const compared = sheet({ compare_components: "always", compare_instances: [[
    "dev", "local"], ["prod", "poc"]] });

  it("keeps the partner of a delivered environment", () => {
    const { input } = restrictInstances(model(compared), ["poc"]);
    expect(instancesOfRow(input, "upgrade")).toEqual(["prod", "poc"]);
  });

  // The pair NOT touched by the delivery goes, whole. Keeping a partner is not
  // keeping everything — the sheet still narrows.
  it("drops a pair neither half of which is delivered", () => {
    const { input } = restrictInstances(model(compared), ["poc"]);
    expect(instancesOfRow(input, "upgrade")).not.toContain("dev");
    expect(instancesOfRow(input, "upgrade")).not.toContain("local");
  });

  // The sheet's own environment list narrows with it, or the viewer renders a
  // column for an environment the rows no longer have.
  it("narrows the sheet's own instance list to match", () => {
    const { input } = restrictInstances(model(compared), ["poc"]);
    expect(input.sheets.find((s) => s.name === "upgrade")!.instances).toEqual(["prod", "poc"]);
  });

  // Every other sheet is delivered exactly as asked.
  it("changes nothing for a sheet that does not compare", () => {
    const { input } = restrictInstances(model(compared), ["poc"]);
    expect(instancesOfRow(input, "database")).toEqual(["poc"]);
  });

  // Only the component that needed it. A pair whose members both sit in ONE
  // component (a declaration the spec accepts and nothing else checks) must not
  // drag a surviving component's other environment back into the delivery.
  it("widens no further than the emptied component", () => {
    const crossed: Sheet = {
      name: "upgrade",
      instances: ["dev", "local", "prod", "poc"],
      compare_components: "always",
      compare_instances: [["dev", "local"], ["prod", "poc"]],
      categories: [
        { name: "old", categories: [{ name: "Network", params: [row("listen", { dev: "9090", local: "8081" })] }] },
        { name: "new", categories: [{ name: "Network", params: [row("listen", { prod: "80", poc: "443" })] }] },
      ],
    };
    const { input } = restrictInstances({ sheets: [crossed] } as never, ["prod"]);
    expect(instancesOfRow(input, "upgrade")).toEqual(["dev", "local", "prod"]);
    expect(instancesOfRow(input, "upgrade")).not.toContain("poc");
  });

  it("says which environment it kept, and what for", () => {
    const { report } = restrictInstances(model(compared), ["poc"]);
    expect(report.compared).toEqual([{ sheet: "upgrade", kept: ["prod"], why: "paired" }]);
    expect(formatRestrictReport(report)).toContain(`sheet "upgrade" also kept prod`);
  });

  // The report describes the document. An environment that is IN the delivery
  // must not also be listed as left out of it.
  it("does not also call the kept environment dropped", () => {
    const { report } = restrictInstances(model(compared), ["poc"]);
    expect(report.dropped).toEqual(["dev", "local"]);
  });
});

describe("a sheet that compares but does not say what against what", () => {
  const vague = sheet({ compare_components: "always" });

  // No correspondence to follow, so any subset of the emptied component's
  // environments would be a guess — it keeps them whole.
  it("keeps the emptied component's environments whole", () => {
    const { input } = restrictInstances(model(vague), ["poc"]);
    expect(instancesOfRow(input, "upgrade")).toEqual(["dev", "prod", "poc"]);
  });

  it("says so, and names the missing declaration", () => {
    const { report } = restrictInstances(model(vague), ["poc"]);
    expect(report.compared[0]).toEqual({ sheet: "upgrade", kept: ["dev", "prod"], why: "unpaired" });
    expect(formatRestrictReport(report)).toContain("compare_instances");
  });
});

describe("the files the sheet previews", () => {
  const compared = sheet({ compare_components: "always", compare_instances: [["dev", "local"], ["prod", "poc"]] });
  const withPreviews = (): ParameterSheetInput =>
    ({
      sheets: [compared, plain()],
      artifacts: [
        { id: "old", sheet: "upgrade", instances: ["prod"], deployed_path: "/etc/app.conf", lines: [] },
        { id: "new", sheet: "upgrade", instances: ["poc"], deployed_path: "/etc/app.conf", lines: [] },
        { id: "gone", sheet: "upgrade", instances: ["dev"], deployed_path: "/etc/app.conf", lines: [] },
      ],
    }) as never;

  // The rendering of the old release's file is exactly what the kept
  // environment is FOR. Dropping it would leave the kept column pointing into
  // a preview the delivery does not contain.
  it("keeps the preview of an environment the sheet kept", () => {
    const { input } = restrictInstances(withPreviews(), ["poc"]);
    expect((input.artifacts ?? []).map((a) => a.id)).toEqual(["old", "new"]);
  });

  it("still drops the previews of environments nobody kept", () => {
    const { report } = restrictInstances(withPreviews(), ["poc"]);
    expect(report.previews).toBe(1);
  });
});

describe("what is left alone", () => {
  // A comparison sheet no part of which is being delivered is a sheet the
  // delivery is not about. Keeping it whole would put a sheet back that the
  // environment filter had emptied.
  it("does not revive a comparison sheet the delivery excludes entirely", () => {
    const other = sheet({
      compare_components: "always",
      instances: ["dev", "prod"],
      categories: [
        { name: "old", categories: [{ name: "Network", params: [row("listen", { dev: "9090" })] }] },
        { name: "new", categories: [{ name: "Network", params: [row("listen", { prod: "80" })] }] },
      ],
    });
    const { input, report } = restrictInstances(model(other), ["poc"]);
    expect(instancesOfRow(input, "upgrade")).toEqual([]);
    expect(report.compared).toEqual([]);
  });

  // `compare_instances` without `compare_components` is not a comparison sheet
  // — the pairs are a display detail of one, and reading them on their own
  // would widen a delivery on the strength of a field that changes nothing.
  it("is not triggered by the pairs alone", () => {
    const pairsOnly = sheet({ compare_instances: [["prod", "poc"]] });
    const { input } = restrictInstances(model(pairsOnly), ["poc"]);
    expect(instancesOfRow(input, "upgrade")).toEqual(["poc"]);
  });
});

describe("a comparison whose components share their environments", () => {
  // The case that made the first version of this wrong on a real delivery:
  // components that are two REALMS, not two releases. Each is configured in
  // every environment, so narrowing to staging and production leaves both
  // components whole — there is no comparison to protect, and widening would
  // put back the `local` column that `--instances` exists to remove.
  const realms = (): Sheet => ({
    name: "realms",
    compare_components: "always",
    instances: ["local", "staging", "production"],
    categories: [
      { name: "corp", categories: [{ name: "Login", params: [row("ssl", { local: "none", staging: "all", production: "all" })] }] },
      // Not stood up locally — so the two components' environment sets differ,
      // and "this component lost one" and "this component lost all" are
      // different questions about it. Only the second one empties a comparison.
      { name: "partner", categories: [{ name: "Login", params: [row("ssl", { staging: "all", production: "all" })] }] },
    ],
  });

  it("narrows exactly as asked", () => {
    const { input } = restrictInstances({ sheets: [realms()] } as never, ["staging", "production"]);
    expect(instancesOfRow(input, "realms")).toEqual(["staging", "production"]);
  });

  it("has nothing to report", () => {
    const { report } = restrictInstances({ sheets: [realms()] } as never, ["staging", "production"]);
    expect(report.compared).toEqual([]);
    expect(report.dropped).toEqual(["local"]);
  });

  // The precise line: a component is emptied when NONE of its environments
  // survives, not when one of them does not. Read the other way round, every
  // one of these components looks emptied and `local` comes back — which is
  // what a real delivery did when this was first written.
  it("is not emptied by losing one environment of several", () => {
    const { input, report } = restrictInstances({ sheets: [realms()] } as never, ["staging", "production"]);
    expect(instancesOfRow(input, "realms")).toEqual(["staging", "production"]);
    expect(report.compared).toEqual([]);
  });
});

describe("a model with a version history", () => {
  // The same sheet appears once per version, and the report describes the
  // DOCUMENT — "also kept prod" said three times reads as three sheets having
  // done it, and the delivery only has one.
  const versioned = () => {
    const s = sheet({ compare_components: "always", compare_instances: [["dev", "local"], ["prod", "poc"]] });
    return {
      versions: [
        { version: "1.0", date: "2026-01-01", sheets: [s] },
        { version: "1.1", date: "2026-02-01", sheets: [s] },
      ],
    } as never;
  };

  it("says what it kept once, not once per version", () => {
    const { report } = restrictInstances(versioned(), ["poc"]);
    expect(report.compared).toEqual([{ sheet: "upgrade", kept: ["prod"], why: "paired" }]);
  });

  // …and it still keeps it, in every version.
  it("keeps the partner in each version", () => {
    const { input } = restrictInstances(versioned(), ["poc"]);
    for (const v of (input as { versions: { sheets: Sheet[] }[] }).versions) {
      expect(v.sheets[0].instances).toEqual(["prod", "poc"]);
    }
  });
});

// …and the report's other per-row list does NOT dedupe, deliberately: see
// restrict.test.ts's "reaches every version of a document that carries a
// history". `emptied` counts empty CELLS, and a version history renders the row
// once per version, so both really are blank. `compared` names a SHEET, and a
// versioned document has one sheet per name however many versions carry it.
describe("the two lists count different things", () => {
  it("names an emptied row once per version, and the sheet once", () => {
    const s: Sheet = {
      name: "upgrade",
      compare_components: "always",
      compare_instances: [["dev", "local"], ["prod", "poc"]],
      instances: ["dev", "prod", "local", "poc"],
      categories: [
        { name: "old", categories: [{ name: "Network", params: [row("listen", { dev: "9090", prod: "80" })] }] },
        {
          name: "new",
          categories: [
            {
              name: "Network",
              // `listen` keeps the component alive; `debug` is set only in an
              // environment nobody delivers, so its cell goes blank.
              params: [row("listen", { local: "8081", poc: "443" }), row("debug", { local: "on" })],
            },
          ],
        },
      ],
    };
    const vs = [1, 2].map((i) => ({ version: `1.${i}`, date: "2026-01-01", sheets: [s] }));
    const { report } = restrictInstances({ versions: vs } as never, ["poc"]);
    expect(report.compared).toEqual([{ sheet: "upgrade", kept: ["prod"], why: "paired" }]);
    expect(report.emptied).toEqual(["upgrade > new > Network > debug", "upgrade > new > Network > debug"]);
  });
});
