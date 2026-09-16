// A plugin names this tool by its package name, and that has to mean THIS
// process — in a project with a node_modules the plugin can see, and in one
// with no node_modules at all.
//
// The second is the configuration that had no answer: a project that keeps the
// tool's path in an environment variable and runs `bun run "$DIR/src/cli.ts"`
// could import `registerProbeRule`'s module from nowhere. The fixture under
// fixtures/plugin-resolve is written the one documented way, and every run here
// starts from a temporary directory with no node_modules above it.
//
// What each CLI case asserts is the JUDGEMENT, not that a file loaded: the
// fixture's rule is the only thing that can answer `cluster-formed`, and it
// answers with a sentence nothing else in the tool says. A resolution that did
// not happen, or a registration that landed in a registry this process does not
// read, both leave that sentence absent.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { selfResolves } from "../src/plugin-resolve";

const ROOT = realpathSync(resolve(import.meta.dir, ".."));
const FIXTURE = join(ROOT, "tests", "fixtures", "plugin-resolve");
const CLI = join(ROOT, "src", "cli.ts");

// A directory with NOTHING above it — no package.json, no node_modules — so a
// bare specifier has no ordinary way to resolve. Under the real temporary
// directory, not a path inside this checkout, or the checkout's own
// node_modules would sit above it and answer.
function bare(): string {
  const at = mkdtempSync(join(realpathSync(tmpdir()), "rs-plugin-"));
  cpSync(FIXTURE, at, { recursive: true });
  return at;
}

async function judge(cwd: string, extra: string[] = []): Promise<{ code: number; err: string; answers: string }> {
  const p = Bun.spawn(
    ["bun", "run", CLI, "judge", "-i", "input.json", "--plan", "plan.json", "--observations", "obs.json", "-o", "out.json", ...extra],
    { cwd, stdout: "pipe", stderr: "pipe" }
  );
  const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  let answers = "";
  try {
    answers = readFileSync(join(cwd, "out.json"), "utf-8");
  } catch {
    // no results file — the run did not get that far, which the caller sees
  }
  return { code, err, answers };
}

describe("what the tool's own name resolves to", () => {
  it("answers with the files this process is running out of", () => {
    expect(selfResolves("review-sheet/src/channel.ts")).toBe(join(ROOT, "src", "channel.ts"));
  });

  // The package's own `main`, not a second copy of it here.
  it("answers a bare name with the package's declared entry point", async () => {
    const main = ((await Bun.file(join(ROOT, "package.json")).json()) as { main: string }).main;
    expect(selfResolves("review-sheet")).toBe(join(ROOT, main));
  });

  // Anchored: a package whose name merely starts with ours is somebody else's.
  it("leaves a package that only starts with the same word alone", () => {
    expect(selfResolves("review-sheet-foo")).toBeUndefined();
    expect(selfResolves("other/review-sheet")).toBeUndefined();
  });
});

describe("a plugin in a project with no node_modules at all", () => {
  it("resolves the tool by name, and its verdict is the one the tool reports", async () => {
    const got = await judge(bare());
    expect(got.code).toBe(0);
    // Two hosts answered, the view names two members, and the fixture compares
    // against the fleet this run collected — so it passes, and it is the only
    // thing in the process that could have said so.
    expect(got.answers).toContain('"status": "pass"');
    expect(got.err).not.toContain("did not gain any entries");
  });

  it("fails the same item when its own comparison fails", async () => {
    const at = bare();
    const obs = JSON.parse(readFileSync(join(at, "obs.json"), "utf-8")) as { hosts: Record<string, unknown> };
    delete obs.hosts["h2"];
    writeFileSync(join(at, "obs.json"), JSON.stringify(obs));
    const got = await judge(at);
    // One host collected, two members in the view: the sentence is the
    // fixture's own, and no other code in this tool produces it.
    expect(got.answers).toContain("2 member(s), expected 1");
  });

  // …and by an explicitly named directory, which is the other way a project
  // points at its rules.
  it("is reached the same way through --rules-dir", async () => {
    const at = bare();
    const got = await judge(at, ["--rules-dir", join(at, ".review-sheet", "rules")]);
    expect(got.code).toBe(0);
    expect(got.answers).toContain('"status": "pass"');
  });
});

describe("a plugin in a project whose node_modules holds a different copy", () => {
  // The precedence claim, and the reason it is worth making: a copy under
  // node_modules would answer the same import by the ordinary rules, and a
  // plugin resolved to it registers into a registry this process does not read.
  it("extends the tool that loaded it, not the copy in node_modules", async () => {
    const at = bare();
    const other = join(at, "node_modules", "review-sheet");
    mkdirSync(join(other, "src", "channels"), { recursive: true });
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "review-sheet", main: "./src/index.ts", type: "module" }));
    // A copy that is LOUD if it is the one used, so this cannot pass by the two
    // copies happening to agree.
    for (const f of ["src/channel.ts", "src/channels/keycloak.ts"]) {
      writeFileSync(join(other, f), 'throw new Error("the node_modules copy answered");\n');
    }
    const got = await judge(at);
    expect(got.err).not.toContain("the node_modules copy answered");
    expect(got.answers).toContain('"status": "pass"');
  });
});
