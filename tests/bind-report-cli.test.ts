import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// T4: `import --spec` reports which method (bind.ts's BindMethod, or "none")
// resolved every drafted key against a bound product dictionary. This is
// end-to-end coverage through the real CLI (not just assemble.ts's own unit
// tests) so the stdout/stderr split and --bind-report file both stay honest:
//   - a per-method tally line goes to stderr, alongside the other progress
//     lines (metadata/materialize/verify) `import --spec` already prints;
//   - "normalized" rows (the one tier that succeeds by INFERENCE — see
//     bind.ts's header comment) are listed on stdout, one per line, always —
//     the "did any new inference appear" question a CI job can grep for;
//   - --bind-report <file> writes the full row set (bound rows AND "none"
//     misses) plus the same method summary as one JSON document.
//
// tests/fixtures/bind-report/ deliberately exercises all four methods this
// fixture can reach: widget_port (alias, via an explicit dict_key), my_time_out
// (normalized — normalizeKey("my_time_out") == normalizeKey("MyTimeOut") but
// neither an exact nor an alias match), and stray_thing (none — matches
// nothing in the dictionary at all).

const root = join(import.meta.dir, "..");
const fixture = join(root, "tests", "fixtures", "bind-report");
const cli = join(root, "src", "cli.ts");

const work = mkdtempSync(join(tmpdir(), "review-sheet-bind-report-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

type BindReportRow = { sheet: string; key: string; method: string; dictKey?: string; product?: string; version?: string };
type BindReport = { rows: BindReportRow[]; summary: Record<string, number> };

function runImport(args: string[]): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "run", cli, "import", "--spec", ".review-sheet/build.yml", ...args], { cwd: fixture });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("import --spec dictionary-binding report", () => {
  it("prints a stderr tally and lists normalized rows on stdout, even without --bind-report", () => {
    const out = join(work, "no-report.json");
    const run = runImport(["-o", out]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("bindings: 1 alias, 0 exact, 0 prefix, 0 derived, 0 leaf, 1 normalized, 1 none");
    // Every "normalized" row, and nothing else, lands on stdout.
    expect(run.stdout.trim().split("\n")).toEqual(["normalized: app > my_time_out -> widget@1:MyTimeOut"]);
  });

  it("--bind-report writes one row per drafted parameter, including a method-domain-valid \"none\" row", () => {
    const out = join(work, "with-report.json");
    const report = join(work, "bind-report.json");
    const run = runImport(["-o", out, "--bind-report", report]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(`Wrote ${report}`);

    const doc = JSON.parse(readFileSync(report, "utf-8")) as BindReport;
    // Row count == the number of drafted (bind-target) parameters, not just
    // the ones that resolved — this fixture drafts exactly three.
    expect(doc.rows).toHaveLength(3);
    expect(doc.rows.map((r) => r.method).sort()).toEqual(["alias", "none", "normalized"]);
    expect(new Set(doc.rows.map((r) => r.method))).toEqual(
      new Set(["alias", "exact", "prefix", "leaf", "normalized", "none"].filter((m) => doc.rows.some((r) => r.method === m)))
    );

    const byKey = Object.fromEntries(doc.rows.map((r) => [r.key, r]));
    expect(byKey.widget_port).toEqual({ sheet: "app", key: "widget_port", dictKey: "Port", method: "alias", product: "widget", version: "1" });
    expect(byKey.my_time_out).toEqual({ sheet: "app", key: "my_time_out", dictKey: "MyTimeOut", method: "normalized", product: "widget", version: "1" });
    // A "none" row carries no dictKey/product/version — there is no entry to name.
    expect(byKey.stray_thing).toEqual({ sheet: "app", key: "stray_thing", method: "none" });

    expect(doc.summary).toEqual({ alias: 1, exact: 0, prefix: 0, derived: 0, leaf: 0, normalized: 1, none: 1 });
  });

  it("rejects --bind-report without --spec", () => {
    const proc = Bun.spawnSync(["bun", "run", cli, "import", "-f", join(fixture, "roles/app/defaults/main.yml"), "--bind-report", join(work, "x.json")]);
    expect(proc.exitCode).toBe(1);
    expect(proc.stderr.toString()).toContain("--bind-report requires --spec");
  });
});
