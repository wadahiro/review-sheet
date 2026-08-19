// What every parser extracts, pinned.
//
// This exists for one job: the container work rebuilds each tree-bearing parser
// around a per-node record and derives `source.path` from it — a rewrite of the
// code deciding row identity for every structured format at once. The claim
// that has to hold is the strongest available one, that every field every
// parser already emits is byte-identical afterwards and the new container
// record is the only addition. A record captured after the rewrite could not
// state that, so this was captured before it began.
//
// A failure here is not "update the golden". It is the refactor changing what a
// row IS — which re-keys source maps, orphans reviews and moves apply targets —
// so read the diff (`bun run scripts/gen-goldens.ts --detail <file>`) and decide
// whether the change was intended before regenerating.

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { stubNonBuiltInParsers, isBuiltInParser } from "./only-builtin-parsers";
import { buildGoldens, goldenFiles, goldenKey, GOLDEN_FILE, type GoldenRow } from "../scripts/gen-goldens";

const committed: GoldenRow[] = JSON.parse(readFileSync(GOLDEN_FILE, "utf-8"));

describe("extraction goldens", () => {
  // Without this the suite's own plugin-parser tests answer for files they were
  // never meant to claim, and this file passes alone while failing in the run.
  beforeEach(stubNonBuiltInParsers);

  it("every parser still extracts exactly what it did", () => {
    const now = buildGoldens(goldenFiles());
    // Compared as maps, so a file ADDED to the repo reports as its own failure
    // rather than shifting an array and reporting every file after it.
    const a = new Map(committed.map((r) => [goldenKey(r), r]));
    const b = new Map(now.map((r) => [goldenKey(r), r]));
    expect([...b.keys()].filter((f) => !a.has(f))).toEqual([]);
    expect([...a.keys()].filter((f) => !b.has(f))).toEqual([]);
    const moved = [...a].filter(([f, r]) => {
      const n = b.get(f)!;
      return n.parser !== r.parser || n.count !== r.count || n.sha !== r.sha;
    });
    expect(moved.map(([f]) => f)).toEqual([]);
  });

  // The safety net is only as good as its coverage, and it started with none
  // for eight parsers — including every tree-bearing one due to be rebuilt.
  // `tests/fixtures/parsers/` exists to close that, and this keeps it closed:
  // a new parser with no file to read is a parser this suite cannot protect.
  it("covers every registered parser", async () => {
    const { listParsers } = await import("../src/parser");
    await import("../src/parsers/index.js");
    const covered = new Set(committed.map((r) => r.parser));
    const missing = listParsers()
      .map((p) => p.name)
      // A plugin parser registered by another test file is that test's, not a
      // shipped format this suite is responsible for pinning.
      .filter((n) => isBuiltInParser(n) && !covered.has(n));
    expect(missing).toEqual([]);
  });
});
