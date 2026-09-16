// A ROUTER A PROJECT WROTE, reached end to end.
//
// `document:` takes a template with three placeholders — `{component}`,
// `{key}`, `{address}` — and matches the filled-in string against a document's
// name. That is a table, and it covers the case where a component and a key
// name the document between them. It does not cover a component holding several
// KINDS of document: the settings of a store and the list of its mappers come
// back as two, under one component, and no combination of the three says which.
//
// The answer is not more placeholders. A router IS a function, registered by
// name from a module in the project's own probe-rule directory, and it says
// both halves at once — which document, and where in it the row sits. This
// pins that a PROJECT can write one: nothing in the tool's own suite did,
// while a project's ability to depends on the rules directory being loaded
// before anything is judged and on the registry being the one judge reads.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, cpSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = realpathSync(resolve(import.meta.dir, ".."));
const FIXTURE = join(ROOT, "tests", "fixtures", "plugin-router");
const CLI = join(ROOT, "src", "cli.ts");

function bare(): string {
  const at = mkdtempSync(join(realpathSync(tmpdir()), "rs-router-"));
  cpSync(FIXTURE, at, { recursive: true });
  return at;
}

async function cli(cwd: string, args: string[]): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(["bun", "run", CLI, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, err };
}

type Results = { results: { status: string }[] };

async function judged(at: string): Promise<{ err: string; said: string; out: Results }> {
  const plan = await cli(at, ["test-plan", "-i", "input.json", "-o", "plan.json"]);
  expect(plan.code, plan.err).toBe(0);
  const p = Bun.spawn(
    ["bun", "run", CLI, "judge", "-i", "input.json", "--plan", "plan.json", "--observations", "obs.json", "-o", "out.json", "--lang", "en"],
    { cwd: at, stdout: "pipe", stderr: "pipe" }
  );
  const [said, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  expect(await p.exited, err).toBe(0);
  return { err, said, out: JSON.parse(readFileSync(join(at, "out.json"), "utf-8")) as Results };
}

describe("a document router a project registered itself", () => {
  it("sends two rows of one component to two different documents", async () => {
    const { out } = await judged(bare());
    // Neither document carries a `sheet` or a `component`, so the fallback that
    // matches on those cannot reach either: the router is the only thing that
    // can have answered these.
    expect(out.results.map((r) => r.status)).toEqual(["pass", "pass"]);
  });

  // A file that registers a router and no probe rule is a working plugin. The
  // load path counted probe rules alone, so it warned that the file had
  // registered nothing — about a file that had.
  it("is not reported as a plugin that registered nothing", async () => {
    const { err } = await judged(bare());
    expect(err).not.toContain("did not gain any entries");
  });

  // A row the router hands back is unanswered rather than filed at a guessed
  // address — the project's statement about what it does not check.
  it("hands back a row its table has no entry for", async () => {
    const at = bare();
    const model = JSON.parse(readFileSync(join(at, "input.json"), "utf-8")) as {
      sheets: { categories: { params: { key: string; value: string; source?: { path: string } }[] }[] }[];
    };
    model.sheets[0]!.categories[0]!.params.push({ key: "unroutable", value: "x", source: { path: "unroutable" } });
    writeFileSync(join(at, "input.json"), JSON.stringify(model));
    const { out, err } = await judged(at);
    // The two routed rows still answer. The third lands `not run` and the run
    // names it — handed back, visibly, rather than filed at a guessed address.
    expect(out.results.map((r) => r.status).sort()).toEqual(["not_run", "pass", "pass"]);
    expect(err).toContain("directories > unroutable");
  });
});

describe("a documents: entry naming a router nothing registered", () => {
  // It used to be indistinguishable from a router declining every row: both
  // left every row of the sheet unanswered, so a misspelled name read as a
  // sheet with no document.
  it("fails the run, and says what is registered", async () => {
    const at = bare();
    const model = JSON.parse(readFileSync(join(at, "input.json"), "utf-8")) as { documents: { router: string }[] };
    model.documents[0]!.router = "store-and-mapper";
    writeFileSync(join(at, "input.json"), JSON.stringify(model));
    await cli(at, ["test-plan", "-i", "input.json", "-o", "plan.json"]);
    const run = await cli(at, ["judge", "-i", "input.json", "--plan", "plan.json", "--observations", "obs.json", "-o", "out.json"]);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain('"store-and-mapper"');
    expect(run.err).toContain('Registered: "store-and-mappers"');
  });
});
