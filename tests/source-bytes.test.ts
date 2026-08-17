// A literal control byte in a source file makes git treat that file as BINARY:
// no diff, no blame, no review. It has happened three times here — a NUL used
// as a map-key separator in systemd.ts and in logrotate.ts, and once a whole
// file that went in as `Bin 0 -> 8447 bytes` — each time written as the byte
// itself where the escape says the same thing and stays readable.
//
// Not a style rule. The cost is that a file stops being reviewable, which is
// what this repository is for.
import { describe, it, expect } from "bun:test";
import { readFileSync, globSync } from "node:fs";

// Everything except tab, newline and carriage return.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// Invisible characters that survive a copy-paste and change a string's
// identity without changing how it reads.
const INVISIBLE = /[\u200b\u200c\u200d\ufeff\u00a0\u2007\u202f]/;

describe("source files stay text", () => {
  it("has no control byte outside tab and newline, and no invisible character", () => {
    const offenders: string[] = [];
    const files = [...globSync("src/**/*.ts"), ...globSync("src/**/*.json"), ...globSync("tests/**/*.ts")];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, i) => {
        const c = CONTROL.exec(line);
        if (c) offenders.push(`${f}:${i + 1}: U+${c[0].codePointAt(0)!.toString(16).padStart(4, "0")} — write the escape`);
        const v = INVISIBLE.exec(line);
        if (v) offenders.push(`${f}:${i + 1}: invisible U+${v[0].codePointAt(0)!.toString(16).padStart(4, "0")}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
