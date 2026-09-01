// A sheet that declares `compare_components` and cannot compare anything.
//
// The check for this existed and asked a WEAKER question than the view asks.
// It counted drafts by KEY: two components both having a `realm` counted as one
// shared row, so the sheet passed. The view joins on the category path BELOW the
// component plus the key (`pivotSheet` in html/app.ts, whose own comment says
// the path without the component level is what the components have in common) —
// and under the default layout each component's rows are headed by the FILE they
// come from, which a comparison's components never share.
//
// So the build said ok and the sheet rendered a diagonal: every row filled in
// exactly one column, every cell on the other side "—". Measured on the shape
// that reported it: two static_files, one component each, identical keys.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { getRecipe } from "../src/recipe";
import { assembleSheets } from "../src/assemble";
import "../src/recipes/index.js";
import "../src/parsers/index.js";

beforeEach(stubNonBuiltInProviders);

const FILES: Record<string, string> = {
  "/a.yml": "realm: demo\nenabled: true\nsslRequired: external\n",
  "/b.yml": "realm: demo\nenabled: true\nsslRequired: none\n",
  // Two components with nothing in common, for the other half of the check.
  "/c.yml": "onlyHere: 1\n",
  // The per-sheet form, which is what a project with more than one sheet
  // writes and what the report came from.
  "/flat.yml": "sheets:\n  up:\n    compare_components: always\n    params: {}\n",
  "/grouped.yml": "sheets:\n  up:\n    layout: categories\n    compare_components: always\n    params: {}\n",
};

const io = {
  readFile: (p: string) => FILES[p] ?? null,
  specDir: "/",
  resolve: (p: string) => p,
  instances: ["local"],
};

function build(files: [string, string][], project: string, extra: Record<string, unknown> = {}) {
  const si = getRecipe("layered")!.load(
    {
      name: "up",
      recipe: "layered",
      instances: ["local"],
      static_files: files.map(([path, component]) => ({ path, format: "yaml", component })),
      ...extra,
    } as never,
    io as never
  );
  return assembleSheets([si as never], { projectPath: project, readFile: io.readFile, strictMetadata: false });
}

const PAIR: [string, string][] = [
  ["/a.yml", "old"],
  ["/b.yml", "new"],
];

describe("a sheet that declares compare_components", () => {
  it("is refused when its components file the same keys under headings that cannot line up", () => {
    expect(() => build(PAIR, "/flat.yml")).toThrow(/DO share 3 parameter\(s\)/);
  });

  // The fix has to be in the message, or the report is a puzzle: the keys are
  // right there in both files and nothing else says why they did not meet.
  it("names the layout that fixes it", () => {
    expect(() => build(PAIR, "/flat.yml")).toThrow(/layout: categories/);
  });

  // Two components that genuinely share nothing is a different mistake with no
  // one-line fix, and it keeps its own sentence.
  it("says something else when the components really do share no parameter", () => {
    let message = "";
    try {
      build(
        [
          ["/a.yml", "old"],
          ["/c.yml", "new"],
        ],
        "/grouped.yml",
        { exclude: ["**"] }
      );
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("no parameter appears in more than one");
    expect(message).not.toContain("layout: categories");
  });

  // What the reporter's own sheets do, and what the fix produces: the rows meet.
  it("accepts the sheet once the headings come from something the components share", () => {
    // `layout: categories` needs a category source; with none declared every row
    // is uncategorised, which is its own (different) error. The point here is
    // only that the compare check is no longer the one that fires.
    let message = "";
    try {
      build(PAIR, "/grouped.yml");
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toContain("compare_components");
  });
});
