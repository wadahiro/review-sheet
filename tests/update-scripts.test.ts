// Putting the folder back into the page.
//
// Dropping it works and stays the fallback, but it is a gesture the recipient
// has to repeat after every edit — and a page that shows what it was BUILT with
// until somebody drags something is a page that is usually wrong. What is
// pinned here is that the script beside the set produces a page carrying the
// set, and that the page reads it.
//
// The shell script is RUN. The PowerShell one is the same steps for a recipient
// on Windows and is not run here — there is no PowerShell on this machine — so
// what is checked of it is that it is written, and that it looks for the marker
// the page actually carries. That is the honest limit and it is stated rather
// than papered over with a test that only reads its own translation.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { UPDATE_MARKER_OPEN, updateBat, updateSh } from "../src/update-scripts";

const work = mkdtempSync(join(tmpdir(), "review-sheet-update-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-keycloak");
const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");

const generated = (): string => {
  const at = join(work, "set");
  if (!existsSync(at)) {
    const r = Bun.spawnSync(["bun", "run", cli, "generate", "-i", "input.json", "--format", "md", "-o", at], { cwd: project });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString().slice(0, 400));
  }
  return at;
};

describe("what a generated set carries", () => {
  it("writes the scripts beside the viewer", () => {
    const at = generated();
    for (const f of ["update.bat", "update.sh", "viewer.html"]) {
      expect(existsSync(join(at, f)), f).toBe(true);
    }
    // One file per platform. The `.ps1` it used to call is gone: `-File` is
    // what the execution policy governs, so splitting them was solving a
    // problem the split had created.
    expect(existsSync(join(at, "update.ps1"))).toBe(false);
  });

  // The page and the scripts have to agree on one string. They are written by
  // the same module for that reason; this is the check that they still are.
  it("leaves the page a block for the scripts to fill", () => {
    expect(readFileSync(join(generated(), "viewer.html"), "utf-8")).toContain(UPDATE_MARKER_OPEN);
    // Both look for the block by its ID rather than by the whole opening tag —
    // an attribute written in another order would otherwise be a tag neither
    // recognises.
    expect(updateBat()).toContain("sheet-md-set");
    expect(updateSh()).toContain("sheet-md-set");
  });

  // A recipient in a corporate environment is entitled to read what they are
  // about to run. The .bat is the three lines that call the readable one.
  // A locked-down machine runs PowerShell in ConstrainedLanguage mode, where
  // .NET is refused outright — `[IO.File]::ReadAllText` and `New-Object` throw
  // rather than run. That is the configuration this is most likely to meet and
  // the one it would fail on, so what it may use is cmdlets and methods on
  // strings. Asked of the COMMAND, not of the comments that explain the rule.
  it("uses nothing a locked-down machine refuses", () => {
    const ps = updateBat()
      .split("\r\n")
      .filter((l) => l.startsWith("set \"PS="))
      .join("\n");
    expect(ps).not.toContain("New-Object");
    expect(ps).not.toMatch(/\[(?:IO|Text|Environment|Convert|Math|Reflection)\./);
    expect(ps).not.toContain("Add-Type");
    expect(ps).not.toContain("Invoke-Expression");
    // …and what it uses instead.
    expect(ps).toContain("Get-Content");
    expect(ps).toContain("Set-Content");
  });

  // cmd reads a .bat in the machine's own code page, so a character outside
  // ASCII is whatever that code page makes of it — a comment nobody can read on
  // a Japanese Windows, which is exactly who gets this.
  it("is ASCII, because cmd reads it in the machine's code page", () => {
    expect([...updateBat()].filter((c) => c.charCodeAt(0) > 126)).toEqual([]);
  });

  // Every way this can be refused ends at the same place, and the way that
  // needs no script is one line away. A recipient who is told nothing assumes
  // the document is broken.
  it("names the way that needs no script, when it fails", () => {
    const bat = updateBat();
    expect(bat).toContain("if errorlevel 1");
    expect(bat).toContain("drag this folder");
    expect(bat).toContain("Nothing has been changed");
  });

  it("keeps the work readable, and out of the execution policy's way", () => {
    const bat = updateBat();
    // `-Command`, never `-File`: the policy governs script files, and a machine
    // that refuses one will still run this. Asked of the INVOCATION — `-File`
    // is also Get-ChildItem's "files only", which is not what is meant.
    const call = bat.split("\r\n").find((l) => l.startsWith("powershell "))!;
    expect(call).toContain("-Command");
    expect(call).not.toContain("-File");
    expect(bat).not.toContain("ExecutionPolicy");
    // Not an encoded one-liner, which is what a corporate reader is trained to
    // refuse: no line of it is longer than a screen.
    expect(Math.max(...bat.split("\r\n").map((l) => l.length))).toBeLessThan(140);
    expect(bat).not.toContain("EncodedCommand");
  });
});

describe("running it", () => {
  it("writes a page that carries the folder", () => {
    const at = generated();
    const r = Bun.spawnSync(["sh", "update.sh"], { cwd: at });
    expect(r.exitCode, r.stderr.toString().slice(0, 400)).toBe(0);
    expect(existsSync(join(at, "sheet.html"))).toBe(true);

    const html = readFileSync(join(at, "sheet.html"), "utf-8");
    const block = new RegExp(`${UPDATE_MARKER_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)\\n</script>`).exec(html);
    expect(block).not.toBeNull();
    // A `<` anywhere in the text would end the element early and the rest of the
    // page would become markup — which reads as a blank document.
    expect(block![1]!).not.toContain("<");
    const files = JSON.parse(block![1]!.replace(/\\u003c/g, "<")) as { path: string }[];
    expect(files.length).toBeGreaterThan(3);
    expect(files.map((f) => f.path)).toContain("README.md");
    // Not the pages, and not the scripts: a page carrying itself is a page that
    // doubles in size every time it is updated.
    expect(files.some((f) => /\.(html|bat|ps1|sh)$/.test(f.path))).toBe(false);
  });

  it("is the same page run twice", () => {
    const at = generated();
    Bun.spawnSync(["sh", "update.sh"], { cwd: at });
    const once = readFileSync(join(at, "sheet.html"), "utf-8");
    Bun.spawnSync(["sh", "update.sh"], { cwd: at });
    expect(readFileSync(join(at, "sheet.html"), "utf-8")).toBe(once);
  });
});
