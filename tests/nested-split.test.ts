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
