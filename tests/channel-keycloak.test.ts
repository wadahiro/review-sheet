// A PRODUCT plugin: what Keycloak's own answers mean.
//
// The knowledge here is the product's, not one project's — a login page names
// its theme in every asset URL in every project that runs Keycloak — so it is
// held once, and tested once, the way the httpd parser has been since the
// beginning. What a PROJECT supplies is which of its items the plugin answers.

import { describe, it, expect, beforeEach } from "bun:test";
import { registerKeycloakChannels } from "../src/channels/keycloak";
import { listFunctionalChannels } from "../src/channel";

const clear = (): void => {
  const arr = (globalThis as Record<symbol, unknown>)[Symbol.for("review-sheet.functional-channels.v1")] as unknown[];
  if (Array.isArray(arr)) arr.length = 0;
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
