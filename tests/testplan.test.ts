// What a unit test tests, derived from the sheet it tests.
//
// The point of deriving it is that "every setting in the design is checked" —
// the sentence such a document always contains — stops being a sentence. So
// what is asserted here is the derivation itself: which rows become items, what
// each item expects, and what happens to a row that becomes none.

import { describe, it, expect } from "bun:test";
import { buildTestPlan, formatTestPlanReport } from "../src/testplan";
import type { ParameterSheetInput } from "../src/types";

const TESTED = { method: { ja: "デプロイ済みファイルを読む" } };

const model = (sheets: unknown[], groups?: unknown[]): ParameterSheetInput =>
  ({ metadata: { title: "t" }, groups, sheets } as unknown as ParameterSheetInput);

const sheet = (over: Record<string, unknown> = {}) =>
  ({
    name: "os",
    label: { ja: "OS 基本情報" },
    group: "server",
    instances: ["staging", "production"],
    categories: [
      {
        name: "/etc/chrony.conf",
        params: [{ key: "server", description: "d", origin: "common", value: "ntp.example" }],
      },
    ],
    ...over,
  }) as unknown as Record<string, unknown>;

const withGroup = (test: unknown = TESTED, over: Record<string, unknown> = {}) =>
  model([sheet(over)], [{ name: "server", label: { ja: "SSO サーバ" }, test }]);

describe("what becomes a test item", () => {
  it("is one item per row per environment", () => {
    const { plan } = buildTestPlan(withGroup());
    expect(plan.items.map((i) => [i.target.key, i.target.instance, i.kind, i.expected])).toEqual([
      ["server", "staging", "value", "ntp.example"],
      ["server", "production", "value", "ntp.example"],
    ]);
  });

  // The three claims a row can make, and each is a different test. An unset row
  // is not "nothing to check" — it asserts that the product's own default is
  // what applies, which is only true until somebody sets it somewhere else.
  it("asks what the row's origin says it should ask", () => {
    const rows = [
      { key: "set", description: "d", origin: "common", value: "1" },
      { key: "unset", description: "d", origin: "default", default: "0" },
      { key: "removed", description: "d", origin: "baseline", baseline: "on" },
    ];
    const { plan } = buildTestPlan(
      withGroup(TESTED, { instances: ["staging"], categories: [{ name: "c", params: rows }] })
    );
    expect(plan.items.map((i) => [i.target.key, i.kind, i.expected])).toEqual([
      ["set", "value", "1"],
      ["unset", "default-in-force", "0"],
      ["removed", "absent", undefined],
    ]);
  });

  it("expects each environment's own value on a per-environment row", () => {
    const { plan } = buildTestPlan(
      withGroup(TESTED, {
        categories: [
          {
            name: "c",
            params: [
              {
                key: "url",
                description: "d",
                origin: "overlay",
                instances: [
                  { name: "staging", value: "https://stg" },
                  { name: "production", value: "https://prod" },
                ],
              },
            ],
          },
        ],
      })
    );
    expect(plan.items.map((i) => [i.target.instance, i.expected])).toEqual([
      ["staging", "https://stg"],
      ["production", "https://prod"],
    ]);
  });

  // A row that says nothing about an environment has nothing to check there —
  // and is REPORTED, because "no item" and "an item nobody wrote down" look the
  // same in a finished document.
  it("says which rows state nothing in an environment, instead of dropping them", () => {
    const { plan, report } = buildTestPlan(
      withGroup(TESTED, {
        categories: [
          {
            name: "c",
            params: [{ key: "only-stg", description: "d", origin: "overlay", instances: [{ name: "staging", value: "x" }] }],
          },
        ],
      })
    );
    expect(plan.items).toHaveLength(1);
    expect(report.unstated).toEqual([{ unit: "server", sheet: "os", key: "only-stg", instance: "production" }]);
  });

  // A value that must not travel is still TESTED; what the record does not get
  // is the value. The item carries the flag rather than the expectation.
  it("keeps a secret out of the plan without dropping its item", () => {
    const { plan } = buildTestPlan(
      withGroup(TESTED, {
        instances: ["staging"],
        categories: [{ name: "c", params: [{ key: "pw", description: "d", origin: "common", value: "hunter2", secret: true }] }],
      })
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].quiet).toBe(true);
    expect(plan.items[0].expected).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain("hunter2");
  });

  // Out of scope is the project's own statement that a row is not being
  // reviewed here. It is not an item, and it is not silence either.
  it("leaves an out-of-scope row out, with its reason", () => {
    const { plan, report } = buildTestPlan(
      withGroup(TESTED, {
        instances: ["staging"],
        categories: [
          {
            name: "c",
            params: [
              { key: "a", description: "d", origin: "common", value: "1" },
              { key: "b", description: "d", origin: "common", value: "2", out_of_scope: { reason: { ja: "DBA の管轄" } } },
            ],
          },
        ],
      })
    );
    expect(plan.items.map((i) => i.target.key)).toEqual(["a"]);
    // …with the component, since two of them can exclude the same key.
    expect(report.excluded).toEqual([{ unit: "server", sheet: "os", component: "c", key: "b", reason: { ja: "DBA の管轄" } }]);
  });

  it("has nothing to say about a document sheet", () => {
    const { plan } = buildTestPlan(model([{ name: "doc", document: { html: "" } }]));
    expect(plan.items).toEqual([]);
    expect(plan.units).toEqual([]);
  });
});

// 大項目 is the chapter that HOLDS sheets, which is what a reader sees beside
// the items — not the phase above it, and not the sheet below.
describe("the unit an item belongs to", () => {
  it("is the group the sheet is in", () => {
    const { plan } = buildTestPlan(
      model(
        [sheet({ group: "server" })],
        [{ name: "detail", label: { ja: "詳細設計" }, groups: [{ name: "server", label: { ja: "SSO サーバ" }, test: TESTED }] }]
      )
    );
    expect(plan.units.map((u) => [u.name, u.label])).toEqual([["server", { ja: "SSO サーバ" }]]);
    expect(plan.items[0].unitLabel).toEqual({ ja: "SSO サーバ" });
    expect(plan.items[0].sheetLabel).toEqual({ ja: "OS 基本情報" });
  });

  it("is the sheet itself when it belongs to no group", () => {
    const { plan } = buildTestPlan(model([sheet({ group: undefined, test: TESTED })]));
    expect(plan.units.map((u) => u.name)).toEqual(["os"]);
  });

  it("carries the component a row sits under, for the sub-heading", () => {
    const { plan } = buildTestPlan(withGroup());
    expect(plan.items[0].component).toBe("/etc/chrony.conf");
  });
});

// The gate. A unit nobody wrote a method for is either untested by accident or
// untested on purpose, and only the second may be silent.
describe("a unit that says nothing about being tested", () => {
  it("fails the build, naming it", () => {
    expect(() => buildTestPlan(model([sheet()], [{ name: "server", label: { ja: "SSO サーバ" } }]))).toThrow(/server/);
  });

  it("is satisfied by saying it is NOT tested here, and then has no items", () => {
    const { plan } = buildTestPlan(withGroup({ not_tested: { ja: "この工程では実施しない" } }));
    expect(plan.items).toEqual([]);
    // …and the unit is still in the plan, or the document would have no place
    // to say so.
    expect(plan.units.map((u) => u.name)).toEqual(["server"]);
  });

  it("counts a unit once however many sheets it holds", () => {
    expect(() =>
      buildTestPlan(model([sheet({ name: "a" }), sheet({ name: "b" })], [{ name: "server" }]))
    ).toThrow(/1 unit\(s\): server/);
  });
});

describe("what the report says out loud", () => {
  it("counts the items by kind, and names what it left out", () => {
    const { plan, report } = buildTestPlan(
      withGroup(TESTED, {
        instances: ["staging"],
        categories: [
          {
            name: "c",
            params: [
              { key: "a", description: "d", origin: "common", value: "1" },
              { key: "b", description: "d", origin: "default", default: "0" },
              { key: "c", description: "d", origin: "common", value: "2", out_of_scope: { reason: { ja: "別管轄" } } },
            ],
          },
        ],
      })
    );
    const said = formatTestPlanReport(plan, report);
    expect(said).toContain("2 item(s) across 1 unit(s)");
    expect(said).toContain("1 value");
    expect(said).toContain("1 default-in-force");
    expect(said).toContain("out of scope (1)");
    expect(said).toContain("os > c");
  });
});

// The declaration travels: a project writes it in its own metadata, the
// assembler carries it into the model verbatim, and the plan reads it there.
// The schema has to admit it at both ends or the model that carries it is
// rejected — which is how this was found, by a build that suddenly failed
// validation with the declaration in place.
describe("the declaration in a model", () => {
  it("is accepted by the input schema on a group and on a sheet", async () => {
    const { validateInput } = await import("../src/validate");
    const doc = {
      metadata: { title: "t" },
      groups: [{ name: "server", label: { ja: "SSO サーバ" }, test: { method: { ja: "m" }, functional: [{ ja: "f" }] } }],
      sheets: [
        { name: "os", group: "server", instances: [], categories: [{ name: "c", params: [{ key: "k", description: "d", value: "1" }] }] },
        {
          name: "alone",
          test: { not_tested: { ja: "この工程では実施しない" } },
          instances: [],
          categories: [{ name: "c", params: [{ key: "k", description: "d", value: "1" }] }],
        },
      ],
    };
    expect(() => validateInput(doc)).not.toThrow();
  });
});

// WHERE to look. A collector cannot answer an item without it, and the plan is
// what the collector reads — so the deployed path travels with the item rather
// than being re-derived from the model by whoever is doing the looking.
describe("the file an item is checked in", () => {
  it("is the sheet's deployed path", () => {
    const { plan } = buildTestPlan(
      withGroup(TESTED, { instances: ["staging"], file_path: "/etc/httpd/conf/httpd.conf" })
    );
    expect(plan.items[0].file).toBe("/etc/httpd/conf/httpd.conf");
  });

  // …and the component's own, on a sheet that covers several artifacts: one
  // path for the whole sheet would send the collector at the wrong file for
  // every component but one.
  it("is the component's own on a sheet that covers several", () => {
    const { plan } = buildTestPlan(
      withGroup(TESTED, {
        instances: ["staging"],
        file_path: "/etc/one",
        categories: [
          { name: "unit", file_path: "/etc/systemd/system/x.service", params: [{ key: "a", description: "d", origin: "common", value: "1" }] },
          { name: "conf", file_path: "/etc/x.conf", params: [{ key: "b", description: "d", origin: "common", value: "2" }] },
        ],
      })
    );
    expect(plan.items.map((i) => [i.target.key, i.file])).toEqual([
      ["a", "/etc/systemd/system/x.service"],
      ["b", "/etc/x.conf"],
    ]);
  });

  // A sheet whose subject is not a file on a host — a product's API-side
  // configuration, a cloud resource — says nothing rather than guessing, and
  // that silence is why such an item usually comes back not run.
  it("is absent when the sheet describes no deployed file", () => {
    const { plan } = buildTestPlan(withGroup(TESTED, { instances: ["staging"] }));
    expect(plan.items[0].file).toBeUndefined();
  });
});
