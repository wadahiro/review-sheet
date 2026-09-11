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
  answer: (id: string, hosts: Record<string, unknown>, instance: string) => FunctionalAnswer | undefined;
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
