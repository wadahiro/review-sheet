// The tool's own judge: a collected file against the sheet that describes it.
//
// What is asserted is the division. Everything a FILE can settle is settled
// here, in this tool's own vocabulary — the parsers, the structural addresses,
// what a row's `kind` means — and everything that needs a second channel to be
// sure is handed back unanswered rather than guessed at.

import { describe, it, expect } from "bun:test";
import "../src/parsers/index";
import { judgeFiles, evidenceFrom, type Observation } from "../src/judge";
import type { TestPlan, TestItem } from "../src/testplan";

const CONF = "/etc/app/app.conf";
// Fixtures carry a second line on purpose: a parser detects the delimiter from
// the FILE, and one line is not enough to tell "Listen 80" from prose.

const item = (over: Partial<TestItem> & { key: string }): TestItem =>
  ({
    target: { sheet: "s", path: ["c"], key: over.key, instance: "stg" },
    unit: "u",
    kind: "value",
    decider: "project",
    file: CONF,
    ...over,
  }) as TestItem;

const planOf = (items: TestItem[]): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { ja: "m" } }, sheets: ["s"] }], items, functional: [] }) as TestPlan;

const obs = (files: Record<string, string | null>, over: Partial<Observation["hosts"][string]> = {}): Observation => ({
  environment: "stg",
  collected_at: "2026-09-11T00:00:00Z",
  hosts: { web01: { files, ...over } },
});

const only = (p: TestPlan, o: Observation[]) => judgeFiles(p, o, { at: "X", lang: "en" });

describe("what a collected file settles", () => {
  it("passes a value the file carries at that address, pointing at the line", () => {
    const got = only(planOf([item({ key: "Listen", expected: "80" })]), [obs({ [CONF]: "Other 1\nListen 80\n" })]);
    expect(got.results[0].status).toBe("pass");
    expect(got.results[0].evidence).toEqual({ host: "web01", file: CONF, line: 2 });
  });

  it("fails one that carries something else, and says what it carries", () => {
    const got = only(planOf([item({ key: "Listen", expected: "80" })]), [obs({ [CONF]: "Other 1\nListen 8080\n" })]);
    expect(got.results[0].status).toBe("fail");
    expect(got.results[0].actual).toBe("8080");
  });

  // A value the plan withheld is withheld here too: the item is judged, and the
  // record gets the verdict without the value.
  it("judges a quiet row and never repeats its value", () => {
    const got = only(planOf([item({ key: "pw", expected: "s3cret", quiet: true })]), [obs({ [CONF]: "Other 1\nMore 2\npw wrong\n" })]);
    expect(got.results[0].status).toBe("fail");
    expect(got.results[0].actual).toBeUndefined();
  });

  it("checks a removed setting by its absence", () => {
    const p = planOf([item({ key: "Gone", kind: "absent", decider: "vendor-removed" })]);
    expect(only(p, [obs({ [CONF]: "Other 1\nListen 80\n" })]).results[0].status).toBe("pass");
    expect(only(p, [obs({ [CONF]: "Other 1\nGone yes\n" })]).results[0].status).toBe("fail");
  });

  // A block holds no value of its own, so "checked" is that it is THERE —
  // everything under it is dead if it is not. Without the plan carrying that
  // fact it looks exactly like a row the sheet states nothing about.
  it("checks a block by its presence, not by a value", () => {
    // A block is proved by what is UNDER it: a parser emits the leaves, and the
    // block's own address is their prefix.
    const p = planOf([item({ key: 'Directory["/var/www"]', container: true })]);
    const held = 'Listen 80\n<Directory "/var/www">\n    AllowOverride None\n</Directory>\n';
    expect(only(p, [obs({ [CONF]: held })]).results[0].status).toBe("pass");
    expect(only(p, [obs({ [CONF]: "Other 1\nListen 80\n" })]).results[0].status).toBe("fail");
  });

  // "We set nothing, so the product's default applies" is a claim about the
  // file — and about every file it reads.
  it("passes an unset row when nothing sets it", () => {
    const p = planOf([item({ key: "Timeout", kind: "default-in-force", decider: "product-default", expected: "60" })]);
    expect(only(p, [obs({ [CONF]: "Other 1\nListen 80\n" })]).results[0].status).toBe("pass");
  });

  it("fails it when the file sets it after all", () => {
    const p = planOf([item({ key: "Timeout", kind: "default-in-force", decider: "product-default", expected: "60" })]);
    const got = only(p, [obs({ [CONF]: "Other 1\nTimeout 5\n" })]);
    expect(got.results[0].status).toBe("fail");
    expect(got.results[0].actual).toBe("5");
  });

  // …and when a file it READS sets it, the verdict points at that file rather
  // than at the one it was asked about. A reader sent to the wrong file to look
  // for a line that is not there is worse off than one sent nowhere.
  it("fails it when a file the subject reads sets it, and names that file", () => {
    const p = planOf([item({ key: "Timeout", kind: "default-in-force", decider: "product-default", expected: "60" })]);
    const got = only(p, [
      obs({ [CONF]: "Other 1\nInclude conf.d/*.conf\n" }, { included_by: { [CONF]: ["/etc/app/conf.d/extra.conf"] }, included: { "/etc/app/conf.d/extra.conf": "Other 1\nTimeout 5\n" } }),
    ]);
    expect(got.results[0].status).toBe("fail");
    expect(got.results[0].evidence?.file).toBe("/etc/app/conf.d/extra.conf");
  });
});

describe("what it refuses to settle", () => {
  it("hands back an item with no deployed file rather than answering it", () => {
    const got = only(planOf([item({ key: "realmName", expected: "x", file: undefined })]), [obs({ [CONF]: "" })]);
    expect(got.results).toEqual([]);
    expect(got.unanswered.map((i) => i.target.key)).toEqual(["realmName"]);
  });

  it("says an environment nobody collected was not run, and dates nothing", () => {
    const got = judgeFiles(planOf([item({ key: "Listen", expected: "80" })]), [], { at: "X", lang: "en" });
    expect(got.results[0].status).toBe("not_run");
    expect(got.results[0].reason).toContain("has not been collected");
    // A date is a claim. Nothing was run against this environment, and a record
    // showing today beside the row says something this run cannot support.
    expect(got.results[0].at).toBeUndefined();
  });

  // A file the sheet says is deployed that the host does not have. Every row of
  // it would say the same thing, so each row says it and the run says it once.
  it("says a file the host does not have was not run, once per file", () => {
    const got = only(planOf([item({ key: "a", expected: "1" }), item({ key: "b", expected: "2" })]), [obs({ [CONF]: null })]);
    expect(got.results.map((r) => r.status)).toEqual(["not_run", "not_run"]);
    expect(new Set(got.missing).size).toBe(1);
  });

  it("says so when the sheet states no value for that environment", () => {
    const got = only(planOf([item({ key: "Listen", expected: undefined })]), [obs({ [CONF]: "Other 1\nListen 80\n" })]);
    expect(got.results[0].status).toBe("not_run");
    expect(got.results[0].reason).toContain("states no value");
  });
});

// A fleet is only as configured as its least configured node.
describe("every host that holds the file", () => {
  it("is judged, not just the first", () => {
    const two: Observation = {
      environment: "stg",
      hosts: { web01: { files: { [CONF]: "Other 1\nListen 80\n" } }, web02: { files: { [CONF]: "Other 1\nListen 8080\n" } } },
    };
    const got = only(planOf([item({ key: "Listen", expected: "80" })]), [two]);
    expect(got.results.map((r) => [r.evidence?.host, r.status])).toEqual([
      ["web01", "pass"],
      ["web02", "fail"],
    ]);
  });
});

describe("the material the verdicts were read from", () => {
  it("is one document per environment, host and file", () => {
    const docs = evidenceFrom(
      [obs({ [CONF]: "Other 1\nListen 80\n" }, { included_by: { [CONF]: ["/etc/app/conf.d/x.conf"] }, included: { "/etc/app/conf.d/x.conf": "Other 1\nTimeout 5\n" } })],
      planOf([item({ key: "Listen", expected: "80" })])
    );
    expect(docs.map((d) => [d.host, d.path])).toEqual([
      ["web01", CONF],
      ["web01", "/etc/app/conf.d/x.conf"],
    ]);
    // …and never twice at one address, even when two files name the same one:
    // the link a verdict carries resolves to whichever came first, so two
    // documents there is a reader shown bytes no verdict was read from.
    const shared = evidenceFrom(
      [
        obs(
          { [CONF]: "Other 1\nListen 80\n", "/etc/app/other.conf": "Other 1\nListen 80\n" },
          {
            included_by: { [CONF]: ["/etc/app/conf.d/x.conf"], "/etc/app/other.conf": ["/etc/app/conf.d/x.conf"] },
            included: { "/etc/app/conf.d/x.conf": "Other 1\nTimeout 5\n" },
          }
        ),
      ],
      planOf([item({ key: "Listen", expected: "80" })])
    );
    expect(shared.filter((d) => d.path === "/etc/app/conf.d/x.conf").length).toBe(1);
    expect(new Set(shared.map((d) => `${d.instance} ${d.host} ${d.path}`)).size).toBe(shared.length);
  });

  it("carries nothing for a file the host does not have", () => {
    expect(evidenceFrom([obs({ [CONF]: null })], planOf([item({ key: "a", expected: "1" })]))).toEqual([]);
  });
});
