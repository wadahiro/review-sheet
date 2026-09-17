// WHAT A RECORD SAYS ABOUT WHAT IT DID NOT CHECK.
//
// Three reasons a row has no test item, in ONE table, told apart by the reason
// column — which is the column that exists to answer exactly that:
//
//   "we left this out"         a decision the project made and can be asked to
//                              justify
//   "nothing was decided here" the dictionary says the product's admin UI shows
//                              the value and offers no way to choose one, and
//                              nobody set it. Droppable with a flag: a project
//                              whose sheet marks those rows per-row is being
//                              told the same thing twice
//   "covered by X instead"     designed and reviewed, and no channel here can
//                              read it back — with X's OWN verdict beside it
//
// …and one line counting the unset parameters, droppable on its own axis: the
// only way to lose the restatement used to be printing every one of them.

import { describe, it, expect } from "bun:test";
import { renderTestDoc, renderExcluded } from "../src/testdoc";
import type { TestPlan } from "../src/testplan";
import type { TestResults } from "../src/testresults";

const EXCLUDED = [
  { unit: "server", sheet: "realm", key: "smtpServer.password", reason: { ja: "本案件では扱わない", en: "not handled here" }, owner: "運用", },
  { unit: "server", sheet: "realm", key: "notBefore", reason: { ja: "選ぶ手段がない", en: "nothing to choose" }, by: "product" as const },
  { unit: "server", sheet: "realm", key: "clientSessionIdleTimeout", reason: { ja: "選ぶ手段がない", en: "nothing to choose" }, by: "product" as const },
  { unit: "other", sheet: "realm", key: "elsewhere", reason: { ja: "別の単体テスト", en: "another unit" } },
];

describe("the two kinds of row a record does not check", () => {
  const out = () => renderExcluded(EXCLUDED, "server", "ja");

  it("keeps the project's own decisions in the out-of-scope table", () => {
    expect(out()).toContain("smtpServer.password");
    expect(out()).toContain("本案件では扱わない");
    expect(out()).toContain("運用");
  });

  // ONE table, and each row carries its own reason — which is what tells the
  // two apart, and is the column a reader is reading for exactly that.
  it("puts what the tool set aside in the same table, with its own reason", () => {
    expect(out()).toContain("notBefore");
    expect(out()).toContain("clientSessionIdleTimeout");
    expect(out().split("\n").find((l) => l.includes("notBefore"))).toContain("選ぶ手段がない");
  });

  it("is one table, not a section per kind", () => {
    expect(out()).not.toContain("###");
  });

  it("counts only this unit's", () => {
    expect(out()).not.toContain("elsewhere");
  });
});

describe("a record with nothing left out", () => {
  // A heading over a table with no rows under it is a section a reader has to
  // decode.
  it("says so in words instead of printing an empty table", () => {
    expect(renderExcluded([], "server", "ja")).toBe("なし。");
    expect(renderExcluded([], "server", "en")).toBe("None.");
  });

  // "Nothing" means nothing in the table at all — the project's rows and the
  // product's are rows of one table now.
  it("still lists what carries no decision, when that is all there is", () => {
    const only = EXCLUDED.filter((e) => e.by !== undefined);
    const text = renderExcluded(only, "server", "ja");
    expect(text).not.toContain("なし。");
    expect(text).toContain("notBefore");
  });
});

describe("a plan built before any of this", () => {
  // Every model and every plan JSON written until now lacks `by`, which is why
  // ABSENT is the project case and not the other way round.
  it("renders entirely as the project's own decisions", () => {
    const old = EXCLUDED.filter((e) => e.unit === "server").map(({ by: _drop, ...rest }) => rest);
    const text = renderExcluded(old, "server", "ja", undefined, { productExclusions: false } as never);
    // Nothing is `by: "product"` any more, so the flag that drops those has
    // nothing to drop and every row stays.
    expect(text).toContain("notBefore");
  });
});

// ---------------------------------------------------------------------------

const PLAN = (): TestPlan =>
  ({
    metadata: { title: "t" },
    units: [{ name: "server", label: { ja: "SSO サーバ" }, declaration: { method: { ja: "読む" } }, sheets: ["os"] }],
    items: [
      { target: { sheet: "os", path: ["a.conf"], key: "Listen", instance: "local" }, unit: "server", component: "a.conf", kind: "value", decider: "project", expected: "80" },
      { target: { sheet: "os", path: ["a.conf"], key: "Timeout", instance: "local" }, unit: "server", component: "a.conf", kind: "default-in-force", decider: "product-default", expected: "60" },
      { target: { sheet: "os", path: ["a.conf"], key: "KeepAlive", instance: "local" }, unit: "server", component: "a.conf", kind: "default-in-force", decider: "product-default", expected: "On" },
    ],
    functional: [],
  }) as TestPlan;

const RESULTS = (): TestResults => ({
  runs: { local: { at: "2026-09-07T07:36:49Z", hosts: ["web01"] } },
  results: [
    { target: { sheet: "os", key: "Listen", instance: "local" }, status: "pass", detail: "d" },
    { target: { sheet: "os", key: "Timeout", instance: "local" }, status: "pass", detail: "d" },
    { target: { sheet: "os", key: "KeepAlive", instance: "local" }, status: "pass", detail: "d" },
  ],
} as TestResults);

describe("the line counting the parameters nobody set", () => {
  const summary = (opts: Record<string, unknown>): string =>
    renderTestDoc(PLAN(), RESULTS(), "server", { lang: "ja", ...opts })["test:summary"];

  it("is there by default", () => {
    expect(summary({})).toContain("2 項目");
  });

  // The axis the request was really about: dropping the sentence used to mean
  // printing all of them as rows instead.
  it("goes away on its own, without turning the rows on", () => {
    const text = summary({ defaultsSummary: false });
    expect(text).not.toContain("2 項目");
    expect(text).not.toContain("KeepAlive");
  });

  // Suppressed in the document, never unreported — the record is the project's
  // to shape, whether it is complete is not a private matter.
  it("still reports what it removed, to the build", () => {
    const said: { unit: string; items: number; answered: number }[] = [];
    summary({ defaultsSummary: false, onDefaultsOmitted: (o: never) => said.push(o) });
    expect(said).toEqual([{ unit: "server", items: 2, answered: 2 }]);
  });

  // A flag is not a per-unit line of noise: a unit with none of these items had
  // nothing removed, so there is nothing to report.
  it("reports nothing for a unit that had none", () => {
    const plan = PLAN();
    plan.items = plan.items.filter((i) => i.kind !== "default-in-force");
    const said: unknown[] = [];
    renderTestDoc(plan, RESULTS(), "server", { lang: "ja", defaultsSummary: false, onDefaultsOmitted: () => said.push(1) });
    expect(said).toEqual([]);
  });
});

// …and the group that carries no decision can be left out entirely.
//
// The same axis as the unset-parameter line: a project whose parameter sheet
// already marks these rows per-row has nothing to restate here, and this group
// is the one holding nothing a reviewer signs. The axis is the SECTION, not the
// rows — the project's own out-of-scope table is untouched either way.
describe("leaving out what the product set aside", () => {
  const out = (o: Record<string, unknown>) => renderExcluded(EXCLUDED, "server", "ja", undefined, o as never);

  it("is printed by default", () => {
    expect(out({})).toContain("notBefore");
  });

  it("goes away when the record asks it to", () => {
    expect(out({ productExclusions: false })).not.toContain("notBefore");
    expect(out({ productExclusions: false })).not.toContain("clientSessionIdleTimeout");
  });

  // The project's own decisions are a different claim and stay.
  it("leaves the project's own out-of-scope table alone", () => {
    expect(out({ productExclusions: false })).toContain("smtpServer.password");
  });

  it("still reports what it removed, to the build", () => {
    const said: { unit: string; rows: number }[] = [];
    out({ productExclusions: false, onProductOmitted: (o: never) => said.push(o) });
    expect(said).toEqual([{ unit: "server", rows: 2 }]);
  });

  it("reports nothing for a unit that had none", () => {
    const said: unknown[] = [];
    renderExcluded(
      EXCLUDED.filter((e) => e.by === undefined),
      "server",
      "ja",
      undefined,
      { productExclusions: false, onProductOmitted: () => said.push(1) } as never
    );
    expect(said).toEqual([]);
  });
});

// THE TAXONOMY'S "IN THIS DOCUMENT" COLUMN IS THE TOOL'S SENTENCE, and it
// claimed one heading per sheet of the detailed design. A sheet whose items are
// ALL unset parameters gets no heading unless those are printed as rows — so on
// a real record the sentence said nine sheets have a section where seven do,
// which is a claim about coverage in a document whose whole job is coverage.
describe("what the taxonomy says about the headings", () => {
  const planWith = (over: Record<string, unknown> = {}): TestPlan =>
    ({
      metadata: { title: "t" },
      units: [
        {
          name: "u",
          label: { ja: "U" },
          sheets: ["set", "unset"],
          declaration: {
            method: { ja: "読む" },
            taxonomy: [
              { level: { ja: "大項目" }, raised: { ja: "a" } },
              { level: { ja: "中項目" }, raised: { ja: "b" } },
              { level: { ja: "小項目" }, raised: { ja: "c" } },
            ],
          },
        },
      ],
      items: [
        { target: { sheet: "set", path: [], key: "Listen", instance: "local" }, unit: "u", kind: "value", decider: "project", expected: "80" },
        { target: { sheet: "unset", path: [], key: "Timeout", instance: "local" }, unit: "u", kind: "default-in-force", decider: "product-default", expected: "60" },
      ],
      functional: [],
      ...over,
    }) as never;

  const results = { runs: {}, results: [] } as unknown as TestResults;
  const taxonomy = (opts: Record<string, unknown> = {}): string =>
    renderTestDoc(planWith(), results, "u", { lang: "ja", ...opts })["test:taxonomy"];

  it("does not claim a heading for a sheet that has none", () => {
    expect(taxonomy()).toContain("行を持つ");
  });

  // …and says the plain thing when it IS true: printing the unset rows gives
  // every sheet its heading back.
  it("claims one per sheet when every sheet has one", () => {
    expect(taxonomy({ includeDefaults: true })).not.toContain("行を持つ");
  });

  // The sentence has two shapes — with functional items and without — and the
  // correction has to reach both, since a unit either declares them or does not.
  it("corrects both shapes of the sentence", () => {
    const withFunctional = renderTestDoc(
      planWith({ functional: [{ unit: "u", text: { ja: "起動できること" }, intrusive: false, instance: "local" }] }),
      results,
      "u",
      { lang: "ja" }
    )["test:taxonomy"];
    expect(withFunctional).toContain("行を持つ詳細設計シート1つにつき1つ");
    expect(withFunctional).toContain("機能確認");
  });

  it("says it in English too", () => {
    const en = (o: Record<string, unknown>): string =>
      renderTestDoc(planWith(), results, "u", { lang: "en", ...o })["test:taxonomy"];
    expect(en({})).toContain("that has rows in this document");
    expect(en({ includeDefaults: true })).not.toContain("that has rows in this document");
  });
});
