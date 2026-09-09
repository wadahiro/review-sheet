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

import type { FunctionalTestItem, TestItem, TestPlan } from "./testplan.js";
import type { LangText } from "./types.js";

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
  // Answers to the functional items. `id` is the join where the declaration
  // gave one; `item` is the prose, kept as the fallback join and as what a
  // record prints. Same shape as the value answers: the id is the row's own
  // address and the loose key only narrows when nothing better exists.
  functional?: { unit: string; id?: string; item: string; instance: string; status: TestStatus; reason?: string; detail?: string; evidence?: TestEvidence }[];
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
  // The same three questions, asked of the functional items. Kept apart because
  // they are a different shape, counted together because they are the same
  // unit test: `answered` and `byStatus` above hold both.
  unansweredFunctional: FunctionalTestItem[];
  unknownFunctional: NonNullable<TestResults["functional"]>;
  silentFunctional: NonNullable<TestResults["functional"]>;
};

// Where a functional answer and a functional item meet. Two addresses, the
// stronger one first, exactly as the value answers work: the declaration's id
// when both sides have one, and the sentence otherwise.
//
// The sentence is indexed in EVERY language the declaration wrote it in — a
// judge answers in the words it was handed, and a document rendered in the
// other language would otherwise find nothing.
const functionalId = (t: { unit: string; instance: string }, id: string): string => `${t.unit}\u0000${t.instance}\u0000#${id}`;
const functionalTexts = (t: { unit: string; instance: string }, text: LangText): string[] =>
  (typeof text === "string" ? [text] : [text.ja, text.en])
    .filter((x): x is string => x !== undefined && x !== "")
    .map((x) => `${t.unit}\u0000${t.instance}\u0000${x}`);

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
    unansweredFunctional: [],
    unknownFunctional: [],
    silentFunctional: [],
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

  // …and the same pass over the functional items, whose answers count into the
  // same totals: they are items of this unit test, not a postscript to it.
  const fById = new Map<string, FunctionalTestItem>();
  const fByText = new Map<string, FunctionalTestItem>();
  for (const f of plan.functional) {
    if (f.id !== undefined) fById.set(functionalId(f, f.id), f);
    for (const k of functionalTexts(f, f.text)) fByText.set(k, f);
  }
  const seenF = new Set<FunctionalTestItem>();
  for (const r of results.functional ?? []) {
    const m =
      (r.id === undefined ? undefined : fById.get(functionalId(r, r.id))) ??
      fByText.get(`${r.unit}\u0000${r.instance}\u0000${r.item}`);
    if (m === undefined) {
      check.unknownFunctional.push(r);
      continue;
    }
    seenF.add(m);
    check.answered += 1;
    check.byStatus[r.status] += 1;
    if (r.status === "not_run" && (r.reason === undefined || r.reason.trim() === "")) check.silentFunctional.push(r);
  }
  check.unansweredFunctional = plan.functional.filter((f) => !seenF.has(f));
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
  const say = (f: { unit: string; instance: string }, what: string): string => `${f.unit} > ${what} [${f.instance}]`;
  if (check.unansweredFunctional.length > 0) {
    lines.push(
      `  functional, unanswered (${check.unansweredFunctional.length}): ${some(check.unansweredFunctional, (f) => say(f, f.id ?? (typeof f.text === "string" ? f.text : (f.text.ja ?? f.text.en ?? ""))))}`
    );
  }
  if (check.unknownFunctional.length > 0) {
    lines.push(`  functional, answers no item in this plan (${check.unknownFunctional.length}): ${some(check.unknownFunctional, (r) => say(r, r.id ?? r.item))}`);
  }
  if (check.silentFunctional.length > 0) {
    lines.push(`  functional, not run, with no reason (${check.silentFunctional.length}): ${some(check.silentFunctional, (r) => say(r, r.id ?? r.item))}`);
  }
  return lines.join("\n");
}

// …and whether that is a failure. Coverage and consistency only: a run with
// failing items has done its job.
export function resultsCheckFails(check: ResultsCheck): boolean {
  return (
    check.unanswered.length > 0 ||
    check.unknown.length > 0 ||
    check.silent.length > 0 ||
    check.leaked.length > 0 ||
    check.unansweredFunctional.length > 0 ||
    check.unknownFunctional.length > 0 ||
    check.silentFunctional.length > 0
  );
}
