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
import { registerKeycloakChannels, registerKeycloakRules } from "./channels/keycloak.js";
import { registerAwsRdsRouter, registerAwsRdsChannel } from "./channels/aws-rds.js";
import { registerChronyRules } from "./channels/chrony.js";
import { registerLogrotateRules } from "./channels/logrotate.js";
import { registerSystemdRules } from "./channels/systemd.js";
import { buildMismatch, buildMismatchReported, rpmVersions, packagesToQuery } from "./channels/rpm.js";
import { wordsFor } from "./channel-words.js";
import "./channels/reads.js"; // the product recipes (reads/addresses/defaults/versions) register on load
import { compiledInFor, injectedOptions, lineOfCompiledIn, includeSyntaxFor } from "./channels/httpd.js";
import { effectiveConfig, isProductDefault, lineOfEffective, SECRET_FIELDS, REDACTED, MASKED, LOGIN_MARKS_LIST } from "./channels/keycloak.js";
import type { TestItem, TestPlan } from "./testplan.js";
import type { LangText, FunctionalRule } from "./types.js";
import { listChannels, listFunctionalChannels, listProbeRules, registerChannel, commandChannel, getDocumentRouter, listDocumentRouters, productVersionFor, type Channel } from "./channel.js";
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
  // What a PROBE found. A functional item has no row behind it — "the service
  // comes back up", "the certificate is not about to expire" — so what answers
  // it is not a value at an address but whatever a probe produced, per host.
  //
  // Keyed by the item's id, which is the join a project already declares. The
  // shape is the COLLECTOR's to fill and its meaning is the judge's, exactly as
  // `commands` is: what ran, whether it ran at all, and what came back.
  probes?: Record<string, ProbeResult>;
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
// A file, read: every value at its own address — and every BLOCK at its own.
//
// A container row is not a setting, it is the opening of a block: `<Directory
// "/var/www">`, a logrotate pattern. It has a line of its own (the opening), and
// an identity written in that opening — which the parsers all record
// (`ContainerNode.line` / `.subject`) and this used to throw away, keeping only
// the leaves. A judge could then say two things about such a row, both weaker
// than the file allows: that it EXISTS, and nothing about where.
type Parsed = Map<string, { value: string; line?: number; block?: BlockRecord }>;

// What a block's own opening says, for the row that IS the block.
type BlockRecord = {
  // The identity written in the opening, verbatim (`ContainerNode.subject`).
  subject?: string;
  // …assembled by a template from variables, so no file holds the result and a
  // comparison against the deployed text is between two spellings of one fact.
  assembled?: boolean;
};

// The same address, two spellings. A file quotes an identity when it has to —
// a URL as a client id — and a product that has no placeholder in it never
// does. Normalised on BOTH sides rather than one being taught the other's rule.
const unquoteIds = (path: string): string => path.replace(/\[([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"\]/g, "[$1=$2]");

const parse = (text: string | null | undefined, path: string, format: Format | undefined, idFields?: string[]): Parsed | null => {
  if (text === undefined || text === null) return null;
  const out: Parsed = new Map();
  for (const e of extractFile(text, path, format, idFields === undefined ? undefined : { idFields })) {
    // THE BLOCKS THIS VALUE IS INSIDE, each at its own address. Every child
    // repeats the whole chain, so the first one to arrive wins — they carry the
    // same opening — and a block is recorded even where no leaf of it is, since
    // its own row asks about the opening and not about what is under it.
    let at = "";
    for (const c of e.containers ?? []) {
      at = at === "" ? c.pathSeg : `${at}.${c.pathSeg}`;
      const address = unquoteIds(at);
      if (out.has(address)) continue;
      out.set(address, {
        value: c.subject ?? "",
        ...(c.line === undefined ? {} : { line: c.line }),
        block: { ...(c.subject === undefined ? {} : { subject: c.subject }), ...(c.subjectAssembled === true ? { assembled: true } : {}) },
      });
    }
    // …and the value itself, which wins over a block of the same address: a
    // leaf is what the row asking at that address is about.
    out.set(unquoteIds(e.source?.path ?? e.key), { value: String(e.value), line: e.source?.line });
  }
  return out;
};

// A block is "there" when the file holds it, or holds anything under it: a
// parser that emits only leaves still proves the block by its children.
const holds = (file: Parsed, key: string): boolean =>
  file.get(key) !== undefined || [...file.keys()].some((k) => k.startsWith(`${key}.`));

// ONE ENVIRONMENT, SEVERAL COLLECTORS. What reaches a fleet of hosts and what
// reaches a cloud API are different programs run at different moments, and both
// answer for the same environment — so a run is handed several observation
// files that share an `environment`.
//
// They are MERGED by host. Keying a map on the environment instead (which is
// what this did) kept whichever came last and dropped the other entirely, in
// silence: every row the lost collector answered came back "not run", which
// reads exactly like a channel that cannot ask rather than a file that was
// thrown away.
//
// A host claimed by two of them is NOT merged field-wise — two collectors
// disagreeing about one host's files is not something this can resolve — so the
// first is kept and the conflict is reported by name.
export function mergeByEnvironment(observations: Observation[]): { merged: Observation[]; conflicts: string[] } {
  const byEnv = new Map<string, Observation>();
  const conflicts: string[] = [];
  for (const obs of observations) {
    const held = byEnv.get(obs.environment);
    if (held === undefined) {
      byEnv.set(obs.environment, { ...obs, hosts: { ...obs.hosts } });
      continue;
    }
    for (const [host, one] of Object.entries(obs.hosts)) {
      if (held.hosts[host] !== undefined) {
        conflicts.push(`${obs.environment}/${host}`);
        continue;
      }
      held.hosts[host] = one;
    }
    // What the importer's placeholders resolved to is a fact about the
    // ENVIRONMENT, not about one collector's hosts, so both files may carry it.
    if (obs.substitutions !== undefined) held.substitutions = { ...obs.substitutions, ...(held.substitutions ?? {}) };
  }
  return { merged: [...byEnv.values()], conflicts };
}

// ONE PROBE ON ONE HOST, as a collector recorded it.
export type ProbeResult = {
  // What was asked, for the record's evidence — `ss -lntp`, `GET /health/ready`.
  how?: string;
  // Whether it ran at all. A probe that did not is a THIRD answer, never a
  // failure: a host with no `chronyc` did not fail the time check, it could not
  // be asked. `why` says which, in the collector's own words.
  ran?: boolean;
  why?: string;
  // A verdict the collector itself could reach (an HTTP status is not a rule,
  // it is the answer). Where the judging needs a rule, the caller supplies one
  // and this is ignored.
  ok?: boolean | null;
  // What came back, carried into the record as the material the verdict was
  // read from.
  text?: string;
};

// What a rule makes of one host's probe. `null` is "this host cannot be asked",
// which is not a failure — see ProbeResult.ran.
export type HostVerdict = {
  ok: boolean | null;
  why?: string;
  // Which line of the probe's output it was read at, so a verdict points at the
  // words rather than at the whole of an output.
  line?: number;
};

// ONE FUNCTIONAL ITEM, ACROSS EVERY HOST — the loop, and nothing about any
// product or any project.
//
// Whoever judges a functional item has to: ask every host rather than the
// first, tell "did not run" from "ran and failed" from "cannot be asked here",
// take the WORST answer (a fleet is only as configured as its least configured
// node) and name the host that produced it, and carry the bytes it was read
// from. None of that is about what is being checked, and every project doing
// infrastructure tests writes it — so it is here, and only the RULE is
// supplied by the caller.
//
// The tool's own `check:` items go through this too, with a rule that compares
// the read value against the declared one. One implementation, so the two can
// never drift.
// What a rule is told about the run it is judging.
export type ProbeContext = {
  host: string;
  held: ObservedHost;
  // How many hosts THIS observation carries. See ProbeRule in channel.ts for
  // why that is not the design's node count.
  observedHosts: number;
  // The same number under the name it used to have, which read like the
  // second thing. Kept so no rule breaks in silence — a renamed field is
  // `undefined`, and a rule comparing against `undefined` does not fail, it
  // answers wrongly.
  hosts?: number;
  lang?: "ja" | "en";
};

// Said once per process, not once per host: a fleet would otherwise print it
// once per node per item.
const warnedAbout = new Set<string>();

function probeContext(
  host: string,
  held: ObservedHost,
  observedHosts: number,
  lang: "ja" | "en" | undefined,
  rule: string | undefined
): ProbeContext {
  const ctx = {
    host,
    held,
    observedHosts,
    ...(lang === undefined ? {} : { lang }),
  } as ProbeContext;
  // A GETTER, so the warning fires when a rule actually reads the old name and
  // not for every rule that never touches it.
  Object.defineProperty(ctx, "hosts", {
    enumerable: true,
    get() {
      const who = rule ?? "a probe rule";
      if (!warnedAbout.has(who)) {
        warnedAbout.add(who);
        console.warn(
          `Warning: ${who} reads ctx.hosts, which is now ctx.observedHosts. Same value — the number of hosts ` +
            `THIS observation carries — under a name that says so. It is not the node count the design expects; ` +
            `where a rule needs that, it is the project's own number. ctx.hosts will be removed.`
        );
      }
      return observedHosts;
    },
  });
  return ctx;
}

export function judgeProbes(
  item: { unit: string; id?: string; text: LangText | string; instance: string; intrusive?: boolean },
  hosts: Record<string, ObservedHost>,
  verdict: (probe: ProbeResult, ctx: ProbeContext) => HostVerdict,
  opts: {
    lang?: "ja" | "en";
    sheet?: string;
    at?: string;
    // The rule's own name, so the deprecation warning on `ctx.hosts` can say
    // WHICH plugin to change. A caller that has no name (the tool's own
    // `check:` path builds its rule inline) passes none.
    rule?: string;
    // Where the probe for this item lives on a host. The default is the
    // declared `probes` map; the `check:` path reads a command's output instead.
    read?: (held: ObservedHost, id: string, host: string) => ProbeResult | undefined;
  } = {}
): {
  answer: NonNullable<TestResults["functional"]>[number];
  documents: NonNullable<TestResults["evidence"]>;
} {
  const t = JUDGE_WORDS[opts.lang ?? "ja"];
  const at = opts.at ?? new Date().toISOString();
  const id = item.id ?? "";
  const base = {
    unit: item.unit,
    ...(item.id === undefined ? {} : { id: item.id }),
    item: typeof item.text === "string" ? item.text : (item.text.ja ?? item.text.en ?? ""),
    instance: item.instance,
  };
  const read = opts.read ?? ((held: ObservedHost) => held.probes?.[id]);
  const documents: NonNullable<TestResults["evidence"]> = [];
  const entries = Object.entries(hosts);
  const seen: { host: string; ran: boolean; ok?: boolean; why?: string; how?: string; line?: number }[] = [];
  for (const [host, held] of entries) {
    const probe = read(held, id, host);
    if (probe === undefined) {
      seen.push({ host, ran: false, why: t.notProbed });
      continue;
    }
    if (probe.ran !== true) {
      // An INTRUSIVE item nobody ran did not fall through a gap — answering it
      // disturbs the running system, and the runner is the one that decides.
      // The collector's own words win where it gave any.
      // An EMPTY `why` is not a reason. A collector that always writes the
      // field (which is what a templating language makes easy) would otherwise
      // put a blank where the record has to say which of the two happened.
      seen.push({ host, ran: false, why: probe.why || (item.intrusive === true ? t.consentNeeded : t.notProbed) });
      continue;
    }
    // The document's language reaches the rule here. Nowhere else does: a rule
    // is registered once, at load, and cannot be told then which document it
    // will end up in.
    const got = verdict(probe, probeContext(host, held, entries.length, opts.lang, opts.rule));
    if (got.ok === null) {
      seen.push({ host, ran: false, why: got.why || t.notProbed });
      continue;
    }
    seen.push({ host, ran: true, ok: got.ok, why: got.why, how: probe.how, line: got.line });
    if (typeof probe.text === "string" && probe.text !== "") {
      documents.push({
        instance: item.instance,
        host,
        at,
        sheet: opts.sheet ?? "",
        ...(probe.how === undefined ? {} : { command: probe.how }),
        text: probe.text,
      });
    }
  }
  const ran = seen.filter((x) => x.ran);
  if (ran.length === 0) {
    return { answer: { ...base, status: "not_run", reason: seen[0]?.why ?? t.notCollected }, documents };
  }
  const failed = ran.filter((x) => x.ok !== true);
  const point = failed[0] ?? ran[0]!;
  return {
    answer: {
      ...base,
      status: failed.length === 0 ? "pass" : "fail",
      detail: t.acrossHosts(point.how ?? id, ran.length),
      ...(failed.length === 0 ? {} : { reason: `${failed.map((x) => x.host).join(", ")}: ${failed[0]!.why ?? ""}` }),
      evidence: {
        host: point.host,
        ...(point.how === undefined ? {} : { command: point.how }),
        ...(point.line === undefined ? {} : { line: point.line }),
      },
    },
    documents,
  };
}

// WHEN each environment was last looked at, and by which hosts — derived from
// the observations that were judged rather than restated by whoever ran them.
//
// A record whose "run on" column is written by the caller is a record that can
// disagree with the answers beside it, and it did: a project computing this
// from its own host map left out an environment that only a cloud collector
// had reached, so a record carrying 444 answers for it said it had been tested
// by nobody. What a project still knows and this does not — which program
// collected, against which model — it supplies, and that is merged on top.
export function runsFrom(observations: Observation[]): Record<string, { at?: string; hosts?: string[] }> {
  const out: Record<string, { at?: string; hosts?: string[] }> = {};
  for (const obs of mergeByEnvironment(observations).merged) {
    const hosts = Object.keys(obs.hosts);
    if (hosts.length === 0) continue;
    out[obs.environment] = { ...(obs.collected_at === undefined ? {} : { at: obs.collected_at }), hosts };
  }
  return out;
}

// The project's own statement about a row nothing here checks — see
// `answerTheRest`'s options. Built once per run because `carried` counts
// across the whole plan.
function notCheckedFor(
  plan: TestPlan,
  rules: { sheet?: string; keys?: string[]; carried?: boolean; reason: string }[],
  substitute: string | undefined,
  t: JudgeWords
): (item: TestItem) => string | undefined {
  const carriedBy = (item: TestItem): number => {
    if (substitute === undefined || item.file !== undefined || item.address !== undefined) return 0;
    // The declared pattern with its capture group replaced by this row's key:
    // `\$\(env:([A-Za-z_]\w*)\)` becomes `\$\(env:SSO_HOST\)`. The group is the
    // first UNESCAPED `(...)` — the pattern's own `\(` is a literal paren the
    // importer writes, not the name it captures.
    const wrapped = substitute.replace(/(?<!\\)\((?!\?)[^)]*\)/, item.target.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const re = new RegExp(wrapped);
    return plan.items.filter(
      (x) =>
        x.target.instance === item.target.instance &&
        x.target.sheet === item.target.sheet &&
        typeof x.expected === "string" &&
        re.test(x.expected)
    ).length;
  };
  return (item) => {
    for (const rule of rules) {
      if (rule.sheet !== undefined && rule.sheet !== item.target.sheet) continue;
      if (rule.keys !== undefined && !rule.keys.includes(item.target.key)) continue;
      if (rule.carried === true) {
        const n = carriedBy(item);
        if (n === 0) continue;
        return `${rule.reason}${t.carriedBy(n)}`;
      }
      return rule.reason;
    }
    return undefined;
  };
}

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
  // One host claimed by two observations of the same environment. See
  // `mergeByEnvironment`.
  conflicts: string[];
};

export type JudgeWords = {
  notCollected: string;
  notProbed: string;
  carriedBy: (n: number) => string;
  consentNeeded: string;
  noFile: (host: string, path: string) => string;
  noValueHere: string;
  absentPass: string;
  absentFail: (path: string) => string;
  containerPass: string;
  containerFail: (path: string) => string;
  containerIs: (subject: string) => string;
  containerIsNot: (subject: string) => string;
  setHere: (path: string) => string;
  setElsewhere: (path: string, by: string) => string;
  fromFile: string;
  noCommand: (host: string, command: string) => string;
  channelSilent: (host: string, how: string) => string;
  unreached: string;
  otherBuild: (what: string) => string;
  injected: (path: string, what: string) => string;
  builtDiffers: (value: string, how: string) => string;
  setBySource: (source: string, how: string) => string;
  docUnreadable: string;
  noAddress: string;
  fromDocument: string;
  notInDocument: (how: string) => string;
  emptyAndAbsent: string;
  acrossHosts: (how: string, hosts: number) => string;
  expected: (got: string, want: string) => string;
};

export const JUDGE_WORDS: Record<"ja" | "en", JudgeWords> = {
  ja: {
    notCollected: "この環境はまだ収集していない",
    notProbed: "この実行では確認していない",
    carriedBy: (n) => `。この値そのものは、これを含む ${n} 項目の判定に、環境ごとに解決した形で含まれている`,
    consentNeeded: "実行者が明示的に許可したときだけ実施する",
    noFile: (host, path) => `${host} に ${path} がない`,
    noValueHere: "この環境について、シートは値を述べていない",
    absentPass: "削除されていることを確認（配布物にあり、この案件では設定しない）",
    absentFail: (path) => `${path} にまだ存在する（配布物から削除したはずの設定）`,
    containerPass: "この設定ブロックが配備ファイルにあることを確認（ブロック自体に値は無い）",
    containerIs: (subject) => `この設定ブロックが配備ファイルにあり、開きが ${subject} であることを確認`,
    containerIsNot: (subject) => `この設定ブロックはあるが、開きは ${subject}`,
    containerFail: (path) => `${path} にこの設定ブロックが無い — 配下の設定はどれも効かない`,
    setHere: (path) => `${path} で設定している`,
    setElsewhere: (path, by) => `${path} が読み込む ${by} で設定している`,
    fromFile: "デプロイ済みファイル",
    noCommand: (host, command) => `${host} に ${command} が無い（この設定を適用しない環境）`,
    channelSilent: (host, how) => `${host} の ${how} はこの設定について何も報告していない`,
    unreached: "配備ファイルを持たず、これを答えるチャネルも宣言されていない",
    otherBuild: (what) => `このホストはシートが記述するビルドではない（${what}）ので、既定値のままとは言えない`,
    injected: (path, what) => `${path} がコマンドラインで設定を渡している（${what}）ため、ファイルだけでは既定値のままとは言えない`,
    builtDiffers: (value, how) => `このビルドの既定値は ${value}（${how}）で、シートが示す製品既定値と異なる`,
    setBySource: (source, how) => `${source} が設定している（${how} が報告）ので、製品の既定値のままではない`,
    docUnreadable: "取得した文書を読めない",
    noAddress: "この行は文書内の住所を持たない（シートがどこから来たか記録していない）",
    fromDocument: "取得した文書",
    notInDocument: (how) => `${how} が返す文書にこの設定が無い`,
    emptyAndAbsent: "シートが空を述べ、文書もこの設定を保持していない",
    acrossHosts: (how, hosts) => `${how}（${hosts} ホスト）`,
    expected: (got, want) => `${got} — ${want} を期待`,
  },
  en: {
    notCollected: "this environment has not been collected",
    notProbed: "this run did not check it",
    carriedBy: (n) => `. Its value is judged inside the ${n} item(s) built from it, as each environment resolved it`,
    consentNeeded: "run only when the operator explicitly allows it",
    noFile: (host, path) => `${host} does not have ${path}`,
    noValueHere: "the sheet states no value for this environment",
    absentPass: "confirmed gone (shipped by the distribution, not set by this project)",
    absentFail: (path) => `still present in ${path} (a setting this project removes)`,
    containerPass: "the block is in the deployed file (a block holds no value of its own)",
    containerIs: (subject) => `the block is in the deployed file, opening with ${subject}`,
    containerIsNot: (subject) => `the block is there, but it opens with ${subject}`,
    containerFail: (path) => `${path} does not hold this block — nothing under it applies`,
    setHere: (path) => `set in ${path}`,
    setElsewhere: (path, by) => `set in ${by}, which ${path} reads`,
    fromFile: "deployed file",
    noCommand: (host, command) => `${host} has no ${command} (an environment this setting does not apply to)`,
    channelSilent: (host, how) => `${how} on ${host} reports nothing about this setting`,
    unreached: "no deployed file, and no channel declared that answers it",
    otherBuild: (what) => `this host is not the build the sheet describes (${what}), so nothing here can say the default still applies`,
    injected: (path, what) => `${path} passes configuration on the command line (${what}), so the file alone cannot say the default is in force`,
    builtDiffers: (value, how) => `this build's own default is ${value} (${how}), which is not the product default the sheet states`,
    setBySource: (source, how) => `${source} sets it (${how} reports), so the product's default is not what applies`,
    docUnreadable: "the collected document could not be read",
    noAddress: "this row carries no address inside a document",
    fromDocument: "the collected document",
    notInDocument: (how) => `${how} returns a document without this setting`,
    emptyAndAbsent: "the sheet states emptiness and the document holds nothing here",
    acrossHosts: (how, hosts) => `${how} (${hosts} host(s))`,
    expected: (got, want) => `${got} — expected ${want}`,
  },
};

export function judgeFiles(
  plan: TestPlan,
  observations: Observation[],
  opts: {
    lang?: "ja" | "en";
    at?: string;
    documents?: DocumentTemplate[];
    idFields?: string[];
    // Which build each sheet describes, and the command whose output says which
    // one this host has.
    builds?: { sheet: string; product: string; version: string }[];
    rpmCommand?: string;
    defaultsCheckedBy?: { product: "httpd" | "keycloak"; file: string; command?: string; aside?: string }[];
    notChecked?: { sheet?: string; keys?: string[]; carried?: boolean; reason: string }[];
    substitute?: string;
  } = {}
): JudgeOutcome {
  // A `documents:` entry naming a router NOTHING registered used to be
  // indistinguishable from a router deliberately handing a row back: both left
  // `documentFor` with nothing, and every row of that sheet came out
  // unanswered. A record then says the sheet could not be answered, which is
  // the same sentence it would say if the sheet genuinely had no document —
  // and the actual cause, a misspelled name or a plugin file that never
  // loaded, appears nowhere. Named, with what IS registered beside it, because
  // the usual cause of one is the spelling of the other.
  const missingRouters = (opts.documents ?? []).filter(
    (d) => d.router !== undefined && getDocumentRouter(d.router) === undefined
  );
  if (missingRouters.length > 0) {
    const have = listDocumentRouters().map((r) => r.name);
    throw new Error(
      `documents: names ${missingRouters.length} router(s) nothing registered: ` +
        missingRouters.map((d) => `"${d.router}" (sheet "${d.sheet}")`).join(", ") +
        `. Registered: ${have.length === 0 ? "none" : have.map((n) => `"${n}"`).join(", ")}. ` +
        `A product router is registered by the plugin that owns it; a project's own is registered by a module ` +
        `under the probe-rule directory (--rules-dir, default ./.review-sheet/rules) calling ` +
        `registerDocumentRouter. Left unregistered, every row of that sheet would come back unanswered with ` +
        `nothing saying why.`
    );
  }
  const t = JUDGE_WORDS[opts.lang ?? "ja"];
  const at = opts.at ?? new Date().toISOString();
  const { merged, conflicts } = mergeByEnvironment(observations);
  const byEnv = new Map(merged.map((o) => [o.environment, o]));
  const out: JudgeOutcome = { results: [], evidence: [], unanswered: [], missing: [], conflicts };
  // Parsed once per (environment, host, path): a file holds hundreds of rows,
  // and parsing it per row is the same work several hundred times over.
  const cache = new Map<string, Parsed | null>();
  // One parse per document, not per row: a realm is a few thousand entries and
  // several hundred rows address into it.
  const docCache = new Map<ObservedDocument, Map<string, Parsed | null>>();
  // Per document AND per identity field set: a router states the field the API
  // identifies a list by (`ParameterName`), which is the product's knowledge and
  // not every document's, so a second reading of the same bytes is a different
  // parse and must not answer from the first one's cache.
  const parsedDoc = (d: ObservedDocument, extraIds: string[] = []): Parsed | null => {
    const k = extraIds.join("\u0000");
    let per = docCache.get(d);
    if (per === undefined) {
      per = new Map<string, Parsed | null>();
      docCache.set(d, per);
    }
    if (!per.has(k)) {
      const ids = extraIds.length === 0 ? opts.idFields : [...(opts.idFields ?? []), ...extraIds];
      per.set(k, d.absent !== undefined ? null : parse(d.text, `document.${d.format}`, d.format, ids));
    }
    return per.get(k) ?? null;
  };
  const parsedOf = (env: string, host: string, path: string, text: string | null | undefined, fmt: Format | undefined): Parsed | null => {
    const k = `${env}\u0000${host}\u0000${path}`;
    if (!cache.has(k)) cache.set(k, parse(text, path, fmt));
    return cache.get(k) ?? null;
  };

  const channels = listChannels();
  // WHAT THIS PROCESS DOES NOT CHECK, asked FIRST. It is a statement about the
  // process, so it outranks every channel — including one that would otherwise
  // answer the row and be wrong about it: a row this project builds other
  // values from is not a field the product has, and a document asked for it
  // says "not there", which is true and misleading.
  const notChecked = notCheckedFor(plan, opts.notChecked ?? [], opts.substitute, t);
  for (const item of plan.items) {
    const stated = notChecked(item);
    if (stated !== undefined) {
      out.results.push({
        target: { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance },
        status: "not_run",
        reason: stated,
      });
      continue;
    }
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
    const doc = obs0 === undefined ? undefined : documentFor(obs0, item, opts.documents ?? [], obs0.substitutions ?? {}, plan.items);
    if (doc !== undefined) {
      // A row saying "the product's own default applies" is a claim about ONE
      // build here exactly as it is on the file path below, and the document
      // branch returned before ever asking. That is the half that mattered
      // most: a realm's and a client's untouched fields are precisely the rows
      // an upgrade moves, and they are answered from a document, never a file.
      const heldDoc = obs0?.hosts?.[doc.host];
      const wrongBuildDoc =
        item.kind === "default-in-force" && heldDoc !== undefined
          ? buildOf(heldDoc, item.target.sheet, opts.builds ?? [], opts.rpmCommand, opts.defaultsCheckedBy ?? [], opts.lang)
          : undefined;
      if (wrongBuildDoc !== undefined) {
        out.results.push({
          target: { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance },
          at,
          evidence: { host: doc.host },
          status: "not_run",
          reason: t.otherBuild(wrongBuildDoc),
        });
        continue;
      }
      out.results.push(...answerByDocument(item, doc.doc, doc.host, doc.address, doc.expected, at, t, parsedDoc, doc.idFields));
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
    //
    // …but only the hosts a FILE COLLECTOR reached. One environment is answered
    // by several collectors (see `mergeByEnvironment`), and the one that reaches
    // a cloud API records a "host" that is an account and a region: it reads no
    // files and never will, so asking it for one produces "this host does not
    // have it" for every row of every file — a fleet-wide finding invented by
    // the shape of the run. A host that collected files and found none of them
    // there records each path as `null` and is judged exactly as before; only a
    // collector that read no files at all is skipped.
    //
    // Where NO host of the environment read any, the answer is the same one an
    // environment nobody collected gets: nothing has been here to look at a
    // file yet. Reporting it per host instead said that an ACCOUNT does not
    // have /etc/systemd/system/keycloak.service — a fleet-wide finding, and a
    // line in `missing`, invented by which collector happened to run.
    const readFiles = Object.entries(obs.hosts).filter(([, h]) => Object.keys(h.files).length > 0);
    if (readFiles.length === 0) {
      out.results.push({ target, status: "not_run", reason: t.notCollected });
      continue;
    }
    for (const [host, held] of readFiles) {
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
        const block = file.get(key);
        if (!holds(file, key)) {
          out.results.push({ target, at, evidence, status: "fail", detail: t.containerFail(path) });
          continue;
        }
        // Where the opening is, so the verdict points at the block rather than
        // at the file. A parser that does not record it leaves this out rather
        // than borrowing a child's line: a row pointed at a line that is not
        // its own is a false claim about the file, and the first attempt at
        // this (the earliest child's line) pointed at an unrelated setting.
        const where = { ...evidence, ...(block?.line === undefined ? {} : { line: block.line }) };
        // A block's IDENTITY is what its opening says. Where the row states
        // one, it is a value and is compared; where it states none — a
        // `<LocationMatch>` the sheet lists by address alone — the old sentence
        // is the true one and is kept for exactly that case.
        const want = item.expected;
        if (want === undefined || want === "") {
          out.results.push({ target, at, evidence: where, status: "pass", detail: t.containerPass });
          continue;
        }
        const said = block?.block?.subject;
        // Assembled by a template from variables: no file holds the result, so
        // the deployed text and the row's value are two spellings of one fact
        // and only the ADDRESS can be compared — which `holds` just did.
        if (said === undefined || block?.block?.assembled === true) {
          out.results.push({ target, at, evidence: where, status: "pass", detail: t.containerPass });
          continue;
        }
        // Compared as the file wrote it, on both sides. A parser records the
        // opening VERBATIM — httpd keeps `"/var/www"` with its quotes, which is
        // what the sheet's own row carries too — and a judge that tidied either
        // side would be comparing a spelling neither file nor sheet holds.
        // (Measured across the parsers: subject and row value agree
        // character for character wherever both exist.)
        const same = String(want) === said;
        out.results.push({
          target, at, evidence: where,
          status: same ? "pass" : "fail",
          detail: same ? t.containerIs(said) : t.containerIsNot(said),
          ...(same || item.quiet === true ? {} : { actual: said }),
        });
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
        // …but only if this host IS the build the sheet describes. A default is
        // a fact about one build, and reading another one's file answers the
        // row with a product the sheet never described — indistinguishable from
        // a correct answer.
        // …and whether anything OTHER than this file decides the value. A
        // binary whose compiled-in default differs from the manual the
        // dictionary was written from is a finding; a file beside the
        // configuration injecting options means the file alone cannot say.
        const also = (opts.defaultsCheckedBy ?? []).find((d) => d.file === path);
        if (also?.product === "httpd") {
          const injected = also.aside === undefined ? undefined : injectedOptions(held.files[also.aside]);
          if (injected !== undefined) {
            out.results.push({ target, at, evidence: { host, file: also.aside! }, status: "not_run", reason: t.injected(also.aside!, injected) });
            continue;
          }
          const built = also.command === undefined ? undefined : compiledInFor(held.commands?.[also.command], key);
          if (built !== undefined && item.expected !== undefined && built !== String(item.expected)) {
            out.results.push({
              target, at,
              evidence: { host, command: also.command!, ...(lineOfCompiledIn(held.commands?.[also.command!], key) === undefined ? {} : { line: lineOfCompiledIn(held.commands?.[also.command!], key)! }) },
              status: "fail",
              detail: t.builtDiffers(built, also.command!),
              ...(item.quiet === true ? {} : { actual: built }),
            });
            continue;
          }
        }
        const wrongBuild = buildOf(held, item.target.sheet, opts.builds ?? [], opts.rpmCommand, opts.defaultsCheckedBy ?? [], opts.lang);
        if (wrongBuild !== undefined) {
          out.results.push({
            target, at,
            evidence: opts.rpmCommand === undefined ? evidence : { host, command: opts.rpmCommand },
            status: "not_run",
            reason: t.otherBuild(wrongBuild),
          });
          continue;
        }
        // …and, LAST, what the product says about itself — only where our own
        // files have already come up empty. That is the whole case this channel
        // exists for: a launcher, a build option or an environment variable
        // sets values no file we read holds, and the product names the source
        // of every value it is using. A file that DOES set it is answered by
        // the line below, which points at the words rather than at a report.
        if (also?.product === "keycloak" && also.command !== undefined && here === undefined && elsewhere === undefined) {
          const reported = held.commands?.[also.command];
          const seen = effectiveConfig(reported).get(key);
          if (seen !== undefined && !isProductDefault(seen.source)) {
            const line = lineOfEffective(reported, key);
            out.results.push({
              target, at,
              evidence: { host, command: also.command, ...(line === undefined ? {} : { line }) },
              status: "fail",
              detail: t.setBySource(seen.source, also.command),
              ...(item.quiet === true ? {} : { actual: seen.value }),
            });
            continue;
          }
        }
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

// Whether this host is running something OTHER than the build the sheet
// describes, said in one line. Undefined when it is the right build, when the
// sheet pins nothing, or when nobody asked — silence is not a claim.
function buildOf(
  held: ObservedHost,
  sheet: string,
  builds: { sheet: string; product: string; version: string }[],
  command: string | undefined,
  // The `defaults_checked_by` entries, so a product that reports its own
  // configuration can also be held to its pin — `rpm -q` answers for a package
  // and says nothing about a tarball, an image or a cloud API, which on one
  // real project was eight of fourteen pinned products (see ProductVersion).
  defaultsCheckedBy: { product: string; command?: string }[] = [],
  lang?: "ja" | "en"
): string | undefined {
  if (builds.length === 0) return undefined;
  const w = wordsFor(lang);
  const bad: string[] = [];
  if (command !== undefined) {
    const out = held.commands?.[command];
    if (typeof out === "string") bad.push(...buildMismatch(builds, sheet, rpmVersions(out), {}, w));
  }
  // What each product's own configuration command reported, keyed by the
  // product whose entry asked for it.
  const asked = new Map<string, string>();
  for (const d of defaultsCheckedBy) {
    const out = d.command === undefined ? undefined : held.commands?.[d.command];
    if (typeof out === "string") asked.set(d.product, out);
  }
  bad.push(...buildMismatchReported(builds, sheet, asked, productVersionFor, w).mismatch);
  return bad.length === 0 ? undefined : bad.join(", ");
}

// Which document answers this row, if any: the one filed under the same sheet
// and, where the sheet has components, the same component. A document naming no
// component answers the whole sheet.
function documentFor(
  obs: Observation,
  item: TestItem,
  templates: DocumentTemplate[],
  subs: Record<string, string>,
  // The plan's own items, for a router that answers this row from another one.
  allItems: TestItem[] = []
): { doc: ObservedDocument; host: string; address: string | undefined; expected: string | undefined; idFields?: string[] } | undefined {
  // A TEMPLATE, where the sheet declares one: it says which document answers
  // the row and where the value sits in it, and both can depend on the row's
  // component. That is the whole of "which realm does this sheet describe, and
  // how is a client of it addressed" — a table, not a program.
  const tpl = templates.find((t) => t.sheet === item.target.sheet);
  // A placeholder an importer resolved, replaced with what it resolved TO in
  // this environment. Its own step, because it applies on both branches: the
  // router one used to return early, so a `documents:` entry declaring both a
  // `router:` and a `substitute:` had the substitution silently do nothing.
  const resolved = (s: string): string =>
    tpl?.substitute === undefined
      ? s
      : s.replace(new RegExp(tpl.substitute, "g"), (whole, name: string) => subs[name] ?? whole);
  // A ROUTER answers both halves at once, for a sheet whose rows the API does
  // not address the way their source does. A row it does not name is left
  // unanswered — never filed at a guessed address.
  if (tpl?.router !== undefined) {
    const to = getDocumentRouter(tpl.router)?.route(item, { items: allItems.filter((x) => x.target.instance === item.target.instance) });
    if (to === undefined) return undefined;
    for (const [host, held] of Object.entries(obs.hosts)) {
      for (const d of held.documents ?? []) {
        if (d.name !== to.document) continue;
        // The router's own answer wins where it gave one, and the observation's
        // substitution applies after either. The two resolve different things —
        // one reads the model, the other reads what the importer did — and each
        // is a no-op where its own pattern does not match, so the order costs
        // nothing and applying only one would.
        const want = to.expected ?? item.expected;
        return {
          doc: d,
          host,
          address: resolved(to.address),
          expected: want === undefined ? undefined : resolved(want),
          ...(to.idFields === undefined ? {} : { idFields: to.idFields }),
        };
      }
    }
    return undefined;
  }
  const fill = (s: string): string =>
    resolved(
      s
        .replace(/\{component\}/g, item.component ?? "")
        .replace(/\{key\}/g, item.target.key)
        .replace(/\{address\}/g, item.address ?? item.target.key)
    );
  for (const [host, held] of Object.entries(obs.hosts)) {
    for (const d of held.documents ?? []) {
      if (tpl !== undefined) {
        if (tpl.document === undefined || tpl.address === undefined) continue;
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
  // …or a PRODUCT plugin that says both, for a sheet whose rows are addressed
  // the way their source addresses them and not the way the API answering them
  // does. See `channel.ts`'s `DocumentRouter`.
  router?: string;
  document?: string;
  address?: string;
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
  parsedDoc: (d: ObservedDocument, extraIds?: string[]) => Parsed | null,
  idFields: string[] = []
): TestResult[] {
  const target = { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance };
  const evidence = { host, ...(doc.how === undefined ? {} : { command: doc.how }) };
  if (doc.absent !== undefined) {
    return [{ target, at, evidence, status: "not_run", reason: doc.absent }];
  }
  const parsed = parsedDoc(doc, idFields);
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
  plan: TestPlan,
  templates: DocumentTemplate[] = [],
  defaults: { file: string; command?: string }[] = [],
  // A command nothing else can trace to a sheet — the build check asks `rpm -q`
  // on behalf of whichever sheets pinned a package, and a document filed
  // nowhere is one a reader of those rows cannot open from them.
  also?: { command?: string; sheet?: string }
): NonNullable<TestResults["evidence"]> {
  const sheetOf = new Map<string, string>();
  for (const i of plan.items) if (i.file !== undefined && !sheetOf.has(i.file)) sheetOf.set(i.file, i.target.sheet);
  // A command is asked FOR some rows, and those rows are in a sheet — which is
  // the chapter a reader of the verdict citing it is standing in. Derived from
  // what actually asked (a channel, for its own items; a default check, for the
  // file it stands beside) rather than declared a second time.
  const sheetOfCommand = new Map<string, string>();
  const channels = listChannels();
  for (const i of plan.items) {
    const asked = channels.find((c) => c.covers(i))?.needs(i);
    if (asked !== undefined && !sheetOfCommand.has(asked)) sheetOfCommand.set(asked, i.target.sheet);
  }
  for (const d of defaults) {
    const sheet = sheetOf.get(d.file);
    if (d.command !== undefined && sheet !== undefined && !sheetOfCommand.has(d.command)) sheetOfCommand.set(d.command, sheet);
  }
  if (also?.command !== undefined && also.sheet !== undefined && !sheetOfCommand.has(also.command)) {
    sheetOfCommand.set(also.command, also.sheet);
  }
  const out: NonNullable<TestResults["evidence"]> = [];
  const seen = new Set<string>();
  for (const obs of mergeByEnvironment(observations).merged) {
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
      // …and the documents, which are evidence for exactly the same reason a
      // file is: a verdict names an address, and the record has to carry what
      // that address names. Keyed by what was ASKED, since a document has no
      // path on any host.
      // The commands, each one document. A channel asked for it, a verdict
      // cites it, and the record has to carry what that citation names — the
      // same contract a file's verdict has.
      for (const [command, text] of Object.entries(held.commands ?? {})) {
        if (typeof text !== "string" || text === "") continue;
        const k = `${obs.environment} ${host} ${command}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ instance: obs.environment, host, at, sheet: sheetOfCommand.get(command) ?? "", command, text });
      }
      for (const d of held.documents ?? []) {
        if (d.absent !== undefined || d.text === "") continue;
        // One copy per ENVIRONMENT, not per host: a document is asked of a
        // PRODUCT, every node answers the same API, and only the node a verdict
        // names can be cited. The others are weight in a delivered file,
        // carried for a reader with no way to open them. (A file is different —
        // it is a fact about the host that holds it, and every host's copy is
        // cited by that host's own verdicts.)
        const k = `${obs.environment} ${d.how ?? d.name ?? d.sheet ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({
          instance: obs.environment, host, at,
          // Filed under the first sheet a template sends to this document —
          // where a reader of the rows it answers is standing.
          sheet: d.sheet ?? templates.find((t) => t.document === d.name)?.sheet ?? "",
          ...(d.name === undefined ? {} : { component: d.name }),
          command: d.how ?? d.name ?? "",
          text: d.text,
        });
      }
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
  // …and what a collector must remove before anything travels, where the
  // sheets bind a product that answers with secrets in the clear. The list is
  // the product's (see channels/keycloak.ts); applying it is the node's, which
  // is the only place it can happen before the bytes leave.
  redact?: { fields: string[]; mask: string; masked: string };
  // …and the marks that make a page the login page, so a collector looks for
  // exactly what the judge will ask about.
  login_marks?: string[];
  // …and how to find the files a deployed file NAMES. "We set nothing, so the
  // default applies" is a claim about those too, and WHICH syntax names them is
  // the product's: httpd's `Include`/`IncludeOptional`, resolved against its
  // `ServerRoot` when the path is relative. A collector cannot know that, and
  // every project that wrote it out was writing httpd's manual into a playbook.
  includes: { file: string; pattern: string; root?: string }[];
};

// The one command that says which build a host has. Named in one place, so the
// plan that asks for it and the judge that reads it cannot drift apart.
export const rpmQuery = (builds: { sheet: string; product: string; version: string }[] | undefined): string | undefined =>
  builds === undefined || packagesToQuery(builds).length === 0
    ? undefined
    : `rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}\n' ${packagesToQuery(builds).join(" ")}`;

export function collectPlan(
  plan: TestPlan,
  builds?: { sheet: string; product: string; version: string }[],
  defaults?: { file: string; command?: string; aside?: string }[],
  // Which product plugins this project bound — what a collector must redact is
  // the product's knowledge, and only the binding says which products are here.
  products: string[] = []
): CollectPlan {
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
  // …and the commands the items with no row behind them declare.
  for (const f of plan.functional) if (f.check !== undefined) commands.add(f.check.command);
  // …and the one that says which build this host has, where the sheets pin one.
  const rpm = rpmQuery(builds);
  if (rpm !== undefined) commands.add(rpm);
  // …and whatever else decides a default: the binary's own report, and the file
  // beside the configuration.
  for (const d of defaults ?? []) {
    if (d.command !== undefined) commands.add(d.command);
    if (d.aside !== undefined) for (const inst of Object.keys(files)) files[inst]!.add(d.aside);
  }
  return {
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [...v].sort()])),
    commands: [...commands].sort(),
    ...(products.includes("keycloak")
      ? { redact: { fields: SECRET_FIELDS, mask: REDACTED, masked: MASKED }, login_marks: LOGIN_MARKS_LIST }
      : {}),
    includes: [...new Set(Object.values(files).flatMap((v) => [...v]))]
      .sort()
      .flatMap((f) => includeSyntaxFor(f).map((x) => ({ file: f, ...x }))),
  };
}

// The channels a MODEL declares, registered so the judge and the collect plan
// both see them. Called by the commands that read a model, because the spec
// that declared them is not in their hands.
export function registerModelChannels(model: {
  channels?: import("./types.js").ChannelSpec[];
  functional_channels?: { channel: string; sheet?: string; login_page?: string; login_assets?: string; ldap_connection?: string; parameters_authored?: string }[];
  documents?: { router?: string }[];
  functional_rules?: FunctionalRule[];
}): number {
  for (const c of model.channels ?? []) {
    registerChannel(commandChannel(c, `${c.channel}:${c.sheet}:${c.command}`));
  }
  // …and the product plugins a project binds. Their knowledge is the product's
  // and lives in channels/; which of this project's items they answer is the
  // project's, and lives here.
  for (const f of model.functional_channels ?? []) {
    if (f.channel === "keycloak") registerKeycloakChannels(f);
    if (f.channel === "aws-rds") registerAwsRdsChannel(f);
  }
  // …and the plugins that only say WHERE a row sits in what a product's API
  // returned. A router named by no `documents:` entry is never registered: a
  // plugin that claims rows nobody asked it to is the same failure as one that
  // answers none.
  // …and the rules that contain no project fact at all: what a readiness body,
  // a logrotate dry run and `systemctl is-enabled` MEAN. The project names its
  // own items, so it binds them, exactly as it binds a channel.
  for (const r of model.functional_rules ?? []) {
    if (r.rule === "chrony") registerChronyRules(r);
    if (r.rule === "keycloak") registerKeycloakRules(r);
    if (r.rule === "logrotate") registerLogrotateRules(r);
    if (r.rule === "systemd") registerSystemdRules(r);
  }
  const routed = (model.documents ?? []).filter((d) => d.router !== undefined);
  for (const d of routed) {
    if (d.router === "aws-rds") registerAwsRdsRouter();
  }
  return (model.channels ?? []).length + (model.functional_channels ?? []).length + routed.length + (model.functional_rules ?? []).length;
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
  opts: {
    lang?: "ja" | "en";
    // WHAT TO SAY about a row nothing reached — declared by the project,
    // because "this process does not check that, and here is what does" is a
    // statement about the process, not about the product or the row. Without
    // it every unreached row gets the tool's own "nobody has been here yet",
    // which is true and useless where the project has a better answer.
    notChecked?: { sheet?: string; keys?: string[]; carried?: boolean; reason: string }[];
    // The importer's placeholder, as the sheet already declares it: it is what
    // makes "this row's value is judged inside the rows that carry it"
    // answerable rather than a claim.
    substitute?: string;
  } = {}
): TestResult[] {
  const t = JUDGE_WORDS[opts.lang ?? "ja"];
  // WHY it was not reached, and the two are different fixes: an environment
  // nobody collected is waiting for a run, while one that WAS collected and
  // still has no answer is waiting for a channel that can ask.
  const collected = new Set(
    mergeByEnvironment(observations).merged.filter((o) => Object.keys(o.hosts).length > 0).map((o) => o.environment)
  );
  const key = (x: { sheet: string; path?: string[]; key: string; instance: string }): string =>
    [x.sheet, (x.path ?? []).join("\u0001"), x.key, x.instance].join("\u0000");
  const seen = new Set(results.map((r) => key(r.target)));
  const stated = notCheckedFor(plan, opts.notChecked ?? [], opts.substitute, t);
  const out: TestResult[] = [];
  for (const item of plan.items) {
    if (seen.has(key(item.target))) continue;
    seen.add(key(item.target));
    const reason = stated(item) ?? (collected.has(item.target.instance) ? t.unreached : t.notCollected);
    out.push({
      target: { sheet: item.target.sheet, path: item.target.path, key: item.target.key, instance: item.target.instance },
      status: "not_run",
      reason,
    });
  }
  return out;
}

// The items with no row behind them, where a command answers them. Everything
// the value items already get: one verdict per host, the line of the output it
// was read at, and the three ways a host can fail to answer told apart — a
// command it does not have, an output that says nothing about this, an
// environment nobody collected.
//
// A project writes the rule for an item a command cannot settle (a date
// compared with now, a count compared with the fleet's size) and hands it back
// with `-a`. What it no longer writes is the loop around it.
export function judgeFunctional(
  plan: TestPlan,
  observations: Observation[],
  opts: { lang?: "ja" | "en"; at?: string } = {}
): { answers: NonNullable<TestResults["functional"]>; evidence: NonNullable<TestResults["evidence"]> } {
  const t = JUDGE_WORDS[opts.lang ?? "ja"];
  const at = opts.at ?? new Date().toISOString();
  const byEnv = new Map(mergeByEnvironment(observations).merged.map((o) => [o.environment, o]));
  const out: NonNullable<TestResults["functional"]> = [];
  // The bytes a product channel read its answer from, for the record to carry.
  const channelDocuments: NonNullable<TestResults["evidence"]> = [];
  const fchannels = listFunctionalChannels();
  for (const f of plan.functional) {
    // A PRODUCT channel first, where one claims the item: it knows what the
    // product's own answer means, which no declaration could carry.
    const fc = f.id === undefined ? undefined : fchannels.find((c) => c.covers(f.id!));
    if (fc !== undefined) {
      const base = {
        unit: f.unit,
        ...(f.id === undefined ? {} : { id: f.id }),
        item: typeof f.text === "string" ? f.text : (f.text.ja ?? f.text.en ?? ""),
        instance: f.instance,
      };
      const obs = byEnv.get(f.instance);
      if (obs === undefined || Object.keys(obs.hosts).length === 0) {
        out.push({ ...base, status: "not_run", reason: t.notCollected });
        continue;
      }
      const got = fc.answer(f.id!, obs.hosts, f.instance, {
        items: plan.items.filter((i) => i.target.instance === f.instance),
        ...(opts.lang === undefined ? {} : { lang: opts.lang }),
      });
      if (got !== undefined) {
        out.push({
          ...base,
          status: got.status,
          ...(got.detail === undefined ? {} : { detail: got.detail }),
          ...(got.reason === undefined ? {} : { reason: got.reason }),
          ...(got.evidence === undefined ? {} : { evidence: got.evidence }),
        });
        for (const d of got.documents ?? []) {
          // One document per address. Two items can be read from the same bytes
          // — a login page answers both its theme and its assets — and pushing
          // it twice puts two documents where a verdict's link resolves to
          // whichever came first.
          if (channelDocuments.some((x) => x.instance === f.instance && x.host === d.host && x.command === d.command)) continue;
          channelDocuments.push({ instance: f.instance, host: d.host, at, sheet: d.sheet, ...(d.component === undefined ? {} : { component: d.component }), command: d.command, text: d.text });
        }
        continue;
      }
    }
    // …and a RULE, where the project registered one for this item. The fold is
    // this tool's either way; what a rule adds is the one thing a declaration
    // cannot carry — what counts as a pass when the answer is not a value at
    // an address.
    const rule = f.id === undefined ? undefined : listProbeRules().find((r) => r.covers(f.id!));
    if (rule !== undefined) {
      const obs = byEnv.get(f.instance);
      const { answer, documents } = judgeProbes(
        f,
        obs?.hosts ?? {},
        (probe, ctx) => rule.verdict(probe, ctx),
        { lang: opts.lang, at, rule: rule.name, ...((rule.sheet ?? f.sheet) === undefined ? {} : { sheet: (rule.sheet ?? f.sheet)! }) }
      );
      out.push(answer);
      for (const d of documents) {
        if (channelDocuments.some((x) => x.instance === d.instance && x.host === d.host && x.command === d.command)) continue;
        channelDocuments.push(d);
      }
      continue;
    }
    if (f.check === undefined) {
      // NO RULE, NO CHANNEL, NO `check:` — and still an item of the plan. A
      // collector that could decide for itself put its verdict in the probe (an
      // HTTP status code is not a rule, it is the answer), and where it could
      // not, the fold says which of the three ways this host failed to answer.
      // Leaving it out instead made the plan's own coverage check fail on an
      // item nobody had declined to answer.
      const obs = byEnv.get(f.instance);
      const { answer, documents } = judgeProbes(f, obs?.hosts ?? {}, (probe) => ({ ok: probe.ok === true }), {
        lang: opts.lang,
        at,
        ...(f.sheet === undefined ? {} : { sheet: f.sheet }),
      });
      out.push(answer);
      for (const d of documents) {
        if (channelDocuments.some((x) => x.instance === d.instance && x.host === d.host && x.command === d.command)) continue;
        channelDocuments.push(d);
      }
      continue;
    }
    const obs = byEnv.get(f.instance);
    if (obs === undefined || Object.keys(obs.hosts).length === 0) {
      out.push({
        unit: f.unit,
        ...(f.id === undefined ? {} : { id: f.id }),
        item: typeof f.text === "string" ? f.text : (f.text.ja ?? f.text.en ?? ""),
        instance: f.instance,
        status: "not_run",
        reason: t.notCollected,
      });
      continue;
    }
    // The SAME fold every other functional item goes through — every host, the
    // worst answer, the failing host named — with a rule that compares the
    // channel's reading against the declared value. The loop used to be written
    // out here, and a project whose item needs a rule instead of a literal
    // wrote it out again.
    const command = f.check.command;
    const channel = commandChannel({ sheet: "", command, read: f.check.read }, `functional:${f.id ?? ""}`);
    const { answer } = judgeProbes(
      f,
      obs.hosts,
      (_probe, ctx) => {
        // The channel reads by the ROW's key; a functional item has none, so it
        // is asked with its own id — which is what `{key}` in a pattern means
        // here, and why an item that needs no key can leave the pattern plain.
        const got = channel.answer(
          { target: { sheet: "", path: [], key: f.id ?? "", instance: f.instance } } as never,
          ctx.held.commands ?? {}
        );
        if (got === undefined) return { ok: null, why: t.channelSilent(ctx.host, command) };
        return { ok: got.value === f.check!.expect, why: t.expected(String(got.value), String(f.check!.expect)), line: got.line };
      },
      {
        lang: opts.lang,
        at,
        // A command's output is already carried as evidence by `evidenceFrom`;
        // emitting it again would put two documents at one address.
        read: (held, _id, host) => {
          const held0 = held.commands ?? {};
          if (held0[command] === null) return { how: command, ran: false, why: t.noCommand(host, command) };
          return { how: command, ran: true };
        },
      }
    );
    out.push(answer);
  }
  return { answers: out, evidence: channelDocuments };
}
