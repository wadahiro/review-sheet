// A list nested inside each member of a split — a Keycloak LDAP store's
// mappers. Two things are being pinned: the component is `<member> / <nested>`,
// and the nested rows are keyed by a SIBLING field's value, which is the only
// thing that makes them bindable. A mapper's meaning comes from its type, the
// same property name means different things under different types, and the
// type appears nowhere in the structural address.
import { describe, it, expect } from "bun:test";
import { splitKeySteps, splitComponentSteps, nestedMemberPath, nestedMemberId, makeKeyTransformer, type StructuralSplit } from "../src/keytransform.js";

const SPLIT: StructuralSplit = {
  at: "components",
  by: "name",
  nest: { at: "subComponents", by: "name", key_from: "providerId", under: "Mappers" },
};

const apply = (steps: ReturnType<typeof splitKeySteps>, input: string): string | undefined =>
  makeKeyTransformer({ from: "path", steps }).apply(input);

describe("split with a nested list", () => {
  const path = 'components[name=corp].subComponents[name=username].config["read.only"][0]';
  const ownPath = "components[name=corp].config[enabled][0]";

  it("keys a nested row by what is left after both levels", () => {
    expect(apply(splitKeySteps(SPLIT), path)).toBe('config["read.only"][0]');
  });

  it("leaves a member's own row alone", () => {
    expect(apply(splitKeySteps(SPLIT), ownPath)).toBe("config[enabled][0]");
  });

  it("files a nested row under its MEMBER, not beside it", () => {
    // The nesting shows in the category (`Mappers > username`), not in the
    // component id: a mapper is part of the store, and seventeen components in
    // a row is not what a reviewer is looking at.
    expect(apply(splitComponentSteps(SPLIT), path)).toBe("corp");
  });

  it("names the nested member, for the category under it", () => {
    expect(nestedMemberId(SPLIT, path)).toBe("username");
    expect(nestedMemberId(SPLIT, ownPath)).toBeUndefined();
  });

  it("still files a member's own row under the member", () => {
    expect(apply(splitComponentSteps(SPLIT), ownPath)).toBe("corp");
  });

  it("drops a row that is neither — a path is not a component id", () => {
    // Without the nest the second step dropped these; with one it has to keep
    // whatever the first step produced, so the drop moved to the end.
    expect(apply(splitComponentSteps(SPLIT), "realm.displayName")).toBeUndefined();
  });

  it("finds the nested member a row belongs to, for the sibling lookup", () => {
    expect(nestedMemberPath(SPLIT, path)).toBe("components[name=corp].subComponents[name=username]");
    expect(nestedMemberPath(SPLIT, ownPath)).toBeUndefined();
  });

  it("changes nothing for a split with no nest", () => {
    const plain: StructuralSplit = { at: "components", by: "name" };
    expect(apply(splitComponentSteps(plain), ownPath)).toBe("corp");
    expect(apply(splitComponentSteps(plain), "realm.displayName")).toBeUndefined();
  });
});

// materialize's half of the same idea: an unset option of a REPEATED thing
// belongs to each repetition. A single row filed under the type is a decision
// nobody can act on, because there is no such object to configure — a reviewer
// setting `is.binary.attribute` sets it on the username mapper or on the email
// one, never on "user-attribute-ldap-mapper".
import { assembleSheets } from "../src/assemble.js";

describe("materialize across a repetition axis", () => {
  const dict = `product: m
version: "1"
coverage: full
parameters:
  user-attribute-ldap-mapper.ldap.attribute:
    unit: user-attribute-ldap-mapper
    description: { en: Attribute }
    default: "cn"
  user-attribute-ldap-mapper.is.binary.attribute:
    unit: user-attribute-ldap-mapper
    description: { en: Binary }
    default: "false"
`;
  const files: Record<string, string> = { "meta/m@1.yml": dict };

  it("expands once per member, not once per unit", () => {
    const input = assembleSheets(
      [
        {
          name: "ldap",
          instances: [],
          layers: [{ kind: "base", entries: new Map() }],
          embedded: [
            { key: "username.user-attribute-ldap-mapper.ldap.attribute", value: "uid", source: { file: "r.yml", line: 1 }, component: "corp", categoryPath: ["Mappers", "username"], categoryPathWins: true },
            { key: "email.user-attribute-ldap-mapper.ldap.attribute", value: "mail", source: { file: "r.yml", line: 2 }, component: "corp", categoryPath: ["Mappers", "email"], categoryPathWins: true },
          ],
          nestedMembers: new Map([["corp", { under: "Mappers", members: [{ id: "username", unit: "user-attribute-ldap-mapper" }, { id: "email", unit: "user-attribute-ldap-mapper" }] }]]),
        },
      ],
      {
        readFile: (p) => files[p] ?? null,
        metadataDirs: ["meta"],
        // The instance leads the key; the dictionary documents the type. One
        // step, the same shape a project declares.
        dictionaries: { ldap: [{ product: "m", version: "1", materialize: true, key_steps: [{ pattern: "^[^.]+\\.([a-z-]+-mapper\\..+)$", replace: "$1" }] }] },
        strictMetadata: false,
      }
    );
    const keys: string[] = [];
    const walk = (cs: { params?: { key: string }[]; categories?: unknown[] }[]): void => {
      for (const c of cs) {
        for (const p of c.params ?? []) keys.push(p.key);
        walk((c.categories ?? []) as typeof cs);
      }
    };
    walk(input.sheets[0].categories as never);
    expect(keys).toContain("username.user-attribute-ldap-mapper.is.binary.attribute");
    expect(keys).toContain("email.user-attribute-ldap-mapper.is.binary.attribute");
    // The type-level row is what this replaces, not something it keeps beside.
    expect(keys).not.toContain("user-attribute-ldap-mapper.is.binary.attribute");
  });
});
