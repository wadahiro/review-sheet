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
  // The OTHER hosts that answered the same row, where several did. The verdict
  // is the worst of them and points at the host that produced it; these are the
  // rest, so a reader following it can reach every set of bytes the row was
  // read from rather than one.
  also?: TestEvidence[];
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
    // The host whose bytes these are — ABSENT for a document that belongs to
    // no host (see judge.ts's `Observation.documents`). A file is a fact about
    // the machine holding it and always has one; a `terraform plan` describes
    // a cloud account, and which workstation fetched it is not part of its
    // identity. Such a document is identified by what was ASKED.
    host?: string;
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

// ONE ROW, EVERY HOST — the same fold `judgeProbes` applies to a functional
// item, applied to the rows.
//
// `judgeFiles` walks every host that was collected and pushes a result per
// host, which is the honest record: two nodes hold the same file and each was
// read. Everything downstream answers per ROW, though, and each did something
// different with the duplicates — the document's index kept whichever came
// last, silently, and the coverage gate counted them all, so a plan of 3698
// items came back "4244 answered".
//
// The rule is the one already written down for functional items: a fleet is
// only as configured as its least configured node, and the host that produced
// the worst answer is named. A host that could not be asked is a THIRD answer
// and does not drag the verdict down — it is not a failure, and treating it as
// one would fail every row of every environment collected in passes.
//
// Every host's evidence is kept. The reason the duplicates existed is that a
// reader following a verdict wants the bytes it was read from, and there is one
// set of those per host.
const RANK: Record<TestStatus, number> = { fail: 3, not_run: 2, pass: 1 };

export function foldByTarget(results: readonly TestResult[]): TestResult[] {
  const groups = new Map<string, TestResult[]>();
  for (const r of results) {
    const k = pathKeyOf(r.target);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: TestResult[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }
    const answered = group.filter((r) => r.status !== "not_run");
    // Nobody could answer: the first reason stands for all of them, the same
    // way `judgeProbes` returns the first `why` when no host ran.
    const decided = answered.length === 0 ? group : answered;
    const worst = [...decided].sort((a, b) => RANK[b.status] - RANK[a.status])[0]!;
    const others = group.filter((r) => r !== worst);
    // …and when the hosts did not agree, the row says so by name: a verdict
    // that reads `fail` without saying which node produced it sends a reader to
    // every one of them.
    const disagree = new Set(group.map((r) => r.status)).size > 1;
    const named = (r: TestResult): string => `${r.evidence?.host ?? "?"}: ${r.status}${r.actual === undefined ? "" : ` (${r.actual})`}`;
    const also = others.map((r) => r.evidence).filter((e): e is TestEvidence => e !== undefined);
    out.push({
      ...worst,
      ...(disagree ? { reason: [worst.reason, group.map(named).join(", ")].filter(Boolean).join(" — ") } : {}),
      ...(worst.evidence === undefined
        ? {}
        : { evidence: { ...worst.evidence, ...(also.length === 0 ? {} : { also }) } }),
    });
  }
  return out;
}

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

  for (const r of foldByTarget(results.results)) {
    // One entry per ROW, never per host — see foldByTarget. Counting the
    // per-host results made `answered` exceed the plan's own item count.
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

// SEVERAL RUNS, ONE RECORD.
//
// A results file is what ONE run produced, and a run answers ONE environment:
// `runs` is keyed by instance, and every result, functional answer and carried
// document names the instance it belongs to. A record that covers several
// environments is therefore several files — collected at different moments, by
// whoever could reach each one — and reading only the newest of them wrote
// "not run" over every row of the others.
//
// MERGED BY ENVIRONMENT, and that is the unit. Two files holding the same
// instance are two runs of the same environment, one of them stale; the later
// one wins WHOLESALE — its results, its functional answers, its evidence, its
// unclaimed. Not row by row: splicing a fresh pass onto a stale run's evidence
// makes the record cite bytes that verdict was never read from, which is a
// record lying in a new way rather than an old one repaired.
//
// LATER BY `runs[instance].at`, never by argument order. The order of a shell
// line is a fact about the shell line; `at` is a fact about the run, and it is
// the one the reader of the record cares about. Where neither says when (an
// older file, two runs stamped the same), the first file wins and the collision
// is named — the same rule `mergeByEnvironment` applies to two collectors
// claiming one host, for the same reason: this cannot resolve it, so it says so.
export function mergeResults(files: TestResults[]): { merged: TestResults; conflicts: string[] } {
  const conflicts: string[] = [];
  if (files.length <= 1) return { merged: files[0] ?? { results: [] }, conflicts };
  // Every environment each file speaks for, and when it spoke. A file with no
  // `runs` entry for an instance it holds results for still speaks for it —
  // older files carry no runs at all — and, saying nothing about when, loses to
  // any run that does.
  const spokenFor = (f: TestResults): Map<string, string | undefined> => {
    const out = new Map<string, string | undefined>();
    for (const [instance, run] of Object.entries(f.runs ?? {})) out.set(instance, run.at);
    for (const r of f.results) if (!out.has(r.target.instance)) out.set(r.target.instance, undefined);
    for (const r of f.functional ?? []) if (!out.has(r.instance)) out.set(r.instance, undefined);
    return out;
  };
  // Did this file actually answer for this environment, or does it merely carry
  // the plan's placeholders for it?
  const answers = (f: TestResults, instance: string): boolean =>
    f.results.some((r) => r.target.instance === instance && r.status !== "not_run") ||
    (f.functional ?? []).some((r) => r.instance === instance) ||
    (f.evidence ?? []).some((e) => e.instance === instance);
  // Which file answers each environment. A later `at` displaces an earlier one;
  // anything else keeps what is held and is reported.
  const winner = new Map<string, { at: string | undefined; from: number }>();
  files.forEach((f, from) => {
    for (const [instance, at] of spokenFor(f)) {
      const held = winner.get(instance);
      if (held === undefined) {
        winner.set(instance, { at, from });
        continue;
      }
      // Whichever side loses, it is only worth reporting if it had something to
      // lose: a stamped run, or an answer of its own. A file that answers the
      // whole plan — which is what the completeness gate asks for — carries
      // `not_run` placeholders for the environments its own run never touched,
      // and dropping those loses nothing.
      const lost = (at !== undefined && held.at !== undefined && at > held.at) || (at !== undefined && held.at === undefined);
      const loser = lost ? files[held.from]! : f;
      const loserAt = lost ? held.at : at;
      if (lost) winner.set(instance, { at, from });
      if (loserAt === undefined && !answers(loser, instance)) continue;
      if (held.at === undefined && at === undefined) {
        conflicts.push(`${instance} (two runs, neither says when it ran — kept the first)`);
        continue;
      }
      const kept = lost ? at : (held.at ?? "the first");
      conflicts.push(`${instance} (kept ${kept}, dropped ${loserAt ?? "a run that says when it ran nowhere"})`);
    }
  });
  const mine = (instance: string, from: number): boolean => winner.get(instance)?.from === from;
  const merged: TestResults = { results: [] };
  const runs: Record<string, TestRun> = {};
  const evidence: NonNullable<TestResults["evidence"]> = [];
  const functional: NonNullable<TestResults["functional"]> = [];
  const unclaimed: NonNullable<TestResults["unclaimed"]> = [];
  files.forEach((f, from) => {
    for (const [instance, run] of Object.entries(f.runs ?? {})) if (mine(instance, from)) runs[instance] = run;
    for (const r of f.results) if (mine(r.target.instance, from)) merged.results.push(r);
    for (const e of f.evidence ?? []) if (mine(e.instance, from)) evidence.push(e);
    for (const r of f.functional ?? []) if (mine(r.instance, from)) functional.push(r);
    for (const u of f.unclaimed ?? []) if (mine(u.instance, from)) unclaimed.push(u);
  });
  if (Object.keys(runs).length > 0) merged.runs = runs;
  if (evidence.length > 0) merged.evidence = evidence;
  if (functional.length > 0) merged.functional = functional;
  if (unclaimed.length > 0) merged.unclaimed = unclaimed;
  return { merged, conflicts };
}
