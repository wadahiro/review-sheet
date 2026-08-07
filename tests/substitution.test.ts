import { describe, it, expect } from "bun:test";
import {
  compileSubstitution,
  bindReferences,
  type EmbeddedEntry,
  type LayerEntry,
} from "../src/substitution";

// keycloak-config-cli's own syntax — the PoC's real-world example driving
// this design (see src/substitution.ts's own module doc).
const PATTERN = String.raw`\$\(env:([A-Za-z_][A-Za-z0-9_]*)\)`;

function entry(key: string, value: string, path?: string): EmbeddedEntry {
  return { key, value, source: { file: "poc.yml", line: 1, path: path ?? key } };
}

function layerEntry(value: string): LayerEntry {
  return { value, source: { file: "default.env", line: 1 } };
}

describe("compileSubstitution", () => {
  it("accepts exactly one capturing group", () => {
    expect(() => compileSubstitution(PATTERN)).not.toThrow();
  });

  it("rejects zero capturing groups, naming the count found", () => {
    expect(() => compileSubstitution(String.raw`\$\(env:[A-Za-z_]+\)`)).toThrow(/found 0/);
  });

  it("rejects more than one capturing group, naming the count found", () => {
    expect(() => compileSubstitution(String.raw`\$\((env):([A-Za-z_]+)\)`)).toThrow(/found 2/);
  });

  it("does not count a non-capturing group", () => {
    expect(() => compileSubstitution(String.raw`\$\((?:env):([A-Za-z_]+)\)`)).not.toThrow();
  });

  it("names the count even for a badly nested pattern", () => {
    expect(() => compileSubstitution(String.raw`((a)(b))`)).toThrow(/found 3/);
  });
});

describe("bindReferences", () => {
  it("row 1 — no match: the entry is untouched", () => {
    const compiled = compileSubstitution(PATTERN);
    const sslRequired = entry("sslRequired", "external");
    const result = bindReferences({
      embedded: [sslRequired],
      baseMap: new Map(),
      overlayLayers: [],
      compiled,
    });
    expect(result.embedded).toEqual([sslRequired]);
    expect(result.keyMap).toEqual([]);
    expect(result.referenceSites).toEqual([]);
    expect(result.warnings).toEqual(["substitution: pattern matched no value"]);
    expect(result.tally).toEqual({ merged: 0, composed: 0, dangling: 0, danglingComposed: 0, matchedNothing: true });
  });

  it("row 2 — whole-value, single backer: merges into a keyMap entry plus one ref site", () => {
    const compiled = compileSubstitution(PATTERN);
    const site = entry("ssoSessionIdleTimeout", "$(env:SSO_SESSION_IDLE_TIMEOUT)");
    const result = bindReferences({
      embedded: [site],
      baseMap: new Map(),
      overlayLayers: [
        { instance: "local", entries: new Map([["SSO_SESSION_IDLE_TIMEOUT", layerEntry("300")]]) },
        { instance: "production", entries: new Map([["SSO_SESSION_IDLE_TIMEOUT", layerEntry("1800")]]) },
      ],
      compiled,
    });
    expect(result.embedded).toEqual([]);
    expect(result.keyMap).toEqual([{ boundKey: "ssoSessionIdleTimeout", variable: "SSO_SESSION_IDLE_TIMEOUT" }]);
    expect(result.referenceSites).toEqual([
      {
        variable: "SSO_SESSION_IDLE_TIMEOUT",
        sites: [{ ...site.source, ref: "$(env:SSO_SESSION_IDLE_TIMEOUT)", anchor: "$(env:SSO_SESSION_IDLE_TIMEOUT)" }],
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.tally).toEqual({ merged: 1, composed: 0, dangling: 0, danglingComposed: 0, matchedNothing: false });
  });

  it("row 2 — resolves via the base layer too, not only overlays", () => {
    const compiled = compileSubstitution(PATTERN);
    const site = entry("smtpServer.user", "$(env:SSO_SMTP_USER)");
    const result = bindReferences({
      embedded: [site],
      baseMap: new Map([["SSO_SMTP_USER", layerEntry("noreply@example.com")]]),
      overlayLayers: [],
      compiled,
    });
    expect(result.embedded).toEqual([]);
    expect(result.keyMap).toEqual([{ boundKey: "smtpServer.user", variable: "SSO_SMTP_USER" }]);
    expect(result.tally.merged).toBe(1);
  });

  it("row 3 — whole-value, multiple backers: merges without a keyMap entry, all sites kept, warned", () => {
    const compiled = compileSubstitution(PATTERN);
    const proxyPass = entry("ProxyPass", "$(env:BACKEND_URL)", "http.location[/api].ProxyPass");
    const proxyPassReverse = entry("ProxyPassReverse", "$(env:BACKEND_URL)", "http.location[/api].ProxyPassReverse");
    const result = bindReferences({
      embedded: [proxyPass, proxyPassReverse],
      baseMap: new Map([["BACKEND_URL", layerEntry("http://backend:8080")]]),
      overlayLayers: [],
      compiled,
    });
    // Both rows are removed from embedded (merged), but no keyMap entry
    // claims either directive's name — the row keeps the variable's own name.
    expect(result.embedded).toEqual([]);
    expect(result.keyMap).toEqual([]);
    expect(result.referenceSites).toEqual([
      {
        variable: "BACKEND_URL",
        sites: [
          { ...proxyPass.source, ref: "$(env:BACKEND_URL)", anchor: "$(env:BACKEND_URL)" },
          { ...proxyPassReverse.source, ref: "$(env:BACKEND_URL)", anchor: "$(env:BACKEND_URL)" },
        ],
      },
    ]);
    expect(result.tally).toEqual({ merged: 2, composed: 0, dangling: 0, danglingComposed: 0, matchedNothing: false });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("BACKEND_URL");
    expect(result.warnings[0]).toContain("ProxyPass");
    expect(result.warnings[0]).toContain("ProxyPassReverse");
    expect(result.warnings[0]).toContain("not 1:1");
  });

  it("row 4 — composed: the row stays embedded, and the variable's own row gets a checked ref site", () => {
    const compiled = compileSubstitution(PATTERN);
    const redirectUri = entry("redirectUris[0]", "https://$(env:SSO_SAML_HOST)/saml/acs");
    const result = bindReferences({
      embedded: [redirectUri],
      baseMap: new Map([["SSO_SAML_HOST", layerEntry("sso.example.com")]]),
      overlayLayers: [],
      compiled,
    });
    expect(result.embedded).toEqual([redirectUri]);
    expect(result.keyMap).toEqual([]);
    expect(result.referenceSites).toEqual([
      {
        variable: "SSO_SAML_HOST",
        sites: [{ ...redirectUri.source, ref: "$(env:SSO_SAML_HOST)", anchor: "$(env:SSO_SAML_HOST)" }],
      },
    ]);
    expect(result.tally).toEqual({ merged: 0, composed: 1, dangling: 0, danglingComposed: 0, matchedNothing: false });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("composed site");
    expect(result.warnings[0]).toContain("redirectUris[0]");
  });

  it("row 4 — a composed value referencing two variables records a site on each", () => {
    const compiled = compileSubstitution(PATTERN);
    const url = entry("issuerUrl", "https://$(env:SSO_OIDC_HOST):$(env:SSO_OIDC_PORT)/realms/x");
    const result = bindReferences({
      embedded: [url],
      baseMap: new Map([
        ["SSO_OIDC_HOST", layerEntry("sso.example.com")],
        ["SSO_OIDC_PORT", layerEntry("8443")],
      ]),
      overlayLayers: [],
      compiled,
    });
    expect(result.embedded).toEqual([url]);
    const variables = result.referenceSites.map((r) => r.variable).sort();
    expect(variables).toEqual(["SSO_OIDC_HOST", "SSO_OIDC_PORT"]);
    expect(result.tally.composed).toBe(1); // one ENTRY, even though it touched two variables
  });

  it("row 4 (mixed) — a dangling piece of a composed value warns and is tallied separately, while the resolved piece still gets its ref site", () => {
    const compiled = compileSubstitution(PATTERN);
    const url = entry("issuerUrl", "https://$(env:SSO_OIDC_HOST):$(env:UNRESOLVED_PORT)/realms/x");
    const result = bindReferences({
      embedded: [url],
      baseMap: new Map([["SSO_OIDC_HOST", layerEntry("sso.example.com")]]),
      overlayLayers: [],
      compiled,
    });
    // The entry's shape is unaffected either way — it stays embedded.
    expect(result.embedded).toEqual([url]);
    // The resolved piece (SSO_OIDC_HOST) still earns its checked ref site;
    // the dangling piece (UNRESOLVED_PORT) earns none.
    expect(result.referenceSites).toEqual([
      { variable: "SSO_OIDC_HOST", sites: [{ ...url.source, ref: "$(env:SSO_OIDC_HOST)", anchor: "$(env:SSO_OIDC_HOST)" }] },
    ]);
    // Two warnings: the per-piece dangling warning (naming the missing key,
    // parallel to row 5's wording) and the one summary "composed site(s) left
    // embedded" line for the entry as a whole.
    expect(result.warnings).toHaveLength(2);
    const danglingWarning = result.warnings.find((w) => w.includes("UNRESOLVED_PORT"));
    expect(danglingWarning).toBeDefined();
    expect(danglingWarning).toContain("composed");
    expect(danglingWarning).toContain("issuerUrl");
    expect(result.warnings.some((w) => w.includes("composed site"))).toBe(true);
    // Dangling-composed is counted separately from whole-value dangling.
    expect(result.tally).toEqual({ merged: 0, composed: 1, dangling: 0, danglingComposed: 1, matchedNothing: false });
  });

  it("row 4 (fully dangling) — no piece of the composed value resolves: no ref site, no 'composed site' summary, only the per-piece dangling warning", () => {
    const compiled = compileSubstitution(PATTERN);
    const url = entry("issuerUrl", "https://$(env:UNRESOLVED_HOST)/realms/x");
    const result = bindReferences({
      embedded: [url],
      baseMap: new Map(),
      overlayLayers: [],
      compiled,
    });
    expect(result.embedded).toEqual([url]);
    expect(result.referenceSites).toEqual([]);
    expect(result.warnings).toEqual([
      `substitution: dangling reference (composed) "$(env:UNRESOLVED_HOST)" at "issuerUrl" — "UNRESOLVED_HOST" is not defined in the base layer or any overlay`,
    ]);
    // No resolved piece landed anywhere, so this entry never joins the
    // "composed site(s) left embedded" summary — `composed` counts entries
    // that gained at least one REAL ref site, not merely composed-shaped ones.
    expect(result.tally).toEqual({ merged: 0, composed: 0, dangling: 0, danglingComposed: 1, matchedNothing: false });
  });

  it("row 5 — dangling whole-value reference: kept embedded, warned naming the site and the missing key", () => {
    const compiled = compileSubstitution(PATTERN);
    const site = entry("pipelineSecret", "$(env:PIPELINE_SECRET)");
    const result = bindReferences({
      embedded: [site],
      baseMap: new Map(),
      overlayLayers: [{ instance: "local", entries: new Map() }],
      compiled,
    });
    expect(result.embedded).toEqual([site]);
    expect(result.keyMap).toEqual([]);
    expect(result.referenceSites).toEqual([]);
    expect(result.tally).toEqual({ merged: 0, composed: 0, dangling: 1, danglingComposed: 0, matchedNothing: false });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("PIPELINE_SECRET");
    expect(result.warnings[0]).toContain("pipelineSecret");
  });

  it("pattern matched no value at all across every entry: warned and tallied", () => {
    const compiled = compileSubstitution(PATTERN);
    const result = bindReferences({
      embedded: [entry("sslRequired", "external"), entry("port", "8443")],
      baseMap: new Map(),
      overlayLayers: [],
      compiled,
    });
    expect(result.tally.matchedNothing).toBe(true);
    expect(result.warnings).toEqual(["substitution: pattern matched no value"]);
    expect(result.embedded).toHaveLength(2);
  });

  it("does not report matchedNothing when at least one entry matched, even if unrelated entries did not", () => {
    const compiled = compileSubstitution(PATTERN);
    const result = bindReferences({
      embedded: [entry("sslRequired", "external"), entry("dbUrl", "$(env:DB_URL)")],
      baseMap: new Map([["DB_URL", layerEntry("postgres://db")]]),
      overlayLayers: [],
      compiled,
    });
    expect(result.tally.matchedNothing).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("the PoC-shaped mix (whole-value + composed + literal + dangling) classifies every entry, dropping none", () => {
    const compiled = compileSubstitution(PATTERN);
    const wholeValue = entry("ssoSessionIdleTimeout", "$(env:SSO_SESSION_IDLE_TIMEOUT)");
    const composed = entry("redirectUris[0]", "https://$(env:SSO_SAML_HOST)/saml/acs");
    const literal = entry("sslRequired", "external");
    const dangling = entry("pipelineSecret", "$(env:PIPELINE_SECRET)");
    const result = bindReferences({
      embedded: [wholeValue, composed, literal, dangling],
      baseMap: new Map([
        ["SSO_SESSION_IDLE_TIMEOUT", layerEntry("1800")],
        ["SSO_SAML_HOST", layerEntry("sso.example.com")],
      ]),
      overlayLayers: [],
      compiled,
    });
    // wholeValue merged away; the other three all survive as embedded rows,
    // in their original order.
    expect(result.embedded).toEqual([composed, literal, dangling]);
    expect(result.keyMap).toEqual([{ boundKey: "ssoSessionIdleTimeout", variable: "SSO_SESSION_IDLE_TIMEOUT" }]);
    const variables = result.referenceSites.map((r) => r.variable).sort();
    expect(variables).toEqual(["SSO_SAML_HOST", "SSO_SESSION_IDLE_TIMEOUT"]);
    expect(result.tally).toEqual({ merged: 1, composed: 1, dangling: 1, danglingComposed: 0, matchedNothing: false });
  });
});
