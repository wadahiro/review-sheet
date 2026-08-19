// What every row binds to, pinned.
//
// The file axis is about to gain a structural level, and the hazard that makes
// that risky is not layout: a component is a binding SCOPE as well as a level
// -- `bindingFor`, materialize's per-component sets, per-component dictionary
// scoping and keyMap all key off it. Measured across the examples and one real
// project, essentially every sheet holds rows with no component today, so if
// the file went into that field every one of those lookups would move at once.
// This codebase has been bitten by that coupling before, when adding a
// component to a sheet silently emptied its under_key column.
//
// So the file lives in its own field, and this is the check that says so: with
// the structural fact recorded on every row, what each row binds to is
// unchanged, to the byte. It is kept afterwards as the regression net for every
// later step that touches filing.

import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, basename, join, resolve } from "path";
import { SPECS } from "../scripts/gen-layout-baseline";

export const BIND_BASELINE = "tests/goldens/bindings.json";

type Report = { rows: unknown[]; summary: unknown };

function reports(): Record<string, Report> {
  const out: Record<string, Report> = {};
  for (const spec of SPECS) {
    if (!existsSync(spec)) continue;
    const root = resolve(dirname(dirname(spec)));
    const model = join(process.env.TMPDIR ?? "/tmp", `bind-model-${basename(root)}.json`);
    const report = join(process.env.TMPDIR ?? "/tmp", `bind-report-${basename(root)}.json`);
    execFileSync(
      "bun",
      ["run", resolve("src/cli.ts"), "import", "--spec", join(basename(dirname(spec)), "build.yml"), "-o", model, "--bind-report", report],
      { cwd: root, stdio: ["ignore", "ignore", "pipe"] }
    );
    out[basename(root)] = JSON.parse(readFileSync(report, "utf-8")) as Report;
  }
  return out;
}

describe("what each row binds to", () => {
  it("is unchanged, with the structural fact recorded on every row", () => {
    const committed = JSON.parse(readFileSync(BIND_BASELINE, "utf-8")) as Record<string, Report>;
    expect(reports()).toEqual(committed);
  });
});
