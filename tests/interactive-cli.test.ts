import { describe, it, expect } from "bun:test";
import { join } from "path";

// P8: `import --interactive` must be a strict no-op unless BOTH stdin and
// stdout are a real TTY (constraint #1 in the task — a CI job or an agent's
// shell must never hang on a prompt nobody can answer, and must never
// silently behave as if --interactive were absent). Bun.spawnSync gives the
// child ordinary pipes for stdio, never a TTY, so this is exactly the
// "--interactive passed, no TTY" case — the guard must fire before the
// command does anything else (no need for the fixture to even have a strict
// failure: the check runs first).
//
// The full interactive happy path (prompts asked, sheet.yml written,
// rebuild succeeds) is NOT covered here — Bun.spawnSync cannot attach a real
// TTY to the child's stdio, and this project does not want a pty-emulation
// dependency merely to test that. See interactive.test.ts for the pure core
// (question sequencing, answer resolution, comment-preserving write-back)
// and this task's manual demonstration for the real end-to-end run.

const root = join(import.meta.dir, "..");
const fixture = join(root, "tests", "fixtures", "scaffold-cli");
const cli = join(root, "src", "cli.ts");

function runImport(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", cli, "import", "--spec", ".review-sheet/build.yml", ...args], {
    cwd: fixture,
    stdin: "pipe", // explicit: a plain pipe, never a TTY — the case this guard exists for
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("import --interactive requires a TTY", () => {
  it("errors immediately (non-zero exit, explicit message) when stdin/stdout are not a TTY", () => {
    const run = runImport(["-o", "/dev/null", "--interactive"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--interactive requires an interactive terminal");
    expect(run.stderr).toContain("stdin and stdout must both be a TTY");
    // Never falls through to the ordinary scaffold/build attempt.
    expect(run.stderr).not.toContain("assemble: 3 parameter(s) have no category");
  });

  it("without --interactive, behavior is exactly the non-interactive default (unaffected by this guard)", () => {
    const withFlag = runImport(["-o", "/dev/null"]);
    expect(withFlag.code).toBe(1);
    expect(withFlag.stderr).toContain("assemble: 3 parameter(s) have no category");
    expect(withFlag.stderr).not.toContain("--interactive requires an interactive terminal");
  });
});
