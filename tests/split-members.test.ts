// `split: { members:, as: }` — naming the members of a list, and saying what
// their identity becomes.
//
// Both exist for a sheet whose COMPONENT axis is already spent: comparing two
// releases of a product whose file holds several clients. The members then
// cannot be components, and their ids cannot be the file's own — a SAML
// client's id is its entity id, so the old server spells a literal production
// host and the new one an environment reference.

import { describe, it, expect } from "bun:test";
import { splitKeySteps, splitComponentSteps, makeKeyTransformer, type StructuralSplit } from "../src/keytransform";

const apply = (split: StructuralSplit, key: string, membersOnly = false): string | undefined =>
  makeKeyTransformer({ from: "path", steps: splitKeySteps(split, membersOnly) }).apply(key);

const SAML: StructuralSplit = {
  at: "clients",
  by: "clientId",
  as: "prefix",
  members: [
    { id: "saml-reporting", match: "https://*/reporting/saml/metadata" },
    { id: "saml-sp", match: "https://*/saml/metadata" },
    { id: "poc-oidc" },
  ],
};

describe("split members: one name for two spellings", () => {
  it("gives the same id to ids that differ between the files", () => {
    // The whole point: these two are the same client, and a comparison keyed
    // on the raw id would show it as two one-sided rows.
    expect(apply(SAML, 'clients[clientId=https://app.example.com/saml/metadata].protocol')).toBe("saml-sp.protocol");
    expect(apply(SAML, 'clients[clientId="https://$(env:HOST)/saml/metadata"].protocol')).toBe("saml-sp.protocol");
  });

  it("matches an id with no match: literally", () => {
    expect(apply(SAML, "clients[clientId=poc-oidc].protocol")).toBe("poc-oidc.protocol");
  });

  it("tries members in the order written", () => {
    // The reporting SP's id ENDS IN the other's, so the order is the whole
    // difference between two clients and one.
    expect(apply(SAML, 'clients[clientId=https://app.example.com/reporting/saml/metadata].protocol')).toBe(
      "saml-reporting.protocol"
    );
  });

  it("reports a member that recognised nothing", () => {
    const t = makeKeyTransformer({ from: "path", steps: splitKeySteps(SAML) });
    t.apply("clients[clientId=poc-oidc].protocol");
    // saml-sp and saml-reporting were never seen — a selection reviewing less
    // than it claims.
    expect(t.unmatchedDropPatterns().length).toBe(2);
  });

  it("drops a member of the list this sheet did not name", () => {
    expect(apply(SAML, "clients[clientId=someone-else].protocol")).toBeUndefined();
  });

  it("keeps a row that is not a member of the list at all", () => {
    // A sheet can read the list AND the variables feeding it.
    expect(apply(SAML, "SSO_OIDC_HOST")).toBe("SSO_OIDC_HOST");
  });

  it("drops it instead when the source IS the list", () => {
    expect(apply(SAML, "realm", true)).toBeUndefined();
    expect(apply(SAML, "clients[clientId=poc-oidc].protocol", true)).toBe("poc-oidc.protocol");
  });
});

describe("split as:", () => {
  it("prefix leaves the component slot to the source", () => {
    // The release lives there; deriving a component from the member would
    // overwrite it.
    expect(splitComponentSteps(SAML)).toEqual([]);
  });

  it("none drops the member identity entirely", () => {
    const one: StructuralSplit = { at: "components", by: "name", as: "none", members: [{ id: "corp-ldap" }] };
    expect(apply(one, "components[name=corp-ldap].config.enabled[0]")).toBe("config.enabled[0]");
    expect(splitComponentSteps(one)).toEqual([]);
  });

  it("none still drops what is not the member, when the source IS the list", () => {
    const one: StructuralSplit = { at: "components", by: "name", as: "none", members: [{ id: "corp-ldap" }] };
    expect(apply(one, "realm", true)).toBeUndefined();
    expect(apply(one, "components[name=other-ldap].config.enabled[0]", true)).toBeUndefined();
  });

  it("none still reports a member that recognised nothing", () => {
    // The probe steps exist for exactly this: with no id entering the key,
    // one combined rewrite does the work, so nothing else would notice.
    const one: StructuralSplit = { at: "components", by: "name", as: "none", members: [{ id: "corp-ldap" }] };
    const t = makeKeyTransformer({ from: "path", steps: splitKeySteps(one) });
    t.apply("realm");
    expect(t.unmatchedDropPatterns().length).toBe(1);
  });

  it("component (the default) names each member as itself", () => {
    const c: StructuralSplit = { ...SAML, as: "component" };
    const t = makeKeyTransformer({ from: "path", steps: splitComponentSteps(c) });
    // An element whose id differs between two files still lands in one
    // component — the same normalisation, applied to the component axis.
    expect(t.apply('clients[clientId=https://a.example.com/saml/metadata].protocol')).toBe("saml-sp");
    expect(t.apply('clients[clientId="https://$(env:HOST)/saml/metadata"].protocol')).toBe("saml-sp");
    expect(t.apply("clients[clientId=someone-else].protocol")).toBeUndefined();
    // ...and the key keeps no member identity, as it always did.
    expect(apply(c, "clients[clientId=poc-oidc].protocol")).toBe("protocol");
  });
});
