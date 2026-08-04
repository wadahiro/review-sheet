import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// A plugin file can `import(...)` cleanly and run its top-level
// code without ever landing in the registry the CLI reads afterwards — most
// often because it resolved a stale/duplicate copy of review-sheet. Before
// this, `loadPluginModules()` only counted files imported, so that failure
// was completely silent; the only symptom was a much later, misleading error
// (e.g. "Unknown recipe", or strict-metadata's "no description"). This test
// spawns the real CLI against a parser plugin file that never calls
// registerParser(), and expects a specific warning naming the mismatch.

const root = join(import.meta.dir, "..");
const fixture = join(root, "tests", "fixtures", "plugin-noop");
const cli = join(root, "src", "cli.ts");

const work = mkdtempSync(join(tmpdir(), "review-sheet-plugin-warning-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("loadPluginModules warns on net-zero registration", () => {
  it("imports the plugin file but warns that the parser registry did not grow", () => {
    const out = join(work, "out.json");
    const proc = Bun.spawnSync(
      ["bun", "run", cli, "import", "-f", "app.conf", "--parsers-dir", "parsers", "-o", out],
      { cwd: fixture }
    );
    const stderr = proc.stderr.toString();

    // The plugin file registers nothing, but the generic line parser still
    // extracts `key = value` from app.conf fine — so this is not an
    // extraction failure, only a silent-registration one.
    expect(proc.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);

    expect(stderr).toContain("Warning: imported 1 parser plugin file(s)");
    expect(stderr).toContain("registry did not gain any entries");
    // Names the actual root cause so a reader doesn't have to reverse-engineer
    // it from a later "Unknown parser"/"no description" symptom.
    expect(stderr).toContain("stale or duplicate");
  });
});
