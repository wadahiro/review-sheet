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

import { registerFunctionalChannel, registerProbeRule, type FunctionalAnswer } from "../channel.js";

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
