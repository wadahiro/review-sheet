// One spelling per concept, across every dictionary this repository ships.
//
// A dictionary's `type` is free text on purpose — a product may name a type
// this tool has never heard of, and inventing an enum would mean dropping that
// information. What is NOT free is spelling the SAME concept two ways: `int`
// here and `integer` there is not two facts, it is one fact a reader has to
// normalize in their head, and it accumulates silently because nothing reads
// the field.
//
// A denylist rather than an allowlist, for that reason: it catches the
// divergence without refusing a product's own vocabulary.
import { describe, it, expect } from "bun:test";
import { readFileSync, globSync } from "node:fs";

// Left: a spelling that means exactly what the right one means.
const ALIASES: Record<string, string> = {
  integer: "int",
  bool: "boolean",
  real: "number",
  // `enum` says a value is one of a fixed set, which is true of many types;
  // what the value IS goes here and WHICH values are legal goes in `options`.
  enum: "string",
};

describe("dictionary type vocabulary", () => {
  it("uses one spelling per concept in every shipped dictionary", () => {
    const offenders: string[] = [];
    for (const f of globSync("examples/**/*.yml")) {
      if (!f.includes("@")) continue;
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const m = line.match(/^ {4}type: (.+)$/);
          const canonical = m && ALIASES[m[1].trim()];
          if (canonical) offenders.push(`${f}:${i + 1}: type: ${m![1].trim()} — write "${canonical}"`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
