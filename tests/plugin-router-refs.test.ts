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
import { buildTestPlan } from "../src/testplan";
import { registerDocumentRouter } from "../src/channel";
import { judgeFiles } from "../src/judge";
import type { TestItem } from "../src/testplan";
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

// A DEFINITION ROW TAKEN OUT OF REVIEW SCOPE.
//
// `out_of_scope` says this row is not reviewed. It does NOT say the row states
// no value — and another row's expected value may be a reference to it. For as
// long as a router could only read `ctx.items`, the two were one fact: taking
// the variable row out of scope stopped the reference resolving, and the row
// that then failed was a DIFFERENT row, in another category, which nobody had
// touched. Measured on this fixture before the fix: `poc-oidc.rootUrl` failed
// with the right actual value and the raw `$(env:…)` as its expectation, while
// its sibling — whose own variable was still in scope — passed.
describe("a definition row the project does not review", () => {
  const withOosDefinition = (): string => {
    const at = bare();
    const file = join(at, "input.json");
    const input = JSON.parse(readFileSync(file, "utf-8")) as {
      sheets: { categories: { params?: { key: string; out_of_scope?: unknown }[] }[] }[];
    };
    for (const c of input.sheets[0]!.categories) {
      for (const prm of c.params ?? []) {
        if (prm.key === "OIDC_HOST") prm.out_of_scope = { reason: { en: "recorded for reference only" } };
      }
    }
    writeFileSync(file, JSON.stringify(input));
    return at;
  };

  it("still resolves a reference to it", async () => {
    const out = await judged(withOosDefinition());
    expect(answered(out, "poc-oidc.rootUrl", "prod").status).toBe("pass");
    expect(answered(out, "poc-oidc.rootUrl", "stg").status).toBe("pass");
  });

  // …per environment, as before: the row it resolves through is the one for
  // THIS environment, whether or not that row is being reviewed. Witnessed by
  // giving prod's document the value STG's row states — which passes only if
  // the resolution took the wrong environment's row.
  it("resolves it from this environment's own row", async () => {
    const at = withOosDefinition();
    const obs = JSON.parse(readFileSync(join(at, "obs-prod.json"), "utf-8")) as {
      hosts: Record<string, { documents: { text: string }[] }>;
    };
    const doc = JSON.parse(obs.hosts["node1"]!.documents[0]!.text) as { "poc-oidc": { rootUrl: string } };
    doc["poc-oidc"].rootUrl = "https://oidc-stg.example.com";
    obs.hosts["node1"]!.documents[0]!.text = JSON.stringify(doc, null, 2);
    writeFileSync(join(at, "obs-prod.json"), JSON.stringify(obs));
    const got = answered(await judged(at), "poc-oidc.rootUrl", "prod");
    expect(got.status).toBe("fail");
    expect(got.actual).toBe("https://oidc-stg.example.com");
  });

  // And `out_of_scope` still means what it says: no item, so nothing to answer.
  // This is the half that must NOT change — the fix adds a second reading of
  // the model, it does not widen what is being tested.
  it("is still not tested itself", async () => {
    const out = await judged(withOosDefinition());
    expect(out.results.filter((r) => r.target.key === "OIDC_HOST")).toHaveLength(0);
  });

  // The untouched sibling, as a control: it passed before the fix too, so a run
  // where BOTH pass is the fix and not the fixture agreeing with itself.
  it("leaves the row that references an in-scope variable alone", async () => {
    const out = await judged(withOosDefinition());
    expect(answered(out, "poc-saml.entityId", "prod").status).toBe("pass");
  });
});

// The plan's own half of it: the value is carried for a row that produces no
// item, which is what the judge composes `ctx.stated` from.
describe("what the plan says about a row it does not test", () => {
  const sheet = (extra: Record<string, unknown>) =>
    ({
      metadata: { title: "t" },
      groups: [{ name: "g", test: { method: { en: "m" }, functional: [{ id: "f", text: { en: "the login test" } }] } }],
      sheets: [
        {
          name: "s",
          group: "g",
          instances: ["stg"],
          categories: [{ name: "c", params: [{ key: "HOST", value: "https://h.example.com", ...extra }, { key: "other", value: "1" }] }],
        },
      ],
    }) as never;

  it("carries what an out-of-scope row states", () => {
    const { plan } = buildTestPlan(sheet({ out_of_scope: { reason: { en: "reference only" } } }));
    expect(plan.unchecked).toEqual([{ target: { sheet: "s", path: ["c"], key: "HOST", instance: "stg" }, expected: "https://h.example.com" }]);
  });

  // The same for a row answered by a test rather than by its value: it is not
  // tested here either, and a reference to it must still resolve.
  it("carries what a covered-elsewhere row states", () => {
    const { plan } = buildTestPlan(sheet({ covered_by: { reason: { en: "checked by the login test" }, functional: "f" } }));
    expect((plan.unchecked ?? []).map((u) => u.target.key)).toEqual(["HOST"]);
  });

  // A plan with nothing out of scope reads exactly as it always did.
  it("says nothing when every row is tested", () => {
    expect(buildTestPlan(sheet({})).plan.unchecked).toBeUndefined();
  });

  // A CREDENTIAL'S VALUE DOES NOT TRAVEL. The item path withholds it (`quiet`),
  // and this list has to withhold it too — a credential is the commonest thing
  // a project puts out of review scope, so it is the ordinary case here. The
  // plan goes to whoever runs the test.
  it("withholds the value of a secret row", () => {
    const { plan } = buildTestPlan(sheet({ out_of_scope: { reason: { en: "reference only" } }, secret: true }));
    expect(plan.unchecked).toEqual([{ target: { sheet: "s", path: ["c"], key: "HOST", instance: "stg" }, quiet: true }]);
    expect(JSON.stringify(plan)).not.toContain("h.example.com");
  });
});


// WHAT THE ROUTER IS HANDED, exactly — because the two lists answer different
// questions and the fix must not blur them. `ctx.stated` gains the row nobody
// reviews; `ctx.items` must not, or a channel iterating "what is being tested"
// silently starts counting rows the project put outside the remit.
describe("the two lists a router sees", () => {
  const seen: { items: string[]; stated: string[] }[] = [];
  registerDocumentRouter({
    name: "records-what-it-got",
    route: (item, ctx) => {
      seen.push({
        items: (ctx?.items ?? []).map((x: TestItem) => x.target.key),
        stated: (ctx?.stated ?? []).map((x) => x.target.key),
      });
      return { document: "d", address: item.target.key };
    },
  });

  const input = {
    metadata: { title: "t" },
    groups: [{ name: "g", test: { method: { en: "m" } } }],
    documents: [{ sheet: "s", router: "records-what-it-got" }],
    sheets: [
      {
        name: "s",
        group: "g",
        instances: ["stg"],
        categories: [
          {
            name: "c",
            params: [
              { key: "HOST", value: "https://h.example.com", out_of_scope: { reason: { en: "reference only" } } },
              { key: "rootUrl", value: "$(env:HOST)", source: { path: "rootUrl" } },
            ],
          },
        ],
      },
    ],
  } as never;

  it("adds the unreviewed row to stated and to nothing else", () => {
    seen.length = 0;
    const { plan } = buildTestPlan(input);
    judgeFiles(
      plan,
      [{ environment: "stg", hosts: { h1: { files: {}, documents: [{ name: "d", format: "json", text: "{}" }] } } }] as never,
      { at: "X", lang: "en", documents: [{ sheet: "s", router: "records-what-it-got" }] }
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.stated).toContain("HOST");
    // The half that must not move.
    expect(seen[0]!.items).not.toContain("HOST");
    expect(seen[0]!.items).toEqual(["rootUrl"]);
  });

  // …and a secret row is in neither, because its value never left the sheet.
  it("does not offer a secret row as a resolution", () => {
    seen.length = 0;
    const withSecret = JSON.parse(JSON.stringify(input)) as {
      sheets: { categories: { params: { key: string; secret?: boolean }[] }[] }[];
    };
    withSecret.sheets[0]!.categories[0]!.params[0]!.secret = true;
    const { plan } = buildTestPlan(withSecret as never);
    judgeFiles(
      plan,
      [{ environment: "stg", hosts: { h1: { files: {}, documents: [{ name: "d", format: "json", text: "{}" }] } } }] as never,
      { at: "X", lang: "en", documents: [{ sheet: "s", router: "records-what-it-got" }] }
    );
    expect(seen[0]!.stated).not.toContain("HOST");
  });
});
