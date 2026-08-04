import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// `import --spec` used to call loadCustomRecipes() only, so custom parsers and
// metadata providers were silently disabled on the one path SKILL.md recommends
// — no error, just missing parameters and missing descriptions. That is only
// observable end to end, hence spawning the real CLI.
//
// tests/fixtures/spec-plugins/ is built so the import CANNOT succeed without
// both: its `app.myconf` file is only parseable by .review-sheet/parsers/, and
// .review-sheet/providers/ is the only description source under strict metadata.

const root = join(import.meta.dir, "..");
const fixture = join(root, "tests", "fixtures", "spec-plugins");
const cli = join(root, "src", "cli.ts");

const work = mkdtempSync(join(tmpdir(), "review-sheet-spec-plugins-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type Run = { code: number; stderr: string; input: string };

function runImport(cwd: string, args: string[], out: string): Run {
  const proc = Bun.spawnSync(["bun", "run", cli, "import", ...args, "-o", out], { cwd });
  return {
    code: proc.exitCode,
    stderr: proc.stderr.toString(),
    input: proc.exitCode === 0 ? readFileSync(out, "utf-8") : "",
  };
}

describe("import --spec loads every kind of plugin", () => {
  it("auto-discovers .review-sheet/parsers and .review-sheet/providers", () => {
    const out = join(work, "auto.json");
    const run = runImport(fixture, ["--spec", ".review-sheet/build.yml"], out);

    expect(run.stderr).not.toContain("no description");
    expect(run.code).toBe(0);
    // The custom parser: `timeout -> 30` is unreadable to every shipped parser.
    expect(run.input).toContain('"key": "timeout"');
    // The custom provider: the only description source in the fixture.
    expect(run.input).toContain("described by fixture-desc: timeout");
    expect(run.stderr).toContain("fixture-desc");
  });

  it("honours explicit --parsers-dir / --providers-dir", () => {
    // Run from the repo root, where auto-discovery finds nothing, so only the
    // explicit flags can supply the plugins.
    const rel = join("tests", "fixtures", "spec-plugins", ".review-sheet");
    const out = join(work, "explicit.json");
    const run = runImport(root, [
      "--spec", join(rel, "build.yml"),
      "--parsers-dir", join(rel, "parsers"),
      "--providers-dir", join(rel, "providers"),
    ], out);

    expect(run.stderr).not.toContain("no description");
    expect(run.code).toBe(0);
    expect(run.input).toContain('"key": "timeout"');
    expect(run.input).toContain("described by fixture-desc: timeout");
  });
});
