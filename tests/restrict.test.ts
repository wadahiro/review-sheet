// A delivery that covers some of the environments a build knows.
//
// What is asserted here is BOTH halves: that the environment is gone from
// everywhere it lived, and that everything the removal cost is REPORTED. A
// filter that quietly took a row with it would be the failure this project is
// organized against — which is also why this is a filter over the finished
// model rather than a narrower build (a build that never reads an
// environment's overlay never creates the rows only that environment sets, and
// has nothing to report).

import { describe, it, expect } from "bun:test";
import { restrictInstances, instancesOf, formatRestrictReport, selectSheets, sheetsOf, formatSheetSelection } from "../src/restrict";
import type { ParameterSheetInput, VersionedSheetInput } from "../src/types";

const MODEL = {
  metadata: { title: "t" },
  artifacts: [
    { id: "a", sheet: "os", component: "keycloak.conf", source_file: "x.j2", instances: ["local"], lines: [] },
    { id: "b", sheet: "os", component: "keycloak.conf", source_file: "x.j2", instances: ["local", "staging"], lines: [] },
    { id: "c", sheet: "os", component: "keycloak.conf", source_file: "x.j2", lines: [] },
  ],
  sheets: [
    {
      name: "os",
      instances: ["local", "staging", "production"],
      categories: [
        {
          name: "keycloak.conf",
          params: [
            { key: "shared", description: "d", value: "5", origin: "common" },
            {
              key: "per-env",
              description: "d",
              origin: "overlay",
              instances: [
                { name: "local", value: "10" },
                { name: "staging", value: "20" },
                { name: "production", value: "20" },
              ],
            },
            // Set in the environment nobody is delivering, and nowhere else.
            { key: "local-only", description: "d", origin: "overlay", instances: [{ name: "local", value: "on" }] },
          ],
          categories: [
            { name: "nested", params: [{ key: "deep", description: "d", origin: "overlay", instances: [{ name: "local", value: "1" }] }] },
          ],
        },
      ],
    },
  ],
} as unknown as ParameterSheetInput;

const keep = ["staging", "production"];

describe("restricting a document to the environments it delivers", () => {
  it("takes the environment out of the sheet's own columns", () => {
    const { input } = restrictInstances(MODEL, keep);
    expect(input.sheets[0].instances).toEqual(["staging", "production"]);
  });

  it("takes its values off every row, however deep", () => {
    const { input } = restrictInstances(MODEL, keep);
    const cat = input.sheets[0].categories[0];
    const perEnv = cat.params!.find((p) => p.key === "per-env")!;
    expect("instances" in perEnv && perEnv.instances!.map((i) => i.name)).toEqual(["staging", "production"]);
    const deep = cat.categories![0].params![0];
    expect("instances" in deep && deep.instances).toEqual([]);
  });

  it("leaves a shared value alone — it claims to hold everywhere", () => {
    const { input } = restrictInstances(MODEL, keep);
    const shared = input.sheets[0].categories[0].params!.find((p) => p.key === "shared")!;
    expect("value" in shared && shared.value).toBe("5");
  });

  // A row whose only value was in the undelivered environment is KEPT: the
  // parameter is still part of the system, and a document that removed the row
  // would tell the reader it does not exist. It is named in the report instead,
  // because "blank" and "emptied by the delivery" are different facts and only
  // one of them is visible on the page.
  it("keeps a row it emptied, and names it", () => {
    const { input, report } = restrictInstances(MODEL, keep);
    expect(input.sheets[0].categories[0].params!.map((p) => p.key)).toContain("local-only");
    expect(report.emptied).toEqual(["os > keycloak.conf > local-only", "os > keycloak.conf > nested > deep"]);
    expect(formatRestrictReport(report)).toContain("os > keycloak.conf > local-only");
    expect(formatRestrictReport(report)).toContain("left out: local");
  });

  // A preview is the deployed file as it was rendered FOR an environment. One
  // rendered only for an environment nobody is delivering is that environment's
  // configuration in full, which is precisely what must not travel.
  it("drops a preview rendered only for an environment it does not deliver", () => {
    const { input, report } = restrictInstances(MODEL, keep);
    expect(input.artifacts!.map((a) => a.id)).toEqual(["b", "c"]);
    expect(input.artifacts!.find((a) => a.id === "b")!.instances).toEqual(["staging"]);
    expect(report.previews).toBe(1);
  });

  it("says which environments the document has, in the order it states them", () => {
    expect(instancesOf(MODEL)).toEqual(["local", "staging", "production"]);
  });

  // Naming every environment is a delivery that leaves nothing out, so it must
  // change nothing at all.
  it("is a no-op when it delivers everything", () => {
    const { input, report } = restrictInstances(MODEL, ["local", "staging", "production"]);
    expect(JSON.stringify(input)).toBe(JSON.stringify(MODEL));
    expect(report.emptied).toEqual([]);
    expect(report.dropped).toEqual([]);
  });

  it("reaches every version of a document that carries a history", () => {
    const versioned = {
      metadata: { title: "t" },
      versions: [
        { version: "old", sheets: MODEL.sheets, artifacts: MODEL.artifacts },
        { version: "current", sheets: MODEL.sheets, artifacts: MODEL.artifacts },
      ],
    } as unknown as VersionedSheetInput;
    const { input, report } = restrictInstances(versioned, keep);
    for (const v of input.versions) {
      expect(v.sheets[0].instances).toEqual(["staging", "production"]);
      expect(v.artifacts!.map((a) => a.id)).toEqual(["b", "c"]);
    }
    // Both versions' rows are named, since both carry them.
    expect(report.emptied).toHaveLength(4);
  });
});

// One build, several documents. A requirements note, a parameter sheet and a
// test record are separate documents in the world — approved separately,
// revised on their own cycles, sometimes handed to different people — so a
// delivery says which sheets it is made of. Same shape as the environments
// above: the model is not narrowed, and what is left out is reported.
describe("making a document out of some of the sheets", () => {
  const TWO = {
    metadata: { title: "t" },
    groups: [
      { name: "platform", label: { ja: "基盤" } },
      { name: "tests", label: { ja: "試験" } },
    ],
    artifacts: [
      { id: "a", sheet: "os", component: "c", source_file: "x", lines: [] },
      { id: "b", sheet: "os tests", component: "c", source_file: "x", lines: [] },
    ],
    sheets: [
      { name: "os", group: "platform", instances: ["staging"], categories: [{ name: "c", params: [{ key: "one", description: "d", value: "1" }, { key: "two", description: "d", value: "2" }] }] },
      { name: "os tests", group: "tests", instances: ["staging"], categories: [{ name: "c", params: [{ key: "t1", description: "d", value: "OK" }] }] },
    ],
  } as unknown as ParameterSheetInput;

  it("keeps the named sheets, in the document's own order", () => {
    const { input } = selectSheets(TWO, ["os"]);
    expect(input.sheets.map((s) => s.name)).toEqual(["os"]);
  });

  it("says what it left out, and how much of it there was", () => {
    const { report } = selectSheets(TWO, ["os"]);
    expect(report.dropped).toEqual(["os tests"]);
    expect(report.rows).toBe(1);
    expect(formatSheetSelection(report)).toContain("left out (1 row(s)): os tests");
  });

  // A preview belongs to the sheet it was built for; without that sheet it is a
  // file nobody in the document can open — and, on a delivery, a file nobody
  // asked to receive.
  it("takes the previews of a sheet it left out with it", () => {
    const { input, report } = selectSheets(TWO, ["os"]);
    expect(input.artifacts!.map((a) => a.id)).toEqual(["a"]);
    expect(report.previews).toBe(1);
  });

  // …and a group nothing is left under is a heading over nothing.
  it("drops a group whose every sheet is gone", () => {
    const { input } = selectSheets(TWO, ["os"]);
    expect(input.groups!.map((g) => g.name)).toEqual(["platform"]);
  });

  it("says which sheets the document has", () => {
    expect(sheetsOf(TWO)).toEqual(["os", "os tests"]);
  });

  it("is a no-op when the document is made of all of them", () => {
    const { input, report } = selectSheets(TWO, ["os", "os tests"]);
    expect(JSON.stringify(input)).toBe(JSON.stringify(TWO));
    expect(report.dropped).toEqual([]);
  });
});
