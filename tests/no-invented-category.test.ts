// A sectionless line format reports no category, rather than inventing one.
//
// It used to stamp every row with the constant "Parameters" — a word in no
// file, needed by nothing that parses, existing only to be shown. The same
// thing a logrotate block's noun was, and removed for the same reason: a parser
// carries the vocabulary it needs to READ a format, and a display label is not
// that.
//
// It sat in the last slot of the category resolution chain, so it could only
// ever surface when nothing else had answered — which means its whole function
// was to turn "this row has no category" into a meaningless tab instead of the
// declaration this project asks for by name. Measured before removing it: zero
// occurrences across every example and one real project, because every real
// sheet answers with a declaration, a dictionary group, or its file.

import { describe, it, expect } from "bun:test";
import { extractLines, LINE_CONFIGS } from "../src/line-config";

describe("a format with no sections", () => {
  it("claims no category", () => {
    const rows = extractLines("a=1\nb=2\n", LINE_CONFIGS.generic);
    expect(rows.map((r) => r.categoryPath)).toEqual([[], []]);
  });

  // A format that DOES have sections still reports them: the removal is about
  // the invented fallback, not about structure the file states.
  it("still reports a section the file writes", () => {
    const rows = extractLines("[core]\nx=1\n", LINE_CONFIGS.ini);
    expect(rows.map((r) => r.categoryPath)).toEqual([["core"]]);
  });
});
