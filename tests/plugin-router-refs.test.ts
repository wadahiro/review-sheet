// A ROW THAT DOES NOT HOLD A VALUE, and what answers it.
//
// Some rows hold the REFERENCE an importer was given — `$(env:NAME)` — because
// that is the one spelling the row has across every environment. The product
// holds what the reference resolved to, so comparing them compares a name with
// a value and never matches.
//
// Two ways to resolve it, and they read different things:
//
//   the OBSERVATION  `documents[].substitute` + the observation's own
//                    `substitutions` map: what the importer actually resolved,
//                    supplied by whoever ran it.
//   the MODEL        a router returning an `expected` of its own, read off
//                    another row — for a project whose sheet already carries
//                    each variable's definition, so the collector need not say
//                    a second time what the sheet already says.
//
// This pins the second, end to end, for the shape that made it necessary:
// several rows of one sheet referencing DIFFERENT variables, each resolving to
// a different value, and differently per environment.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, cpSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = realpathSync(resolve(import.meta.dir, ".."));
const FIXTURE = join(ROOT, "tests", "fixtures", "plugin-router-refs");
const CLI = join(ROOT, "src", "cli.ts");

function bare(): string {
  const at = mkdtempSync(join(realpathSync(tmpdir()), "rs-refs-"));
  cpSync(FIXTURE, at, { recursive: true });
  return at;
}

type Results = { results: { status: string; actual?: string; target: { key: string; instance: string } }[] };

async function judged(at: string): Promise<Results> {
  const plan = Bun.spawn(["bun", "run", CLI, "test-plan", "-i", "input.json", "-o", "plan.json"], { cwd: at, stdout: "pipe", stderr: "pipe" });
  const planErr = await new Response(plan.stderr).text();
  expect(await plan.exited, planErr).toBe(0);
  const p = Bun.spawn(
    ["bun", "run", CLI, "judge", "-i", "input.json", "--plan", "plan.json", "--observations", "obs-stg.json", "obs-prod.json", "-o", "out.json", "--lang", "en"],
    { cwd: at, stdout: "pipe", stderr: "pipe" }
  );
  const err = await new Response(p.stderr).text();
  expect(await p.exited, err).toBe(0);
  return JSON.parse(readFileSync(join(at, "out.json"), "utf-8")) as Results;
}

const answered = (out: Results, key: string, instance: string): { status: string; actual?: string } => {
  const r = out.results.find((x) => x.target.key === key && x.target.instance === instance);
  if (r === undefined) throw new Error(`no result for ${key} [${instance}]`);
  return r;
};

describe("a router that resolves what a row expects", () => {
  it("answers two rows from two different variables", async () => {
    const out = await judged(bare());
    expect(answered(out, "poc-oidc.rootUrl", "prod").status).toBe("pass");
    expect(answered(out, "poc-saml.entityId", "prod").status).toBe("pass");
  });

  // Per environment, from that environment's own definition row. The two
  // variables resolve to four values across two environments, and a lookup that
  // took the first match would answer three of them with the wrong one.
  it("resolves each environment from its own rows", async () => {
    const out = await judged(bare());
    for (const instance of ["stg", "prod"]) {
      expect(answered(out, "poc-oidc.rootUrl", instance).status).toBe("pass");
      expect(answered(out, "poc-saml.entityId", instance).status).toBe("pass");
    }
  });

  // The resolution has to be REAL: when the document holds something else, the
  // row fails and the record says what the document held — not the reference.
  it("fails when the product holds something the variable does not say", async () => {
    const at = bare();
    const obs = JSON.parse(readFileSync(join(at, "obs-prod.json"), "utf-8")) as {
      hosts: Record<string, { documents: { text: string }[] }>;
    };
    const doc = JSON.parse(obs.hosts["node1"]!.documents[0]!.text) as { "poc-oidc": { rootUrl: string } };
    doc["poc-oidc"].rootUrl = "https://somewhere-else.example.com";
    obs.hosts["node1"]!.documents[0]!.text = JSON.stringify(doc, null, 2);
    writeFileSync(join(at, "obs-prod.json"), JSON.stringify(obs));
    const got = answered(await judged(at), "poc-oidc.rootUrl", "prod");
    expect(got.status).toBe("fail");
    expect(got.actual).toBe("https://somewhere-else.example.com");
    // …and the OTHER environment still passes, so this is one row's answer and
    // not the resolution collapsing.
    expect(answered(await judged(at), "poc-saml.entityId", "prod").status).toBe("pass");
  });

  // …and the OTHER resolution, on the same entry. `substitute:` is the
  // importer's own placeholder pattern, resolved from the observation's map —
  // what the importer actually did, which only whoever ran it can say. It used
  // to be declared and do nothing here: the router branch returned before the
  // substitution step, so an entry carrying both silently applied one.
  it("still applies the observation's substitutions on a routed sheet", async () => {
    const out = await judged(bare());
    // The variable behind this row is on no sheet — only the observation says
    // what it resolved to — so nothing but that path can have answered it.
    expect(answered(out, "poc-oidc.adminUrl", "prod").status).toBe("pass");
    expect(answered(out, "poc-oidc.adminUrl", "stg").status).toBe("pass");
  });

  // A row the router hands back is the project's own input, not a product
  // field: the variable definitions answer to nothing in the document.
  it("leaves the definition rows unanswered", async () => {
    const out = await judged(bare());
    expect(answered(out, "OIDC_HOST", "prod").status).toBe("not_run");
  });
});
