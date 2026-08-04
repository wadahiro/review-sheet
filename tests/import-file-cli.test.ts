import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// P10 bug 1: `import -f` mixing several files used to silently drop any file
// that yielded ZERO parameters the moment at least one OTHER file in the same
// call produced something — "Extracted N parameter(s) from M file(s)" counted
// the empty file in M with no sign it contributed nothing. These tests run
// the real CLI (Bun.spawnSync) end to end, since the bug is specifically
// about what reaches stderr/exit code, not just buildInputWithReport's return
// value (covered separately in extract.test.ts).

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const work = mkdtempSync(join(tmpdir(), "review-sheet-import-file-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runImport(...args: string[]) {
  const proc = Bun.spawnSync(["bun", "run", cli, "import", ...args]);
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("import -f — zero-extraction files are never silent (P10 bug 1)", () => {
  const workingConf = join(work, "httpd.conf");
  writeFileSync(workingConf, "ServerRoot /etc/httpd\nListen 80\nServerName www.example.com\n");

  // Genuinely nothing to extract — a comments-only file, so this is
  // deterministic regardless of which parser auto-detection happens to pick
  // (unlike a misdetection, this isn't fixed by P10 bug 3's httpd.ts change;
  // it is the plain "any file contributing zero rows must not be silent"
  // case the report exists for).
  const emptyConf = join(work, "empty.conf");
  writeFileSync(emptyConf, "# nothing here, just comments\n; and more comments\n");

  it("a single file that extracts nothing still hard-fails, and now also names the parser it tried", () => {
    const run = runImport("-f", emptyConf, "-o", join(work, "out-single.json"));
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("No parameters extracted");
    expect(run.stderr).toContain("0 parameters extracted from");
    expect(run.stderr).toContain(emptyConf);
    expect(run.stderr).toContain("parser: sysctl");
    expect(run.stderr).toContain("--format");
  });

  it("mixing a working file with an empty one still succeeds, but warns by name and parser for the empty one", () => {
    const out = join(work, "out-mixed.json");
    const run = runImport("-f", workingConf, emptyConf, "-o", out);
    expect(run.code).toBe(0);
    // The working file's 3 params are still all that's counted — empty.conf
    // (comments only) contributes 0.
    expect(run.stderr).toContain("Extracted 3 parameter(s) from 2 file(s)");
    expect(run.stderr).toContain(`Warning: 0 parameters extracted from ${emptyConf}`);
    expect(run.stderr).not.toContain(`0 parameters extracted from ${workingConf}`);
  });

  it("two files that both extract cleanly produce no zero-extraction warning at all", () => {
    const other = join(work, "other.conf");
    writeFileSync(other, "ServerAdmin root@localhost\nTimeout 60\n");
    const run = runImport("-f", workingConf, other, "-o", join(work, "out-clean.json"));
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain("0 parameters extracted from");
  });
});
