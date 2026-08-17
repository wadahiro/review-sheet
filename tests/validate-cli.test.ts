// `validate` used to read one syntax (JSON) and know two documents (a model and
// a review). Every other document the pipeline reads — a dictionary, its
// overlay — is YAML, so pointing this at one failed on the first `#` of the
// generated header, which reads as "malformed" when nothing is wrong with it.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const work = mkdtempSync(join(tmpdir(), "review-sheet-validate-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const write = (name: string, body: string): string => {
  const p = join(work, name);
  writeFileSync(p, body);
  return p;
};

function run(...args: string[]) {
  const proc = Bun.spawnSync(["bun", "run", cli, "validate", ...args]);
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const DICT = `# a generated header, which is why this is not JSON
product: demo
version: "1"
provenance: official
coverage: partial
parameters:
  listen_port:
    description:
      en: The port
    default: "8080"
    group: core
`;

const OVERLAY = `product: demo
version: "1"
parameters:
  listen_port:
    description:
      ja: ポート
`;

const MODEL = JSON.stringify({
  sheets: [{ name: "s", categories: [{ name: "c", params: [{ key: "k", value: "v", description: "d" }] }] }],
});

describe("validate: a dictionary", () => {
  it("reads YAML, and says what it checked", () => {
    const r = run("-i", write("demo@1.yml", DICT));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Dictionary: OK");
    expect(r.stdout).toContain("demo@1");
    expect(r.stdout).toContain("1 parameter");
  });

  it("fails on a field the dictionary schema does not define", () => {
    const r = run("-i", write("bad@1.yml", DICT + "  other:\n    descriptoin:\n      en: x\n"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/descriptoin|description/);
  });
});

describe("validate: an overlay", () => {
  it("is told from a dictionary by the name the pipeline looks it up under", () => {
    // An overlay is a strict SUBSET of a dictionary, so it passes as one — and
    // saying "Dictionary: OK" would claim a check that never ran.
    const r = run("-i", write("demo@1.overlay.yml", OVERLAY));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Dictionary overlay: OK");
  });

  it("rejects a dictionary-only field, which is the whole reason it is checked separately", () => {
    const r = run("-i", write("demo@2.overlay.yml", OVERLAY + "    default: \"8080\"\n"));
    expect(r.code).toBe(1);
  });
});

describe("validate: the documents it already knew", () => {
  it("still validates a model", () => {
    const r = run("-i", write("model.json", MODEL));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Model: OK");
  });

  it("still validates a review document", () => {
    const r = run("-i", write("review.json", JSON.stringify({ schema_version: "2.0", created_at: "2026-01-01", reviews: [] })));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Review document: OK");
  });
});

describe("validate: the schema name", () => {
  it("refuses one it does not know, instead of checking the wrong thing", () => {
    // The old default silently fell back to the model schema, so `-s dictionry`
    // reported a dictionary as a malformed model.
    const r = run("-i", write("d@1.yml", DICT), "-s", "dictionry");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("did you mean");
    expect(r.stderr).toContain("dictionary");
  });

  it("is still honoured when given", () => {
    const r = run("-i", write("plain.yml", OVERLAY), "-s", "overlay");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Dictionary overlay: OK");
  });
});
