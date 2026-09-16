// A PRODUCT plugin: what Keycloak's own answers mean.
//
// The knowledge here is the product's, not one project's — a login page names
// its theme in every asset URL in every project that runs Keycloak — so it is
// held once, and tested once, the way the httpd parser has been since the
// beginning. What a PROJECT supplies is which of its items the plugin answers.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerKeycloakChannels, registerKeycloakLdapRouter, effectiveConfig, isProductDefault, lineOfEffective,
  readyReport, clusterMembers, issuerOf, issuerFor, issuerMatches, realmAsked, configuredHostname,
  stickySessionNode, hasSessionCookie, registerKeycloakRules,
} from "../src/channels/keycloak";
import { listFunctionalChannels, listDocumentRouters, listProbeRules } from "../src/channel";
import { CHANNEL_WORDS } from "../src/channel-words";
import type { TestItem } from "../src/testplan";

const clear = (): void => {
  for (const key of ["review-sheet.functional-channels.v1", "review-sheet.document-routers.v1"]) {
    const arr = (globalThis as Record<symbol, unknown>)[Symbol.for(key)] as unknown[];
    if (Array.isArray(arr)) arr.length = 0;
  }
};
beforeEach(() => {
  clear();
  registerKeycloakChannels({ sheet: "realm", login_page: "login-page", login_assets: "login-assets", ldap_connection: "ldap" });
});
const channel = () => listFunctionalChannels()[0]!;
const hosts = (held: unknown) => ({ web01: held });

const page = (over: Record<string, unknown> = {}) => ({
  realm: "poc",
  url: "https://sso/realms/poc/…",
  status: 200,
  form: ["kc-form-login", 'name="username"', 'name="password"'],
  theme: "keycloak.v2",
  declared_theme: null,
  assets: [{ path: "/resources/x/login/keycloak.v2/css/styles.css", status: 200 }],
  html: "<html>…</html>",
  ...over,
});

describe("what a login page means", () => {
  // A realm's loginTheme says which theme was CHOSEN. Where it states none, the
  // product's default applies and there is nothing to be "as designed".
  it("reports the served theme where the realm declares none, rather than inventing an expectation", () => {
    const got = channel().answer("login-page", hosts({ login: [page()] }), "stg")!;
    expect(got.status).toBe("not_run");
    expect(got.reason).toContain("loginTheme");
  });

  it("fails when the theme served is not the one the realm declares", () => {
    const got = channel().answer("login-page", hosts({ login: [page({ declared_theme: "corp" })] }), "stg")!;
    expect(got.status).toBe("fail");
    expect(got.reason).toContain("corp");
  });

  // The page has to BE the login page before its theme means anything.
  it("fails a page that answers but carries no login form", () => {
    const got = channel().answer("login-page", hosts({ login: [page({ form: ["kc-form-login"], declared_theme: "corp" })] }), "stg")!;
    expect(got.status).toBe("fail");
    // …and says WHICH marks are missing, which a count never could.
    expect(got.reason).toBe(CHANNEL_WORDS.en.loginPageBad("poc", "200", ['name="username"', 'name="password"']));
  });

  // A theme can be SELECTED and still broken: the resource version is re-minted
  // when the themes are rebuilt, so a stale jar leaves the page pointing at CSS
  // that 404s and rendering bare.
  it("fails when something the page references cannot be fetched", () => {
    const broken = page({ assets: [{ path: "/resources/x/login/corp/css/styles.css", status: 404 }] });
    const got = channel().answer("login-assets", hosts({ login: [broken] }), "stg")!;
    expect(got.status).toBe("fail");
    expect(got.reason).toContain("404");
  });

  it("carries the page it read as evidence", () => {
    const got = channel().answer("login-assets", hosts({ login: [page()] }), "stg")!;
    expect(got.documents?.[0]?.text).toBe("<html>…</html>");
    expect(got.documents?.[0]?.sheet).toBe("realm");
  });
});

describe("what a directory test means", () => {
  const provider = (over: Record<string, unknown> = {}) => ({
    realm: "poc",
    name: "corp",
    enabled: true,
    result: { testConnection: { ok: true }, testAuthentication: { ok: true } },
    ...over,
  });

  it("passes when every enabled provider answers both questions", () => {
    expect(channel().answer("ldap", hosts({ ldap: [provider()] }), "stg")!.status).toBe("pass");
  });

  // The product's OWN word for why is the whole value of asking it.
  it("fails with the product's own reason", () => {
    const bad = provider({ result: { testConnection: { ok: false, message: '{"errorMessage":"UnknownHost"}' }, testAuthentication: { ok: false } } });
    const got = channel().answer("ldap", hosts({ ldap: [bad] }), "stg")!;
    expect(got.status).toBe("fail");
    expect(got.reason).toContain("UnknownHost");
  });

  // A provider this environment DISABLED is not asked: a failed bind against a
  // directory nobody talks to is not a finding.
  it("does not judge a provider this environment disabled", () => {
    const got = channel().answer("ldap", hosts({ ldap: [provider({ enabled: false })] }), "stg")!;
    expect(got.status).toBe("not_run");
    expect(got.reason).toBe(CHANNEL_WORDS.en.ldapDisabledHere("corp"));
  });
});

// The ids are the PROJECT's: a product plugin cannot know what a project called
// its items, and an unbound id must not be claimed by accident.
describe("what the plugin claims", () => {
  it("is only what the project bound to it", () => {
    expect(channel().covers("login-page")).toBe(true);
    expect(channel().covers("time-synced")).toBe(false);
  });
});

// What the product says it is USING, and who decided each value.
describe("the effective configuration the product reports", () => {
  const OUT = [
    "Current Mode: production",
    "Current Configuration:",
    "\tkc.db =  postgres (classpath application.properties)",
    "\tkc.hostname =  https://sso.example (SysPropConfigSource)",
    "\tkc.health-enabled =  true (Persisted)",
    "",
  ].join("\n");

  it("reads each key with its value and the source that decided it", () => {
    expect([...effectiveConfig(OUT)]).toEqual([
      ["db", { value: "postgres", source: "classpath application.properties" }],
      ["hostname", { value: "https://sso.example", source: "SysPropConfigSource" }],
      ["health-enabled", { value: "true", source: "Persisted" }],
    ]);
  });

  // Only the product's own bundled properties are the product's default. Every
  // other source names somebody who SET the value — a build option baked in by
  // `kc.sh build` is still a decision, not a default.
  it("counts only the product's own properties as its default", () => {
    expect(isProductDefault("classpath application.properties")).toBe(true);
    // The deployment's OWN file is a source like any other: the product reports
    // it by basename, and a value from there was set by this project.
    expect(isProductDefault("keycloak.conf")).toBe(false);
    expect(isProductDefault("Persisted")).toBe(false);
    expect(isProductDefault("system property")).toBe(false);
  });

  // `Derived` is Keycloak computing a value FROM other options (measured:
  // http-access-log-file-name/-suffix, derived from
  // http-access-log-file-enabled et al.) with no independent user input of its
  // own — if the deriving option WERE overridden, that option's own row shows
  // it, so counting `Derived` here loses no coverage.
  it("counts a derived value as a product default too — it has no override of its own", () => {
    expect(isProductDefault("Derived")).toBe(true);
  });

  it("points at the line a key was reported at, and nowhere for one it does not report", () => {
    expect(lineOfEffective(OUT, "hostname")).toBe(4);
    expect(lineOfEffective(OUT, "http-port")).toBeUndefined();
  });
});

// What the product says about itself while it runs. The READING is the
// product's; what the answer should BE is the project's, so only the reading is
// here.
describe("what the running product reports about itself", () => {
  it("reads the readiness endpoint's status and the checks under it", () => {
    const up = 'HTTP 200 OK\n{\n  "status": "UP",\n  "checks": [{ "name": "Database", "status": "UP" }]\n}';
    expect(readyReport(up)).toEqual({ http: 200, down: false });
    // A 200 with one check DOWN is not a shape the product is meant to produce,
    // which is exactly why it is read rather than assumed away.
    expect(readyReport(up.replace('"status": "UP",', '"status": "DOWN",'))).toEqual({ http: 200, down: true });
    expect(readyReport("HTTP 503 Service Unavailable")).toEqual({ http: 503, down: false });
    expect(readyReport(null)).toEqual({ down: false });
  });

  it("reads how many members the cluster last logged, and nothing where it logged none", () => {
    const view = "Sep 09 00:17:21 node kc.sh[1]: ISPN000094: Received new cluster view for channel ISPN: [node1|1] (2) [node1, node2]";
    expect(clusterMembers(view)).toBe(2);
    expect(clusterMembers("no such line in the journal")).toBeUndefined();
  });

  it("reads the issuer a realm publishes, and says what it would be", () => {
    expect(issuerOf('{"issuer":"https://sso.example.com/realms/app","authorization_endpoint":"…"}')).toBe(
      "https://sso.example.com/realms/app"
    );
    expect(issuerOf("<html>404</html>")).toBeUndefined();
    // The product's own rule, applied to two facts only the project has.
    expect(issuerFor("https://sso.example.com", "app")).toBe("https://sso.example.com/realms/app");
    // …and a trailing slash on the configured hostname is not a difference.
    expect(issuerFor("https://sso.example.com/", "app")).toBe("https://sso.example.com/realms/app");
  });
});

// A login page is fetched through the node's OWN front end, so a proxy broken
// on the second node serves a page that never renders — and an answer read off
// the first node has not looked at it.
describe("a login page on more than one node", () => {
  const ok = { realm: "app", url: "https://a/realms/app/…", status: 200, form: ["kc-form-login", 'name="username"', 'name="password"'], theme: "corp", declared_theme: "corp", assets: [] };
  it("fails when one node's page is broken, and names that node", () => {
    const got = channel().answer(
      "login-page",
      { web01: { login: [ok] }, web02: { login: [{ ...ok, url: "https://b/realms/app/…", status: 502, form: [] }] } },
      "stg"
    )!;
    expect(got.status).toBe("fail");
    expect(got.reason).toContain("web02");
    expect(got.evidence?.host).toBe("web02");
    // …and the node is named only because more than one answered: on a single
    // node the realm alone is what a reader is looking at.
    const one = channel().answer("login-page", { web01: { login: [{ ...ok, status: 502, form: [] }] } }, "stg")!;
    expect(one.reason).toStartWith("app:");
  });

  it("carries every node's page, not the first node's", () => {
    const got = channel().answer(
      "login-page",
      { web01: { login: [{ ...ok, html: "a" }] }, web02: { login: [{ ...ok, html: "b" }] } },
      "stg"
    )!;
    expect(got.documents?.map((d) => [d.host, d.text])).toEqual([
      ["web01", "a"],
      ["web02", "b"],
    ]);
  });
});

// The gap `registerProductAddress`'s `{address}` template cannot close: a
// mapper row's key has `split.nest` (keytransform.ts) folding the mapper's
// identity INTO it (`<mapperName>.<providerId>.<realKey>`), for which no
// placeholder template can ever spell the address back out — for an
// authored row exactly as much as a materialized one. Real shapes below are
// taken verbatim from a project's own test-plan output (plan.json), not
// invented.
describe("where a user-federation row sits in a reconstructed realm document", () => {
  const bind = () =>
    registerKeycloakLdapRouter({
      document: "userFederation",
      sheet: "federation",
      ldap_component: "corp-ldap",
      mappers_category: "Mappers",
    });

  const item = (over: Partial<TestItem>): TestItem =>
    ({
      target: { sheet: "federation", path: ["Mappers", "sAMAccountName"], key: "x", instance: "local" },
      unit: "u",
      kind: "default-in-force",
      decider: "product-default",
      ...over,
    }) as TestItem;

  it("registers itself, once, under a name naming the sheet it is bound to", () => {
    bind();
    expect(listDocumentRouters().map((r) => r.name)).toEqual(["keycloak-ldap:federation"]);
  });

  it("does not answer a row of a different sheet", () => {
    const router = bind();
    expect(router.route(item({ target: { sheet: "other", path: [], key: "k", instance: "local" } }))).toBeUndefined();
  });

  // A materialized mapper row's own field, address-built the same way
  // check-live.mjs's matchMapperItem built it by hand — `providerId` is a
  // plain field of the mapper, so it attaches with a dot.
  it("addresses a mapper's own providerId field", () => {
    const router = bind();
    expect(
      router.route(item({ target: { sheet: "federation", path: ["Mappers", "sAMAccountName"], key: "sAMAccountName.user-attribute-ldap-mapper.providerId", instance: "local" } }))
    ).toEqual({
      document: "userFederation",
      address:
        'components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name=sAMAccountName].providerId',
      idFields: ["name"],
    });
  });

  // A materialized config.* row: the real key already carries its own
  // bracket form (config["ldap.attribute"][0]) and attaches with a dot too —
  // the extra bracket wrap is only for keys the parser has no bracket form
  // for yet (a bare dotted key like is.mandatory.in.ldap).
  it("addresses a mapper's config.* field without double-wrapping the bracket it already has", () => {
    const router = bind();
    expect(
      router.route(
        item({
          target: {
            sheet: "federation",
            path: ["Mappers", "sAMAccountName"],
            key: 'sAMAccountName.user-attribute-ldap-mapper.config["ldap.attribute"][0]',
            instance: "local",
          },
        })
      )?.address
    ).toBe(
      'components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name=sAMAccountName].config["ldap.attribute"][0]'
    );
  });

  // A bare dotted key with no bracket form of its own gets one from the
  // router, so extractFile reads it as ONE key and not a third nesting level.
  // A MATERIALIZED mapper row's key is bare — never `config[...]`-wrapped,
  // because nothing extracted it from a file; a dictionary names its own
  // mapper entries this way (`is.mandatory.in.ldap`, `attribute.force.default`).
  // It is still a `config` entry of the mapper on the API side — there is no
  // other place for it — so it is addressed under `.config[...][0]`, the
  // same shape extractFile gives an AUTHORED row's equivalent key. An
  // authored mapper key already carries `config[`; a materialized one never
  // does — the two never collide.
  it("routes a bare materialized key under config[...][0], the same shape an authored key already has", () => {
    const router = bind();
    expect(
      router.route(
        item({
          target: { sheet: "federation", path: ["Mappers", "sAMAccountName"], key: "sAMAccountName.user-attribute-ldap-mapper.is.mandatory.in.ldap", instance: "local" },
        })
      )?.address
    ).toBe(
      'components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name=sAMAccountName].config["is.mandatory.in.ldap"][0]'
    );
  });

  // An AUTHORED mapper row (`kind: value`, a real `item.address`) is
  // CONSTRUCTED too, from its key, exactly like a materialized one — never
  // read off `item.address`. Construction and `item.address` name the same
  // address once both are read through judge.ts's own `unquoteIds`; this
  // one is the case that would NOT agree without it — Keycloak's own default
  // mapper name has a space, so `item.address` carries it quoted
  // (`[name="last name"]`) while this construction spells it bare. A router
  // reachable only through `judgeFiles` (which normalizes both sides before
  // comparing) can rely on that; one wired into a caller that compares raw
  // strings cannot, which is exactly why this router does not read
  // `item.address` at all.
  it("constructs an authored mapper row's address too, unquoted", () => {
    const router = bind();
    expect(
      router.route(
        item({
          kind: "value",
          address:
            'components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name="last name"].config["ldap.attribute"][0]',
          target: { sheet: "federation", path: ["Mappers", "last name"], key: 'last name.user-attribute-ldap-mapper.config["ldap.attribute"][0]', instance: "local" },
        })
      )?.address
    ).toBe(
      'components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name=last name].config["ldap.attribute"][0]'
    );
  });

  // A STORE's own row (General/Settings/Cache Settings/…) is not under the
  // mappers category, so its key carries no mapper prefix to construct
  // from — it is answered from its own `item.address` instead, which for a
  // store's own field IS the correct — and only — address. This is what
  // lets a project bind the WHOLE sheet through `documents:`'s `router:`
  // (judge.ts takes no other branch once a sheet names one) without losing
  // every store-level row the moment it does.
  it("answers a store's own row from its own item.address, not by constructing one", () => {
    const router = bind();
    expect(
      router.route(item({ kind: "value", address: "irrelevant", target: { sheet: "federation", path: ["General"], key: "kcr_ldap_connection_url", instance: "local" } }))
    ).toEqual({ document: "userFederation", address: "irrelevant", idFields: ["name"] });
  });

  // A store row with no `item.address` (a MATERIALIZED row — nothing ever
  // wrote it anywhere) falls back to its own bare key, exactly the fallback
  // judge.ts's `{address}` template applies (`item.address ?? item.target.key`).
  // Never `undefined`: a router that declined here would turn documentFor's
  // "the document was asked and the key was absent" (default-in-force's own
  // pass, judge.ts's answerByDocument) into an indistinguishable "no document
  // answers this row at all".
  it("falls back to a store row's own bare key when it has no item.address", () => {
    const router = bind();
    expect(
      router.route(item({ target: { sheet: "federation", path: ["General"], key: "kcr_ldap_connection_url", instance: "local" } }))
    ).toEqual({ document: "userFederation", address: "kcr_ldap_connection_url", idFields: ["name"] });
  });

  // The mapper name is the LAST path segment, not a fixed index — a sheet
  // with several stores nests it one level deeper ([store, "Mappers", name])
  // and the same construction still finds it.
  it("finds the mapper name at the end of the category path regardless of nesting depth", () => {
    const router = bind();
    expect(
      router.route(
        item({
          target: { sheet: "federation", path: ["corp-ldap", "Mappers", "sAMAccountName"], key: "sAMAccountName.user-attribute-ldap-mapper.providerId", instance: "local" },
        })
      )?.address
    ).toContain("[name=sAMAccountName]");
  });

  // A key that does not start with "<mapperName>." is a shape this router
  // does not recognise (a malformed nest, or a sheet whose category does not
  // actually name the mapper) — left unanswered rather than guessed at, the
  // same "a row the table does not name gets no answer" rule aws-rds.ts
  // documents. Silent to this router; LOUD in the plan (the row falls back
  // to not_run, which a verdict diff against a working baseline surfaces).
  it("leaves an unrecognised key shape unanswered rather than guessing", () => {
    const router = bind();
    expect(
      router.route(item({ target: { sheet: "federation", path: ["Mappers", "sAMAccountName"], key: "unrelated.key", instance: "local" } }))
    ).toBeUndefined();
  });
});

// A sheet with SEVERAL LDAP stores (`split: { by: name }`) puts the store at
// path[0], which two stores of one product routinely name their mappers
// alike — "username", "email", "last name" are the product's own defaults,
// reused by every store an admin sets up. `ldap_component` is a single fixed
// string and cannot tell them apart; the router must read the store off the
// row itself instead.
describe("where a user-federation row sits, with several LDAP stores on one sheet", () => {
  const bind = () =>
    registerKeycloakLdapRouter({
      document: "userFederation",
      sheet: "multi-federation",
      mappers_category: "Mappers",
    });

  const item = (over: Partial<TestItem>): TestItem =>
    ({
      target: { sheet: "multi-federation", path: ["corp-ldap", "Mappers", "username"], key: "username.user-attribute-ldap-mapper.providerId", instance: "local" },
      unit: "u",
      kind: "default-in-force",
      decider: "product-default",
      ...over,
    }) as TestItem;

  it("addresses a mapper under the FIRST store using that store's own name", () => {
    const router = bind();
    expect(router.route(item({}))?.address).toBe(
      'components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name=username].providerId'
    );
  });

  // The same mapper NAME, under the OTHER store — must resolve under ITS OWN
  // store, never fall back to the first-seen one. A router that ignored
  // path[0] here would silently address a partner store's row under the
  // corporate store, reading one store's configuration as if it were the
  // other's: a confident wrong verdict, not a missing one.
  it("addresses the SAME mapper name under a SECOND store using that store's own name, not the first's", () => {
    const router = bind();
    expect(
      router.route(
        item({
          target: { sheet: "multi-federation", path: ["partner-ldap", "Mappers", "username"], key: "username.user-attribute-ldap-mapper.providerId", instance: "local" },
        })
      )?.address
    ).toBe(
      'components["org.keycloak.storage.UserStorageProvider"][name=partner-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name=username].providerId'
    );
  });

  // A store's own row (General/Settings) still carries the store at path[0]
  // but is outside the mappers category, so it is answered from its own
  // `item.address` here too, unchanged from the single-store case — the
  // store axis at path[0] plays no part in this branch, since the row
  // already carries its own correct address.
  it("answers a store's own row on a multi-store sheet from its own item.address too", () => {
    const router = bind();
    expect(
      router.route(item({ kind: "value", address: "irrelevant", target: { sheet: "multi-federation", path: ["corp-ldap", "General"], key: "kcr_ldap_connection_url", instance: "local" } }))
    ).toEqual({ document: "userFederation", address: "irrelevant", idFields: ["name"] });
  });
});

// A single-store sheet whose project OMITS `ldap_component` (rather than
// naming the wrong LDAP store, which nothing here can detect) has no fact
// anywhere the router can address a mapper row with — path[0] is the
// mappers category, not a store name, on a single-store sheet. The same "no
// address, no answer" rule as an unrecognised key shape, never a guess.
describe("where a single-store sheet's binding omits ldap_component", () => {
  it("leaves a mapper row unanswered rather than guessing a store name", () => {
    const router = registerKeycloakLdapRouter({ document: "userFederation", sheet: "no-component-bound", mappers_category: "Mappers" });
    expect(
      router.route({
        target: { sheet: "no-component-bound", path: ["Mappers", "sAMAccountName"], key: "sAMAccountName.user-attribute-ldap-mapper.providerId", instance: "local" },
        unit: "u",
        kind: "default-in-force",
        decider: "product-default",
      } as TestItem)
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The issuer a realm publishes, and why the comparison is parsed.

describe("comparing a published issuer against the expected one", () => {
  const WANT = "https://sso.example.com/realms/main";

  it("accepts the same URL written differently", () => {
    expect(issuerMatches("https://sso.example.com/realms/main", WANT)).toBe(true);
    expect(issuerMatches("https://sso.example.com/realms/main/", WANT)).toBe(true);
    expect(issuerMatches("https://SSO.Example.com/realms/main", WANT)).toBe(true);
    expect(issuerMatches("https://sso.example.com:443/realms/main", WANT)).toBe(true);
  });

  // The reason this is parsed and not a substring search. Each of these
  // CONTAINS the expected hostname and is a realm published under somebody
  // else's name; a token minted by any of them would be validated against a
  // host this deployment does not own.
  it("refuses a host that merely contains the expected one", () => {
    expect(issuerMatches("https://sso.example.com.attacker.io/realms/main", WANT)).toBe(false);
    expect(issuerMatches("https://attacker.io/?x=https://sso.example.com/realms/main", WANT)).toBe(false);
    expect(issuerMatches("https://evil.com/sso.example.com/realms/main", WANT)).toBe(false);
    expect(issuerMatches("https://not-sso.example.com/realms/main", WANT)).toBe(false);
  });

  // Scheme and port are part of who answers. An issuer served over http is not
  // the https one, whatever the hostname says.
  it("counts the scheme and the port as part of the origin", () => {
    expect(issuerMatches("http://sso.example.com/realms/main", WANT)).toBe(false);
    expect(issuerMatches("https://sso.example.com:8443/realms/main", WANT)).toBe(false);
  });

  it("counts the realm path too", () => {
    expect(issuerMatches("https://sso.example.com/realms/other", WANT)).toBe(false);
    expect(issuerMatches("https://sso.example.com/auth/realms/main", WANT)).toBe(false);
  });

  // Something that will not parse is not equal to anything. An issuer this
  // cannot read is one it cannot vouch for.
  it("refuses what it cannot parse", () => {
    expect(issuerMatches("sso.example.com/realms/main", WANT)).toBe(false);
    expect(issuerMatches("", WANT)).toBe(false);
    expect(issuerMatches(undefined, WANT)).toBe(false);
    expect(issuerMatches(WANT, undefined)).toBe(false);
  });

  // A run asks several realms and each answers with its own issuer, so the
  // answer is judged against the realm the REQUEST named.
  it("reads the realm off the request", () => {
    expect(realmAsked("GET https://sso.example.com/realms/main/.well-known/openid-configuration")).toBe("main");
    expect(realmAsked("https://sso.example.com/realms/other/protocol/openid-connect/certs")).toBe("other");
    expect(realmAsked("GET https://sso.example.com/health/ready")).toBeUndefined();
  });
});

describe("the issuer rule a project binds", () => {
  const ctx = { host: "h1", held: {}, observedHosts: 1 };
  const body = (issuer: string) => JSON.stringify({ issuer });
  const ruleFor = (id: string, base?: string) => {
    registerKeycloakRules({ issuer_external: id, ...(base === undefined ? {} : { issuer_base: base }), sheet: "sso" });
    const r = listProbeRules().find((x) => x.covers(id));
    if (r === undefined) throw new Error("no rule covers " + id);
    return r;
  };
  const ASKED = "GET https://sso.example.com/realms/main/.well-known/openid-configuration";

  it("passes the issuer the base and the asked realm make", () => {
    const v = ruleFor("sso.issuer.1", "https://sso.example.com").verdict(
      { how: ASKED, text: body("https://sso.example.com/realms/main") },
      ctx
    );
    expect(v.ok).toBe(true);
  });

  // The judgement this whole rule exists for: hostname-strict, so a realm
  // publishing an issuer under a lookalike host fails.
  it("fails a lookalike host", () => {
    const v = ruleFor("sso.issuer.2", "https://sso.example.com").verdict(
      { how: ASKED, text: body("https://sso.example.com.attacker.io/realms/main") },
      ctx
    );
    expect(v.ok).toBe(false);
    expect(v.why).toContain("attacker.io");
  });

  // A common real defect: hostname left at the node's own name, so every token
  // names a host no client can reach.
  it("fails an issuer still naming the node", () => {
    const v = ruleFor("sso.issuer.3", "https://sso.example.com").verdict(
      { how: ASKED, text: body("https://node1.internal:8443/realms/main") },
      ctx
    );
    expect(v.ok).toBe(false);
  });

  // With no base declared nothing here knows what the issuer should have been.
  // Saying so is the answer; passing anything would be a rule that cannot fail.
  it("declines to judge when no base is declared", () => {
    const v = ruleFor("sso.issuer.4").verdict({ how: ASKED, text: body("https://anything/realms/main") }, ctx);
    expect(v.ok).toBe(null);
    expect(v.why).toContain("issuer_base");
  });

  // A run asks several realms through the same item, and each answers with its
  // own issuer. Judging every answer against one realm passes the wrong pairing
  // — including the case that matters: a realm publishing ANOTHER realm's
  // issuer.
  it("judges each answer against the realm its own request named", () => {
    const rule = ruleFor("sso.issuer.6", "https://sso.example.com");
    const other = "GET https://sso.example.com/realms/other/.well-known/openid-configuration";
    expect(rule.verdict({ how: other, text: body("https://sso.example.com/realms/other") }, ctx).ok).toBe(true);
    expect(rule.verdict({ how: other, text: body("https://sso.example.com/realms/main") }, ctx).ok).toBe(false);
  });

  it("fails a response carrying no issuer at all", () => {
    const v = ruleFor("sso.issuer.5", "https://sso.example.com").verdict({ how: ASKED, text: "502 Bad Gateway" }, ctx);
    expect(v.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The session cookie, and the node name the product appends to it.

describe("what AUTH_SESSION_ID says about the deployment", () => {
  it("finds the node identifier the sticky-session encoder appended", () => {
    expect(stickySessionNode("Set-Cookie: AUTH_SESSION_ID=abc123def.node1; Path=/; HttpOnly")).toBe("node1");
  });

  it("finds none when the session id stands alone", () => {
    expect(stickySessionNode("Set-Cookie: AUTH_SESSION_ID=abc123def; Path=/; HttpOnly")).toBeUndefined();
  });

  // A dot in the node's own name belongs to the node, not to a second field.
  it("keeps a dotted node name whole", () => {
    expect(stickySessionNode("AUTH_SESSION_ID=abc.node1.dc1")).toBe("node1.dc1");
  });

  // Carrying no cookie is not the same as carrying one with no node in it, and
  // a verdict that confuses them reports a request that was never given a
  // session as a deployment that is not leaking node names.
  it("tells no cookie from a cookie with no node", () => {
    expect(hasSessionCookie("HTTP/1.1 200 OK\nContent-Type: text/html")).toBe(false);
    expect(hasSessionCookie("Set-Cookie: AUTH_SESSION_ID=abc; Path=/")).toBe(true);
    expect(stickySessionNode("HTTP/1.1 200 OK")).toBeUndefined();
  });
});

describe("the sticky-session rule a project binds", () => {
  const ctx = { host: "h1", held: {}, observedHosts: 1 };
  const ruleFor = (id: string) => {
    registerKeycloakRules({ sticky_session_cookie: id, sheet: "sso" });
    const r = listProbeRules().find((x) => x.covers(id));
    if (r === undefined) throw new Error("no rule covers " + id);
    return r;
  };

  it("passes a cookie that names no node", () => {
    const v = ruleFor("sso.sticky.1").verdict({ text: "Set-Cookie: AUTH_SESSION_ID=abc; Path=/; HttpOnly" }, ctx);
    expect(v.ok).toBe(true);
  });

  it("fails a cookie that publishes the node name", () => {
    const v = ruleFor("sso.sticky.2").verdict({ text: "Set-Cookie: AUTH_SESSION_ID=abc.node1; Path=/" }, ctx);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("node1");
  });

  it("declines to judge a response that was given no session", () => {
    const v = ruleFor("sso.sticky.3").verdict({ text: "HTTP/1.1 302 Found\nLocation: /" }, ctx);
    expect(v.ok).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// …and where the expected base comes from when it is not a literal.
//
// A deployment whose hostname differs per environment cannot declare one
// literal, and writing one per environment into the build would be a second
// copy of a value the observation already carries. So the binding names the
// FILE — a path, not a value — and the product's own option in it says what
// this node will publish.

describe("the hostname a deployed keycloak.conf sets", () => {
  it("reads the product's own option", () => {
    expect(configuredHostname("db=postgres\nhostname=https://sso.example.com\nhostname-strict=true\n")).toBe(
      "https://sso.example.com"
    );
  });

  // A commented-out setting is not a setting. Comparing against one would judge
  // the product against a value it never saw.
  it("ignores a commented-out hostname", () => {
    expect(configuredHostname("#hostname=https://old.example.com\nhostname=https://sso.example.com\n")).toBe(
      "https://sso.example.com"
    );
    expect(configuredHostname("# hostname=https://old.example.com\n")).toBeUndefined();
    expect(configuredHostname("!hostname=https://old.example.com\n")).toBeUndefined();
  });

  // `hostname-strict` is a different option and must not answer for `hostname`.
  it("does not answer with a longer option's value", () => {
    expect(configuredHostname("hostname-strict=true\nhostname-backchannel-dynamic=false\n")).toBeUndefined();
  });

  it("takes the last of a key written twice", () => {
    expect(configuredHostname("hostname=https://a.example.com\nhostname=https://b.example.com\n")).toBe(
      "https://b.example.com"
    );
  });
});

describe("the issuer rule reading its expectation off the host", () => {
  const ctx = (conf: string | null) => ({ host: "h1", held: { files: { "/opt/keycloak/conf/keycloak.conf": conf } }, observedHosts: 1 });
  const ASKED = "GET https://sso.example.com/realms/main/.well-known/openid-configuration";
  const body = (issuer: string) => JSON.stringify({ issuer });
  const ruleFor = (id: string, extra: Record<string, string>) => {
    registerKeycloakRules({ issuer_external: id, sheet: "sso", ...extra });
    const r = listProbeRules().find((x) => x.covers(id));
    if (r === undefined) throw new Error("no rule covers " + id);
    return r;
  };
  const CONF = "hostname=https://sso.example.com\nhostname-strict=true\n";

  it("compares against what the deployed file says this node publishes", () => {
    const rule = ruleFor("sso.issuer.conf.1", { issuer_conf: "/opt/keycloak/conf/keycloak.conf" });
    expect(rule.verdict({ how: ASKED, text: body("https://sso.example.com/realms/main") }, ctx(CONF)).ok).toBe(true);
    expect(rule.verdict({ how: ASKED, text: body("https://node1.internal:8443/realms/main") }, ctx(CONF)).ok).toBe(false);
  });

  // The same host's own file, so each environment brings its own expectation
  // and the build holds no copy of any of them.
  it("follows the file from one environment to the next", () => {
    const rule = ruleFor("sso.issuer.conf.2", { issuer_conf: "/opt/keycloak/conf/keycloak.conf" });
    const stg = "hostname=https://sso-stg.example.com\n";
    const asked = "GET https://sso-stg.example.com/realms/main/.well-known/openid-configuration";
    expect(rule.verdict({ how: asked, text: body("https://sso-stg.example.com/realms/main") }, ctx(stg)).ok).toBe(true);
    expect(rule.verdict({ how: asked, text: body("https://sso.example.com/realms/main") }, ctx(stg)).ok).toBe(false);
  });

  // An expectation somebody wrote down outranks one derived from the host.
  it("lets a declared base win over the file", () => {
    const rule = ruleFor("sso.issuer.conf.3", {
      issuer_base: "https://sso.example.com",
      issuer_conf: "/opt/keycloak/conf/keycloak.conf",
    });
    const wrong = "hostname=https://node1.internal:8443\n";
    expect(rule.verdict({ how: ASKED, text: body("https://sso.example.com/realms/main") }, ctx(wrong)).ok).toBe(true);
  });

  // Each of the three ways there is no expectation is its own answer, and none
  // of them is a failing issuer.
  it("declines, with the reason, when the file cannot supply one", () => {
    const rule = ruleFor("sso.issuer.conf.4", { issuer_conf: "/opt/keycloak/conf/keycloak.conf" });
    const reply = { how: ASKED, text: body("https://sso.example.com/realms/main") };
    expect(rule.verdict(reply, ctx(null)).ok).toBe(null);
    expect(rule.verdict(reply, ctx(null)).why).toContain("was not observed");
    expect(rule.verdict(reply, ctx("db=postgres\n")).why).toContain("sets no hostname");
    // Keycloak accepts a bare hostname; an issuer built from one would be a
    // guess about the scheme.
    expect(rule.verdict(reply, ctx("hostname=sso.example.com\n")).ok).toBe(null);
    expect(rule.verdict(reply, ctx("hostname=sso.example.com\n")).why).toContain("not a full URL");
  });

  // `issuer_scheme` lets the PROJECT state the one fact the file cannot: a
  // bare `hostname=` still gets its hostname from each host's own file, but
  // the scheme comes from what the binding declares — never guessed.
  it("prefixes a bare hostname with the declared scheme, but never overrides one already stated", () => {
    const rule = ruleFor("sso.issuer.conf.6", {
      issuer_conf: "/opt/keycloak/conf/keycloak.conf",
      issuer_scheme: "https",
    });
    const reply = { how: ASKED, text: body("https://sso.example.com/realms/main") };
    expect(rule.verdict(reply, ctx("hostname=sso.example.com\n")).ok).toBe(true);
    expect(rule.verdict({ ...reply, text: body("http://sso.example.com/realms/main") }, ctx("hostname=sso.example.com\n")).ok).toBe(
      false
    );
    // A conf value that already states a scheme is trusted as stated —
    // `issuer_scheme` never overrides it, so an `http` issuer against an
    // `https://` conf value still fails rather than being coerced to match.
    expect(rule.verdict({ ...reply, text: body("http://sso.example.com/realms/main") }, ctx(CONF)).ok).toBe(false);
  });

  it("reads the path it was told to and no other", () => {
    const rule = ruleFor("sso.issuer.conf.5", { issuer_conf: "/etc/keycloak/keycloak.conf" });
    const v = rule.verdict({ how: ASKED, text: body("https://sso.example.com/realms/main") }, ctx(CONF));
    expect(v.ok).toBe(null);
    expect(v.why).toContain("/etc/keycloak/keycloak.conf");
  });
});
