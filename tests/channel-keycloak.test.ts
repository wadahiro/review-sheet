// A PRODUCT plugin: what Keycloak's own answers mean.
//
// The knowledge here is the product's, not one project's — a login page names
// its theme in every asset URL in every project that runs Keycloak — so it is
// held once, and tested once, the way the httpd parser has been since the
// beginning. What a PROJECT supplies is which of its items the plugin answers.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerKeycloakChannels, registerKeycloakLdapRouter, effectiveConfig, isProductDefault, lineOfEffective,
  readyReport, clusterMembers, issuerOf, issuerFor,
} from "../src/channels/keycloak";
import { listFunctionalChannels, listDocumentRouters } from "../src/channel";
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
    expect(got.reason).toContain("ログインフォームが無い");
    // …and says WHICH mark is missing, which a count never could.
    expect(got.reason).toContain('name="username"');
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
    expect(got.reason).toContain("無効");
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
  it("brackets a bare dotted key rather than attaching it with another dot", () => {
    const router = bind();
    expect(
      router.route(
        item({
          target: { sheet: "federation", path: ["Mappers", "sAMAccountName"], key: "sAMAccountName.user-attribute-ldap-mapper.is.mandatory.in.ldap", instance: "local" },
        })
      )?.address
    ).toBe(
      'components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap].subComponents["org.keycloak.storage.ldap.mappers.LDAPStorageMapper"][name=sAMAccountName]["is.mandatory.in.ldap"]'
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

  // A store row with no `item.address` at all (never authored, and
  // materialize has nothing to invent one from either) gets no answer — the
  // same "no address on the row, no address from the router" rule as an
  // unrecognised mapper key shape.
  it("leaves a store's own row with no item.address unanswered", () => {
    const router = bind();
    expect(
      router.route(item({ target: { sheet: "federation", path: ["General"], key: "kcr_ldap_connection_url", instance: "local" } }))
    ).toBeUndefined();
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
