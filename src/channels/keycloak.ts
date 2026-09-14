// What Keycloak's own answers MEAN.
//
// A product's knowledge is not one project's. "A login page names its theme in
// every asset URL it references", "testLDAPConnection returns the product's own
// word for why a bind failed" is the same in every project that runs Keycloak —
// the same kind of fact `src/parsers/httpd.ts` has held since the beginning,
// one layer up. Written into each project's judging script instead, it is
// copied per project and held by no test anywhere.
//
// IT JUDGES, IT DOES NOT REACH. A collector has already asked the product and
// handed the bytes over; this reads them. What it cannot do is say what to
// fetch — the authorization request a login page needs is built from the realm
// the product just returned, which is a second round-trip no plan can express —
// so the asking stays with whoever reaches the host.
//
// The ids are the PROJECT's: a project names its own functional items, and a
// product plugin cannot know what it called them. It binds them (build.yml's
// `functional_channels:`), which is also what keeps this from claiming an item
// that happens to share a name.

import { registerDocumentRouter, registerFunctionalChannel, registerProbeRule, type DocumentRouter, type FunctionalAnswer } from "../channel.js";
import type { TestItem } from "../testplan.js";

// ---------------------------------------------------------------------------
// What the product says it is USING, and where each value came from.
//
// `kc.sh show-config` prints `kc.<key> = <value> (<source>)`. That second half
// is the strong part and the reason to ask at all: a file can only say what was
// written, while this names WHO decided each value — so "we set nothing, so the
// product's default applies" stops being an inference and becomes a question
// the product answers.
//
// Only a value the product reports from its own bundled properties IS the
// default. Every other source names somebody who set it: `Persisted` is a build
// option baked in by `kc.sh build`, a system property or an environment
// variable is the launcher. A row claiming the default is in force is then
// simply wrong — and that is the case no reading of our own files can find.
export function effectiveConfig(text: string | null | undefined): Map<string, { value: string; source: string }> {
  const out = new Map<string, { value: string; source: string }>();
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*kc\.([A-Za-z0-9._-]+)\s*=\s*(.*?)\s*\(([^()]*)\)\s*$/.exec(line);
    if (m !== null) out.set(m[1]!, { value: m[2]!, source: m[3]! });
  }
  return out;
}

export const isProductDefault = (source: string): boolean => /^classpath /.test(source);

// Which line a key was reported at, so a verdict points at the words.
export function lineOfEffective(text: string | null | undefined, key: string): number | undefined {
  if (typeof text !== "string") return undefined;
  const at = text.split("\n").findIndex((l) => new RegExp(`^\\s*kc\\.${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(l));
  return at < 0 ? undefined : at + 1;
}


// ---------------------------------------------------------------------------
// What the product says about ITSELF while it runs.
//
// Three answers a project asks of every Keycloak deployment, and in each one
// the reading is the product's and the EXPECTATION is the project's — so what
// lives here is only the reading. How many members a cluster should have is the
// fleet's size; which hostname the issuer should carry is the deployed
// configuration's: neither is knowable from the product's reply alone.

// `/health/ready`. The endpoint answers 200 with a body naming each check, so
// the status line alone is not the answer: one check reporting DOWN under an
// overall 200 is not a shape the product is meant to produce, and reading it is
// cheaper than assuming it cannot happen.
export function readyReport(text: string | null | undefined): { http?: number; down: boolean } {
  const code = /HTTP (\d+)/.exec(text ?? "")?.[1];
  return {
    ...(code === undefined ? {} : { http: Number(code) }),
    down: /"status"\s*:\s*"DOWN"/.test(text ?? ""),
  };
}

// The size of the cluster view the embedded cache last logged (Infinispan's
// `ISPN000094`, whose view line ends `(N) [member, member]`). How many there
// SHOULD be is the fleet's, not the product's.
export function clusterMembers(text: string | null | undefined): number | undefined {
  const m = /\((\d+)\)\s*\[/.exec(text ?? "");
  return m === null ? undefined : Number(m[1]);
}

// What the realm publishes as its issuer, from its discovery document.
export function issuerOf(text: string | null | undefined): string | undefined {
  return /"issuer"\s*:\s*"([^"]+)"/.exec(text ?? "")?.[1];
}

// …and what it WOULD be for a base URL and a realm. The product's own rule
// (`<base>/realms/<realm>`), applied to two facts only the project has: the
// hostname its configuration deploys, and the realm the question was put about.
export function issuerFor(base: string | null | undefined, realm: string | null | undefined): string {
  return `${(base ?? "").replace(/\/$/, "")}/realms/${realm ?? ""}`;
}


// One realm's login page, as a collector fetched it. The shape is the
// collector's to produce; what each field MEANS is this file's.
type LoginPage = {
  realm: string;
  url?: string;
  status?: number;
  theme?: string | string[] | null;
  declared_theme?: string | null;
  form?: string[];
  assets?: { path: string; status: number }[];
  html?: string;
  reason?: string;
  error?: string;
};

type LdapProvider = {
  realm: string;
  name?: string;
  enabled?: boolean;
  result?: Record<string, { ok?: boolean; status?: number; message?: string }> | null;
  error?: string;
};

type Held = { login?: LoginPage[]; ldap?: LdapProvider[]; collected_at?: string };

// ---------------------------------------------------------------------------
// WHAT MUST NEVER LEAVE THE NODE, and the marks that make a page the login page.
//
// Both are facts about the PRODUCT, and both were being written out by hand in
// every project that dumps a realm. The first is the one that matters: the
// Admin API returns client secrets and LDAP bind credentials IN THE CLEAR (it
// is the partial-export endpoint that masks them, not this one), so a realm
// document has to be redacted before it travels — and WHICH fields carry a
// secret is Keycloak's shape, not a project's guess. A name missing from a
// project's own copy of this list is a credential in a delivered document, and
// nothing about the delivery looks wrong.
//
// By NAME rather than by asking the sheet which rows are secret: this is the
// node's last line and should hold for a field no sheet mentions. The sheet's
// own `secret:` marking is narrower and is applied again later, where the
// record is written.
export const SECRET_FIELDS = [
  "secret",
  "bindCredential",
  "privateKey",
  "clientSecret",
  "password",
  "credentials",
  "adminPassword",
  "keyPassword",
  "truststorePassword",
  "keystorePassword",
];

// …and the mask the server itself understands: `testLDAPConnection` takes the
// masked credential with a `componentId` beside it and uses the one it already
// holds, so a connection can be tested without any secret travelling at all.
export const MASKED = "**********";

// What a collector should leave in place of a value it removed. Not the same
// string as the mask above: one says "we took this out", the other is what the
// product itself expects to be handed back.
export const REDACTED = "(redacted on the node)";

// The marks that make a page the LOGIN page rather than an error page wearing
// the same theme — the same list `loginAnswer` judges against, so a collector
// and the judge cannot disagree about what it looked for.
export const LOGIN_MARKS_LIST = ["kc-form-login", 'name="username"', 'name="password"'];

// What makes a page the LOGIN page rather than an error page wearing the same
// theme: the product's own form id, and the two fields it asks for. A collector
// reports which of them it found; this says which are meant to be there, so a
// page missing one is named by the mark it is missing.
const LOGIN_MARKS = LOGIN_MARKS_LIST;

const missingMarks = (found: string[] | undefined): string[] =>
  LOGIN_MARKS.filter((m) => !(found ?? []).includes(m));

// EVERY host that has an answer, not the first.
//
// A realm is the same realm from every node, which is why this used to read one
// — but a login page is fetched through the node's OWN front end, so a proxy
// broken on the second node is a page that never renders and an answer that
// never mentions it. Same rule as every other verdict here: a fleet is only as
// configured as its least configured node.
//
// A host the collector did not ask is not an answer and is skipped; where none
// was asked, the caller says so.
const allWith = (hosts: Record<string, unknown>, has: (h: Held) => boolean): [string, Held][] =>
  Object.entries(hosts).filter(([, held]) => has(held as Held)) as [string, Held][];

const firstWith = (hosts: Record<string, unknown>, has: (h: Held) => boolean): [string, Held] | undefined =>
  allWith(hosts, has)[0];

function loginAnswer(id: string, hosts: Record<string, unknown>, sheet: string): FunctionalAnswer | undefined {
  // EVERY node that was asked: a login page is fetched through the node's own
  // front end, so one whose proxy is broken serves a page that never renders —
  // and reading only the first node answers for a fleet it never looked at.
  const from = allWith(hosts, (h) => (h.login ?? []).length > 0);
  if (from.length === 0) return { status: "not_run", reason: "ログイン画面を取得できていない" };
  const all = from.flatMap(([host, held]) => (held.login ?? []).map((p) => ({ host, p })));
  const pages = all.filter(({ p }) => p.reason === undefined && p.error === undefined);
  const documents = pages
    .filter(({ p }) => typeof p.html === "string" && p.html !== "")
    .map(({ host, p }) => ({ host, command: `GET ${p.url}`, text: p.html!, sheet, component: p.realm }));
  if (pages.length === 0) {
    return {
      status: "not_run",
      reason: all.map(({ p }) => `${p.realm}: ${p.reason ?? p.error}`).join(" / "),
      documents,
    };
  }
  const cite = { host: pages[0]!.host, command: `GET ${pages[0]!.p.url}` };
  // A page is named by the node it was fetched from once more than one node
  // answered, and by its realm alone where only one did — the fleet's shape
  // decides, not this file.
  const many = from.length > 1;
  const name = ({ host, p }: { host: string; p: LoginPage }): string => (many ? `${host} ${p.realm}` : p.realm);

  if (id.endsWith("assets")) {
    // A theme can be SELECTED and still broken: the resource version in every
    // asset URL is re-minted when the themes are rebuilt, so a jar that was not
    // redeployed leaves the page pointing at CSS that 404s and renders bare.
    const bad = pages.flatMap((x) =>
      (x.p.assets ?? []).filter((a) => a.status !== 200).map((a) => `${name(x)} ${a.path} → ${a.status}`)
    );
    const total = pages.reduce((n, x) => n + (x.p.assets ?? []).length, 0);
    return {
      status: bad.length === 0 ? "pass" : "fail",
      detail: `ログイン画面が参照する ${total} 件（${pages.length} レルム）`,
      ...(bad.length === 0 ? {} : { reason: bad.slice(0, 3).join(" / ") }),
      evidence: cite,
      documents,
    };
  }

  // …and the page itself has to BE the login page before its theme means
  // anything. WHICH marks make it one is the product's knowledge — a bare count
  // was this file asserting how many a collector it does not own decides to
  // look for, and it could only ever say "not enough of something" — so the
  // marks are named here and the verdict says which one is missing.
  const broken = pages.filter((x) => x.p.status !== 200 || missingMarks(x.p.form).length > 0);
  if (broken.length > 0) {
    return {
      status: "fail",
      detail: `GET ${pages[0]!.p.url}`,
      reason: broken
        .map((x) => `${name(x)}: HTTP ${x.p.status}${missingMarks(x.p.form).length === 0 ? "" : `、ログインフォームが無い（${missingMarks(x.p.form).join(", ")}）`}`)
        .join(" / "),
      evidence: { host: broken[0]!.host, command: `GET ${broken[0]!.p.url}` },
      documents,
    };
  }
  // A realm's `loginTheme` says which theme was CHOSEN. Where it states none,
  // the product's own default applies and there is nothing to be "as designed":
  // the served theme is REPORTED and the item says so rather than inventing an
  // expectation.
  const declared = pages.filter((x) => x.p.declared_theme != null);
  if (declared.length === 0) {
    return {
      status: "not_run",
      reason: `どのレルムも loginTheme を指定していない（製品既定 ${[...new Set(pages.map((x) => String(x.p.theme)))].join(", ")} が配信されている）`,
      documents,
    };
  }
  const wrong = declared.filter((x) => x.p.theme !== x.p.declared_theme);
  return {
    status: wrong.length === 0 ? "pass" : "fail",
    detail: `GET ${pages[0]!.p.url}（${declared.length} レルム）`,
    ...(wrong.length === 0
      ? {}
      : { reason: wrong.map((x) => `${name(x)}: ${JSON.stringify(x.p.theme)} が配信されている、指定は ${x.p.declared_theme}`).join(" / ") }),
    evidence: wrong.length === 0 ? cite : { host: wrong[0]!.host, command: `GET ${wrong[0]!.p.url}` },
    documents,
  };
}

function ldapAnswer(hosts: Record<string, unknown>, sheet: string): FunctionalAnswer | undefined {
  const from = firstWith(hosts, (h) => (h.ldap ?? []).length > 0);
  if (from === undefined) return { status: "not_run", reason: "ユーザフェデレーションの状態を読めていない" };
  const [host, held] = from;
  const all = held.ldap ?? [];
  const providers = all.filter((p) => p.error === undefined);
  const documents = [
    { host, command: "POST /admin/realms/{realm}/testLDAPConnection", text: JSON.stringify(all, null, 2), sheet },
  ];
  // A provider this environment DISABLED is not asked: `enabled: false` means
  // the project deliberately does not use it, and a failed bind against a
  // directory nobody talks to is not a finding.
  const live = providers.filter((p) => p.enabled === true);
  if (live.length === 0) {
    return {
      status: "not_run",
      reason: providers.length === 0 ? "LDAP プロバイダが無い" : `この環境では無効: ${providers.map((p) => p.name).join(", ")}`,
      documents,
    };
  }
  const bad = live.flatMap((p) =>
    ["testConnection", "testAuthentication"]
      .filter((a) => p.result?.[a]?.ok !== true)
      // The product's OWN word for why — `UnknownHost`, `AuthenticationError` —
      // is the whole value of asking it rather than guessing from a row.
      .map((a) => `${p.name} ${a}: ${p.result?.[a]?.message || p.result?.[a]?.status || "no answer"}`)
  );
  return {
    status: bad.length === 0 ? "pass" : "fail",
    detail: `POST /admin/realms/{realm}/testLDAPConnection（${live.length} プロバイダ）`,
    ...(bad.length === 0 ? {} : { reason: bad.slice(0, 2).join(" / ") }),
    evidence: { host, command: "POST /admin/realms/{realm}/testLDAPConnection" },
    documents,
  };
}

// Bound by a project, because the ids are a project's own. `sheet` is where the
// evidence is filed — the chapter a reader of those rows is standing in.
export function registerKeycloakChannels(binding: {
  login_page?: string;
  login_assets?: string;
  ldap_connection?: string;
  sheet?: string;
}): void {
  const sheet = binding.sheet ?? "";
  const ids = new Map<string, "login" | "assets" | "ldap">();
  if (binding.login_page !== undefined) ids.set(binding.login_page, "login");
  if (binding.login_assets !== undefined) ids.set(binding.login_assets, "assets");
  if (binding.ldap_connection !== undefined) ids.set(binding.ldap_connection, "ldap");
  registerFunctionalChannel({
    name: "keycloak",
    covers: (id) => ids.has(id),
    answer: (id, hosts) => {
      const kind = ids.get(id);
      if (kind === undefined) return undefined;
      if (kind === "ldap") return ldapAnswer(hosts, sheet);
      return loginAnswer(kind === "assets" ? "assets" : "page", hosts, sheet);
    },
  });
}

// ---------------------------------------------------------------------------
// WHERE A USER-FEDERATION MAPPER ROW SITS in a realm's user-federation
// component document — the one address `registerProductAddress`
// (channels/reads.ts, "keycloak-ldap") cannot state as a template, because
// review-sheet's own `split.nest` (keytransform.ts) has folded the mapper's
// identity INTO the key (`<mapperName>.<providerId>.<realKey>`, via
// `withNestPrefix`) — there is no template placeholder that could spell that
// back out for EITHER an authored row or a materialized one.
//
// Always CONSTRUCTS, deliberately never passes an authored row's own
// `item.address` through unchanged (unlike a template's address, which
// judge.ts's document branch does prefer over a construction — see its
// "stated beats derived" comment): an authored mapper row's `item.address`
// and this construction from its key name the same address, once both are
// read through `unquoteIds` (judge.ts) — an identity predicate whose value
// needs quoting (`[name="last name"]`, a mapper Keycloak itself names with a
// space) is quoted in `item.address` and unquoted here, and only a reader
// that normalizes BOTH sides before comparing can treat them as one
// address. `judgeFiles` does; a caller that reads its own collected
// document through `extractFile` and compares raw strings does not — so
// passing `item.address` through unchanged there would construct a correct
// address for a materialized row and silently miscompare every mapper
// Keycloak itself names with a space ("last name", "first name", "creation
// date", "modify date"). One construction, one code path, for every kind —
// reachable through `judgeFiles` too, which normalizes what this always
// spells unquoted.
//
// The DOCUMENT this addresses is a project's own synthesized shape — a realm
// export's `components` field, keyed by provider TYPE rather than by the
// flat, `parentId`-linked list the Admin API itself returns (`GET
// /admin/realms/{realm}` carries no `components` field at all, and
// `/admin/realms/{realm}/components` is flat). Reconstructing that nesting
// from the flat API is the COLLECTOR's job, once, the same project fact
// `documents:` names for any other sheet — this router only says where
// inside that already-nested document a row sits, never how the document
// was built. A project whose collector emits a different shape gets wrong
// addresses from this router, not an error: state the shape in the
// `documents:` binding's own comment, the discipline `aws-rds.ts` documents
// for its own table.
const LDAP_PROVIDER_TYPE = "org.keycloak.storage.UserStorageProvider";
const LDAP_MAPPER_PROVIDER_TYPE = "org.keycloak.storage.ldap.mappers.LDAPStorageMapper";

// Which LDAP store (the Admin API's `components[name=…]`) a row belongs to.
// A sheet with ONE store has no store axis at all — `item.target.path` is
// `["Mappers", mapperName]` and `item.component` is the CATEGORY label
// ("Mappers"), never the store, so there is nothing on the row to read it
// from and the project has to STATE it (`binding.ldap_component`). A sheet
// with SEVERAL stores (`split: { by: name }`) puts the store at `path[0]`
// (`[store, "Mappers", mapperName]`) precisely because two stores share one
// key space and something has to disambiguate them — and that something is
// already on every row, so reading it off the path is not a guess, it is the
// same fact `by:` used to build the split in the first place.
//
// The two cases are told apart structurally, not by whether a binding was
// given: the mappers category sits at path[0] on a single-store sheet and
// one level deeper on a multi-store one, so "is path[0] the category" is the
// same test either way. A binding is still required (not merely offered) for
// the single-store case, since there the path carries no store name to fall
// back to.
function ldapComponentNameOf(item: TestItem, binding: { ldap_component?: string; mappers_category: string }): string | undefined {
  if (item.target.path[0] === binding.mappers_category) return binding.ldap_component;
  return item.target.path[0] ?? binding.ldap_component;
}

// A mapper row's key, once `split.nest` has folded the mapper's own identity
// in front of it: `<mapperName>.<providerId>.<realKey>`. Bound on the LAST
// path segment rather than a fixed index — the mapper name is always the
// innermost segment, whether the sheet has one store or several.
//
// `undefined` here, for a row the caller already knows is under the mappers
// category, means the KEY does not carry the shape this function expects —
// review-sheet's own `split.nest` producing something else, or a project
// hand-editing a materialized row's key. That is a shape the router does not
// recognise, the same "a row the table does not name gets no answer, never a
// guess" rule `aws-rds.ts` documents, and the caller should treat it as
// louder than an ordinary miss: it falls back to `not_run` in the plan, which
// a verdict diff against a working baseline surfaces (see
// tests/channel-keycloak.test.ts's "leaves an unrecognised key shape
// unanswered").
function nestedMapperAddress(item: TestItem, ldapComponentName: string): string | undefined {
  const mapperName = item.target.path.at(-1);
  if (mapperName === undefined) return undefined;
  const prefix = `${mapperName}.`;
  if (!item.target.key.startsWith(prefix)) return undefined;
  const rest = item.target.key.slice(prefix.length);
  const dot = rest.indexOf(".");
  if (dot === -1) return undefined;
  const realKey = rest.slice(dot + 1);
  // `providerId` is a plain field of the mapper itself; an AUTHORED row's
  // config.* key is already a complete bracketed reference
  // (`config["ldap.attribute"][0]`, extractFile's own spelling), so both
  // attach with a dot. Everything else is a bare dictionary key
  // (`is.mandatory.in.ldap`, `attribute.force.default`) — a dictionary
  // names its own mapper entries this way, never `config[`-prefixed and
  // never the name of a structural component field
  // (id/name/providerId/providerType/parentId/subComponents/config) — and a
  // bare key like this is a `config` entry the product itself has no OTHER
  // place to put, so it is addressed there, index 0, the same shape
  // extractFile gives an authored one. Bracketing it directly on the mapper
  // (no `.config`) would construct an address one level too shallow for
  // every materialized mapper row.
  const suffix =
    realKey === "providerId" || realKey.startsWith("config[") ? `.${realKey}` : `.config["${realKey}"][0]`;
  return (
    `components["${LDAP_PROVIDER_TYPE}"][name=${ldapComponentName}]` +
    `.subComponents["${LDAP_MAPPER_PROVIDER_TYPE}"][name=${mapperName}]${suffix}`
  );
}

// Bound by the project: which document holds the reconstructed realm's
// `components`, which sheet(s) route through it, and — for a sheet with only
// one store, where nothing on the row can say so (see `ldapComponentNameOf`)
// — that store's own Admin API name. A sheet with several stores derives it
// per row instead, so `ldap_component` is optional: omitting it on a
// single-store sheet is not a guess-around, it is the same "a row the
// binding does not name gets no answer" rule as an unrecognised key shape —
// route() returns undefined, the row lands not_run, and a verdict diff
// surfaces it.
export function registerKeycloakLdapRouter(binding: {
  document: string;
  sheet: string;
  ldap_component?: string;
  mappers_category: string;
}): DocumentRouter {
  const router: DocumentRouter = {
    name: `keycloak-ldap:${binding.sheet}`,
    route: (item) => {
      if (item.target.sheet !== binding.sheet) return undefined;
      // A MAPPER row's key carries a `<mapperName>.<providerId>.` prefix to
      // strip; a STORE's own row (General/Settings/Cache Settings) does not
      // and is answered from its own `item.address` instead — unquoted the
      // same way nestedMapperAddress's own construction is (see that
      // function's doc comment on why judge.ts's unquoteIds makes this
      // safe): a router bound via `documents:`'s `router:` (rather than
      // left for the `{address}` template to answer) is the ONLY path for
      // every row of the sheet, mapper and store alike — judge.ts's
      // documentFor takes no other branch once a sheet names a router, so a
      // router that only ever answered Mappers rows would leave every
      // store-level row unanswered the moment a project wires it that way.
      // The mappers category can sit at path[0] (one store on the sheet) or
      // one level deeper ([store, "Mappers", mapper], several stores) — see
      // nestedMapperAddress's own comment on why the mapper name itself is
      // read off the LAST segment rather than a fixed index.
      //
      // A row with NO item.address (materialized from a dictionary, nothing
      // ever wrote it anywhere) falls back to its own bare key, exactly the
      // fallback judge.ts's own `{address}` template applies (`item.address
      // ?? item.target.key`) — never `undefined`. Skipping this fallback
      // would silently regress every default-in-force row of a sheet bound
      // via `router:`: a row whose miss MEANS "the product's own default
      // applies" (judge.ts's own answerByDocument, `kind ===
      // "default-in-force"`) would turn into a silent not_run instead,
      // because `route()` returning undefined here is indistinguishable to
      // documentFor from "no document answers this row at all".
      if (!item.target.path.includes(binding.mappers_category)) {
        return { document: binding.document, address: item.address ?? item.target.key, idFields: ["name"] };
      }
      const ldapComponentName = ldapComponentNameOf(item, binding);
      if (ldapComponentName === undefined) return undefined;
      const address = nestedMapperAddress(item, ldapComponentName);
      return address === undefined ? undefined : { document: binding.document, address, idFields: ["name"] };
    },
  };
  registerDocumentRouter(router);
  return router;
}

// "The readiness endpoint answered, and nothing under it is DOWN" contains no
// project fact at all — no expectation to compare against, nothing this
// deployment decided. It is what `/health/ready` MEANS, so it is the product's
// verdict and not a rule anyone should have to write again.
export function registerKeycloakRules(binding: { health_ready?: string; sheet?: string }): void {
  const id = binding.health_ready;
  if (id === undefined) return;
  registerProbeRule({
    name: "keycloak.health-ready",
    covers: (x) => x === id,
    ...(binding.sheet === undefined ? {} : { sheet: binding.sheet }),
    verdict: (probe) => {
      const said = readyReport(probe.text);
      if (said.http !== 200) return { ok: false, why: `HTTP ${said.http ?? "—"}` };
      return said.down ? { ok: false, why: "ready but a check reports DOWN" } : { ok: true };
    },
  });
}
