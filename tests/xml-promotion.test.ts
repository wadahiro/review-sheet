// An element's address must not depend on how many siblings it has.
//
// `identityAttr` used to be consulted only for a group of MORE THAN ONE, so a
// single `<local-cache name="realms">` was addressed `local-cache` and kept a
// `@name` row, while two of them were addressed `local-cache[name=realms]` with
// no `@name` row at all. Adding a second cache anywhere in the file therefore
// re-keyed the first one's every descendant — every source map, review target
// and apply target under it — and deleted a row, because something unrelated
// had been added elsewhere.
//
// Promoting unconditionally fixes that and suppresses the `@name` row for the
// singleton too. The fact is not lost: the element is a row now, carrying the
// same value read from the same attribute. That row is why this could not ship
// before it existed — promoting a singleton without it simply dropped the
// value.

import { describe, it, expect } from "bun:test";
import { resolveParser } from "../src/parser";
import "../src/parsers/index.js";
import { assembleSheets } from "../src/assemble";
import type { Entry } from "../src/parser";

const paths = (xml: string): string[] =>
  resolveParser("a.xml", xml)!
    .extract(xml, "a.xml", {})
    .map((e) => e.source?.path ?? "");

const ONE = `<c><local-cache name="realms"><memory max-count="1"/></local-cache></c>`;
const TWO = `<c><local-cache name="realms"><memory max-count="1"/></local-cache><local-cache name="u"><memory max-count="2"/></local-cache></c>`;

// Assemble so the container rows exist, which is where the conservation holds.
function assembled(xml: string): { key: string; value?: string; container?: { name: string } }[] {
  const es: Entry[] = resolveParser("a.xml", xml)!.extract(xml, "a.xml", {});
  const si = {
    name: "x",
    instances: [],
    layers: [{ kind: "base" as const, entries: new Map() }],
    embedded: es.map((e) => ({ key: e.source!.path!, value: e.value, source: e.source, categoryPath: ["a.xml"], containers: e.containers })),
  };
  const readFile = (p: string): string | null => (p === "/sheet.yml" ? "sheets:\n  x:\n    params: {}\n" : null);
  const out = assembleSheets([si] as never, { readFile, projectPath: "/sheet.yml", instances: [], strictMetadata: false } as never);
  const flat: { key: string; value?: string; container?: { name: string } }[] = [];
  const walk = (cs: { params?: never[]; categories?: never[] }[] | undefined): void => {
    for (const c of cs ?? []) { flat.push(...((c.params ?? []) as never[])); walk(c.categories); }
  };
  for (const sh of out.sheets) walk(sh.categories as never);
  return flat;
}

describe("identity promotion does not depend on sibling count", () => {
  it("addresses a lone element exactly as it would with a sibling", () => {
    expect(paths(ONE)).toEqual(["c.local-cache[name=realms].memory.@max-count"]);
  });

  // The bug, stated as the property it broke: adding a cache elsewhere in the
  // file must not move the rows of the one already there.
  it("leaves the first element's rows where they were when a sibling is added", () => {
    const before = paths(ONE);
    const after = paths(TWO);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  // Conservation: the value the `@name` row used to carry is still on the
  // sheet, on the element's own row.
  it("keeps the value the suppressed attribute row carried", () => {
    const rows = assembled(ONE);
    const container = rows.find((p) => p.container);
    expect(container?.container).toEqual({ name: "local-cache" });
    expect(container?.value).toBe("realms");
  });

  // And it gains what it never had: two caches were distinguishable only inside
  // the addresses of their settings before, with nowhere to describe either.
  it("gives every promoted element a row of its own", () => {
    expect(assembled(TWO).filter((p) => p.container).map((p) => p.value)).toEqual(["realms", "u"]);
  });
});
