// WHICH ENVIRONMENT ANSWERS WHICH.
//
// A migration puts two releases side by side and each has its own environments
// — an on-premises dev/prod becoming a cloud local/poc, sharing no name. The
// side-by-side view stacks each side's environments and lines them up by
// position, and its own comment says that is the entire point: a row can be
// read ACROSS. With four environments in two columns, nothing said whether
// `dev` is answered by `local` or by `poc`, so the alignment was the reader's
// guess.
//
// Declared, the pairs order the stacked values — line k of one column is line k
// of the next — and are printed under the title, because an alignment nobody
// can see is not one. Display only: nothing about what is compared, joined or
// judged changes.

import { describe, it, expect } from "bun:test";
import { assembleSheets } from "../src/assemble";
import type { SheetInputs } from "../src/assemble";

const inputs = (): SheetInputs[] => [
  {
    name: "upgrade",
    instances: ["dev", "prod", "local", "poc"],
    layers: [{ kind: "base", entries: new Map() }],
    embedded: [
      {
        key: "listen",
        value: "9090",
        source: { file: "old.conf", line: 1 },
        component: "19.0.2",
        categoryPath: ["Network"],
        instances: [
          { name: "dev", value: "9090" },
          { name: "prod", value: "80" },
        ],
      },
      {
        key: "listen",
        value: "8081",
        source: { file: "new.conf", line: 1 },
        component: "26.7.3",
        categoryPath: ["Network"],
        instances: [
          { name: "local", value: "8081" },
          { name: "poc", value: "443" },
        ],
      },
    ],
  } as never as SheetInputs,
];

const build = (pairs?: string[][]) => {
  const yaml = [
    "sheets:",
    "  upgrade:",
    "    compare_components: always",
    ...(pairs === undefined ? [] : [`    compare_instances: ${JSON.stringify(pairs)}`]),
    "",
  ].join("\n");
  return assembleSheets(inputs(), {
    strictMetadata: false,
    projectPath: "sheet.yml",
    readFile: (p: string) => (p.endsWith("sheet.yml") ? yaml : null),
  } as never);
};

const listenOf = (out: ReturnType<typeof build>, component: string): string[] => {
  const names: string[] = [];
  const walk = (cats: { name: string; params?: { key: string; component?: string; instances?: { name: string }[] }[]; categories?: unknown[] }[], where?: string): void => {
    for (const c of cats) {
      for (const p of c.params ?? []) {
        if (p.key === "listen" && (p.component ?? where) === component) names.push(...(p.instances ?? []).map((i) => i.name));
      }
      walk((c.categories ?? []) as never, c.name === component ? c.name : where);
    }
  };
  walk((out.sheets[0]!.categories ?? []) as never);
  return names;
};

describe("pairing the environments of two releases", () => {
  it("orders the values by the pairs, not by the sheet's own list", () => {
    const got = build([
      ["prod", "poc"],
      ["dev", "local"],
    ]);
    // Declared in the OTHER order than the sheet's instances, so an accidental
    // alignment cannot pass this: line 1 is the pair, line 2 is the pair.
    expect(listenOf(got, "19.0.2")).toEqual(["prod", "dev"]);
    expect(listenOf(got, "26.7.3")).toEqual(["poc", "local"]);
  });

  it("leaves the order alone when no pairs are declared", () => {
    expect(listenOf(build(), "19.0.2")).toEqual(["dev", "prod"]);
  });

  it("carries the pairs into the sheet, for the legend", () => {
    expect(build([["dev", "local"]]).sheets[0]!.compare_instances).toEqual([["dev", "local"]]);
    expect(build().sheets[0]!.compare_instances).toBeUndefined();
  });

  // An environment this sheet does not have would order nothing, silently.
  it("refuses a name the sheet does not have", () => {
    expect(() => build([["dev", "nowhere"]])).toThrow(/names nowhere, which this sheet does not have/);
  });

  // An environment answers ONE other, or the correspondence says nothing.
  it("refuses an environment in two pairs", () => {
    expect(() => build([["dev", "local"], ["dev", "poc"]])).toThrow(/puts dev in two pairs/);
  });

  // Never dropped: an environment nobody paired still has values, and leaving
  // it out of the ordering would leave it out of the reading.
  it("keeps an environment in no pair, after the paired ones", () => {
    const got = build([["prod", "poc"]]);
    expect(listenOf(got, "19.0.2")).toEqual(["prod", "dev"]);
  });
});
