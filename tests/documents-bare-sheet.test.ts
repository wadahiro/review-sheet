// A SHEET WHOSE ROWS CARRY THEIR OWN ADDRESSES.
//
// Most `documents:` entries are a template: which document answers this sheet,
// and where in it a row sits. A sheet built FROM a document of the same shape
// needs neither — every row already records where it was read from, and the
// document naming the sheet answers it there.
//
// That path existed and was reachable only by leaving the entry out of
// `documents:` altogether, which is not a thing a reader can find. The schema
// refused the entry that says it.

import { describe, it, expect } from "bun:test";
import { judgeFiles } from "../src/judge";
import type { TestPlan, TestItem } from "../src/testplan";

const DOC = JSON.stringify({ things: [{ at: "alpha", settings: { timeout: "60" } }] });

const item = (): TestItem =>
  ({
    target: { sheet: "s", path: [], key: "alpha.timeout", instance: "local" },
    unit: "u",
    kind: "value",
    decider: "project",
    expected: "60",
    address: "things[at=alpha].settings.timeout",
  }) as TestItem;

const plan = (): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { en: "m" } }, sheets: ["s"] }], items: [item()], functional: [] }) as never;

const obs = [
  { environment: "local", hosts: { h1: { files: {}, documents: [{ sheet: "s", format: "json", how: "GET /things", text: DOC }] } } },
] as never;

// `undefined` where nothing answered the row at all — judgeFiles returns no
// result for it, and the caller falls through to the file or hands it back.
const status = (documents?: { sheet: string; document?: string; address?: string }[]): string | undefined =>
  judgeFiles(plan(), obs, { at: "X", lang: "en", idFields: ["at"], ...(documents === undefined ? {} : { documents }) })
    .results[0]?.status;

describe("a documents: entry that names only its sheet", () => {
  // The claim: saying it and leaving it out are the same thing.
  it("answers the rows where they say they sit", () => {
    expect(status([{ sheet: "s" }])).toBe("pass");
  });

  it("is the same as declaring nothing", () => {
    expect(status()).toBe(status([{ sheet: "s" }]));
  });

  // …and an entry for ANOTHER sheet leaves this one on the fall-through, so the
  // bare shape is not just "any template at all".
  it("is not confused with a template for a different sheet", () => {
    expect(status([{ sheet: "other", document: "x", address: "y" }])).toBe("pass");
  });

  // A template that names a document still behaves as one: a row it does not
  // match is left unanswered, never quietly answered from the fall-through
  // instead. That is the whole difference between declaring a template and
  // declaring the bare shape.
  it("leaves a real template alone", () => {
    expect(status([{ sheet: "s", document: "nothing-by-this-name", address: "{key}" }])).toBeUndefined();
  });
});
