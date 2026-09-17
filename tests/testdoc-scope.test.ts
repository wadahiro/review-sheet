// WHAT A RECORD SAYS ABOUT WHAT IT DID NOT CHECK.
//
// Three claims that used to be one, or none:
//
//   "we left these out"        a decision the project made and can be asked to
//                              justify — the out-of-scope table
//   "nothing was decided here" the dictionary says the product's admin UI shows
//                              the value and offers no way to choose one, and
//                              nobody set it. There is no remit to be outside
//                              of, and printing it under the heading above made
//                              a reader read it as one
//   "N unset parameters were   true, and already said per-row on the parameter
//    checked too"              sheet of a project that marks them there. The
//                              only way to drop the restatement was to print
//                              every one of them as a row

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

  // The table is the project's claim, so a row the tool set aside must not be
  // in it — that is the whole complaint this answers.
  it("keeps what the tool set aside out of that table", () => {
    const table = out().split("###")[0];
    expect(table).not.toContain("notBefore");
    expect(table).not.toContain("clientSessionIdleTimeout");
  });

  it("gives them their own heading, which says what they are", () => {
    expect(out()).toContain("### 決定の存在しない項目");
    expect(out()).toContain("notBefore");
    expect(out()).toContain("clientSessionIdleTimeout");
  });

  // Once for the pair, not once per row: the sentence is the dictionary's and
  // it is the same sentence.
  it("says the shared reason once and lists the keys under it", () => {
    const said = out().split("選ぶ手段がない").length - 1;
    expect(said).toBe(1);
    expect(out()).toContain("- realm > `notBefore`");
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

  // …and still shows the other section. "The project excluded nothing, and
  // here is what carries no decision" is exactly the distinction being drawn.
  it("still says what carries no decision", () => {
    const only = EXCLUDED.filter((e) => e.by !== undefined);
    const text = renderExcluded(only, "server", "ja");
    expect(text.startsWith("なし。")).toBe(true);
    expect(text).toContain("### 決定の存在しない項目");
  });
});

describe("a plan built before any of this", () => {
  // Every model and every plan JSON written until now lacks `by`, which is why
  // ABSENT is the project case and not the other way round.
  it("renders entirely as the project's own decisions", () => {
    const old = EXCLUDED.filter((e) => e.unit === "server").map(({ by: _drop, ...rest }) => rest);
    const text = renderExcluded(old, "server", "ja");
    expect(text).not.toContain("###");
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
