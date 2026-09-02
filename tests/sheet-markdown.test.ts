// A sheet rendered as markdown, and read back.
//
// This is the load-bearing half of editing a whole sheet as text: the write-back
// is an AI's job, but WHAT CHANGED has to be computed, not re-derived by
// whoever reads the diff. That only works if the rendering round-trips —
// `parse(render(project(sheet)))` equal to `project(sheet)` — because otherwise
// a document nobody touched already reports changes, and a change set that
// cries wolf is one nobody reads.
//
// Checked against every sheet of a real project as well (1536 rows, 15 sheets
// with rows, 338 KB of markdown) during development; what is pinned here is the
// behaviour, in cases small enough to read.

import { describe, it, expect } from "bun:test";
import { toMarkdownSheet, renderSheetMarkdown, parseSheetMarkdown } from "../src/sheet-markdown";
import type { SheetData } from "../src/prompt";

const sheetOf = (extra: Record<string, unknown> = {}): SheetData["sheets"][number] =>
  ({
    name: "web",
    instances: ["staging", "production"],
    categories: [
      {
        name: "httpd.conf",
        params: [
          {
            key: "Listen",
            instances: [
              { name: "staging", value: "80" },
              { name: "production", value: "8080" },
            ],
            description: { ja: "リッスンするポート" },
            default: "80",
          },
          // Shared: one value, shown in every column.
          { key: "ServerTokens", value: "Prod", description: { ja: "応答ヘッダの詳細度" }, default: "Full" },
        ],
      },
    ],
    ...extra,
  }) as never;

const roundTrip = (sheet: SheetData["sheets"][number]) => {
  const doc = toMarkdownSheet(sheet, "ja");
  const text = renderSheetMarkdown(doc);
  return { doc, text, back: parseSheetMarkdown(text, doc.instances) };
};

describe("a sheet as markdown", () => {
  it("round-trips: reading back what was written gives the same document", () => {
    const { doc, text, back } = roundTrip(sheetOf());
    expect(renderSheetMarkdown(back)).toBe(text);
    // `shared` is read off the model and cannot be recovered from the text —
    // the two render identically — so it is the one field the parse omits.
    expect(back.sections).toEqual(doc.sections.map((s) => ({ ...s, rows: s.rows.map(({ shared: _s, ...r }) => r) })));
  });

  it("gives a shared value a column of its own per environment", () => {
    const { doc } = roundTrip(sheetOf());
    const row = doc.sections[0].rows.find((r) => r.key === "ServerTokens")!;
    expect(row.values).toEqual({ staging: "Prod", production: "Prod" });
    expect(row.shared).toBe(true);
  });

  // A heading for a category whose rows are all in its children. Without it the
  // nested category is written at a depth whose parent was never named, and the
  // read-back cannot recover which level it was on.
  it("writes a heading for every category, including one that holds no rows", () => {
    const nested = sheetOf({
      categories: [{ name: "parent", categories: [{ name: "child", params: [{ key: "k", value: "1" }] }] }],
    });
    const { text, doc, back } = roundTrip(nested);
    expect(text).toContain("## parent");
    expect(text).toContain("### child");
    expect(back.sections.map((s) => s.path)).toEqual(doc.sections.map((s) => s.path));
  });

  // …but no TABLE under it. An empty header and rule is noise on every nested
  // sheet — 272 tables over 1536 rows, and one per parent category on top of
  // that — and the parse already tolerates a heading with nothing beneath it.
  it("writes no table under a heading that holds no rows", () => {
    const nested = sheetOf({
      categories: [{ name: "parent", categories: [{ name: "child", params: [{ key: "k", value: "1" }] }] }],
    });
    const { text } = roundTrip(nested);
    const parentBlock = text.slice(text.indexOf("## parent"), text.indexOf("### child"));
    expect(parentBlock).not.toContain("| 設定項目 |");
    expect(text.slice(text.indexOf("### child"))).toContain("| 設定項目 |");
  });

  // Both are rare in real data and neither may be lost.
  it("carries a pipe and a newline through a cell", () => {
    const odd = sheetOf({
      categories: [{ name: "c", params: [{ key: "k", value: "a|b", description: { ja: "一行目\n二行目" } }] }],
    });
    const { doc, back } = roundTrip(odd);
    expect(back.sections[0].rows[0].values).toEqual(doc.sections[0].rows[0].values);
    expect(back.sections[0].rows[0].description).toBe("一行目\n二行目");
  });

  // A `<br>` the text itself contains, against the one written for a newline.
  // Not in any of the 1536 rows measured — which is exactly why it needed a
  // test rather than a reading: the data happened not to hold one, and the
  // reader turned the author's own tag into a line break.
  it("tells a written <br> from a newline", () => {
    const both = sheetOf({
      categories: [
        { name: "c", params: [{ key: "k", value: "a<br>b", description: { ja: "<br/> と改行\nの両方" } }] },
      ],
    });
    const { doc, back } = roundTrip(both);
    expect(back.sections[0].rows[0].values).toEqual(doc.sections[0].rows[0].values);
    expect(back.sections[0].rows[0].values[Object.keys(doc.sections[0].rows[0].values)[0]]).toBe("a<br>b");
    expect(back.sections[0].rows[0].description).toBe("<br/> と改行\nの両方");
  });

  // `description`/`remarks` are LangText and the projection collapses them to
  // one language, so an edit to one is an edit to whichever language rendered.
  // A change set that does not say which would have its reader write a Japanese
  // override over an English string.
  it("says which language its prose is in", () => {
    expect(toMarkdownSheet(sheetOf(), "en").lang).toBe("en");
    expect(roundTrip(sheetOf()).back.lang).toBe("ja");
  });

  // Measured on a real dictionary: one description ends in a space. A table cell
  // cannot hold it — every renderer trims, and so does anyone editing by hand —
  // so the projection is trimmed too, or that row reports as changed forever.
  it("normalises whitespace a table cell cannot hold", () => {
    const padded = sheetOf({
      categories: [{ name: "c", params: [{ key: "k", value: "1", description: { ja: "説明 " } }] }],
    });
    const { doc, back } = roundTrip(padded);
    expect(doc.sections[0].rows[0].description).toBe("説明");
    expect(back.sections[0].rows[0].description).toBe("説明");
  });
});

describe("what an edit to the markdown is seen as", () => {
  const base = roundTrip(sheetOf());
  const read = (text: string) => JSON.stringify(parseSheetMarkdown(text, base.doc.instances));
  const unchanged = read(base.text);
  const sees = (edited: string): boolean => read(edited) !== unchanged;

  it("sees a value, a remark, an added row and a removed one", () => {
    expect(sees(base.text.replace("| 80 | 8080 |", "| 8080 | 8080 |"))).toBe(true);
    expect(sees(base.text.replace("| `Listen` |", "| `NewOne` | d | 1 | a | a |\n| `Listen` |"))).toBe(true);
    expect(sees(base.text.split("\n").filter((l) => !l.startsWith("| `Listen`")).join("\n"))).toBe(true);
  });

  // The order the SHEET uses, so a reader does not have to re-learn where to
  // look: key, description, default, one column per environment, remarks.
  it("writes the columns in the order the sheet does", () => {
    const header = base.text.split("\n").find((l) => l.startsWith("| 設定項目"));
    // No row here carries a remark, so there is no 備考 column to write.
    expect(header).toBe("| 設定項目 | 説明 | デフォルト値 | staging | production |");
  });

  // …and a column the reviewer ADDS by hand is read: the header row is what
  // says which columns a table has, so a 備考 column written into a document
  // that had none lands on the row it was written for.
  it("reads a column the reviewer added by hand", () => {
    const withRemarks = base.text
      .replace("| staging | production |", "| staging | production | 備考 |")
      .replace(/\| --- \| --- \| --- \| --- \| --- \|/, "| --- | --- | --- | --- | --- | --- |")
      .replace("| `Listen` | リッスンするポート | 80 | 80 | 8080 |", "| `Listen` | リッスンするポート | 80 | 80 | 8080 | 要確認 |");
    const back = parseSheetMarkdown(withRemarks, base.doc.instances, "ja");
    expect(back.sections[0].rows[0].remarks).toBe("要確認");
    expect(back.sections[0].rows[0].values).toEqual({ staging: "80", production: "8080" });
  });

  // A column nobody has anything for is not written at all — the sheet drops
  // those too, and a document of empty cells is harder to edit, not fuller.
  it("leaves out a column the sheet has nothing for", () => {
    const bare = {
      name: "web",
      instances: [],
      categories: [{ name: "c", params: [{ key: "k", value: "1" }] }],
    } as never;
    const text = renderSheetMarkdown(toMarkdownSheet(bare, "ja"));
    expect(text).toContain("| 設定項目 | デフォルト値 | 設定値 |");
    const back = parseSheetMarkdown(text, [], "ja");
    expect(back.sections[0].rows[0]).toMatchObject({ key: "k", values: { "": "1" }, description: "", remarks: "" });
  });

  // The whole point of the prose channel: a reviewer says something the table
  // has no column for, and it is kept rather than dropped.
  it("sees prose written beside a table, and prose written above every heading", () => {
    expect(sees(base.text.replace("## httpd.conf\n", "## httpd.conf\n\nこの節は要検討。\n"))).toBe(true);
    expect(sees(base.text.replace("\n## ", "\n\n全体の所見。\n\n## "))).toBe(true);
  });

  // Formatting is not an edit. A reviewer who re-aligns a table, or whose editor
  // adds a blank line, has changed nothing — and a diff that says otherwise is
  // one nobody will trust.
  it("does not see re-aligned column rules, or blank lines", () => {
    expect(sees(base.text.replace(/\| --- \|/g, "|-----|"))).toBe(false);
    expect(sees(base.text.replace(/\n\n/g, "\n\n\n"))).toBe(false);
  });
});
