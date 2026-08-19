// Where every row sits, pinned.
//
// A category path is part of a row's identity, so moving one strands every
// review filed against it. The file axis is due to stop being a category and
// become structure, which moves rows on purpose -- and this is what turns
// "moved on purpose" into a list somebody can read, rather than a claim.
//
// A failure here is not "regenerate the baseline". It is rows changing where
// they live; read the diff, decide whether that was the intent, and if it was,
// the same diff is what the release note and the orphaned-review check are
// written from.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { buildBaseline, BASELINE_FILE, type Baseline } from "../scripts/gen-layout-baseline";

const committed: Baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));

describe("row placement", () => {
  const now = buildBaseline();

  it("every row is still in the category it was in", () => {
    const before = new Map(committed.placements.map((p) => [`${p.sheet}::${p.key}`, p.path]));
    const after = new Map(now.placements.map((p) => [`${p.sheet}::${p.key}`, p.path]));
    const moved = [...before]
      .filter(([k, path]) => after.has(k) && after.get(k) !== path)
      .map(([k, path]) => `${k}: ${path} -> ${after.get(k)}`);
    expect(moved).toEqual([]);
  });

  // Separate from the move check on purpose: a row that VANISHED reads as a
  // move to nowhere otherwise, and losing a row is the one failure this project
  // refuses outright.
  it("no row appeared or disappeared", () => {
    const before = new Set(committed.placements.map((p) => `${p.sheet}::${p.key}`));
    const after = new Set(now.placements.map((p) => `${p.sheet}::${p.key}`));
    expect([...before].filter((k) => !after.has(k))).toEqual([]);
    expect([...after].filter((k) => !before.has(k))).toEqual([]);
  });

  it("each sheet holds the same number of rows in the same number of categories", () => {
    expect(now.sheets).toEqual(committed.sheets);
  });
});
