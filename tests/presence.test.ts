// Settings with no value: a logrotate policy says `missingok`, a firewall
// permits a service by listing it. What the file records is that the thing is
// there, and the row's value is that fact.
//
// Three owners, one fact each — the arrangement this replaced had the
// dictionary spelling the tool's storage convention, which no schema could
// check and which would have gone silently wrong the day the spelling changed:
//
//   the format   how presence is written (a bare flag, a list member)
//   the tool     how presence is spelled internally (PRESENCE_VALUE)
//   the product  that a setting IS presence, and its own word for it

import { describe, it, expect } from "bun:test";
import { PRESENCE_VALUE } from "../src/types";
import { parseDictionary } from "../src/providers/dictionary";
import { extractLines, LINE_CONFIGS } from "../src/line-config";
import { logrotateIndex } from "../src/logrotate";

describe("the format states how presence is written", () => {
  // A directive standing alone on its line. Dropping it lost a real setting
  // with no report; reading it as presence is what makes it a row.
  it("a bare flag in a space-delimited file", () => {
    const rows = extractLines("rtcsync\nmakestep 1.0 3\n", LINE_CONFIGS.space);
    const flag = rows.find((r) => r.key === "rtcsync")!;
    expect(flag.value).toBe(PRESENCE_VALUE);
    expect(flag.presence).toBe(true);
    // And the one with an argument is an ordinary row, not presence.
    expect(rows.find((r) => r.key === "makestep")!.presence).toBeUndefined();
  });

  it("a logrotate flag, and not a directive that takes an argument", () => {
    const rows = logrotateIndex("/var/log/x {\n  missingok\n  rotate 4\n}\n");
    expect(rows.find((r) => r.key === "missingok")).toMatchObject({ value: PRESENCE_VALUE, presence: true });
    expect(rows.find((r) => r.key === "rotate")!.presence).toBeUndefined();
  });

  // Stated by the parser, never inferred from the value: a product whose
  // legitimate value happens to be this tool's spelling would otherwise be read
  // as presence, with nothing saying so.
  it("is a declared fact, not a value that looks like one", () => {
    const rows = extractLines("debug true\n", LINE_CONFIGS.space);
    expect(rows[0].value).toBe("true");
    expect(rows[0].presence).toBeUndefined();
  });
});

describe("the product states that a setting IS presence, and its own word", () => {
  const dict = (entry: string) =>
    `product: p\nversion: "1"\nprovenance: official\ncoverage: full\nparameters:\n  a:\n    description: { en: d }\n${entry}`;

  const load = (entry: string) => parseDictionary("d.yml", dict(entry));

  it("accepts the bare form and the form carrying a word", () => {
    expect(() => load("    presence: true\n")).not.toThrow();
    expect(() => load("    presence:\n      label: { en: permitted, ja: 許可 }\n")).not.toThrow();
  });

  // The arrangement this replaced. `options` maps a value the PRODUCT stores to
  // the name the PRODUCT gives it; presence is spelled by the tool, so an
  // options entry for it is a product document quoting a tool internal — and
  // `"true"` in an options list is indistinguishable from a product's own
  // boolean, so no schema could ever have caught it.
  it("refuses presence and options on one entry", () => {
    expect(() => load('    presence: true\n    options: [{ value: "true" }]\n')).toThrow();
  });

  // `present`/`absent` is validated vocabulary. A dictionary writing the tool's
  // spelling fails here — which is the whole difference between a schema
  // keyword and a magic string.
  it("takes present/absent as the default, and refuses the tool's spelling", () => {
    expect(() => load("    presence: true\n    default: present\n")).not.toThrow();
    expect(() => load("    presence: true\n    default: absent\n")).not.toThrow();
    expect(() => load('    presence: true\n    default: "true"\n')).toThrow(/allowed values/);
  });
});
