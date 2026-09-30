// A DOCUMENT THAT BELONGS TO NO HOST.
//
// A `terraform plan` describes a cloud account, not a machine: which
// workstation ran the command is provenance of the FETCH and not of the
// values, and a reader checking `idle_timeout = 60` does not care whose laptop
// it was.
//
// `documents` existed only under a host, so such a document had to be filed
// under an invented one (`localhost`) — which then appeared in the unit's
// "hosts checked" line and in front of every evidence label, naming a machine
// that has nothing to do with what the record certifies. Worse, renaming the
// host to something meaningful duplicated the `how`: `[terraform terraform
// plan …]`. The host was a map key the model demanded, not a fact anybody
// stated.
//
// No flag says so: where the document sits does.

import { describe, it, expect } from "bun:test";
import { judgeFiles, evidenceFrom } from "../src/judge";
import { evidencePreviews } from "../src/evidence";
import { renderTestDoc } from "../src/testdoc";
import { validateObservation } from "../src/validate";
import type { TestPlan } from "../src/testplan";

const PLAN = {
  metadata: { title: "t" },
  units: [{ name: "u", label: { ja: "AWS 基盤" }, declaration: { method: { ja: "plan と突き合わせる" } }, sheets: ["aws"] }],
  items: [
    {
      target: { sheet: "aws", path: ["alb"], key: "idle_timeout", instance: "prod" },
      unit: "u",
      sheetLabel: { ja: "ALB" },
      component: "alb",
      kind: "value",
      decider: "project",
      expected: "60",
      address: "resource_changes[address=aws_lb.this].change.after.idle_timeout",
    },
  ],
  functional: [],
} as unknown as TestPlan;

const PLAN_JSON = JSON.stringify({
  format_version: "1.2",
  terraform_version: "1.9.5",
  resource_changes: [{ address: "aws_lb.this", change: { actions: ["no-op"], after: { idle_timeout: "60" } } }],
});

const HOW = "terraform show -json (prod)";

// No hosts at all — the thing being judged is an account, and nothing was read
// from a machine.
const obs = () =>
  [
    {
      environment: "prod",
      collected_at: "2026-09-30T01:00:00Z",
      hosts: {},
      documents: [{ sheet: "aws", format: "json", how: HOW, text: PLAN_JSON }],
    },
  ] as never;

const judged = () => judgeFiles(PLAN, obs(), { at: "2026-09-30T01:00:00Z", lang: "ja", idFields: ["address"] });

describe("a document filed under no host", () => {
  it("answers the rows it holds", () => {
    expect(judged().results[0]!.status).toBe("pass");
  });

  // The whole point: no invented machine anywhere in the verdict.
  it("gives the verdict no host", () => {
    const ev = judged().results[0]!.evidence as { host?: string; command?: string };
    expect(ev.host).toBeUndefined();
    expect(ev.command).toBe(HOW);
  });

  it("carries the bytes without one either", () => {
    const carried = evidenceFrom(obs(), PLAN);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.host).toBeUndefined();
    expect(carried[0]!.command).toBe(HOW);
  });
});

describe("what the record shows for it", () => {
  const rendered = () => {
    const out = judged();
    const results = { runs: { prod: { at: "2026-09-30T01:00:00Z" } }, results: out.results, evidence: evidenceFrom(obs(), PLAN) };
    return renderTestDoc(PLAN, results as never, "u", {})["test:items"];
  };

  // The label is what was ASKED, with nothing in front of it — so a `how` that
  // already names the tool no longer reads `terraform terraform show …`.
  it("labels the evidence with the how alone", () => {
    expect(rendered()).toContain(`[${HOW}]`);
  });

  // The heading does not name a machine, because none was read. (The unit's
  // own host line is asked of its answers — see testdoc's own tests.)
  it("names no host in the heading", () => {
    expect(rendered()).toContain("対象ホスト: —");
  });
});

describe("the evidence document a delivery carries", () => {
  const cited = (id: string) => new Map([[id, "aws"]]);

  // The id is the address a delivered record links to, so the spelling WITH a
  // host must not move — every set already handed over links by it.
  it("keeps the hosted spelling byte for byte", () => {
    const [doc] = evidencePreviews(
      { results: [], evidence: [{ instance: "prod", host: "web01", at: "T", sheet: "aws", path: "/etc/x", text: "a\n" }] } as never,
      undefined,
      cited("observed prod web01 /etc/x")
    );
    expect(doc!.id).toBe("observed prod web01 /etc/x");
  });

  // …and a hostless one drops the SEGMENT rather than carrying a blank where
  // the machine would go.
  it("drops the host segment when there is no host", () => {
    const id = `observed prod ${HOW}`;
    const [doc] = evidencePreviews(
      { results: [], evidence: [{ instance: "prod", at: "T", sheet: "aws", command: HOW, text: "a\n" }] } as never,
      undefined,
      cited(id)
    );
    expect(doc!.id).toBe(id);
    expect(doc!.observed?.host).toBeUndefined();
    expect(doc!.observed?.at).toBe("T");
  });
});

describe("what the observation schema says about it", () => {
  it("accepts documents beside hosts", () => {
    expect(() =>
      validateObservation({ environment: "prod", hosts: {}, documents: [{ format: "json", text: "{}", sheet: "aws" }] })
    ).not.toThrow();
  });

  // The schema is open on purpose — a project's own channels ride along beside
  // the fields this tool reads — so an unknown key cannot be refused…
  it("still allows a project's own keys", () => {
    expect(() => validateObservation({ environment: "prod", hosts: { h1: { files: {}, ldap: { whatever: 1 } } } })).not.toThrow();
  });

  // …but a NEAR-MISS of a declared name is not one of those: it is a key
  // somebody wrote intending one this tool reads, and the openness would
  // swallow it — the documents never arrive and every row reads "not run".
  it("refuses a misspelling of a key it does read", () => {
    expect(() => validateObservation({ environment: "prod", hosts: { h1: { files: {}, documnets: [] } } })).toThrow(
      /documnets.*did you mean "documents"/
    );
  });

  it("catches one at the top level too", () => {
    expect(() => validateObservation({ environment: "prod", hosts: {}, docments: [] })).toThrow(/did you mean "documents"/);
  });
});
