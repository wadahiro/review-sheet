// …and assemble merges it into the model, beside whatever the spec declared.
import { describe, it, expect } from "bun:test";
import { assembleSheets } from "../src/assemble";
import type { SheetInputs } from "../src/assemble";

const sheet = (over: Partial<SheetInputs>): SheetInputs =>
  ({
    name: "s",
    instances: ["local"],
    layers: [{ kind: "base", entries: new Map([["k", { value: "1", source: { file: "f" } }]]) }],
    embedded: [],
    ...over,
  }) as never;

const opts = { readFile: () => null, strictMetadata: false };

describe("the identity fields a model carries", () => {
  it("takes what a recipe stated for its sheet", () => {
    const m = assembleSheets([sheet({ idFields: ["address"] })], opts as never);
    expect(m.id_fields).toEqual(["address"]);
  });

  // The spec's own come first: a project that declares a field means it, and a
  // recipe's is an addition rather than a replacement.
  it("keeps the spec's own, and adds the recipe's after them", () => {
    const m = assembleSheets([sheet({ idFields: ["address"] })], { ...opts, idFieldsOut: ["clientId"] } as never);
    expect(m.id_fields).toEqual(["clientId", "address"]);
  });

  // Two sheets asking for the same one ask once.
  it("says each field once", () => {
    const m = assembleSheets([sheet({ idFields: ["address"] }), sheet({ name: "t", idFields: ["address"] })], opts as never);
    expect(m.id_fields).toEqual(["address"]);
  });

  // …and a model whose recipes stated none is unchanged.
  it("carries none when nothing asked", () => {
    expect(assembleSheets([sheet({})], opts as never).id_fields).toBeUndefined();
  });
});
