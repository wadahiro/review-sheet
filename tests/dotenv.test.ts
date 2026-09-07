import { describe, it, expect } from "bun:test";
import { extractLines, LINE_CONFIGS } from "../src/line-config";
import { getParser } from "../src/parser";
import "../src/parsers/index.js";
import { verifySources } from "../src/verify";
import { computeApply } from "../src/apply";
import type { SheetData, ReviewItem } from "../src/prompt";

// A `.env` file is read by a shell-like reader, and two of its rules are
// SYNTAX rather than value. Both were measured against a running product, not
// reasoned about: a realm whose display name the sheet showed as `"IAM
// Platform"` is held by the server as `IAM Platform`, and a row the sheet
// showed set to a value from the shared defaults is EMPTY in the environment
// that overrides it — the override was dropped, so the sheet claimed a value
// that environment does not have.
//
// Both are scoped to `dotenv`, like `bareFlag` is scoped to `space`: in a
// properties or ini file a quote is a character of the value, and `generic` is
// the lowest-priority fallback that matches every file there is.

const ENV = ['SSO_SMTP_USER=', 'SSO_SMTP_FROM_DISPLAY_NAME="IAM Platform"', "SSO_SMTP_HOST=mailpit", "EMPTY_QUOTED=\"\"", "SSO_ODD=\"a"].join("\n");

describe("a .env file's own syntax", () => {
  it("keeps a variable set to nothing — that is a statement, not an absence", () => {
    const rows = extractLines(ENV, LINE_CONFIGS.dotenv);
    const user = rows.find((r) => r.key === "SSO_SMTP_USER");
    expect(user?.value).toBe("");
    // The anchor is the whole assignment: the value is nowhere on the line, so
    // it is the only thing locate can match on.
    expect(user?.source).toEqual({ line: 1, anchor: "SSO_SMTP_USER=" });
  });

  it("reads the quotes as syntax, so the value is what the reader would hand on", () => {
    const rows = extractLines(ENV, LINE_CONFIGS.dotenv);
    expect(rows.find((r) => r.key === "SSO_SMTP_FROM_DISPLAY_NAME")?.value).toBe("IAM Platform");
    expect(rows.find((r) => r.key === "SSO_SMTP_HOST")?.value).toBe("mailpit");
    expect(rows.find((r) => r.key === "EMPTY_QUOTED")?.value).toBe("");
    // …a lone quote is not a pair, so it is part of the value.
    expect(rows.find((r) => r.key === "SSO_ODD")?.value).toBe('"a');
  });

  it("leaves every other delimited format exactly as it was", () => {
    for (const cfg of [LINE_CONFIGS.properties, LINE_CONFIGS.generic, LINE_CONFIGS.sysctl, LINE_CONFIGS.ini]) {
      const rows = extractLines(ENV, cfg);
      expect(rows.some((r) => r.key === "SSO_SMTP_USER")).toBe(false);
      expect(rows.find((r) => r.key === "SSO_SMTP_FROM_DISPLAY_NAME")?.value).toBe('"IAM Platform"');
    }
  });
});

const sheet = (value: string, line: number, anchor: string): SheetData => ({
  sheets: [
    {
      name: "s",
      categories: [
        { name: "c", params: [{ key: "SSO_SMTP_USER", value, source: { file: "/x.env", line, anchor } }] },
      ],
    },
  ],
});

describe("a variable set to nothing, verified and applied", () => {
  const io = () => ENV;

  it("resolves against the line that sets it to nothing", () => {
    const out = verifySources(sheet("", 1, "SSO_SMTP_USER=") as never, io);
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
  });

  // …and only that line. An empty value is a substring of every line there is,
  // so the ordinary "the line still carries the value" test would accept any
  // of them — including one that sets the variable to something.
  it("does not resolve against a line that gives it a value", () => {
    const other = () => "SSO_SMTP_USER=smtp-relay\n";
    const out = verifySources(sheet("", 1, "SSO_SMTP_USER=") as never, other);
    expect(out.error).toBe(1);
  });

  it("writes the new value after the assignment rather than at the start of the line", () => {
    const reviews: ReviewItem[] = [
      {
        id: "r",
        status: "pending",
        target: { sheet: "s", category: "c", param: "SSO_SMTP_USER", field: "value" },
        changes: [{ field: "value", current: "", suggested: "relay" }],
      },
    ];
    const out = computeApply(sheet("", 1, "SSO_SMTP_USER=") as never, reviews, () => ENV);
    expect(out.applied).toBe(1);
    expect(out.files.find((f) => f.path === "/x.env")!.content.split("\n")[0]).toBe("SSO_SMTP_USER=relay");
  });
});

describe("the parser as the registry hands it out", () => {
  it("reads a .env through the dotenv rules", () => {
    const rows = getParser("dotenv")!.extract(ENV, "/x.env");
    expect(rows.find((r) => r.key === "SSO_SMTP_FROM_DISPLAY_NAME")?.value).toBe("IAM Platform");
    expect(rows.some((r) => r.key === "SSO_SMTP_USER")).toBe(true);
  });
});
