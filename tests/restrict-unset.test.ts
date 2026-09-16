// A delivery is the rows somebody DECIDED.
//
// A materialized sheet is an exhaustive ledger: every option the product has,
// the ones nobody set carrying the product's own default and marked `default`.
// That is the right shape for the document an engineer keeps — "did we mean to
// leave this alone" is a question only an exhaustive list can be asked — and on
// one real delivery it is 862 of 1558 rows.
//
// The page already knows it is usually the wrong shape for a recipient: the
// viewer hides those rows behind a filter and collapses a category made of
// nothing else. This takes the same cut one stage earlier, so the rows are not
// in the file at all — the difference between a reader who must not turn a
// filter on and a document that does not carry them.

import { describe, it, expect } from "bun:test";
import { dropUnset, formatUnsetReport } from "../src/restrict";
import type { ParameterSheetInput, VersionedSheetInput } from "../src/types";

const row = (key: string, over: Record<string, unknown> = {}) => ({ key, value: "v", ...over });

const doc = (): ParameterSheetInput =>
  ({
    metadata: { title: "t" },
    sheets: [
      {
        name: "app",
        categories: [
          {
            name: "set",
            params: [row("a"), row("b", { origin: "default" })],
          },
          // Nothing but unset rows, and nobody wrote a word into it: the whole
          // section goes, exactly as the filter collapses it.
          { name: "all unset", params: [row("c", { origin: "default" }), row("d", { origin: "default" })] },
          // …unless somebody did. Hiding a section because every row in it is
          // unset is right; hiding what a person wrote there is not.
          { name: "noted", note: "we reviewed these and chose the defaults", params: [row("e", { origin: "default" })] },
          // A decision, and one of the more interesting ones: the vendor
          // shipped it and this project removed it.
          { name: "decided", params: [row("f", { origin: "baseline" }), row("g", { out_of_scope: true })] },
          // …and a level down, because a materialized sheet's unset rows sit
          // wherever the dictionary's own groups put them and that is rarely
          // the top.
          {
            name: "deep",
            params: [row("h")],
            categories: [
              { name: "deep unset", params: [row("i", { origin: "default" })] },
              { name: "deep set", params: [row("j")] },
            ],
          },
        ],
      },
    ],
  }) as never;

const keys = (input: ParameterSheetInput): string[] => {
  const out: string[] = [];
  const walk = (cs: { name: string; params?: { key: string }[]; categories?: unknown[] }[]): void => {
    for (const c of cs) {
      for (const p of c.params ?? []) out.push(p.key);
      walk((c.categories ?? []) as never);
    }
  };
  walk((input.sheets[0]!.categories ?? []) as never);
  return out;
};
const cats = (input: ParameterSheetInput): string[] => (input.sheets[0]!.categories ?? []).map((c) => c.name);

describe("leaving out the rows nobody set", () => {
  it("drops an unset row and keeps the set one beside it", () => {
    const { input } = dropUnset(doc());
    expect(keys(input)).toContain("a");
    expect(keys(input)).not.toContain("b");
  });

  it("collapses a category left holding nothing", () => {
    expect(cats(dropUnset(doc()).input)).not.toContain("all unset");
  });

  // …at every level. A materialized sheet's unset rows sit where the
  // dictionary's own groups put them, which is rarely the top.
  it("reaches a category below the first level", () => {
    const { input } = dropUnset(doc());
    expect(keys(input)).not.toContain("i");
    expect(keys(input)).toContain("j");
    const deep = (input.sheets[0]!.categories ?? []).find((c) => c.name === "deep");
    expect((deep?.categories ?? []).map((c) => c.name)).toEqual(["deep set"]);
  });

  it("keeps one somebody wrote a note into, even emptied", () => {
    const { input } = dropUnset(doc());
    expect(cats(input)).toContain("noted");
    expect(keys(input)).not.toContain("e");
  });

  // The predicate is `default` and nothing else. A baseline row says the vendor
  // shipped it and this project removed it; an out-of-scope row is a different
  // filter answering a different question. Dropping either changes what the
  // document claims.
  it("does not touch a baseline row or an out-of-scope one", () => {
    const { input } = dropUnset(doc());
    expect(keys(input)).toContain("f");
    expect(keys(input)).toContain("g");
  });

  // A row with no `origin` of its own is not unset — `effectiveOrigin` reads it
  // as `common` or `overlay`. Re-deriving that here would be a second answer to
  // one question, and the two would part company on exactly this row.
  it("keeps a row that states no origin at all", () => {
    const { input } = dropUnset({
      metadata: { title: "t" },
      sheets: [{ name: "app", categories: [{ name: "c", params: [{ key: "plain", value: "v" }] }] }],
    } as never);
    expect(keys(input as never)).toEqual(["plain"]);
  });

  it("takes the same cut in every version of a versioned document", () => {
    const versioned = {
      metadata: { title: "t" },
      versions: [
        { version: "v1", sheets: [{ name: "app", categories: [{ name: "c", params: [row("a"), row("b", { origin: "default" })] }] }] },
        { version: "v2", sheets: [{ name: "app", categories: [{ name: "c", params: [row("a"), row("z", { origin: "default" })] }] }] },
      ],
    } as never as VersionedSheetInput;
    const { input, report } = dropUnset(versioned);
    for (const v of input.versions) {
      expect((v.sheets[0]!.categories![0]!.params ?? []).map((p) => p.key)).toEqual(["a"]);
    }
    expect(report.rows).toBe(2);
  });

  it("leaves a document that has none of them alone", () => {
    const only = { metadata: { title: "t" }, sheets: [{ name: "app", categories: [{ name: "c", params: [row("a")] }] }] } as never;
    const { input, report } = dropUnset(only);
    expect(keys(input as never)).toEqual(["a"]);
    expect(report.rows).toBe(0);
    expect(formatUnsetReport(report)).toContain("none to leave out");
  });
});

describe("what it says it dropped", () => {
  // Always, and by name: a delivery that quietly left half its rows out is the
  // thing this flag must never be used to do by accident.
  it("counts the rows and the categories, per sheet, with examples", () => {
    const { report } = dropUnset(doc());
    expect(report.rows).toBe(5);
    expect(report.categories).toBe(2);
    const said = formatUnsetReport(report);
    expect(said).toContain("5 unset row(s)");
    expect(said).toContain("2 category(ies)");
    expect(said).toContain("app:");
    // R4: a count carries its own members.
    expect(said).toContain("app > set > b");
  });
});

// ---------------------------------------------------------------------------
// …and the set says the cut was taken.
//
// A set is stamped over the model it was WRITTEN FROM, and `verify --md`
// recomputes that stamp to tell a current set from a stale one. It already
// replays `--instances` from what the set records; without the same for this,
// a set made with the flag is called stale the moment it is checked — not
// because anything changed, but because the reader narrowed differently.

import { stampOf, toMarkdownSet } from "../src/md-set";

describe("what a set records about how it was narrowed", () => {
  const indexOf = (opts: Record<string, unknown>): string =>
    toMarkdownSet({ metadata: { title: "t" }, sheets: [{ name: "app", categories: [{ name: "c", params: [row("a")] }] }] } as never, "ja", {
      stamp: "abc123",
      ...opts,
    }).files[0]!.text;

  it("says the unset rows were left out, beside the environments", () => {
    const was = stampOf(indexOf({ instances: ["staging", "production"], withoutUnset: true }));
    expect(was?.stamp).toBe("abc123");
    expect(was?.instances).toEqual(["staging", "production"]);
    expect(was?.withoutUnset).toBe(true);
  });

  it("says nothing about it when the cut was not taken", () => {
    expect(stampOf(indexOf({ instances: ["staging"] }))?.withoutUnset).toBeUndefined();
  });

  // A set written before this existed carries no such word, and is read as one
  // that kept them — which is what it is.
  it("reads a set that predates the word as one that kept them", () => {
    expect(stampOf("<!-- rs:model abc123 instances=staging lang=ja -->")?.withoutUnset).toBeUndefined();
    expect(stampOf("<!-- rs:model abc123 lang=ja -->")?.stamp).toBe("abc123");
  });
});
