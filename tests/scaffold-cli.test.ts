import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// T5: formalizes a workflow a PoC clean-room user invented on their own —
// run `import --spec` once against an empty `params:`, transcribe the exact
// key list the "no category" error printed straight into sheet.yml. This is
// end-to-end coverage through the real CLI (not just assemble.ts/enrich.ts's
// own unit tests) so the actual failure -> stdout snippet -> --scaffold file
// -> paste -> rebuild loop stays honest, the same way bind-report-cli.test.ts
// covers --bind-report end to end.
//
// tests/fixtures/scaffold-cli/ starts with an EMPTY params: (a real project's
// own starting point) and three base keys (ghost_one/two/three) with no dictionary
// declared at all, so the very first `import --spec` run trips assemble.ts's
// unconditional "no category" check.

const root = join(import.meta.dir, "..");
const fixture = join(root, "tests", "fixtures", "scaffold-cli");
const sheetsFixture = join(root, "tests", "fixtures", "scaffold-cli-sheets");
const cli = join(root, "src", "cli.ts");

const work = mkdtempSync(join(tmpdir(), "review-sheet-scaffold-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runImport(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", cli, "import", "--spec", ".review-sheet/build.yml", ...args], { cwd });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("import --spec scaffold on a strict failure", () => {
  it("prints a paste-able params: snippet on stdout, even without --scaffold", () => {
    const out = join(work, "no-scaffold.json");
    const run = runImport(fixture, ["-o", out]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("assemble: 3 parameter(s) have no category");

    const doc = parseYaml(run.stdout) as { params: Record<string, unknown> };
    expect(Object.keys(doc.params).sort()).toEqual(["ghost_one", "ghost_three", "ghost_two"]);
  });

  it("--scaffold <file> saves the same snippet to disk", () => {
    const out = join(work, "with-scaffold.json");
    const scaffoldFile = join(work, "scaffold.yml");
    const run = runImport(fixture, ["-o", out, "--scaffold", scaffoldFile]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`Wrote ${scaffoldFile}`);

    const saved = readFileSync(scaffoldFile, "utf-8");
    expect(saved.trim()).toBe(run.stdout.trim());
  });

  it("round-trips: pasting the saved snippet into sheet.yml over the empty params: makes the next import --spec succeed", () => {
    const copyDir = join(work, "roundtrip");
    cpSync(fixture, copyDir, { recursive: true });
    const sheetYmlPath = join(copyDir, ".review-sheet", "sheet.yml");
    const scaffoldFile = join(work, "roundtrip-scaffold.yml");

    const first = runImport(copyDir, ["-o", join(work, "roundtrip-1.json"), "--scaffold", scaffoldFile]);
    expect(first.code).toBe(1);

    const scaffold = readFileSync(scaffoldFile, "utf-8");
    const before = readFileSync(sheetYmlPath, "utf-8");
    writeFileSync(sheetYmlPath, before.replace("params: {}\n", "") + scaffold, "utf-8");

    const out = join(work, "roundtrip-2.json");
    const second = runImport(copyDir, ["-o", out]);
    expect(second.code).toBe(0);

    const written = JSON.parse(readFileSync(out, "utf-8")) as { sheets: { categories: { name: string; params?: { key: string }[] }[] }[] };
    const keys = written.sheets[0].categories.flatMap((c) => c.params ?? []).map((p) => p.key).sort();
    expect(keys).toEqual(["ghost_one", "ghost_three", "ghost_two"]);
  });
});

// P6: renderScaffold used to pick flat `params:` vs `sheets: <name>: params:`
// from how many sheets the FAILURE itself spanned — wrong, since the shape
// that matters is the TARGET file's own shape. tests/fixtures/scaffold-cli-
// sheets/ reproduces the exact bug report: a project metadata doc that
// already uses `sheets:` (one sheet, "other", fully documented; the other,
// "app", starts with an empty params:), where the strict failure trips on
// only the ONE sheet ("app"). Before the fix this rendered a flat params:
// fragment that fails loadProjectMeta's own "sheets: and top-level params:
// cannot both be set" check the moment it's pasted in — i.e. the tool's own
// remediation didn't work. This is the same round-trip shape as the describe
// block above (fail -> --scaffold -> paste -> succeed), but for a sheets: doc.
describe("import --spec scaffold shape matches the target sheet.yml (P6)", () => {
  it("a single-sheet failure against a sheets: doc still renders a sheets: fragment, and pasting it in succeeds", () => {
    const copyDir = join(work, "sheets-roundtrip");
    cpSync(sheetsFixture, copyDir, { recursive: true });
    const sheetYmlPath = join(copyDir, ".review-sheet", "sheet.yml");
    const scaffoldFile = join(work, "sheets-roundtrip-scaffold.yml");

    const out = join(work, "sheets-scaffold.json");
    const run = runImport(copyDir, ["-o", out, "--scaffold", scaffoldFile]);
    expect(run.code).toBe(1);
    // The failure names only "app" — "other" is already fully documented.
    expect(run.stderr).toContain("assemble: 3 parameter(s) have no category");
    expect(run.stderr).toContain("app > ghost_one");
    expect(run.stderr).not.toContain("other >");

    // The rendered fragment must be sheets:-shaped (not flat params:), even
    // though this one failure only ever names a single sheet.
    const doc = parseYaml(run.stdout) as { sheets?: Record<string, { params: Record<string, unknown> }>; params?: unknown };
    expect(doc.params).toBeUndefined();
    expect(Object.keys(doc.sheets ?? {})).toEqual(["app"]);
    expect(Object.keys(doc.sheets!.app.params).sort()).toEqual(["ghost_one", "ghost_three", "ghost_two"]);

    // Paste it in: merge the fragment's "app" params: block into the existing
    // sheets: doc's own "app" entry, exactly what the fragment's own leading
    // comment instructs a human reader to do by hand — "other" is untouched.
    const before = parseYaml(readFileSync(sheetYmlPath, "utf-8")) as { sheets: Record<string, { params: Record<string, unknown> }> };
    const scaffold = parseYaml(readFileSync(scaffoldFile, "utf-8")) as { sheets: Record<string, { params: Record<string, unknown> }> };
    before.sheets.app.params = scaffold.sheets.app.params;
    writeFileSync(sheetYmlPath, stringifyYaml(before), "utf-8");

    const out2 = join(work, "sheets-scaffold-2.json");
    const second = runImport(copyDir, ["-o", out2]);
    expect(second.code).toBe(0);

    const written = JSON.parse(readFileSync(out2, "utf-8")) as {
      sheets: { name: string; categories: { params?: { key: string }[] }[] }[];
    };
    const app = written.sheets.find((s) => s.name === "app");
    const appKeys = (app?.categories ?? []).flatMap((c) => c.params ?? []).map((p) => p.key).sort();
    expect(appKeys).toEqual(["ghost_one", "ghost_three", "ghost_two"]);
    const other = written.sheets.find((s) => s.name === "other");
    const otherKeys = (other?.categories ?? []).flatMap((c) => c.params ?? []).map((p) => p.key);
    expect(otherKeys).toEqual(["known_key"]);
  });
});
