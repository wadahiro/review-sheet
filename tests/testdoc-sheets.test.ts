// WHICH SHEETS GO IN A RECORD — a second axis beside the unit one.
//
// A unit is not always the cut a record has to be made along. One unit can hold
// the sheet a customer reads and a sheet of the build's own internals, and
// `generate --sheets` cannot separate them afterwards: a record is ONE document
// sheet with every table already inside it, so narrowing the delivery can only
// take the whole record or none of it.
//
// Driven through the CLI because that is where the narrowing is: the record is
// made of the plan AND the plan's report — the item tables from one, the
// out-of-scope table from the other — and a sheet left out of one and not the
// other would be half hidden.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, cpSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = realpathSync(resolve(import.meta.dir, ".."));
const FIXTURE = join(ROOT, "tests", "fixtures", "testdoc-sheets");
const CLI = join(ROOT, "src", "cli.ts");

function bare(): string {
  const at = mkdtempSync(join(realpathSync(tmpdir()), "rs-tdsheets-"));
  cpSync(FIXTURE, at, { recursive: true });
  return at;
}

async function run(at: string, extra: string[]): Promise<{ code: number; err: string; doc: string }> {
  const p = Bun.spawn(["bun", "run", CLI, "test-doc", "-i", "input.json", "--unit", "unit", "-d", "doc.md", "--lang", "en", ...extra], {
    cwd: at,
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  const code = await p.exited;
  return { code, err, doc: readFileSync(join(at, "doc.md"), "utf-8") };
}

describe("every sheet of the unit, which is the default", () => {
  it("writes both sheets' rows", async () => {
    const { code, doc } = await run(bare(), []);
    expect(code).toBe(0);
    expect(doc).toContain("kept-key");
    expect(doc).toContain("hidden-key");
    // …and the out-of-scope row of the second sheet, which comes from the
    // plan's REPORT rather than from the plan.
    expect(doc).toContain("hidden-oos");
  });
});

describe("a record narrowed to some of its unit's sheets", () => {
  it("keeps the sheet it was told to keep", async () => {
    const { code, doc } = await run(bare(), ["--sheets", "shown"]);
    expect(code).toBe(0);
    expect(doc).toContain("kept-key");
  });

  it("leaves the other sheet's items out", async () => {
    const { doc } = await run(bare(), ["--sheets", "shown"]);
    expect(doc).not.toContain("hidden-key");
  });

  // BOTH HALVES. The out-of-scope table is built from the report, so a sheet
  // dropped from the plan alone would still be named there — the row, its
  // reason and its owner, which is exactly what the omission is for.
  it("leaves its out-of-scope rows out too", async () => {
    const { doc } = await run(bare(), ["--sheets", "shown"]);
    expect(doc).not.toContain("hidden-oos");
    expect(doc).not.toContain("an input of the build");
  });

  // NEVER IN THE DOCUMENT, always in the run's own output. The same claim
  // `--instances` makes about columns: what is left out is not in the file, and
  // a line saying "a sheet was omitted" would state the very thing the omission
  // is for.
  it("says what it left out, where the person who ran it is standing", async () => {
    const { err, doc } = await run(bare(), ["--sheets", "shown"]);
    expect(err).toContain("internal");
    expect(err).toContain("1 item(s)");
    expect(doc).not.toContain("internal");
  });

  // A name this model does not have is refused rather than matching nothing:
  // the whole point of the flag is to leave something out, so a typo would
  // leave out the sheet somebody meant to KEEP.
  it("refuses a sheet it does not have, and names the near miss", async () => {
    const { code, err } = await run(bare(), ["--sheets", "shwon"]);
    expect(code).not.toBe(0);
    expect(err).toContain("does not have");
    expect(err).toContain('did you mean "shown"');
  });

  it("changes nothing when every sheet is named", async () => {
    const whole = await run(bare(), []);
    const named = await run(bare(), ["--sheets", "shown", "internal"]);
    expect(named.doc).toBe(whole.doc);
  });
});
