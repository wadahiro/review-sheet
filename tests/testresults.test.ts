// Whether a set of answers ANSWERS a plan.
//
// The schema says what an answer looks like; this is the other question, and
// only this one catches the failure a test record is most prone to — looking
// complete because what is missing from it is missing. Every check here is
// about coverage and consistency; none of them is about pass or fail, because
// a record with failures in it is doing its job.

import { describe, it, expect } from "bun:test";
import { checkResults, formatResultsCheck, resultsCheckFails, type TestResults } from "../src/testresults";
import { validateResults } from "../src/validate";
import type { TestPlan } from "../src/testplan";

const plan = (items: { sheet?: string; key: string; instance: string; path?: string[]; quiet?: boolean }[]): TestPlan =>
  ({
    metadata: { title: "t" },
    units: [{ name: "u", declaration: {}, sheets: ["os"] }],
    items: items.map((i) => ({
      target: { sheet: i.sheet ?? "os", path: i.path ?? ["c"], key: i.key, instance: i.instance },
      unit: "u",
      kind: "value" as const,
      ...(i.quiet === true ? { quiet: true as const } : { expected: "x" }),
    })),
  }) as TestPlan;

const answers = (rs: TestResults["results"]): TestResults => ({ results: rs });

describe("whether the answers answer the plan", () => {
  it("counts what came back, by verdict", () => {
    const check = checkResults(plan([{ key: "a", instance: "stg" }, { key: "b", instance: "stg" }]), answers([
      { target: { sheet: "os", path: ["c"], key: "a", instance: "stg" }, status: "pass" },
      { target: { sheet: "os", path: ["c"], key: "b", instance: "stg" }, status: "fail", actual: "y" },
    ]));
    expect(check.answered).toBe(2);
    expect(check.byStatus).toEqual({ pass: 1, fail: 1, not_run: 0 });
    // A failing item is not a problem with the RECORD.
    expect(resultsCheckFails(check)).toBe(false);
  });

  // The one a document cannot show you: an item nothing answered leaves no
  // trace in a record that prints the answers it has.
  it("names a plan item nothing answered", () => {
    const check = checkResults(plan([{ key: "a", instance: "stg" }, { key: "b", instance: "stg" }]), answers([
      { target: { sheet: "os", path: ["c"], key: "a", instance: "stg" }, status: "pass" },
    ]));
    expect(check.unanswered.map((i) => i.target.key)).toEqual(["b"]);
    expect(resultsCheckFails(check)).toBe(true);
  });

  // A stale record judged against an older sheet: every answer looks fine, and
  // some of them are about rows that no longer exist.
  it("names an answer that belongs to no item of this plan", () => {
    const check = checkResults(plan([{ key: "a", instance: "stg" }]), answers([
      { target: { sheet: "os", path: ["c"], key: "a", instance: "stg" }, status: "pass" },
      { target: { sheet: "os", path: ["c"], key: "gone", instance: "stg" }, status: "pass" },
    ]));
    expect(check.unknown.map((r) => r.target.key)).toEqual(["gone"]);
    expect(resultsCheckFails(check)).toBe(true);
  });

  // Not attempted is a legitimate state; not attempted for no stated reason is
  // a gap wearing the same clothes as a decision.
  it("names a not-run with no reason, and accepts one that has a reason", () => {
    const silent = checkResults(plan([{ key: "a", instance: "prod" }]), answers([
      { target: { sheet: "os", path: ["c"], key: "a", instance: "prod" }, status: "not_run" },
    ]));
    expect(silent.silent).toHaveLength(1);
    expect(resultsCheckFails(silent)).toBe(true);

    const said = checkResults(plan([{ key: "a", instance: "prod" }]), answers([
      { target: { sheet: "os", path: ["c"], key: "a", instance: "prod" }, status: "not_run", reason: "本番は未構築" },
    ]));
    expect(said.silent).toEqual([]);
    expect(resultsCheckFails(said)).toBe(false);
  });

  // The plan withheld the value on purpose; a record that puts it back has
  // published it.
  it("names an answer carrying a value the plan withheld", () => {
    const check = checkResults(plan([{ key: "pw", instance: "stg", quiet: true }]), answers([
      { target: { sheet: "os", path: ["c"], key: "pw", instance: "stg" }, status: "pass", actual: "hunter2" },
    ]));
    expect(check.leaked).toHaveLength(1);
    expect(resultsCheckFails(check)).toBe(true);
  });

  // A judge that answers by sheet and key — the question a reader asks — is
  // answering the plan, and is not made wrong by not repeating the category
  // path back.
  it("accepts an answer that names no category path", () => {
    const check = checkResults(plan([{ key: "a", instance: "stg" }]), answers([
      { target: { sheet: "os", key: "a", instance: "stg" }, status: "pass" },
    ]));
    expect(check.answered).toBe(1);
    expect(check.unanswered).toEqual([]);
  });

  it("says all of it out loud, with examples", () => {
    const check = checkResults(plan([{ key: "a", instance: "stg" }, { key: "b", instance: "stg" }]), answers([
      { target: { sheet: "os", path: ["c"], key: "zzz", instance: "stg" }, status: "pass" },
    ]));
    const said = formatResultsCheck(check);
    expect(said).toContain("unanswered (2)");
    expect(said).toContain("os > a [stg]");
    expect(said).toContain("answers no item in this plan (1)");
    expect(said).toContain("os > zzz [stg]");
  });
});

// The schema is the other half: it says what an answer looks like at all, and
// one rule in it is load-bearing rather than descriptive.
describe("the shape of a results document", () => {
  it("refuses a not_run with no reason", () => {
    expect(() => validateResults({ results: [{ target: { sheet: "os", key: "a", instance: "stg" }, status: "not_run" }] })).toThrow(
      /reason/
    );
  });

  it("accepts one that says why", () => {
    expect(() =>
      validateResults({ results: [{ target: { sheet: "os", key: "a", instance: "stg" }, status: "not_run", reason: "未構築" }] })
    ).not.toThrow();
  });

  it("refuses a verdict it does not know", () => {
    expect(() => validateResults({ results: [{ target: { sheet: "os", key: "a", instance: "stg" }, status: "skipped" }] })).toThrow();
  });

  // The run's own facts are held once, not copied onto every row: an execution
  // date on two thousand rows is two thousand chances to disagree.
  it("keeps the run's facts per environment, beside the answers", () => {
    expect(() =>
      validateResults({
        runs: { local: { at: "2026-09-07T07:36:49Z", hosts: ["web01"], collector: "check-live.mjs" } },
        results: [{ target: { sheet: "os", key: "a", instance: "local" }, status: "pass", evidence: { host: "web01", file: "/etc/chrony.conf", line: 3 } }],
      })
    ).not.toThrow();
  });

  // The reverse direction of coverage: something the system has that no row
  // claims. Only a thing that looked at the system can know it.
  it("has a place for what was seen and answered nothing", () => {
    expect(() =>
      validateResults({ results: [], unclaimed: [{ instance: "local", what: "--endpoint-url[0]", evidence: { file: "/usr/local/bin/x.sh" } }] })
    ).not.toThrow();
  });
});
