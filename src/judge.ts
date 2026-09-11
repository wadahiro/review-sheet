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
import type { Collected } from "./channel.js";
import type { TestItem, TestPlan } from "./testplan.js";
import { listChannels, registerChannel, commandChannel, type Channel } from "./channel.js";
import type { TestResult, TestResults } from "./testresults.js";

// One environment, as somebody collected it. The shape is a contract rather
// than a convention: it is what makes "who collects" and "who judges"
// separable, and a closed network that has only Ansible produces exactly this
// and carries the one file out.
export type Observation = {
  environment: string;
  collected_at?: string;
  hosts: Record<string, ObservedHost>;
  // What an importer's placeholders resolved to in THIS environment. Only the
  // project read the files the importer read, so only it can say.
  substitutions?: Record<string, string>;
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
  // What the host was asked, and what it said. One entry per command — the
  // commands a CHANNEL asked for (`collect-plan` lists them), so the collector
  // does not carry a second copy of the same strings.
  commands?: Collected;
  // A DOCUMENT the project fetched: a realm as a product's API describes it, a
  // resource as a cloud API returns it. Not a file on this host and not a
  // command's output — bytes that answer a whole sheet or component, addressed
  // by each row's own structural address exactly as a file is.
  //
  // The same machinery reads both, because the difference between them is where
  // the bytes came from and nothing else. A project that judged these itself
  // re-implemented the address resolution the tool already owns.
  documents?: ObservedDocument[];
};

export type ObservedDocument = {
  // What to call it, so a sheet can say which document answers its rows
  // (`documents:` in the build spec). A product that returns one document per
  // realm names them by realm; one that returns a single document needs no
  // name at all.
  name?: string;
  // …or which rows it answers directly, for a sheet whose rows carry their own
  // address and need no template.
  sheet?: string;
  component?: string;
  // How to read it. A realm comes back as JSON; nothing says another product's
  // will.
  format: Format;
  text: string;
  // What was asked, for the record's evidence — `GET /admin/realms/poc`.
  how?: string;
  // …or it could not be read at all, which is an answer about the product and
  // not a gap in the run.
  absent?: string;
};

// Where a row's value sits in one collected file, keyed by the structural
// address the sheet was built from — the same projection every other reader of
// an entry uses, so a row's own address resolves against it unchanged.
type Parsed = Map<string, { value: string; line?: number }>;

// The same address, two spellings. A file quotes an identity when it has to —
// a URL as a client id — and a product that has no placeholder in it never
// does. Normalised on BOTH sides rather than one being taught the other's rule.
const unquoteIds = (path: string): string => path.replace(/\[([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"\]/g, "[$1=$2]");

const parse = (text: string | null | undefined, path: string, format: Format | undefined, idFields?: string[]): Parsed | null => {
  if (text === undefined || text === null) return null;
  const out: Parsed = new Map();
  for (const e of extractFile(text, path, format, idFields === undefined ? undefined : { idFields })) {
    out.set(unquoteIds(e.source?.path ?? e.key), { value: String(e.value), line: e.source?.line });
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
  noCommand: (host: string, command: string) => string;
  channelSilent: (host: string, how: string) => string;
  unreached: string;
  docUnreadable: string;
  noAddress: string;
  fromDocument: string;
  notInDocument: (how: string) => string;
  emptyAndAbsent: string;
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
    noCommand: (host, command) => `${host} に ${command} が無い（この設定を適用しない環境）`,
    channelSilent: (host, how) => `${host} の ${how} はこの設定について何も報告していない`,
    unreached: "配備ファイルを持たず、これを答えるチャネルも宣言されていない",
    docUnreadable: "取得した文書を読めない",
    noAddress: "この行は文書内の住所を持たない（シートがどこから来たか記録していない）",
    fromDocument: "取得した文書",
    notInDocument: (how) => `${how} が返す文書にこの設定が無い`,
    emptyAndAbsent: "シートが空を述べ、文書もこの設定を保持していない",
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
    noCommand: (host, command) => `${host} has no ${command} (an environment this setting does not apply to)`,
    channelSilent: (host, how) => `${how} on ${host} reports nothing about this setting`,
    unreached: "no deployed file, and no channel declared that answers it",
    docUnreadable: "the collected document could not be read",
    noAddress: "this row carries no address inside a document",
    fromDocument: "the collected document",
    notInDocument: (how) => `${how} returns a document without this setting`,
    emptyAndAbsent: "the sheet states emptiness and the document holds nothing here",
  },
};

export function judgeFiles(
  plan: TestPlan,
  observations: Observation[],
  opts: { lang?: "ja" | "en"; at?: string; documents?: DocumentTemplate[]; idFields?: string[] } = {}
): JudgeOutcome {
  const t = JUDGE_WORDS[opts.lang ?? "ja"];
  const at = opts.at ?? new Date().toISOString();
  const byEnv = new Map(observations.map((o) => [o.environment, o]));
  const out: JudgeOutcome = { results: [], evidence: [], unanswered: [], missing: [] };
  // Parsed once per (environment, host, path): a file holds hundreds of rows,
  // and parsing it per row is the same work several hundred times over.
  const cache = new Map<string, Parsed | null>();
  // One parse per document, not per row: a realm is a few thousand entries and
  // several hundred rows address into it.
  const docCache = new Map<ObservedDocument, Parsed | null>();
  const parsedDoc = (d: ObservedDocument): Parsed | null => {
    if (!docCache.has(d)) docCache.set(d, d.absent !== undefined ? null : parse(d.text, `document.${d.format}`, d.format, opts.idFields));
    return docCache.get(d) ?? null;
  };
  const parsedOf = (env: string, host: string, path: string, text: string | null | undefined, fmt: Format | undefined): Parsed | null => {
    const k = `${env}\u0000${host}\u0000${path}`;
    if (!cache.has(k)) cache.set(k, parse(text, path, fmt));
    return cache.get(k) ?? null;
  };

  const channels = listChannels();
  for (const item of plan.items) {
    // A CHANNEL first, where one claims the row: it is the stronger witness by
    // construction — a file says what was written, a channel says what the host
    // or the product is doing — and it is the only one that can answer a row no
    // file backs at all.
    const channel = channels.find((c) => c.covers(item));
    if (channel !== undefined) {
      const obs = byEnv.get(item.target.instance);
      // A channel covers it and the environment was never collected: that is
      // "nobody has been here yet", not "nothing can answer this". Falling
      // through said the second, which is a different fix for a reader.
      if (obs === undefined || Object.keys(obs.hosts).length === 0) {
        out.results.push({
          target: { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance },
          status: "not_run",
          reason: t.notCollected,
        });
        continue;
      }
      const answered = answerByChannel(item, channel, obs, at, t);
      if (answered.length > 0) {
        out.results.push(...answered);
        continue;
      }
    }
    // A DOCUMENT the project fetched, where one covers this row. Read with the
    // same machinery a file is, because the difference between them is where
    // the bytes came from and nothing else.
    const obs0 = byEnv.get(item.target.instance);
    const doc = obs0 === undefined ? undefined : documentFor(obs0, item, opts.documents ?? [], obs0.substitutions ?? {});
    if (doc !== undefined) {
      out.results.push(...answerByDocument(item, doc.doc, doc.host, doc.address, doc.expected, at, t, parsedDoc));
      continue;
    }
    const path = item.file;
    if (path === undefined) {
      out.unanswered.push(item);
      continue;
    }
    const obs = byEnv.get(item.target.instance);
    const target = { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance };
    if (obs === undefined || Object.keys(obs.hosts).length === 0) {
      // No `at`: nothing was run against this environment, and the record's
      // "run on" column would otherwise carry today's date for a row nobody
      // touched — a date is a claim, and this run has no standing to make it.
      out.results.push({ target, status: "not_run", reason: t.notCollected });
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

// Which document answers this row, if any: the one filed under the same sheet
// and, where the sheet has components, the same component. A document naming no
// component answers the whole sheet.
function documentFor(
  obs: Observation,
  item: TestItem,
  templates: DocumentTemplate[],
  subs: Record<string, string>
): { doc: ObservedDocument; host: string; address: string | undefined; expected: string | undefined } | undefined {
  // A TEMPLATE, where the sheet declares one: it says which document answers
  // the row and where the value sits in it, and both can depend on the row's
  // component. That is the whole of "which realm does this sheet describe, and
  // how is a client of it addressed" — a table, not a program.
  const tpl = templates.find((t) => t.sheet === item.target.sheet);
  const fill = (s: string): string => {
    let out = s
      .replace(/\{component\}/g, item.component ?? "")
      .replace(/\{key\}/g, item.target.key)
      .replace(/\{address\}/g, item.address ?? item.target.key);
    if (tpl?.substitute !== undefined) {
      out = out.replace(new RegExp(tpl.substitute, "g"), (whole, name: string) => subs[name] ?? whole);
    }
    return out;
  };
  for (const [host, held] of Object.entries(obs.hosts)) {
    for (const d of held.documents ?? []) {
      if (tpl !== undefined) {
        if (d.name !== fill(tpl.document)) continue;
        // The EXPECTED value carries the same placeholder the address does —
        // a row whose value is a URL built from the environment — and the
        // document holds what the importer resolved. Both sides, or the
        // comparison is between two spellings of one value.
        // The ROW'S OWN address wins where it has one: the template exists for
        // the rows that have none (a sheet materialized them from a
        // dictionary, so nothing wrote them anywhere). Stated beats derived,
        // the same order every other resolution here follows.
        const where = item.address === undefined ? fill(tpl.address) : fill(item.address);
        return { doc: d, host, address: where, expected: item.expected === undefined ? undefined : fill(item.expected) };
      }
      if (d.sheet !== item.target.sheet) continue;
      if (d.component !== undefined && d.component !== item.component) continue;
      return { doc: d, host, address: item.address ?? item.target.key, expected: item.expected };
    }
  }
  return undefined;
}

// Which document answers a sheet's rows, and where in it each row sits.
export type DocumentTemplate = {
  sheet: string;
  document: string;
  address: string;
  // A placeholder an importer resolves at apply time, which a row's address
  // therefore still carries: the SAML client is identified by a URL that
  // differs per environment, so the placeholder is the one identity the row can
  // hold across all of them. The regex captures the NAME; the observation
  // supplies what it resolved to, per environment, because only the project
  // read the files the importer read. Same shape as `static_files`'
  // `substitution.pattern`, which is the same problem one stage earlier.
  substitute?: string;
};

// A row, resolved against the document that holds it. The row's OWN structural
// address, never its key: two components of one sheet share a key space by
// design, and the address is what the sheet was built from.
function answerByDocument(
  item: TestItem,
  doc: ObservedDocument,
  host: string,
  address: string | undefined,
  expected: string | undefined,
  at: string,
  t: JudgeWords,
  parsedDoc: (d: ObservedDocument) => Parsed | null
): TestResult[] {
  const target = { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance };
  const evidence = { host, ...(doc.how === undefined ? {} : { command: doc.how }) };
  if (doc.absent !== undefined) {
    return [{ target, at, evidence, status: "not_run", reason: doc.absent }];
  }
  const parsed = parsedDoc(doc);
  if (parsed === null) return [{ target, at, evidence, status: "not_run", reason: t.docUnreadable }];
  // A row the sheet MATERIALIZED from a dictionary carries no source — nothing
  // wrote it anywhere — and its key IS the address the dictionary names it by
  // (`smtpServer.host`). So the key is the fallback, and it is a fallback
  // rather than the rule: an authored row's own source is the stronger fact.
  // (the address the caller resolved: a template's, or the row's own)
  if (address === undefined) return [{ target, at, evidence, status: "not_run", reason: t.noAddress }];
  const seen = address === undefined ? undefined : parsed.get(unquoteIds(address));

  if (item.kind === "default-in-force") {
    // The product OMITS what nobody set: a key absent from the map it returns
    // is the confirmation, not a gap. Where it always reports the field, the
    // value it reports is compared with the default instead.
    if (seen === undefined) return [{ target, at, evidence, status: "pass", detail: doc.how ?? t.fromDocument }];
    if (expected === undefined) return [{ target, at, evidence, status: "not_run", reason: t.noValueHere }];
    const same = seen.value === String(expected);
    return [{
      target, at, evidence: { ...evidence, ...(seen.line === undefined ? {} : { line: seen.line }) },
      status: same ? "pass" : "fail",
      detail: doc.how ?? t.fromDocument,
      ...(same || item.quiet === true ? {} : { actual: seen.value }),
    }];
  }
  if (item.kind === "absent" || item.container === true) {
    const there = seen !== undefined || [...parsed.keys()].some((k) => k.startsWith(`${unquoteIds(address ?? "")}.`));
    const want = item.container === true;
    return [{ target, at, evidence, status: there === want ? "pass" : "fail", detail: doc.how ?? t.fromDocument }];
  }
  if (expected === undefined) return [{ target, at, evidence, status: "not_run", reason: t.noValueHere }];
  if (seen === undefined) {
    // A row that expects EMPTINESS is satisfied by the key being absent: a
    // producer that omits what is unset spells "no value" by leaving it out,
    // and the two are the same fact told two ways. Anything else missing is a
    // finding.
    if (String(expected) === "") return [{ target, at, evidence, status: "pass", detail: t.emptyAndAbsent }];
    return [{ target, at, evidence, status: "fail", detail: t.notInDocument(doc.how ?? t.fromDocument) }];
  }
  const ok = seen.value === String(expected);
  return [{
    target, at, evidence: { ...evidence, ...(seen.line === undefined ? {} : { line: seen.line }) },
    status: ok ? "pass" : "fail",
    detail: doc.how ?? t.fromDocument,
    ...(ok || item.quiet === true ? {} : { actual: seen.value }),
  }];
}

// One item, asked of a channel on every host that was collected. Empty when
// nothing can be said — no observation, or no host that could answer — and the
// caller falls through to the file, or hands the item back.
function answerByChannel(
  item: TestItem,
  channel: Channel,
  obs: Observation | undefined,
  at: string,
  t: JudgeWords
): TestResult[] {
  if (obs === undefined || Object.keys(obs.hosts).length === 0) return [];
  const target = { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance };
  const command = channel.needs(item);
  const out: TestResult[] = [];
  for (const [host, held] of Object.entries(obs.hosts)) {
    const collected = held.commands ?? {};
    const evidence = { host, ...(command === undefined ? {} : { command }) };
    // A command this host does not have is an ANSWER about the host, not a gap
    // in the run: a container with no `getenforce` does not apply SELinux, and
    // saying "not run, because the host has no such command" is the honest form
    // — never a pass.
    if (command !== undefined && collected[command] === null) {
      out.push({ target, at, evidence, status: "not_run", reason: t.noCommand(host, command) });
      continue;
    }
    const got = channel.answer(item, collected);
    if (got === undefined) {
      out.push({ target, at, evidence, status: "not_run", reason: t.channelSilent(host, command ?? channel.name) });
      continue;
    }
    const where = { ...evidence, ...(got.line === undefined ? {} : { line: got.line }) };
    if (item.expected === undefined) {
      out.push({ target, at, evidence: where, status: "not_run", reason: t.noValueHere });
      continue;
    }
    const ok = got.value === String(item.expected);
    out.push({
      target, at, evidence: where,
      status: ok ? "pass" : "fail",
      detail: command ?? channel.name,
      ...(ok || item.quiet === true ? {} : { actual: got.value }),
    });
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

// WHAT TO COLLECT, derived from the plan.
//
// The point of a channel declaring `needs`: the commands exist once, here, and
// the collector loops over this list. Written twice — in the judge and in the
// playbook that reaches the hosts — nothing checked the two agreed, and a
// command corrected in one of them made its rows quietly "not collected".
export type CollectPlan = {
  // Every deployed file the sheets describe, per environment.
  files: Record<string, string[]>;
  // …and every command a channel asked for. Not per environment: a channel
  // covers a row, and a row's environments are the sheet's.
  commands: string[];
};

export function collectPlan(plan: TestPlan): CollectPlan {
  const files: Record<string, Set<string>> = {};
  const commands = new Set<string>();
  const channels = listChannels();
  for (const item of plan.items) {
    const channel = channels.find((c) => c.covers(item));
    const needs = channel?.needs(item);
    if (needs !== undefined) commands.add(needs);
    if (item.file === undefined) continue;
    (files[item.target.instance] ??= new Set()).add(item.file);
  }
  return {
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [...v].sort()])),
    commands: [...commands].sort(),
  };
}

// The channels a MODEL declares, registered so the judge and the collect plan
// both see them. Called by the commands that read a model, because the spec
// that declared them is not in their hands.
export function registerModelChannels(model: { channels?: import("./types.js").ChannelSpec[] }): number {
  for (const c of model.channels ?? []) {
    registerChannel(commandChannel(c, `${c.channel}:${c.sheet}:${c.command}`));
  }
  return (model.channels ?? []).length;
}

// EVERY plan item ends with an answer. What is left after the files, the
// channels and whatever a project handed back is what no route reaches at all,
// and saying so is not a formality: an item with no answer leaves no trace in a
// document that prints the answers it has, so a record looks complete because
// what is missing from it is missing.
//
// It belongs here rather than in each project's judge, where it used to sit:
// there it could not tell an item nobody reaches from one the TOOL had just
// answered, and it filed "not attempted" over verdicts that had been attempted.
export function answerTheRest(
  plan: TestPlan,
  results: TestResult[],
  observations: Observation[] = [],
  opts: { lang?: "ja" | "en" } = {}
): TestResult[] {
  const t = JUDGE_WORDS[opts.lang ?? "ja"];
  // WHY it was not reached, and the two are different fixes: an environment
  // nobody collected is waiting for a run, while one that WAS collected and
  // still has no answer is waiting for a channel that can ask.
  const collected = new Set(observations.filter((o) => Object.keys(o.hosts).length > 0).map((o) => o.environment));
  const key = (x: { sheet: string; path?: string[]; key: string; instance: string }): string =>
    [x.sheet, (x.path ?? []).join("\u0001"), x.key, x.instance].join("\u0000");
  const seen = new Set(results.map((r) => key(r.target)));
  const out: TestResult[] = [];
  for (const item of plan.items) {
    if (seen.has(key(item.target))) continue;
    seen.add(key(item.target));
    out.push({
      target: { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance },
      status: "not_run",
      reason: collected.has(item.target.instance) ? t.unreached : t.notCollected,
    });
  }
  return out;
}
