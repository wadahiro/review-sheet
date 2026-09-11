// A CHANNEL: something other than a deployed file that can answer a row.
//
// A file settles most rows and nothing else needs asking. The rest are settled
// by asking the HOST or the PRODUCT — what SELinux is enforcing, which services
// the firewall permits, what the product says its effective configuration is —
// and every project doing infrastructure tests writes that table. Before this
// there was no shape for it, so every project invented one too.
//
// THE AXIS IS THE CHANNEL, NOT THE COLLECTOR. Ansible is what reaches a host;
// `getenforce` reads the same whether Ansible, Salt or a person ran it, and
// this tool runs none of them. A registry keyed on the collector would be keyed
// on the part that does not vary.
//
// What a channel declares is two things, and the second is the one that pays:
//
//   covers   which items it answers
//   needs    WHAT TO COLLECT for them — so the collector can be derived from
//            the plan instead of hand-listing the same commands a second time,
//            in a second language, with nothing checking the two agree.
//
// A channel never reaches anything. It is a pure function from what was
// collected to a value, which is what lets its rules be broken on purpose and
// watched failing.

import { sharedRegistry } from "./registry.js";
import type { TestItem } from "./testplan.js";

// What a host was asked, and what it said. One entry per command.
export type Collected = Record<string, string | null>;

export type ChannelAnswer = {
  value: string;
  // Which line of the output it was read at, so a verdict points at the words
  // it was read from rather than at 341 lines of `getsebool -a`.
  line?: number;
};

export type Channel = {
  name: string;
  covers: (item: TestItem) => boolean;
  // The command whose output answers this item. Undefined for an item this
  // channel covers but needs nothing new for (it reads something already
  // collected for another reason).
  needs: (item: TestItem) => string | undefined;
  answer: (item: TestItem, collected: Collected) => ChannelAnswer | undefined;
};

// WHERE a row sits in a document a product's API returned.
//
// A document is read by the same machinery a file is — the row's own structural
// address, looked up in the parsed reply — which works whenever the sheet and
// the API agree on how a value is addressed. They often do not: a row of an
// infrastructure sheet is addressed the way its SOURCE addresses it, and the
// API that can be asked names the same field something else. That relation is
// the PRODUCT's, the same kind of fact a parser holds, and it cannot be
// inferred from the spelling.
//
// A router says which document answers a row and where the value sits in it.
// Bound by the project (a `documents:` entry naming it), because only the
// project knows which of its sheets holds those rows. A row the router does not
// name is left unanswered rather than guessed at.
export type DocumentRouter = {
  name: string;
  route: (item: TestItem) => { document: string; address: string; idFields?: string[] } | undefined;
};

const routers = sharedRegistry<DocumentRouter>("review-sheet.document-routers.v1");

export function registerDocumentRouter(r: DocumentRouter): void {
  const i = routers.findIndex((x) => x.name === r.name);
  if (i >= 0) routers[i] = r;
  else routers.push(r);
}

export function getDocumentRouter(name: string): DocumentRouter | undefined {
  return routers.find((r) => r.name === name);
}

export function listDocumentRouters(): DocumentRouter[] {
  return [...routers];
}

// A RULE FOR ONE HOST'S PROBE.
//
// A functional item whose answer is not a value at an address and not a
// literal comparison needs a rule, and a rule is code. What this registry
// changes is WHERE that code runs: registered here, the tool's own fold calls
// it — every host, the worst answer, the failing host named, the bytes carried
// — so a project supplies the rule and nothing else. Before it, a project ran
// its own program, wrote an answers file and had it merged, and everything
// that seam needed (clearing the file, gating on whether it was written,
// agreeing on exit codes) was code nobody was judging anything with.
//
// Two kinds sit in the same registry. A rule with no project fact in it at all
// — "the readiness endpoint answered 200 and no check reports DOWN" — is the
// PRODUCT's and ships with the tool, bound to whatever the project calls that
// item. One that compares against this deployment's own design is the
// project's and is loaded from `./.review-sheet/rules/`.
export type ProbeRule = {
  name: string;
  covers: (id: string) => boolean;
  // Where the bytes it read are filed in the record.
  sheet?: string;
  // `probe` is what the collector recorded for this item on this host; `ctx`
  // carries the host, everything else that host holds, and how many hosts
  // answered — the fleet's own size, which is an expectation no literal can
  // state.
  verdict: (
    probe: { how?: string; ran?: boolean; why?: string; ok?: boolean | null; text?: string },
    ctx: { host: string; held: unknown; hosts: number }
  ) => { ok: boolean | null; why?: string; line?: number };
};

const rules = sharedRegistry<ProbeRule>("review-sheet.probe-rules.v1");

export function registerProbeRule(r: ProbeRule): void {
  const i = rules.findIndex((x) => x.name === r.name);
  if (i >= 0) rules[i] = r;
  else rules.push(r);
}

export function listProbeRules(): ProbeRule[] {
  return [...rules];
}

const registry = sharedRegistry<Channel>("review-sheet.channels.v1");

export function registerChannel(c: Channel): void {
  const i = registry.findIndex((x) => x.name === c.name);
  if (i >= 0) registry[i] = c;
  else registry.push(c);
}

export function listChannels(): Channel[] {
  return [...registry];
}

export function getChannel(name: string): Channel | undefined {
  return registry.find((c) => c.name === name);
}

// ---------------------------------------------------------------------------
// The built-in `command` channel, configured by DATA.
//
// Three ways to read an output, and no more. Each is a shape a real command
// has, not a step in a language: a general expression evaluator here would be
// the same mistake as implementing Jinja2 in the extractor, and would put a
// project's rules somewhere no test of this tool can reach.
//
//   whole     the output IS the value (`getenforce` -> "Enforcing")
//   pattern   one line names the row, and a capture is its value
//             (`getsebool -a` -> `httpd_can_network_connect --> on`)
//   member    the row is one of the words the output lists, and the value is
//             whether it is there (`firewall-cmd --list-services` -> "ssh http")

export type CommandRead =
  | { whole: true; lower?: boolean }
  | { pattern: string; map?: Record<string, string> }
  | { member: true };

export type CommandChannelSpec = {
  // Which rows: a sheet, and the keys within it.
  sheet: string;
  // An exact key, or a prefix ending in `.` — `firewalld.` covers every
  // service the firewall row names, without listing them.
  keys?: string[];
  key_prefix?: string;
  command: string;
  read: CommandRead;
};

const lineOf = (text: string, re: RegExp): number | undefined => {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i]!)) return i + 1;
  return undefined;
};

// `firewalld.ssh` asks about `ssh`: the prefix is how the sheet namespaces a
// row, and the host has never heard of it.
const bare = (spec: CommandChannelSpec, key: string): string =>
  spec.key_prefix !== undefined && key.startsWith(spec.key_prefix) ? key.slice(spec.key_prefix.length) : key;

const covers = (spec: CommandChannelSpec, item: TestItem): boolean => {
  if (item.target.sheet !== spec.sheet) return false;
  const k = item.target.key;
  if (spec.key_prefix !== undefined && k.startsWith(spec.key_prefix)) return true;
  return (spec.keys ?? []).includes(k);
};

export function commandChannel(spec: CommandChannelSpec, name?: string): Channel {
  return {
    name: name ?? `command:${spec.command}`,
    covers: (item) => covers(spec, item),
    needs: (item) => (covers(spec, item) ? spec.command : undefined),
    answer: (item, collected) => {
      const out = collected[spec.command];
      // A command the host does not have reports null, and that is an answer of
      // its own — "this host does not apply that setting" — which the caller
      // states. Undefined here means only that this channel cannot say.
      if (typeof out !== "string") return undefined;
      const key = bare(spec, item.target.key);
      if ("whole" in spec.read) {
        const v = out.trim();
        return { value: spec.read.lower === true ? v.toLowerCase() : v, line: out.trim() === "" ? undefined : 1 };
      }
      if ("member" in spec.read) {
        return { value: String(out.trim().split(/\s+/).includes(key)), line: 1 };
      }
      // `{key}` is the row's own name put into the pattern, so one entry covers
      // every boolean a project sets rather than one entry each.
      const re = new RegExp(spec.read.pattern.replace(/\{key\}/g, key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "m");
      const m = re.exec(out);
      if (m === null) return undefined;
      const raw = m[1] ?? "";
      return { value: spec.read.map?.[raw] ?? raw, line: lineOf(out, re) };
    },
  };
}

// ---------------------------------------------------------------------------
// A FUNCTIONAL channel: an item with no row behind it, answered from what a
// collector already gathered.
//
// The axis here is the PRODUCT, and that is the point. "What a Keycloak login
// page means", "what its testLDAPConnection answers", "what `httpd -V` prints"
// is the same in every project that runs those products — the same kind of
// knowledge `src/parsers/httpd.ts` has held since the beginning. Written into
// each project's judging script it is copied per project and tested in none.
//
// It JUDGES, it does not reach. By the time this runs, a collector has already
// stood on the host and handed bytes over; a channel reads them. What a plugin
// cannot yet do is say what to fetch — `collect-plan` names commands, not
// requests — so the asking half stays with whoever reaches.
export type FunctionalAnswer = {
  status: "pass" | "fail" | "not_run";
  detail?: string;
  reason?: string;
  evidence?: { host?: string; command?: string; file?: string; line?: number };
  // Bytes this answer was read from, for the record to carry.
  documents?: { host: string; command: string; text: string; sheet: string; component?: string }[];
};

export type FunctionalChannel = {
  name: string;
  // Which items, by the id the project's own declaration gives them. A product
  // plugin cannot know a project's ids, so the project binds them.
  covers: (id: string) => boolean;
  // One answer for the whole item, from every host that was collected: a
  // product asked once answers once, and which host was asked is the channel's
  // to decide (a realm is the same from every node; a file is not).
  // `ctx.items` is what the PLAN says about the sheet this channel is bound to,
  // for the answers that are about the sheet as a whole rather than about one
  // row — "nobody changed anything we did not decide" is a question about the
  // set of rows, and the set is the plan's.
  answer: (
    id: string,
    hosts: Record<string, unknown>,
    instance: string,
    ctx?: { items?: TestItem[] }
  ) => FunctionalAnswer | undefined;
};

const functionalRegistry = sharedRegistry<FunctionalChannel>("review-sheet.functional-channels.v1");

export function registerFunctionalChannel(c: FunctionalChannel): void {
  const i = functionalRegistry.findIndex((x) => x.name === c.name);
  if (i >= 0) functionalRegistry[i] = c;
  else functionalRegistry.push(c);
}

export function listFunctionalChannels(): FunctionalChannel[] {
  return [...functionalRegistry];
}
