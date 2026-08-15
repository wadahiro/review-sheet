import { describe, it, expect } from "bun:test";
import { extractLines, LINE_CONFIGS } from "../src/line-config";
import { getParser } from "../src/parser";
import "../src/parsers/index.js";
import { verifySources } from "../src/verify";
import { computeApply } from "../src/apply";
import type { SheetData, ReviewItem } from "../src/prompt";

// A directive with no argument is a setting whose value is its own presence —
// `rtcsync` in chrony.conf, `noclientlog`, sshd's bare keywords. The space
// parser used to drop those lines and say nothing: `if (value === "") continue`,
// so the row never existed and nothing reported that it had not.
//
// The mechanism is LineConfig.bareFlag, off for every delimited format on
// purpose (see its comment): in `key=value` a line with no delimiter is prose
// or a typo, and `generic` matches every file there is.

const CHRONY = [
  "# managed",
  "server 169.254.169.123 iburst",
  "driftfile /var/lib/chrony/drift",
  "makestep 1.0 3",
  "rtcsync",
  "port 0",
].join("\n");

describe("bare directives as presence flags", () => {
  it("extracts a lone directive as a row valued true, without disturbing the rest", () => {
    const rows = extractLines(CHRONY, LINE_CONFIGS.space);
    expect(rows.map((r) => `${r.key}=${r.value}`)).toEqual([
      "server=169.254.169.123 iburst",
      "driftfile=/var/lib/chrony/drift",
      "makestep=1.0 3",
      "rtcsync=true",
      "port=0",
    ]);
    // The anchor is the directive itself — that is what locate matches on.
    expect(rows.find((r) => r.key === "rtcsync")?.source).toEqual({ line: 5, anchor: "rtcsync" });
  });

  it("leaves every delimited format alone", () => {
    // The same content through the formats where a delimiter-less line means
    // nothing. `generic` is the last-resort fallback and matches every file, so
    // this is what keeps a README from becoming rows.
    for (const cfg of [LINE_CONFIGS.generic, LINE_CONFIGS.sysctl, LINE_CONFIGS.properties, LINE_CONFIGS.ini, LINE_CONFIGS.dotenv]) {
      const rows = extractLines("alpha = 1\nbarebones\n", cfg);
      expect(rows.map((r) => r.key)).toEqual(["alpha"]);
    }
  });

  it("does not invent a flag from an indented or multi-token line", () => {
    const rows = extractLines(["  spaced", "two tokens", "trailing   "].join("\n"), LINE_CONFIGS.space);
    // "  spaced" trims to one token and IS a flag; "two tokens" is an ordinary
    // key/value; "trailing   " is one token with trailing space.
    expect(rows.map((r) => `${r.key}=${r.value}`)).toEqual(["spaced=true", "two=tokens", "trailing=true"]);
  });
});

describe("verify and apply for a presence flag", () => {
  const sheet = (value: string): SheetData => ({
    sheets: [
      {
        name: "os",
        categories: [
          {
            name: "Parameters",
            params: [{ key: "rtcsync", value, source: { file: "chrony.conf", line: 5, anchor: "rtcsync", baseFormat: "space" } }],
          },
        ],
      },
    ],
  });
  const read = (p: string): string | null => (p === "chrony.conf" ? CHRONY : null);

  it("verifies by the line BEING the directive, since the value is nowhere in the file", () => {
    const out = verifySources(sheet("true"), read);
    expect(out.error).toBe(0);
    expect(out.ok).toBe(1);
  });

  it("reports a flag whose line has gone", () => {
    const gone = (p: string): string | null => (p === "chrony.conf" ? CHRONY.replace("rtcsync\n", "") : null);
    const out = verifySources(sheet("true"), gone);
    expect(out.error).toBe(1);
  });

  it("does not resolve against a line that merely starts with the directive", () => {
    const near = (p: string): string | null => (p === "chrony.conf" ? CHRONY.replace("rtcsync", "rtcsyncfoo bar") : null);
    expect(verifySources(sheet("true"), near).error).toBe(1);
  });

  it("HOLDS an apply instead of guessing where the line goes", () => {
    const review: ReviewItem[] = [
      {
        id: "r1",
        status: "pending",
        target: { sheet: "os", category: "Parameters", param: "rtcsync" },
        changes: [{ field: "value", current: "true", suggested: "false" }],
      },
    ];
    const res = computeApply(sheet("true"), review, read);
    const edit = res.results[0];
    expect(edit.status).toBe("held");
    expect(edit.reason).toContain("presence");
    // Held changes are what the AI prompt is built from — not dropped.
    expect(res.heldPrompt).toBeTruthy();
  });
});
