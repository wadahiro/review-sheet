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

import { registerFunctionalChannel, type FunctionalAnswer } from "../channel.js";

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

// The three things that make a page the LOGIN page rather than an error page
// wearing the same theme.
const FORM = 3;

const firstWith = (hosts: Record<string, unknown>, has: (h: Held) => boolean): [string, Held] | undefined => {
  for (const [host, held] of Object.entries(hosts)) if (has(held as Held)) return [host, held as Held];
  return undefined;
};

function loginAnswer(id: string, hosts: Record<string, unknown>, sheet: string): FunctionalAnswer | undefined {
  const from = firstWith(hosts, (h) => (h.login ?? []).length > 0);
  if (from === undefined) return { status: "not_run", reason: "ログイン画面を取得できていない" };
  const [host, held] = from;
  const pages = (held.login ?? []).filter((p) => p.reason === undefined && p.error === undefined);
  const documents = pages
    .filter((p) => typeof p.html === "string" && p.html !== "")
    .map((p) => ({ host, command: `GET ${p.url}`, text: p.html!, sheet, component: p.realm }));
  if (pages.length === 0) {
    return {
      status: "not_run",
      reason: (held.login ?? []).map((p) => `${p.realm}: ${p.reason ?? p.error}`).join(" / "),
      documents,
    };
  }
  const cite = { host, command: `GET ${pages[0]!.url}` };

  if (id.endsWith("assets")) {
    // A theme can be SELECTED and still broken: the resource version in every
    // asset URL is re-minted when the themes are rebuilt, so a jar that was not
    // redeployed leaves the page pointing at CSS that 404s and renders bare.
    const bad = pages.flatMap((p) =>
      (p.assets ?? []).filter((a) => a.status !== 200).map((a) => `${p.realm} ${a.path} → ${a.status}`)
    );
    const total = pages.reduce((n, p) => n + (p.assets ?? []).length, 0);
    return {
      status: bad.length === 0 ? "pass" : "fail",
      detail: `ログイン画面が参照する ${total} 件（${pages.length} レルム）`,
      ...(bad.length === 0 ? {} : { reason: bad.slice(0, 3).join(" / ") }),
      evidence: cite,
      documents,
    };
  }

  // …and the page itself has to BE the login page before its theme means
  // anything.
  const broken = pages.filter((p) => p.status !== 200 || (p.form ?? []).length < FORM);
  if (broken.length > 0) {
    return {
      status: "fail",
      detail: `GET ${pages[0]!.url}`,
      reason: broken
        .map((p) => `${p.realm}: HTTP ${p.status}${(p.form ?? []).length < FORM ? "、ログインフォームが無い" : ""}`)
        .join(" / "),
      evidence: cite,
      documents,
    };
  }
  // A realm's `loginTheme` says which theme was CHOSEN. Where it states none,
  // the product's own default applies and there is nothing to be "as designed":
  // the served theme is REPORTED and the item says so rather than inventing an
  // expectation.
  const declared = pages.filter((p) => p.declared_theme != null);
  if (declared.length === 0) {
    return {
      status: "not_run",
      reason: `どのレルムも loginTheme を指定していない（製品既定 ${[...new Set(pages.map((p) => String(p.theme)))].join(", ")} が配信されている）`,
      documents,
    };
  }
  const wrong = declared.filter((p) => p.theme !== p.declared_theme);
  return {
    status: wrong.length === 0 ? "pass" : "fail",
    detail: `GET ${pages[0]!.url}（${declared.length} レルム）`,
    ...(wrong.length === 0
      ? {}
      : { reason: wrong.map((p) => `${p.realm}: ${JSON.stringify(p.theme)} が配信されている、指定は ${p.declared_theme}`).join(" / ") }),
    evidence: cite,
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
