// What changed in a hand-maintained sheet, said cheaply.
//
// The reader is a model with a budget: a row's description shares a line with
// its value, so a line diff reprints a paragraph to move one word. What is
// asserted here is that the statement is the change — and that anything the
// statements do NOT cover is still shown, because a cheap report that quietly
// drops something is worse than an expensive one.

import { describe, it, expect } from "bun:test";
import { markdownChangeReport, renderMarkdownChanges } from "../src/markdown-changes";
import { unifiedDiff } from "../src/diff-text";

const LONG = "Configures whether the service shall be restarted when the service process exits. ".repeat(4);
const doc = (restart: string, extra = ""): string =>
  [
    "# os",
    "",
    "## keycloak.service",
    "",
    `| 設定項目 | 説明 | デフォルト値 | staging | production |`,
    "| --- | --- | --- | --- | --- |",
    "| `Service` |  |  |  |  |",
    `|   \`Restart\` | ${LONG} |  | ${restart} | ${restart} |`,
    `|   \`RestartSec\` | ${LONG} |  | 5 | 5 |`,
    "",
  ].join("\n") + extra;

const ENV = ["staging", "production"];

describe("a change, stated", () => {
  it("names the row, the column and the two values", () => {
    const rep = markdownChangeReport(doc("on-failure"), doc("always"), ENV, "ja");
    expect(renderMarkdownChanges(rep.changes)).toBe(
      '~ keycloak.service > Service.Restart [staging]: "on-failure" -> "always"\n' +
        '~ keycloak.service > Service.Restart [production]: "on-failure" -> "always"'
    );
    expect(rep.unaccounted).toBe("");
  });

  // The number that decides this design.
  it("costs a fraction of the same change as a line diff", () => {
    const before = doc("on-failure");
    const after = doc("always");
    const stated = renderMarkdownChanges(markdownChangeReport(before, after, ENV, "ja").changes);
    // Measured on a real sheet the ratio is ~40x; this fixture is small, so
    // the claim is only that the statement is a fraction of the diff.
    expect(stated.length * 3).toBeLessThan(unifiedDiff(before, after).length);
  });

  it("names a section and the note written in it", () => {
    const rep = markdownChangeReport(doc("on-failure"), doc("on-failure", "\n## 運用メモ\n\n見直した。\n"), ENV, "ja");
    const text = renderMarkdownChanges(rep.changes);
    expect(text).toContain("+ section 運用メモ");
    expect(text).toContain('~ note 運用メモ: "見直した。"');
    expect(rep.unaccounted).toBe("");
  });

  // A row gone from one heading and present under another is ONE statement, not
  // a removal and an addition the reader has to notice are the same thing.
  it("reports a row that moved as a move", () => {
    const before = doc("on-failure");
    const moved =
      before.replace(/\|   `RestartSec`.*\n/, "") +
      "\n## 別の節\n\n| 設定項目 | 説明 | デフォルト値 | staging | production |\n| --- | --- | --- | --- | --- |\n" +
      `|   \`RestartSec\` | ${LONG} |  | 5 | 5 |\n`;
    const text = renderMarkdownChanges(markdownChangeReport(before, moved, ENV, "ja").changes);
    expect(text).toContain("> row RestartSec: keycloak.service -> 別の節");
  });

  it("names a column somebody added", () => {
    const before = doc("on-failure");
    const after = before
      .replace("| staging | production |", "| staging | production | 備考 |")
      .replace("| --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- | --- |");
    expect(renderMarkdownChanges(markdownChangeReport(before, after, ENV, "ja").changes)).toContain("~ columns");
  });

  // The guard: text that no statement covers is shown as itself. A report that
  // silently omits what it could not name would be the drop this project
  // refuses everywhere else.
  it("shows what no statement covered", () => {
    // Rows REORDERED inside their table: every row is still where it was
    // addressed, so no statement above has anything to say — and something did
    // change. The lines themselves are the report.
    const before = doc("on-failure");
    const a = before.split("\n");
    const i = a.findIndex((l) => l.includes("`Restart`"));
    const reordered = [...a.slice(0, i), a[i + 1], a[i], ...a.slice(i + 2)].join("\n");
    const rep = markdownChangeReport(before, reordered, ENV, "ja");
    expect(rep.changes).toEqual([]);
    expect(rep.unaccounted).toContain("`Restart`");
  });

  // A paragraph written anywhere is the section's note, so it is stated rather
  // than left to the diff.
  it("accounts for prose without falling back to lines", () => {
    const before = doc("on-failure");
    const rep = markdownChangeReport(before, `${before}\n覚え書き。\n`, ENV, "ja");
    expect(renderMarkdownChanges(rep.changes)).toContain("覚え書き。");
    expect(rep.unaccounted).toBe("");
  });
});

// Full editing means the document can say things the model does not know yet,
// and the biggest of those is a new ENVIRONMENT: a column written beside
// `production`. It has to read as a value column (or the values in it would be
// filed as documentation) and it has to be reported as its own decision — a
// layer of configuration and the files behind it — rather than as "the header
// row changed".
describe("an environment the reader added", () => {
  const withColumn = (name: string, values: string[]): string => {
    const lines = doc("on-failure").split("\n");
    return lines
      .map((line) => {
        if (!line.startsWith("|")) return line;
        const cells = line.split("|").slice(1, -1);
        if (cells.every((c) => /^\s*-{3,}\s*$/.test(c))) return `|${[...cells, " --- "].join("|")}|`;
        if (cells[0].includes("設定項目")) return `|${[...cells, ` ${name} `].join("|")}|`;
        const add = cells[0].includes("Restart`") ? values[0] : cells[0].includes("RestartSec") ? values[1] : "";
        return `|${[...cells, ` ${add} `].join("|")}|`;
      })
      .join("\n");
  };

  // The document's environment SET is what makes a column an environment; the
  // set is passed in, because it is the document's own and not something to
  // guess from a header.
  it("is named, with what was written in it", () => {
    const rep = markdownChangeReport(doc("on-failure"), withColumn("dr", ["always", "10"]), [...ENV, "dr"], "ja");
    const text = renderMarkdownChanges(rep.changes);
    expect(text).toContain("+ environment dr");
    expect(text).toContain('Service.Restart="always"');
    expect(rep.unaccounted).toBe("");
  });

  // A column the set does not name is a column, not an axis — whatever it is
  // called and wherever it sits.
  it("is not confused with a column the set does not name", () => {
    for (const name of ["備考", "担当者"]) {
      const rep = markdownChangeReport(doc("on-failure"), withColumn(name, ["要確認", ""]), ENV, "ja");
      const text = renderMarkdownChanges(rep.changes);
      expect(text).not.toContain("environment");
      expect(text).toContain("~ columns");
    }
  });
});
