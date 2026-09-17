// A ROW WHOSE VALUE IS SECRET IS NOT A ROW WITH NO VALUE.
//
// The plan refuses to carry an expectation for a secret row (testplan's
// `quiet`), so the judge has nothing to compare against and files it not-run.
// It used to give that the same reason as a row the sheet genuinely says
// nothing about in this environment — and the sheet does state this one, as
// `${vault.corp-ldap-bind}`, right where the reader is being sent to look for
// a gap that is not there.

import { describe, it, expect } from "bun:test";
import { judgeFiles } from "../src/judge";
import type { TestPlan } from "../src/testplan";

const plan = (over: Record<string, unknown>): TestPlan =>
  ({
    metadata: { title: "t" },
    units: [{ name: "u", label: { ja: "U" }, declaration: { method: { ja: "読む" } }, sheets: ["ldap"] }],
    items: [
      {
        target: { sheet: "ldap", path: ["corp"], key: "bind-credential", instance: "local" },
        unit: "u",
        kind: "value",
        decider: "project",
        file: "/etc/app.conf",
        ...over,
      },
    ],
    functional: [],
  }) as never;

const observations = [
  { environment: "local", collected_at: "2026-09-17T00:00:00Z", hosts: { h1: { files: { "/etc/app.conf": "other=1\n" } } } },
] as never;

const reasonOf = (p: TestPlan): string | undefined =>
  judgeFiles(p, observations as never, { at: "X" }).results[0]?.reason;

describe("a not-run row says which kind it is", () => {
  it("a secret row says the plan carries no expectation", () => {
    expect(reasonOf(plan({ quiet: true }))).toContain("秘密");
  });

  // …and the other case keeps the sentence it always had.
  it("a row the sheet says nothing about here keeps the old reason", () => {
    expect(reasonOf(plan({}))).toContain("値を述べていない");
  });

  it("does not use one for the other", () => {
    expect(reasonOf(plan({ quiet: true }))).not.toContain("値を述べていない");
    expect(reasonOf(plan({}))).not.toContain("秘密");
  });

  it("says both in English too", () => {
    const en = (p: TestPlan): string | undefined =>
      judgeFiles(p, observations as never, { at: "X", lang: "en" }).results[0]?.reason;
    expect(en(plan({ quiet: true }))).toContain("marked secret");
    expect(en(plan({}))).toContain("states no value");
  });
});
