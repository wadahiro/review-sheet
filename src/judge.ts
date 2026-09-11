// What a collected file says, against what the sheet says it should.
//
// REACHING a host stays outside this tool, and that is not what this is. By the
// time anything here runs, a project has already stood on the host, decided
// what may travel, and handed over bytes. Comparing those bytes with the sheet
// is the same comparison `verify` and `apply` already make — the parsers, the
// structural addresses, the meaning of a row's `kind` are all this tool's, and
// a project re-implementing them re-implements them differently.
//
// WHAT THIS ANSWERS is every item the file alone can answer:
//
//   value             the file must carry that value at that address
//   absent            no line of the file may carry it
//   container         the block must be there (every row under it is dead if
//                     it is not), and it has no value of its own
//   default-in-force  nothing in the file may set it, so the product's own
//                     default still applies
//
// WHAT IT DOES NOT is everything that needs a second channel to be sure: a
// product that reports its own effective configuration and where each value
// came from, a binary whose compiled-in default differs from its manual, a
// file beside the configuration that injects options on the command line. Those
// are per-product, a project declares them, and it overrides this file-only
// verdict by handing its own answer back (`--answers`). Overriding is normal;
// doing it silently is not, so the count comes back with the results.

import { extractFile } from "./extract.js";
import type { Format } from "./extract.js";
import type { TestItem, TestPlan } from "./testplan.js";
import type { TestResult, TestResults } from "./testresults.js";

// One environment, as somebody collected it. The shape is a contract rather
// than a convention: it is what makes "who collects" and "who judges"
// separable, and a closed network that has only Ansible produces exactly this
// and carries the one file out.
export type Observation = {
  environment: string;
  collected_at?: string;
  hosts: Record<string, ObservedHost>;
};

export type ObservedHost = {
  // Deployed path -> the bytes, or null for a file the host does not have —
  // which is an answer, not an absence of one.
  files: Record<string, string | null>;
  // A configuration that NAMES other files is answerable only together with
  // them: "we do not set this, so the default applies" is a claim about all of
  // them. Which file named which, and what each holds.
  included_by?: Record<string, string[]>;
  included?: Record<string, string | null>;
  // A format a path's own name cannot state (`space` is nobody's extension).
  formats?: Record<string, Format>;
};

// Where a row's value sits in one collected file, keyed by the structural
// address the sheet was built from — the same projection every other reader of
// an entry uses, so a row's own address resolves against it unchanged.
type Parsed = Map<string, { value: string; line?: number }>;

const parse = (text: string | null | undefined, path: string, format: Format | undefined): Parsed | null => {
  if (text === undefined || text === null) return null;
  const out: Parsed = new Map();
  for (const e of extractFile(text, path, format)) {
    out.set(e.source?.path ?? e.key, { value: String(e.value), line: e.source?.line });
  }
  return out;
};

// A block is "there" when the file holds it, or holds anything under it: a
// parser that emits only leaves still proves the block by its children.
const holds = (file: Parsed, key: string): boolean =>
  file.get(key) !== undefined || [...file.keys()].some((k) => k.startsWith(`${key}.`));

export type JudgeOutcome = {
  results: TestResult[];
  evidence: NonNullable<TestResults["evidence"]>;
  // Items this could say nothing about — no `file` on them at all. Returned
  // rather than answered `not_run`: a project's own channels answer these, and
  // an answer invented here would be one they then have to fight.
  unanswered: TestItem[];
  // Files the sheet says are deployed that a host does not have. One line per
  // (environment, host, file) — every row of that file says the same thing, so
  // the rows say it once each and this says it once.
  missing: string[];
};

export type JudgeWords = {
  notCollected: string;
  noFile: (host: string, path: string) => string;
  noValueHere: string;
  absentPass: string;
  absentFail: (path: string) => string;
  containerPass: string;
  containerFail: (path: string) => string;
  setHere: (path: string) => string;
  setElsewhere: (path: string, by: string) => string;
  fromFile: string;
};

export const JUDGE_WORDS: Record<"ja" | "en", JudgeWords> = {
  ja: {
    notCollected: "この環境はまだ収集していない",
    noFile: (host, path) => `${host} に ${path} がない`,
    noValueHere: "この環境について、シートは値を述べていない",
    absentPass: "削除されていることを確認（配布物にあり、この案件では設定しない）",
    absentFail: (path) => `${path} にまだ存在する（配布物から削除したはずの設定）`,
    containerPass: "この設定ブロックが配備ファイルにあることを確認（ブロック自体に値は無い）",
    containerFail: (path) => `${path} にこの設定ブロックが無い — 配下の設定はどれも効かない`,
    setHere: (path) => `${path} で設定している`,
    setElsewhere: (path, by) => `${path} が読み込む ${by} で設定している`,
    fromFile: "デプロイ済みファイル",
  },
  en: {
    notCollected: "this environment has not been collected",
    noFile: (host, path) => `${host} does not have ${path}`,
    noValueHere: "the sheet states no value for this environment",
    absentPass: "confirmed gone (shipped by the distribution, not set by this project)",
    absentFail: (path) => `still present in ${path} (a setting this project removes)`,
    containerPass: "the block is in the deployed file (a block holds no value of its own)",
    containerFail: (path) => `${path} does not hold this block — nothing under it applies`,
    setHere: (path) => `set in ${path}`,
    setElsewhere: (path, by) => `set in ${by}, which ${path} reads`,
    fromFile: "deployed file",
  },
};

export function judgeFiles(
  plan: TestPlan,
  observations: Observation[],
  opts: { lang?: "ja" | "en"; at?: string } = {}
): JudgeOutcome {
  const t = JUDGE_WORDS[opts.lang ?? "ja"];
  const at = opts.at ?? new Date().toISOString();
  const byEnv = new Map(observations.map((o) => [o.environment, o]));
  const out: JudgeOutcome = { results: [], evidence: [], unanswered: [], missing: [] };
  // Parsed once per (environment, host, path): a file holds hundreds of rows,
  // and parsing it per row is the same work several hundred times over.
  const cache = new Map<string, Parsed | null>();
  const parsedOf = (env: string, host: string, path: string, text: string | null | undefined, fmt: Format | undefined): Parsed | null => {
    const k = `${env}\u0000${host}\u0000${path}`;
    if (!cache.has(k)) cache.set(k, parse(text, path, fmt));
    return cache.get(k) ?? null;
  };

  for (const item of plan.items) {
    const path = item.file;
    if (path === undefined) {
      out.unanswered.push(item);
      continue;
    }
    const obs = byEnv.get(item.target.instance);
    const target = { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance };
    if (obs === undefined || Object.keys(obs.hosts).length === 0) {
      out.results.push({ target, at, status: "not_run", reason: t.notCollected });
      continue;
    }
    // EVERY host that holds the file, not the first: a fleet is only as
    // configured as its least configured node, and a verdict read off one node
    // says nothing about the others.
    for (const [host, held] of Object.entries(obs.hosts)) {
      const file = parsedOf(item.target.instance, host, path, held.files[path], held.formats?.[path]);
      const evidence = { host, file: path };
      if (file === null) {
        out.results.push({ target, at, evidence, status: "not_run", reason: t.noFile(host, path) });
        out.missing.push(`${item.target.instance}/${host} ${path}`);
        continue;
      }
      const key = item.target.key;
      if (item.kind === "absent") {
        const there = holds(file, key);
        out.results.push({ target, at, evidence, status: there ? "fail" : "pass", detail: there ? t.absentFail(path) : t.absentPass });
        continue;
      }
      if (item.container === true) {
        const there = holds(file, key);
        out.results.push({ target, at, evidence, status: there ? "pass" : "fail", detail: there ? t.containerPass : t.containerFail(path) });
        continue;
      }
      // The files this one NAMES are part of the claim: "nothing sets it" is
      // false if one of them does, and the verdict must point at the file that
      // answered rather than at the one it was asked about.
      const named = (held.included_by?.[path] ?? [])
        .map((p) => ({ path: p, entries: parsedOf(item.target.instance, host, p, held.included?.[p], held.formats?.[p]) }))
        .filter((x): x is { path: string; entries: Parsed } => x.entries !== null);
      const here = file.get(key);
      const elsewhere = named.find((x) => x.entries.get(key) !== undefined);

      if (item.kind === "default-in-force") {
        const setBy =
          here !== undefined ? { why: t.setHere(path), where: evidence, value: here.value, line: here.line } :
          elsewhere !== undefined
            ? {
                why: t.setElsewhere(path, elsewhere.path),
                where: { host, file: elsewhere.path },
                value: elsewhere.entries.get(key)!.value,
                line: elsewhere.entries.get(key)!.line,
              }
            : undefined;
        out.results.push(
          setBy === undefined
            ? { target, at, evidence, status: "pass", detail: t.fromFile }
            : {
                target, at,
                evidence: { ...setBy.where, ...(setBy.line === undefined ? {} : { line: setBy.line }) },
                status: "fail",
                detail: setBy.why,
                ...(item.quiet === true ? {} : { actual: setBy.value }),
              }
        );
        continue;
      }
      if (item.expected === undefined) {
        out.results.push({ target, at, evidence, status: "not_run", reason: t.noValueHere });
        continue;
      }
      const seen = here ?? elsewhere?.entries.get(key);
      const from = here !== undefined ? { host, file: path, ...(here.line === undefined ? {} : { line: here.line }) }
        : elsewhere !== undefined
          ? { host, file: elsewhere.path, ...(elsewhere.entries.get(key)!.line === undefined ? {} : { line: elsewhere.entries.get(key)!.line }) }
          : evidence;
      if (seen === undefined) {
        out.results.push({ target, at, evidence, status: "fail", detail: t.noFile(host, `${path} (${key})`) });
        continue;
      }
      const ok = seen.value === String(item.expected);
      out.results.push({
        target, at, evidence: from,
        status: ok ? "pass" : "fail",
        detail: t.fromFile,
        ...(ok || item.quiet === true ? {} : { actual: seen.value }),
      });
    }
  }
  return out;
}

// The raw material every verdict above was read from. One document per
// (environment, host, file): the moment they were taken differs between hosts,
// so a merged one can no longer say which host a verdict was read from.
export function evidenceFrom(
  observations: Observation[],
  plan: TestPlan
): NonNullable<TestResults["evidence"]> {
  const sheetOf = new Map<string, string>();
  for (const i of plan.items) if (i.file !== undefined && !sheetOf.has(i.file)) sheetOf.set(i.file, i.target.sheet);
  const out: NonNullable<TestResults["evidence"]> = [];
  const seen = new Set<string>();
  for (const obs of observations) {
    for (const [host, held] of Object.entries(obs.hosts)) {
      const at = obs.collected_at ?? new Date().toISOString();
      const add = (path: string, text: string | null | undefined, sheet: string): void => {
        if (typeof text !== "string" || text === "") return;
        const k = `${obs.environment}\u0000${host}\u0000${path}`;
        if (seen.has(k)) return;
        seen.add(k);
        out.push({ instance: obs.environment, host, at, sheet, path, text });
      };
      for (const [path, text] of Object.entries(held.files)) add(path, text, sheetOf.get(path) ?? "");
      for (const [owner, paths] of Object.entries(held.included_by ?? {})) {
        for (const p of paths) add(p, held.included?.[p], sheetOf.get(owner) ?? "");
      }
    }
  }
  return out;
}
