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
  // `lang` is the language the DOCUMENT this verdict lands in is written in.
  // A rule that only quotes what a product said can ignore it; one that says
  // anything of its own resolves its words from it (`wordsFor` in
  // src/channel-words.ts) rather than writing a sentence in one language.
  verdict: (
    probe: { how?: string; ran?: boolean; why?: string; ok?: boolean | null; text?: string },
    ctx: { host: string; held: unknown; hosts: number; lang?: "ja" | "en" }
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

// ---------------------------------------------------------------------------
// How a PRODUCT reports its own settings — the half of a `channels:` entry that
// was never the project's.
//
// A declared entry carries two unrelated things: WHICH rows (a sheet, some
// keys) and HOW to read them (a command, and the shape of its output). The
// second is the product's, identically, in every project that runs it —
// `getenforce` is how SELinux states its mode and always will be — and a
// project writing it down is writing product knowledge into project config,
// where no test of this tool reaches it. Measured on one real spec: three of
// four entries were nothing but this.
//
// Keyed by the DICTIONARY PRODUCT a sheet binds, because that binding already
// selects exactly the right rows — verified against the same spec: the rows a
// `getenforce` entry named and the rows bound to `selinux` are the same set,
// and likewise for `selinux-boolean` and `firewalld-service`. So a recipe needs
// no scope of its own; the build derives it (see assemble-spec.ts).
//
// Not in the dictionary YAML: a dictionary is written wholesale by a generator
// from the product's own documentation, and a man page does not say which
// command reports the setting — a hand-added recipe would be destroyed by the
// next regeneration. This is code, like the judging half beside it.
export type ProductRead = {
  // The product name a `dictionaries:` binding names. Versionless: a product
  // that changed how it reports a setting would need a new recipe, and none of
  // the ones here ever has. Add a version when one does, not before.
  product: string;
  command: string;
  read: CommandRead;
};

const reads = sharedRegistry<ProductRead>("review-sheet.product-reads.v1");

export function registerProductRead(r: ProductRead): void {
  const i = reads.findIndex((x) => x.product === r.product);
  if (i >= 0) reads[i] = r;
  else reads.push(r);
}

export function getProductRead(product: string): ProductRead | undefined {
  return reads.find((r) => r.product === product);
}

export function listProductReads(): ProductRead[] {
  return [...reads];
}

// WHERE a row sits in what a product's own API returned — the other half of a
// `documents:` entry, and the other thing that was never the project's.
//
// `clients[clientId={component}].{key}` is the shape of a Keycloak realm
// export, not a decision anyone made here, and a project that spells it even
// slightly wrong gets rows that silently resolve to nothing. The realm DOCUMENT
// a sheet is compared against (`poc`, `master`) stays the project's, as does
// `substitute:` — measured, that one varies BETWEEN SHEETS OF ONE PRODUCT (the
// project's own clients carry `$(env:…)` references and the product's default
// clients do not), so it is a fact about the data, not about the product.
//
// Per SHEET rather than per row, because a `documents:` entry is: the sheet's
// one bound product with an address recipe decides it, and two would be an
// ambiguity the build refuses rather than resolves.
export type ProductAddress = {
  product: string;
  address: string;
};

const addresses = sharedRegistry<ProductAddress>("review-sheet.product-addresses.v1");

export function registerProductAddress(a: ProductAddress): void {
  const i = addresses.findIndex((x) => x.product === a.product);
  if (i >= 0) addresses[i] = a;
  else addresses.push(a);
}

export function getProductAddress(product: string): ProductAddress | undefined {
  return addresses.find((a) => a.product === product);
}

export function listProductAddresses(): ProductAddress[] {
  return [...addresses];
}

// How a product is asked to report its OWN effective configuration — the third
// half-a-declaration that was never the project's.
//
// `defaults_checked_by:` says which product, which deployed file, and the
// command that makes it answer. The product and the file the build already
// knows: a sheet carrying a deployed `file_path` and binding exactly one
// product IS that pairing. Only the command had to be written down, and
// `httpd -V` is how httpd states its compiled-in defaults everywhere.
//
// `command` is a FUNCTION of the config file's path, not a string, because a
// product installed under a prefix carries its own tooling there
// (`/opt/keycloak/conf/keycloak.conf` -> `/opt/keycloak/bin/kc.sh`) while one
// on PATH ignores the argument entirely. That relation is the product's
// distribution layout — exactly the kind of fact this registry is for — and a
// template with a placeholder would have to invent a vocabulary for "two
// directories up" that only one product would ever use.
//
// `aside:` is deliberately NOT derivable and stays the project's: the second
// file httpd reads (`/etc/sysconfig/httpd`) is the DISTRIBUTION's doing, and a
// dictionary pinned to an upstream version (`httpd@2.4.62`, unlike an NVR like
// `systemd@252-67.el9_8.4`) does not say which distribution this is.
export type ProductDefaults = {
  product: "httpd" | "keycloak";
  command: (configFile: string) => string;
};

const defaultsBy = sharedRegistry<ProductDefaults>("review-sheet.product-defaults.v1");

export function registerProductDefaults(d: ProductDefaults): void {
  const i = defaultsBy.findIndex((x) => x.product === d.product);
  if (i >= 0) defaultsBy[i] = d;
  else defaultsBy.push(d);
}

export function getProductDefaults(product: string): ProductDefaults | undefined {
  return defaultsBy.find((d) => d.product === product);
}

export function listProductDefaults(): ProductDefaults[] {
  return [...defaultsBy];
}

// How a product says WHICH BUILD it is — for the products `rpm -q` cannot
// answer for.
//
// A sheet's `builds:` pin (assemble-spec.ts) says which build it describes, and
// `buildMismatch` (channels/rpm.ts) holds a host to it. That check reaches only
// products the tool maps to an RPM package: measured on one real project, six
// of fourteen pinned products were checked and eight — everything installed
// from a tarball, an image or a cloud API — were never checked at all. A
// Keycloak upgrade therefore left every sheet silently reviewing the previous
// version's attack surface, which is precisely the "answered by a product the
// sheet does not describe, with an answer that looks exactly like a correct
// one" the pin exists to prevent.
//
// `products` is a LIST because one deployed product is usually described by
// several dictionaries — Keycloak's server options, its realms, its clients and
// its LDAP providers are four products to a binding and one install on a host.
//
// `from` names the `defaults_checked_by` product whose command already carries
// the answer, so this adds nothing to collect: a product that reports its own
// effective configuration states its version in the same breath.
export type ProductVersion = {
  products: string[];
  from: string;
  version: (output: string) => string | undefined;
};

const versions = sharedRegistry<ProductVersion>("review-sheet.product-versions.v1");

export function registerProductVersion(v: ProductVersion): void {
  const i = versions.findIndex((x) => x.from === v.from);
  if (i >= 0) versions[i] = v;
  else versions.push(v);
}

export function productVersionFor(product: string): ProductVersion | undefined {
  return versions.find((v) => v.products.includes(product));
}

export function listProductVersions(): ProductVersion[] {
  return [...versions];
}

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
    // `lang` as on ProbeRule above: the document's language, for the half of an
    // answer the channel writes rather than quotes.
    ctx?: { items?: TestItem[]; lang?: "ja" | "en" }
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
