// Where every row SITS, pinned before anything moves it.
//
// The file axis is due to become structure rather than a category, which moves
// rows between category paths -- and a category path is part of a row's
// identity (sheet::category::param), so every move strands whatever was filed
// against it. This records the arrangement as it is now, so that when it
// changes the diff says which rows moved and the `unresolved` report can be
// checked against it.
//
// It consumes what the pipeline EMITS -- a built model, produced by the same
// command a project runs -- and reconstructs nothing. Three measurements taken
// against reconstructed inputs during this design were each plausible and each
// wrong: a category's kind guessed from how its name looked (dictionary group
// paths read as files), componentless rows counted from visible tabs (a single
// component collapses its level), and a backing variable read from any `extra`
// value (`provenance` lives there, so every row looked variable-backed). The
// one measurement that was right first time read real output. Hence the rule
// this file keeps: a check may only consume what the build itself says, and
// where the build says nothing, the work is to make it say it.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, basename, join, resolve } from "path";

export const BASELINE_FILE = "tests/goldens/layout.json";

// The repository's own examples. A project outside it can be passed on the
// command line for a local run; nothing committed here may depend on one.
export const SPECS = [
  "examples/ansible-basic/review-sheet/build.yml",
  "examples/ansible-httpd/review-sheet/build.yml",
  "examples/ansible-keycloak/review-sheet/build.yml",
  "examples/cdk-snapshot/review-sheet/build.yml",
];

export type Placement = { sheet: string; path: string; key: string };
export type SheetSummary = { spec: string; sheet: string; rows: number; categories: number };
export type Baseline = { placements: Placement[]; sheets: SheetSummary[] };

type Cat = { name: string; params?: { key: string }[]; categories?: Cat[] };

export function buildBaseline(specs: string[] = SPECS, cli = "src/cli.ts"): Baseline {
  const placements: Placement[] = [];
  const sheets: SheetSummary[] = [];
  for (const spec of specs) {
    if (!existsSync(spec)) continue;
    const root = resolve(dirname(dirname(spec)));
    const out = join(process.env.TMPDIR ?? "/tmp", `layout-${basename(root)}.json`);
    // The real command, from the directory a project runs it in: paths in a
    // spec are relative to the spec, and a model built from anywhere else is a
    // different model.
    execFileSync("bun", ["run", resolve(cli), "import", "--spec", join(basename(dirname(spec)), "build.yml"), "-o", out], {
      cwd: root,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const model = JSON.parse(readFileSync(out, "utf-8")) as { sheets: { name: string; categories?: Cat[] }[] };
    for (const sh of model.sheets) {
      let rows = 0;
      let cats = 0;
      const walk = (cs: Cat[] | undefined, path: string): void => {
        for (const c of cs ?? []) {
          const here = path ? `${path}/${c.name}` : c.name;
          cats++;
          for (const p of c.params ?? []) {
            rows++;
            placements.push({ sheet: sh.name, path: here, key: p.key });
          }
          walk(c.categories, here);
        }
      };
      walk(sh.categories, "");
      sheets.push({ spec: basename(root), sheet: sh.name, rows, categories: cats });
    }
  }
  placements.sort((a, b) => `${a.sheet} ${a.path} ${a.key}`.localeCompare(`${b.sheet} ${b.path} ${b.key}`));
  return { placements, sheets };
}

if (import.meta.main) {
  const extra = process.argv.slice(2);
  const b = buildBaseline(extra.length > 0 ? extra : SPECS);
  if (extra.length === 0) writeFileSync(BASELINE_FILE, JSON.stringify(b, null, 2) + "\n");
  console.error(`${b.sheets.length} sheet(s), ${b.placements.length} row placement(s)`);
  for (const s of b.sheets) console.error(`  ${s.spec} > ${s.sheet}: ${s.rows} rows in ${s.categories} categories`);
}
