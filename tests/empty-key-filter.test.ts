// AN EMPTY `include:` SELECTED EVERYTHING.
//
// `makeKeySelector` starts from `included = inc.length === 0`, which is how an
// omitted filter means "no filter" — and an empty list is indistinguishable
// from an omitted one, so `include: []` read as "take every key". That is the
// opposite of what somebody writing it means, and it arrives silently: a
// role's whole variable file becomes rows of a sheet that asked for none of
// it. Measured on a four-variable file, `include: []` produced the same six
// rows as no filter at all.
//
// "Take nothing from this source" is said by removing the source. Refused
// rather than redefined, because a project may also have GENERATED the list
// and got an empty one, and "everything" is the dangerous reading either way.

import { describe, it, expect } from "bun:test";
import { loadBuildSpec } from "../src/spec";
import "../src/recipes";
import { makeKeySelector } from "../src/keyglob";

const spec = (sheet: Record<string, unknown>): string =>
  JSON.stringify({ version: 1, metadata: { title: "t" }, instances: ["prod"], sheets: [{ name: "s", ...sheet }] });

const load = (sheet: Record<string, unknown>) =>
  loadBuildSpec("build.yml", { readFile: (p) => (p === "build.yml" ? spec(sheet) : null) });

describe("an empty key filter", () => {
  it("is refused on a layered sheet", () => {
    expect(() => load({ recipe: "layered", defaults: "vars.yml", include: [] })).toThrow(/include/);
  });

  // The message has to answer the question the author was asking, which the
  // schema's own words ("fewer than 1 items") do not.
  it("says what to do instead", () => {
    expect(() => load({ recipe: "layered", defaults: "vars.yml", include: [] })).toThrow(/selects EVERY key, not none/);
    expect(() => load({ recipe: "layered", defaults: "vars.yml", include: [] })).toThrow(/remove the source/);
  });

  it("is refused on exclude too", () => {
    expect(() => load({ recipe: "layered", defaults: "vars.yml", exclude: [] })).toThrow(/exclude.*selects EVERY key/s);
  });

  // Every recipe that has the filter agrees about it.
  it("is refused on ansible and snapshot alike", () => {
    expect(() => load({ recipe: "ansible", defaults: "vars.yml", include: [] })).toThrow(/selects EVERY key/);
    expect(() => load({ recipe: "snapshot", snapshots: { prod: "s.json" }, include: [] })).toThrow(/selects EVERY key/);
  });

  // …and a filter that names something is untouched.
  it("leaves a real filter alone", () => {
    expect(load({ recipe: "layered", defaults: "vars.yml", include: ["kcr_ldap_*"] }).sheets[0]).toBeDefined();
  });
});

describe("what the selector does with no patterns", () => {
  // The behaviour the refusal exists because of — pinned, so the refusal's
  // reason cannot quietly stop being true.
  it("takes every key when nothing is named", () => {
    const all = makeKeySelector([], []);
    expect(all.select("anything_at_all")).toBe(true);
  });

  it("takes only what an include names", () => {
    const some = makeKeySelector(["kcr_ldap_*"], []);
    expect(some.select("kcr_ldap_host")).toBe(true);
    expect(some.select("unrelated_role_var")).toBe(false);
  });
});
