// The answers to a plan, and the join between them.
//
// The schema (results.schema.json) says what an answer looks like; this says
// whether a set of them ANSWERS the plan. Those are different questions and
// only the second can catch the failure this whole area exists to prevent: a
// record that looks complete because what is missing from it is missing.
//
// Three checks, and they are all about coverage rather than about verdicts:
//
//   unanswered   a plan item nothing answered — the test record's version of a
//                dropped row, and invisible in a document that only prints the
//                answers it has
//   unknown      an answer to no plan item — a stale record judged against an
//                older sheet, which is how a run reports findings that were
//                fixed days ago
//   silent       a `not_run` with no reason. Not attempted is a legitimate
//                state; not attempted for no stated reason is a gap wearing the
//                same clothes as a decision
//
// A FAILING item is not one of them. A test record with failures in it is a
// legitimate deliverable — that is what a test record is for — so nothing here
// gates on pass/fail.

import type { TestItem, TestPlan } from "./testplan.js";

export type TestStatus = "pass" | "fail" | "not_run";

export type TestEvidence = {
  host?: string;
  file?: string;
  line?: number;
  command?: string;
  note?: string;
};

export type TestResult = {
  target: { sheet: string; path?: string[]; key: string; instance: string };
  status: TestStatus;
  reason?: string;
  actual?: string;
  detail?: string;
  evidence?: TestEvidence;
  at?: string;
};

export type TestRun = {
  at?: string;
  hosts?: string[];
  by?: string;
  collector?: string;
  model?: string;
};

export type TestResults = {
  runs?: Record<string, TestRun>;
  results: TestResult[];
  // The raw material a result points at — see evidence.ts. Written by the judge
  // (which decides what may travel), carried by `generate --evidence`.
  evidence?: {
    instance: string;
    host: string;
    at: string;
    sheet: string;
    component?: string;
    path?: string;
    command?: string;
    text: string;
  }[];
  unclaimed?: { instance: string; what: string; evidence?: TestEvidence }[];
  functional?: { unit: string; item: string; instance: string; status: TestStatus; reason?: string; detail?: string; evidence?: TestEvidence }[];
};

// The join key. The category path is part of a row's identity — two components
// of one sheet share a key space by design — but a judge that answers by sheet
// and key alone is answering the question a reader asks, so the path is
// OPTIONAL here and only narrows the match when it is given.
const keyOf = (t: { sheet: string; key: string; instance: string }): string => `${t.sheet}\u0000${t.key}\u0000${t.instance}`;
const pathKeyOf = (t: { sheet: string; path?: string[]; key: string; instance: string }): string =>
  `${keyOf(t)}\u0000${(t.path ?? []).join("\u0000")}`;

export type ResultsCheck = {
  answered: number;
  byStatus: Record<TestStatus, number>;
  unanswered: TestItem[];
  unknown: TestResult[];
  silent: TestResult[];
  // Answers whose plan item is quiet and which carry a value anyway. The plan
  // withheld it on purpose; a record that puts it back has published it.
  leaked: TestResult[];
};

export function checkResults(plan: TestPlan, results: TestResults): ResultsCheck {
  const byPath = new Map<string, TestItem>();
  const byKey = new Map<string, TestItem[]>();
  for (const item of plan.items) {
    byPath.set(pathKeyOf(item.target), item);
    const k = keyOf(item.target);
    byKey.set(k, [...(byKey.get(k) ?? []), item]);
  }

  const check: ResultsCheck = {
    answered: 0,
    byStatus: { pass: 0, fail: 0, not_run: 0 },
    unanswered: [],
    unknown: [],
    silent: [],
    leaked: [],
  };
  const seen = new Set<TestItem>();

  for (const r of results.results) {
    // With a path, the answer names one item. Without one it names every item
    // that key has — which is one, unless two components of the sheet share the
    // key, and then answering without the path is genuinely ambiguous and every
    // one of them is counted as answered rather than a silent pick.
    const matched = r.target.path !== undefined ? [byPath.get(pathKeyOf(r.target))].filter((x): x is TestItem => x !== undefined) : (byKey.get(keyOf(r.target)) ?? []);
    if (matched.length === 0) {
      check.unknown.push(r);
      continue;
    }
    for (const m of matched) seen.add(m);
    check.answered += 1;
    check.byStatus[r.status] += 1;
    if (r.status === "not_run" && (r.reason === undefined || r.reason.trim() === "")) check.silent.push(r);
    if (matched.some((m) => m.quiet === true) && r.actual !== undefined) check.leaked.push(r);
  }
  check.unanswered = plan.items.filter((i) => !seen.has(i));
  return check;
}

// What the check found, said in the order a reader needs it: the shape of the
// run first, then each way it fails to line up with the plan, each with its
// first few members (verifying.md R4 — a count nobody can read is not a
// report).
export function formatResultsCheck(check: ResultsCheck): string {
  const lines: string[] = [
    `results: ${check.answered} answered — ${check.byStatus.pass} pass, ${check.byStatus.fail} fail, ${check.byStatus.not_run} not run`,
  ];
  const some = <T>(xs: T[], say: (x: T) => string): string =>
    xs.slice(0, 3).map(say).join(", ") + (xs.length > 3 ? ", …" : "");
  if (check.unanswered.length > 0) {
    lines.push(`  unanswered (${check.unanswered.length}): ${some(check.unanswered, (i) => `${i.target.sheet} > ${i.target.key} [${i.target.instance}]`)}`);
  }
  if (check.unknown.length > 0) {
    lines.push(`  answers no item in this plan (${check.unknown.length}): ${some(check.unknown, (r) => `${r.target.sheet} > ${r.target.key} [${r.target.instance}]`)}`);
  }
  if (check.silent.length > 0) {
    lines.push(`  not run, with no reason (${check.silent.length}): ${some(check.silent, (r) => `${r.target.sheet} > ${r.target.key} [${r.target.instance}]`)}`);
  }
  if (check.leaked.length > 0) {
    lines.push(`  carries a value the plan withheld (${check.leaked.length}): ${some(check.leaked, (r) => `${r.target.sheet} > ${r.target.key}`)}`);
  }
  return lines.join("\n");
}

// …and whether that is a failure. Coverage and consistency only: a run with
// failing items has done its job.
export function resultsCheckFails(check: ResultsCheck): boolean {
  return check.unanswered.length > 0 || check.unknown.length > 0 || check.silent.length > 0 || check.leaked.length > 0;
}
