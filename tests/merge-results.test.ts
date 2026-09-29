// SEVERAL RUNS, ONE RECORD.
//
// A results file is what one run produced, and a run answers one environment.
// A record covering several environments is therefore several files, collected
// at different moments by whoever could reach each — and reading only one of
// them wrote "not run" over every row of the others.

import { describe, it, expect } from "bun:test";
import { mergeResults } from "../src/testresults";
import type { TestResults } from "../src/testresults";

const run = (instance: string, at: string | undefined, status: "pass" | "fail"): TestResults =>
  ({
    ...(at === undefined ? {} : { runs: { [instance]: { at, hosts: ["h1"] } } }),
    results: [{ target: { sheet: "s", key: "k", instance }, status, detail: at ?? "unstamped" }],
    functional: [{ unit: "u", id: "f", item: "works", instance, status }],
    evidence: [{ instance, host: "h1", at: at ?? "", sheet: "s", path: "/etc/x", text: at ?? "unstamped" }],
    unclaimed: [{ instance, what: `left over in ${instance}` }],
  }) as TestResults;

const of = (...files: TestResults[]) => mergeResults(files);

describe("two runs of different environments", () => {
  const { merged, conflicts } = of(run("local", "2026-01-01T00:00:00Z", "pass"), run("prod", "2026-01-02T00:00:00Z", "fail"));

  it("keeps both", () => {
    expect(merged.results.map((r) => r.target.instance).sort()).toEqual(["local", "prod"]);
  });

  // Every list the record is made of, not just the verdicts: a page built from
  // the merge cites evidence and prints functional answers too.
  it("keeps every part of both", () => {
    expect(Object.keys(merged.runs ?? {}).sort()).toEqual(["local", "prod"]);
    expect((merged.functional ?? []).length).toBe(2);
    expect((merged.evidence ?? []).length).toBe(2);
    expect((merged.unclaimed ?? []).length).toBe(2);
  });

  it("has nothing to report", () => {
    expect(conflicts).toEqual([]);
  });
});

describe("two runs of ONE environment", () => {
  const older = run("local", "2026-01-01T00:00:00Z", "fail");
  const newer = run("local", "2026-02-01T00:00:00Z", "pass");

  // By the run's own timestamp, never by argument order: the order of a shell
  // line is a fact about the shell line.
  it("keeps the later one whichever way round they are given", () => {
    for (const merged of [of(older, newer).merged, of(newer, older).merged]) {
      expect(merged.results[0]!.status).toBe("pass");
      expect(merged.runs?.local?.at).toBe("2026-02-01T00:00:00Z");
    }
  });

  // WHOLESALE. Splicing a fresh pass onto a stale run's evidence makes the
  // record cite bytes that verdict was never read from.
  it("takes its evidence and its functional answers with it", () => {
    const { merged } = of(older, newer);
    expect((merged.evidence ?? []).map((e) => e.text)).toEqual(["2026-02-01T00:00:00Z"]);
    expect((merged.functional ?? []).map((f) => f.status)).toEqual(["pass"]);
    expect((merged.unclaimed ?? []).length).toBe(1);
  });

  it("says which run it dropped", () => {
    const { conflicts } = of(older, newer);
    expect(conflicts.join(" ")).toContain("local");
    expect(conflicts.join(" ")).toContain("2026-01-01T00:00:00Z");
  });
});

describe("a run that does not say when it ran", () => {
  // Older files carry no `runs` at all. The environment is still answered — it
  // is in the results — and, saying nothing about when, it loses.
  it("loses to one that does", () => {
    const { merged } = of(run("local", undefined, "fail"), run("local", "2026-01-01T00:00:00Z", "pass"));
    expect(merged.results[0]!.status).toBe("pass");
  });

  // THE ROWS ARE NOT LOST. An older file carries no `runs`, so the environment
  // it answers has to be read off the rows themselves — otherwise it speaks for
  // nothing, every one of its rows is dropped as somebody else's, and the
  // record comes back "not run" for a whole environment that was judged.
  it("keeps its rows beside another file's environment", () => {
    const { merged } = of(run("local", undefined, "fail"), run("prod", "2026-01-01T00:00:00Z", "pass"));
    expect(merged.results.map((r) => r.target.instance).sort()).toEqual(["local", "prod"]);
    expect((merged.evidence ?? []).length).toBe(2);
  });

  // …read off the VERDICTS, and off the functional answers, because a file may
  // carry either without the other. Each is the only witness in its own case.
  it("reads the environment off whichever list the file has", () => {
    const verdictsOnly = { results: [{ target: { sheet: "s", key: "k", instance: "local" }, status: "pass" }] } as TestResults;
    const functionalOnly = {
      results: [],
      functional: [{ unit: "u", id: "f", item: "works", instance: "qa", status: "pass" }],
    } as unknown as TestResults;
    const other = run("prod", "2026-01-01T00:00:00Z", "pass");
    expect(of(verdictsOnly, other).merged.results.map((r) => r.target.instance).sort()).toEqual(["local", "prod"]);
    expect((of(functionalOnly, other).merged.functional ?? []).map((f) => f.instance).sort()).toEqual(["prod", "qa"]);
  });

  it("still wins against nothing", () => {
    const { merged } = of(run("local", undefined, "fail"));
    expect(merged.results[0]!.status).toBe("fail");
  });

  // Two of them cannot be told apart, so the first is kept and it is said.
  it("keeps the first of two, and says so", () => {
    const { merged, conflicts } = of(run("local", undefined, "fail"), run("local", undefined, "pass"));
    expect(merged.results[0]!.status).toBe("fail");
    expect(conflicts.join(" ")).toContain("neither says when");
  });

  // The shape a real project produces: a file that answers the whole plan carries
  // `not_run` placeholders for the environments its own run never touched. Two
  // files agreeing that nobody ran `qa` have dropped nothing.
  it("says nothing when both sides only carry placeholders", () => {
    const placeholder = (instance: string): TestResults =>
      ({ results: [{ target: { sheet: "s", key: "k", instance }, status: "not_run", reason: "not this run" }] }) as TestResults;
    const { merged, conflicts } = of(placeholder("qa"), placeholder("qa"));
    expect(merged.results).toHaveLength(1);
    expect(conflicts).toEqual([]);
  });

  // The same, one side stamped: a run that judged `qa` beside a file that merely
  // carries its placeholders. The placeholders lose and are worth no sentence,
  // whichever order the two arrive in.
  it("says nothing when the loser only carries placeholders", () => {
    const placeholder = (instance: string): TestResults =>
      ({ results: [{ target: { sheet: "s", key: "k", instance }, status: "not_run", reason: "not this run" }] }) as TestResults;
    const judged = run("qa", "2026-01-01T00:00:00Z", "pass");
    expect(of(judged, placeholder("qa")).conflicts).toEqual([]);
    expect(of(placeholder("qa"), judged).conflicts).toEqual([]);
    expect(of(placeholder("qa"), judged).merged.results[0]!.status).toBe("pass");
  });
});

describe("what a single file does", () => {
  // Identity: everything below this change reads the same object it always did.
  it("is handed back exactly as it came", () => {
    const one = run("local", "2026-01-01T00:00:00Z", "pass");
    expect(of(one).merged).toBe(one);
  });

  it("is an empty record when there are no files at all", () => {
    expect(of().merged).toEqual({ results: [] });
  });
});
