import { describe, it, expect } from "bun:test";
import { buildDiffModel, rowKey } from "../src/diffview";
import { diffSheets } from "../src/diff";
import type { SheetData } from "../src/prompt";

// The overlay and `review-sheet diff` must give the same answer. `alignValues`
// was shared from the start for that reason; the STATUS was not, so the viewer
// kept a second copy of the rule and could not tell a moved product default
// from a reworded description. These pin the two together.
const sheets = (params: unknown[]): SheetData["sheets"] => [
  { name: "S", categories: [{ name: "C", params: params as never }] },
];

describe("buildDiffModel agrees with diffSheets", () => {
  const cases: [string, unknown[], unknown[]][] = [
    ["a value change", [{ key: "k", value: "1" }], [{ key: "k", value: "2" }]],
    ["prose only", [{ key: "k", value: "1", description: { en: "a" } }], [{ key: "k", value: "1", description: { en: "b" } }]],
    ["a default under a set value", [{ key: "k", value: "1", origin: "embedded", default: "x" }], [{ key: "k", value: "1", origin: "embedded", default: "y" }]],
    ["a default under NO value", [{ key: "k", origin: "default", default: "x" }], [{ key: "k", origin: "default", default: "y" }]],
    ["nothing", [{ key: "k", value: "1" }], [{ key: "k", value: "1" }]],
  ];

  for (const [label, from, to] of cases) {
    it(`reports the same kinds for ${label}`, () => {
      const cli = diffSheets(sheets(from), sheets(to)).sheets[0].categories[0].params[0];
      const view = buildDiffModel(sheets(from), sheets(to), false);
      expect(view.status.get(rowKey("S", "C", "k"))).toBe(cli.status);
      expect(view.kinds.get(rowKey("S", "C", "k")) ?? []).toEqual(cli.changed);
    });
  }

  it("counts the doc-only share the same way", () => {
    const from = sheets([{ key: "a", value: "1", description: { en: "x" } }, { key: "b", value: "1" }]);
    const to = sheets([{ key: "a", value: "1", description: { en: "y" } }, { key: "b", value: "2" }]);
    const cli = diffSheets(from, to).summary;
    const view = buildDiffModel(from, to, false).summary;
    expect(view.changed).toBe(cli.changed);
    expect(view.docOnly).toBe(cli.docOnly);
    expect(view.unchanged).toBe(cli.unchanged);
    expect(view.docOnly).toBe(1);
  });

  it("marks the unset-default row effective in the overlay too", () => {
    const view = buildDiffModel(
      sheets([{ key: "k", origin: "default", default: "ldapsOnly" }]),
      sheets([{ key: "k", origin: "default", default: "always" }]),
      false
    );
    expect(view.kinds.get(rowKey("S", "C", "k"))).toEqual(["effective"]);
  });
});
