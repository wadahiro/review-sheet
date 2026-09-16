// ONE ROW, EVERY HOST.
//
// `judgeFiles` walks every host that was collected and answers per host, which
// is the honest record: two nodes hold the same file and each was read.
// Everything downstream answers per ROW, and each did something different with
// the duplicates — the document's index kept whichever came last, and the
// coverage gate counted them all, so a plan of 3698 items came back "4244
// answered" on a real record.
//
// The rule is the one already written down for functional items: a fleet is
// only as configured as its least configured node, the host that produced the
// worst answer is named, and a host that could not be asked is a third answer
// rather than a failure.

import { describe, it, expect } from "bun:test";
import { foldByTarget, checkResults, type TestResult } from "../src/testresults";
import type { TestPlan } from "../src/testplan";

const target = { sheet: "os", path: ["c"], key: "k", instance: "prod" };
const on = (host: string, over: Partial<TestResult> = {}): TestResult =>
  ({ target, status: "pass", evidence: { host, file: "/etc/x.conf", line: 3 }, ...over }) as TestResult;

describe("two hosts answering one row", () => {
  it("becomes one row", () => {
    expect(foldByTarget([on("a"), on("b")])).toHaveLength(1);
  });

  // A fleet is only as configured as its least configured node.
  it("takes the worst answer, and points at the host that produced it", () => {
    const [got] = foldByTarget([on("a"), on("b", { status: "fail", actual: "wrong" })]);
    expect(got!.status).toBe("fail");
    expect(got!.evidence?.host).toBe("b");
  });

  // …and says so by name. A verdict reading `fail` without saying which node
  // produced it sends a reader to every one of them.
  it("names both hosts and what each said when they disagree", () => {
    const [got] = foldByTarget([on("a"), on("b", { status: "fail", actual: "wrong" })]);
    expect(got!.reason).toContain("a: pass");
    expect(got!.reason).toContain("b: fail (wrong)");
  });

  // The other host's bytes are what a reader checks the verdict against.
  it("keeps every host's evidence", () => {
    const [got] = foldByTarget([on("a"), on("b", { status: "fail" })]);
    expect(got!.evidence?.also?.map((e) => e.host)).toEqual(["a"]);
  });

  // A host that could not be asked is a THIRD answer, not a failure — the same
  // reading `judgeProbes` gives it. Treating it as one would fail every row of
  // an environment collected in passes.
  it("does not let a host that could not answer decide the row", () => {
    const [got] = foldByTarget([on("a"), on("b", { status: "not_run", reason: "no such file here" })]);
    expect(got!.status).toBe("pass");
  });

  it("says not_run only when nobody could answer", () => {
    const [got] = foldByTarget([on("a", { status: "not_run", reason: "x" }), on("b", { status: "not_run", reason: "y" })]);
    expect(got!.status).toBe("not_run");
  });

  it("leaves a row only one host answered exactly as it was", () => {
    const one = on("a");
    expect(foldByTarget([one])[0]).toBe(one);
  });

  // Two rows are two rows. The fold is by TARGET and must not merge a sheet's
  // rows into each other.
  it("does not fold two different rows together", () => {
    const other = { ...on("a"), target: { ...target, key: "other" } };
    expect(foldByTarget([on("a"), other])).toHaveLength(2);
  });
});

describe("the coverage gate", () => {
  const plan = {
    metadata: { title: "t" },
    units: [{ name: "u", declaration: { method: { en: "m" } }, sheets: ["os"] }],
    items: [{ target, unit: "u", kind: "value", decider: "project", expected: "v" }],
    functional: [],
  } as never as TestPlan;

  // One item, two hosts: counting the results made a plan of N items come back
  // with more answers than it has items.
  it("counts the item once, however many hosts answered it", () => {
    expect(checkResults(plan, { results: [on("a"), on("b")] }).answered).toBe(1);
    expect(checkResults(plan, { results: [on("a"), on("b")] }).unanswered).toEqual([]);
  });

  it("counts the worst status, not one per host", () => {
    const got = checkResults(plan, { results: [on("a"), on("b", { status: "fail" })] });
    expect(got.byStatus).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });
});
