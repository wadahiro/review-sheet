// NOT THERE, versus NOT ADDRESSABLE HERE.
//
// "The key is absent" is an answer: a product that omits what nobody set says
// "still the default" by leaving it out. "The document's shape has no such
// address" is not an answer at all — the document was parsed with a different
// idea of how its lists are addressed, or it is simply another document, and
// every row under that address then reads as absent.
//
// Read as one fact, the first swallowed the second, and it swallowed it in the
// dangerous direction: a `default-in-force` row PASSED on a document that could
// not have answered it. Found by judging a sheet against a document whose lists
// are keyed by a field the parser had not been told about — over half the
// sheet's rows confirmed a default that nothing had looked at.

import { describe, it, expect } from "bun:test";
import { judgeFiles } from "../src/judge";
import type { TestPlan, TestItem } from "../src/testplan";

// A document whose list is addressed by one of its own fields, the way a
// Terraform plan addresses `resource_changes` by `address`.
// `at` rather than `name`/`id`/`key`: those three the extractor identifies a
// list's elements by on its own, so a document using one of them is addressable
// with nothing declared — and a test written on one would never have seen this.
const DOC = JSON.stringify({
  things: [
    { at: "alpha", settings: { timeout: "60" } },
    { at: "beta", settings: { timeout: "90" } },
  ],
});

const item = (over: Partial<TestItem>): TestItem =>
  ({
    target: { sheet: "s", path: [], key: "alpha.timeout", instance: "local" },
    unit: "u",
    kind: "value",
    decider: "project",
    address: 'things[at=alpha].settings.timeout',
    ...over,
  }) as TestItem;

const planOf = (items: TestItem[]): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { en: "m" } }, sheets: ["s"] }], items, functional: [] }) as never;

const obs = [
  {
    environment: "local",
    hosts: { h1: { files: {}, documents: [{ sheet: "s", format: "json", how: "GET /things", text: DOC }] } },
  },
] as never;

const verdict = (i: TestItem, idFields?: string[]) =>
  judgeFiles(planOf([i]), obs, { at: "X", lang: "en", ...(idFields === undefined ? {} : { idFields }) }).results[0]!;

describe("a document the judge cannot address", () => {
  // THE HAZARD. Without the id field the list is keyed positionally, so this
  // address resolves to nothing — and "nothing" used to mean "the default is in
  // force", which is a verdict nobody took.
  it("does not confirm a default it never looked at", () => {
    const v = verdict(item({ kind: "default-in-force", expected: "60" }));
    expect(v.status).toBe("not_run");
    expect(v.reason).toContain("no such address");
  });

  // …and the same row, with the parser told how the list is keyed, is answered
  // for real. The address was always right; the document was read wrong.
  it("answers it once the list is addressable", () => {
    expect(verdict(item({ kind: "default-in-force", expected: "60" }), ["at"]).status).toBe("pass");
  });

  // The other direction was wrong too, if less dangerous: a value row reported
  // NG, which claims the product is missing a setting it was never asked for.
  it("does not report a value missing from a document of another shape", () => {
    const v = verdict(item({ kind: "value", expected: "60" }));
    expect(v.status).toBe("not_run");
    expect(v.status).not.toBe("fail");
  });

  it("compares it once the list is addressable", () => {
    expect(verdict(item({ kind: "value", expected: "60" }), ["at"]).status).toBe("pass");
    expect(verdict(item({ kind: "value", expected: "99" }), ["at"]).status).toBe("fail");
  });

  // WHAT MUST NOT CHANGE: an ordinary absence inside a container that IS there.
  // A nested block nobody configured has no keys under it either, and that
  // absence is exactly what the default-in-force branch reads as confirmation.
  it("still reads a missing key inside a container it can address", () => {
    const v = verdict(
      item({ kind: "default-in-force", expected: "on", address: 'things[at=alpha].settings.compression' }),
      ["at"]
    );
    expect(v.status).toBe("pass");
  });

  // …and the case that decides WHICH container is asked about. A nested block
  // nobody configured has no keys under it AT ALL, so its immediate parent is
  // as absent as a shape mismatch would make it — and reading that as "cannot
  // address" turns every unset block into a row nobody checked. The element the
  // address identifies is what a mismatch loses; the block inside it is not.
  it("still reads a block that is not configured at all", () => {
    const v = verdict(
      item({ kind: "default-in-force", expected: "on", address: 'things[at=alpha].logging.enabled' }),
      ["at"]
    );
    expect(v.status).toBe("pass");
  });

  // …and a top-level address, whose container is the document root.
  it("says nothing about a top-level address", () => {
    const flat = [
      { environment: "local", hosts: { h1: { files: {}, documents: [{ sheet: "s", format: "json", how: "GET /x", text: '{"a":"1"}' }] } } },
    ] as never;
    const v = judgeFiles(
      planOf([item({ kind: "default-in-force", expected: "2", address: "b" })]),
      flat,
      { at: "X", lang: "en" }
    ).results[0]!;
    expect(v.status).toBe("pass");
  });
});
