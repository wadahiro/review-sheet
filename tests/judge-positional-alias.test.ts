// A LIST OF ONE HAS ONE ELEMENT, and both its addresses are that element.
//
// The extractor addresses a list's elements by an identifying field where every
// element has one, and by position where they do not. Which it picks is a
// property of the DOCUMENT, not of the list — so two documents describing the
// same thing spell one element's address two ways.
//
// That is what an optional block does across a pair of Terraform plans: its
// identifying field has no value yet in the plan that PROPOSES a stack, so the
// sheet built from it says `[0]`, while the plan read back from the built stack
// knows the value and says `[name=…]`. The value under both is the same value.

import { describe, it, expect } from "bun:test";
import { judgeFiles } from "../src/judge";
import type { TestPlan, TestItem } from "../src/testplan";

const doc = (things: unknown[]) => JSON.stringify({ things });

const ONE = doc([{ at: "alpha", timeout: "60" }]);
const TWO = doc([{ at: "alpha", timeout: "60" }, { at: "beta", timeout: "90" }]);
// …and the same one list, in the document that could not name its element yet.
const UNNAMED = doc([{ timeout: "60" }]);

const item = (address: string): TestItem =>
  ({
    target: { sheet: "s", path: [], key: "timeout", instance: "local" },
    unit: "u",
    kind: "value",
    decider: "project",
    expected: "60",
    address,
  }) as TestItem;

const planOf = (i: TestItem): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { en: "m" } }, sheets: ["s"] }], items: [i], functional: [] }) as never;

const verdict = (address: string, text: string) =>
  judgeFiles(planOf(item(address)), [
    { environment: "local", hosts: { h1: { files: {}, documents: [{ sheet: "s", format: "json", how: "GET /things", text }] } } },
  ] as never, { at: "X", lang: "en", idFields: ["at"] }).results[0]!;

describe("one element, addressed two ways", () => {
  // The row the sheet built from the earlier document carries.
  it("answers a positional address against an identified element", () => {
    expect(verdict("things[0].timeout", ONE).status).toBe("pass");
  });

  // …and the identified address still works, because the alias is added beside
  // the primary and never in place of it.
  it("still answers the identified address", () => {
    expect(verdict("things[at=alpha].timeout", ONE).status).toBe("pass");
  });

  // A row whose value disagrees is still a finding — the alias resolves the
  // ADDRESS and decides nothing about the value.
  it("compares the value once the address resolves", () => {
    const v = judgeFiles(planOf({ ...item("things[0].timeout"), expected: "99" } as TestItem), [
      { environment: "local", hosts: { h1: { files: {}, documents: [{ sheet: "s", format: "json", how: "GET /x", text: ONE }] } } },
    ] as never, { at: "X", lang: "en", idFields: ["at"] }).results[0]!;
    expect(v.status).toBe("fail");
  });

  // THE BOUNDARY. Matching `[0]` against the first of several identified
  // elements assumes the two documents order them the same way, which this tool
  // can assert about no format it reads — and a wrong answer there is silent.
  it("refuses to guess which of several elements a position means", () => {
    const v = verdict("things[0].timeout", TWO);
    expect(v.status).toBe("not_run");
    expect(v.reason).toContain("no such address");
  });

  // …while an identified address against the same list is ordinary: it resolves
  // and the value decides, which is the whole point of naming the element.
  it("answers an identified address in a longer list", () => {
    expect(verdict("things[at=alpha].timeout", TWO).status).toBe("pass");
    expect(verdict("things[at=beta].timeout", TWO).status).toBe("fail");
  });

  // A document whose list really is positional is untouched: the alias is only
  // added where nothing already holds that key.
  it("leaves a positional document alone", () => {
    expect(verdict("things[0].timeout", UNNAMED).status).toBe("pass");
  });
});
