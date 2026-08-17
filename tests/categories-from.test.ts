// One row, filed in two places.
//
// A sheet comparing two RELEASES of one product binds a dictionary per
// component, and the two do not have to agree about where a field belongs.
// The side-by-side view groups rows by category path, so a disagreement turns
// one row into two — each filled in one column and blank in the other, which
// is the exact opposite of what a comparison sheet is for. It used to happen
// in silence.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { assembleSheets, type SheetInputs, type AssembleOpts } from "../src/assemble";

beforeEach(stubNonBuiltInProviders);

// The same field, grouped differently by each release's dictionary — the old
// one has a single flat group, the new one mirrors the console's tabs.
const DICT_OLD = `
product: demo
version: "1"
coverage: partial
provenance: official
parameters:
  publicClient: { group: Clients, description: { en: d } }
  enabledFlag:  { group: Clients, description: { en: d } }
`;
const DICT_NEW = `
product: demo
version: "2"
coverage: partial
provenance: official
parameters:
  publicClient: { group: [Settings, Capability config], description: { en: d } }
  enabledFlag:  { group: Clients, description: { en: d } }
  newOnly:      { group: [Settings, Access settings], description: { en: d } }
`;

const files: Record<string, string> = {
  "meta/demo@1.yml": DICT_OLD,
  "meta/demo@2.yml": DICT_NEW,
};

function opts(project = "sheets:\n  upgrade:\n    params: {}\n"): AssembleOpts {
  return {
    projectPath: "project.yml",
    metadataDirs: ["meta"],
    readFile: (p) => (p === "project.yml" ? project : (files[p] ?? null)),
    strictMetadata: false,
    dictionaries: {
      upgrade: [
        { product: "demo", version: "1", component: "1" },
        { product: "demo", version: "2", component: "2" },
      ],
    },
  };
}

// Both releases set the same two fields; only `publicClient` is grouped
// differently by the two dictionaries. Carried as `embedded` entries because a
// layer's Map cannot hold one key twice, and the whole point here is that both
// components have it.
const inputs = (): SheetInputs[] => [
  {
    name: "upgrade",
    instances: ["production"],
    componentOrder: ["1", "2"],
    layers: [{ kind: "base", entries: new Map() }],
    embedded: [
      { key: "publicClient", value: "true", source: { file: "a.yml", line: 1 }, component: "1" },
      { key: "enabledFlag", value: "true", source: { file: "a.yml", line: 2 }, component: "1" },
      { key: "publicClient", value: "false", source: { file: "b.yml", line: 1 }, component: "2" },
      { key: "enabledFlag", value: "true", source: { file: "b.yml", line: 2 }, component: "2" },
    ],
  },
];

describe("categories_from", () => {
  it("is what the failure says to reach for", () => {
    // Naming the row and BOTH places it landed: the message has to be enough
    // to decide which one governs without opening either dictionary.
    let err: Error | undefined;
    try {
      assembleSheets(inputs(), opts());
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain("publicClient");
    expect(err!.message).toContain("Clients");
    expect(err!.message).toContain("Capability config");
    expect(err!.message).toContain("categories_from");
  });

  it("says nothing about a row the components agree on", () => {
    const err = (() => {
      try {
        assembleSheets(inputs(), opts());
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(err).not.toContain("enabledFlag");
  });

  it("files every row where the declared component files it", () => {
    const project = "sheets:\n  upgrade:\n    categories_from: \"2\"\n    params: {}\n";
    const input = assembleSheets(inputs(), opts(project));
    const paths: string[] = [];
    const walk = (cats: { name: string; params?: { key: string }[]; categories?: unknown }[], path: string[]): void => {
      for (const c of cats) {
        for (const p of c.params ?? []) paths.push([...path, c.name, p.key].join(" > "));
        walk((c.categories ?? []) as never[], [...path, c.name]);
      }
    };
    walk(input.sheets[0].categories as never[], []);
    // Both components' publicClient under the NEW dictionary's path — one row
    // per column, which is what makes them line up.
    expect(paths).toContain("1 > Settings > Capability config > publicClient");
    expect(paths).toContain("2 > Settings > Capability config > publicClient");
  });
});

// A name that matches nothing does not merely do nothing. The disagreement
// check runs only when NO governing component is declared, so an unmatched
// name both reverts the sheet to per-component filing and disarms the error
// that exists to catch it — a one-character typo putting back every split row
// with the build still reporting ok.
describe("categories_from names a component the sheet has", () => {
  it("fails on a name no component matches, and suggests the near one", () => {
    const project = "sheets:\n  upgrade:\n    categories_from: \"2.0\"\n    params: {}\n";
    let err: Error | undefined;
    try {
      assembleSheets(inputs(), opts(project));
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain('categories_from: "2.0"');
    expect(err!.message).toContain("no component for");
  });

  it("does not silently fall back to splitting the rows", () => {
    // The failure that made this check necessary: the build used to succeed.
    const project = "sheets:\n  upgrade:\n    categories_from: \"2.0\"\n    params: {}\n";
    expect(() => assembleSheets(inputs(), opts(project))).toThrow();
  });
});
