// A DECLARED SHEET THAT ENDED UP WITH NOTHING.
//
// The strongest form of the failure this area exists to prevent, and the one
// thing nothing said. A sheet is made of rows or of prose, so one with neither
// did not travel — and it looks exactly like a sheet that is simply short.
// `md-set.ts` reports it when WRITING a markdown set, but by then the build has
// succeeded and the document is out; whoever changed the declaration has gone.
//
// Reported at the build instead. The case that earned it: a key filter is the
// whole SHEET's, so `exclude: ["**"]`, reached for to drop a shared variable
// file, also emptied the `static_files:` the sheet was actually about — and the
// build said `0 parameter(s) enriched` and succeeded.

import { describe, it, expect } from "bun:test";
import { assembleSheetsWithReport, rowCountOf } from "../src/assemble";
import type { SheetInputs } from "../src/assemble";

const base = (entries: [string, { value: string; source: { file: string } }][]): SheetInputs =>
  ({
    name: "s",
    instances: ["prod"],
    layers: [{ kind: "base", entries: new Map(entries) }],
    embedded: [],
  }) as never;

const row = (key: string): [string, { value: string; source: { file: string } }] => [key, { value: "1", source: { file: "f" } }];

const built = (si: SheetInputs) =>
  assembleSheetsWithReport([si], {
    readFile: () => null,
    strictMetadata: false,
    projectMeta: { params: { a: { description: { en: "d" }, category: "General" } } },
  } as never);

describe("a sheet with no rows", () => {
  it("is reported", () => {
    const { emptySheets } = built(base([]));
    expect(emptySheets).toHaveLength(1);
    expect(emptySheets[0]).toContain("s");
    expect(emptySheets[0]).toContain("no rows at all");
  });

  // The message has to point at the thing that most often did it, because the
  // author is mid-experiment with exactly that declaration.
  it("names the filter as a place to look", () => {
    expect(built(base([])).emptySheets[0]).toContain("include:/exclude:");
  });

  it("says nothing about a sheet that has rows", () => {
    expect(built(base([row("a")])).emptySheets).toEqual([]);
  });

  // PROSE IS THE OTHER THING A SHEET CAN BE MADE OF. A document sheet has no
  // categories by construction, so a check that only counted rows would call
  // every record and every requirements note in the model a failure — and the
  // warning would then be noise in exactly the builds that carry one.
  it("says nothing about a sheet that is prose", () => {
    const { emptySheets } = built({
      name: "s",
      instances: ["prod"],
      layers: [{ kind: "base", entries: new Map() }],
      embedded: [],
      document: { markdown: "# A record\n\nprose, not rows\n" },
    } as never);
    expect(emptySheets).toEqual([]);
  });
});

describe("counting what a finished sheet carries", () => {
  // Rows live anywhere in the tree, so a count that only looked at the top
  // would call a perfectly full sheet empty.
  it("counts rows nested under subcategories", () => {
    expect(rowCountOf({ categories: [{ name: "c", categories: [{ name: "d", params: [{ key: "k" }] }] }] } as never)).toBe(1);
  });

  it("counts a sheet with no categories at all as empty", () => {
    expect(rowCountOf({} as never)).toBe(0);
    expect(rowCountOf({ categories: [] } as never)).toBe(0);
  });

  // A heading with no rows of its own is not a row.
  it("does not count headings", () => {
    expect(rowCountOf({ categories: [{ name: "c" }, { name: "d", params: [] }] } as never)).toBe(0);
  });
});
