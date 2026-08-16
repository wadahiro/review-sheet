import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import diffDemo from "./fixtures/diff-demo.json";
import type { SheetData } from "../src/prompt";

// `diff` prints rows on stdout and the summary on stderr, so in text mode "no
// differences" and "the command failed" both look like an empty stdout. These
// tests cover the machine-readable form that removes that ambiguity.

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const work = mkdtempSync(join(tmpdir(), "review-sheet-diff-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const [v1, v2] = diffDemo.versions as { sheets: SheetData["sheets"] }[];
const base = join(work, "base.json");
const current = join(work, "current.json");
writeFileSync(base, JSON.stringify({ sheets: v1.sheets }));
writeFileSync(current, JSON.stringify({ sheets: v2.sheets }));

function runDiff(a: string, b: string, ...args: string[]) {
  const proc = Bun.spawnSync(["bun", "run", cli, "diff", "-i", a, "-i", b, ...args]);
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("diff --format json", () => {
  it("emits one document with the summary included", () => {
    const run = runDiff(base, current, "--format", "json");
    expect(run.code).toBe(0);
    const doc = JSON.parse(run.stdout) as { summary: Record<string, number>; rows: { status: string }[] };
    expect(doc.summary).toMatchObject({ changed: 5, added: 6, removed: 6 });
    expect(doc.rows.length).toBeGreaterThan(0);
    expect(doc.rows.every((r) => r.status !== "unchanged")).toBe(true);
    // stdout is the single source: no summary duplicated on stderr.
    expect(run.stderr).not.toContain("changed,");
  });

  it("emits a valid document — not an empty stdout — when nothing differs", () => {
    const run = runDiff(base, base, "--format", "json");
    expect(run.code).toBe(0);
    const doc = JSON.parse(run.stdout) as { summary: { changed: number }; rows: unknown[] };
    expect(doc.summary.changed).toBe(0);
    expect(doc.rows).toEqual([]);
  });

  it("lists unchanged rows under --all", () => {
    const run = runDiff(base, current, "--format", "json", "--all");
    const doc = JSON.parse(run.stdout) as { rows: { status: string }[] };
    expect(doc.rows.some((r) => r.status === "unchanged")).toBe(true);
  });

  it("rejects an unknown format instead of falling back to text", () => {
    const run = runDiff(base, current, "--format", "yaml");
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Unknown --format "yaml"');
  });

  it("still splits rows/summary across stdout/stderr in text mode", () => {
    const run = runDiff(base, current);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("~ ");
    // The changed count now names its doc-only share when there is one, so the
    // assertion anchors on the prefix rather than on the punctuation after it.
    expect(run.stderr).toContain("diff: 5 changed");
  });
});

// Comparing two DIFFERENT sheets (e.g. two deployment platforms) for
// equivalence: --equivalence (or its two components) keeps materialize noise
// and structurally-absent sheets from burying the real differences.
describe("diff --equivalence", () => {
  const equivBase = join(work, "equiv-base.json");
  const equivOther = join(work, "equiv-other.json");
  const equivSheets = (extra: object[]): { sheets: SheetData["sheets"] } => ({
    sheets: [
      { name: "shared", categories: [{ name: "C", params: [{ key: "a", value: "1" }, ...extra] as never }] },
      { name: "httpd", categories: [{ name: "C", params: [{ key: "vhost", value: "x" }] as never }] },
    ],
  });
  writeFileSync(equivBase, JSON.stringify(equivSheets([{ key: "b", value: "product-default", origin: "default" }])));
  writeFileSync(equivOther, JSON.stringify({ sheets: [equivSheets([]).sheets[0]] })); // no httpd sheet, no "b"

  it("without the flag: sheet absence and materialize rows are counted as removed, burying nothing", () => {
    const run = runDiff(equivBase, equivOther, "--format", "json");
    const doc = JSON.parse(run.stdout) as { summary: Record<string, number> };
    expect(doc.summary.removed).toBe(2); // "b" (default-origin) + "vhost" (httpd sheet only in baseline)
  });

  it("with --equivalence: both are excluded/reported separately, and it is visible in the JSON", () => {
    const run = runDiff(equivBase, equivOther, "--format", "json", "--equivalence");
    expect(run.code).toBe(0);
    const doc = JSON.parse(run.stdout) as {
      summary: Record<string, number>;
      excluded: { defaultOrigin: number };
      sheetsOnlyOnOneSide: { name: string; onlyIn: string; paramCount: number }[];
      rows: unknown[];
    };
    expect(doc.summary).toMatchObject({ changed: 0, added: 0, removed: 0, unchanged: 1 });
    expect(doc.excluded).toEqual({ defaultOrigin: 1 });
    expect(doc.sheetsOnlyOnOneSide).toEqual([{ name: "httpd", onlyIn: "from", paramCount: 1 }]);
  });

  it("without --equivalence, excluded/sheetsOnlyOnOneSide are still present but empty/zero", () => {
    const run = runDiff(equivBase, equivOther, "--format", "json");
    const doc = JSON.parse(run.stdout) as { excluded: { defaultOrigin: number }; sheetsOnlyOnOneSide: unknown[] };
    expect(doc.excluded).toEqual({ defaultOrigin: 0 });
    expect(doc.sheetsOnlyOnOneSide).toEqual([]);
  });

  it("prints the sheet-only fact and the exclusion count on stdout/stderr in text mode", () => {
    const run = runDiff(equivBase, equivOther, "--equivalence");
    expect(run.stdout).toContain("o httpd: sheet only in the baseline input (1 params, excluded from removed/added counts)");
    expect(run.stderr).toContain("excluded 1 materialize default-origin rows");
    expect(run.stderr).toContain("1 sheet(s) present on only one side");
  });

  it("--exclude-default-origin and --sheet-presence work independently", () => {
    const onlyOrigin = runDiff(equivBase, equivOther, "--format", "json", "--exclude-default-origin");
    const onlyOriginDoc = JSON.parse(onlyOrigin.stdout) as { summary: Record<string, number>; excluded: { defaultOrigin: number } };
    expect(onlyOriginDoc.excluded.defaultOrigin).toBe(1);
    expect(onlyOriginDoc.summary.removed).toBe(1); // httpd's "vhost" still counted removed

    const onlyPresence = runDiff(equivBase, equivOther, "--format", "json", "--sheet-presence");
    const onlyPresenceDoc = JSON.parse(onlyPresence.stdout) as { summary: Record<string, number>; sheetsOnlyOnOneSide: unknown[] };
    expect(onlyPresenceDoc.sheetsOnlyOnOneSide).toHaveLength(1);
    expect(onlyPresenceDoc.summary.removed).toBe(1); // "b" (default-origin) still counted removed
  });
});
