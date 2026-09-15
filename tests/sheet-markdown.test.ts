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
import { toMarkdownSheet, renderSheetMarkdown, parseSheetMarkdown, splitKeyCell, tableShape, declaredInstances } from "../src/sheet-markdown";
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

// The way into the file a row is a line of, written under the row's key.
//
// It shares a cell with the identity, which is the whole hazard: an address
// left stuck to the key would make every row a row the model does not have, and
// a change set that reports an untouched sheet rewritten is one nobody reads.
describe("the address under a row's key", () => {
  const withPreview = (dest: (key: string) => string | undefined) =>
    renderSheetMarkdown(toMarkdownSheet(sheetOf(), "ja", { preview: (p) => dest(p.key) }));

  it("writes one word, the same on every row, and the address behind it", () => {
    const text = withPreview((k) => (k === "Listen" ? "artifacts/httpd.conf#L12" : undefined));
    expect(text).toContain("`Listen`<br>[プレビュー](artifacts/httpd.conf#L12)");
    // A row no file has a line for gets nothing rather than an address that
    // opens nothing — the rule the sheet's own affordance already follows.
    expect(text).toContain("`ServerTokens` |");
  });

  it("adds no column: the table is the one a set without addresses has", () => {
    const heads = (text: string): string[] => text.split("\n").find((l) => l.startsWith("| 設定項目"))!.split("|").map((h) => h.trim());
    expect(heads(withPreview(() => "artifacts/x#L1"))).toEqual(heads(renderSheetMarkdown(toMarkdownSheet(sheetOf(), "ja"))));
  });

  it("round-trips: the key read back is the key, not the key and its address", () => {
    const doc = toMarkdownSheet(sheetOf(), "ja", { preview: () => "artifacts/httpd.conf#L12" });
    const text = renderSheetMarkdown(doc);
    const back = parseSheetMarkdown(text, doc.instances);
    expect(back.sections[0].rows.map((r) => r.key)).toEqual(["Listen", "ServerTokens"]);
  });

  it("leaves a key that merely looks like one whole", () => {
    // Anchored on the closing backtick and a COMPLETE link after it. A key
    // holding brackets of its own is still just a key.
    expect(splitKeyCell("`attributes[\"a.b\"]`")).toEqual({ key: '`attributes["a.b"]`' });
    expect(splitKeyCell("`k`<br>[プレビュー](a/b#L3)")).toEqual({ key: "`k`", preview: "a/b#L3" });
    expect(splitKeyCell("`k`<br>[プレビュー](a/b")).toEqual({ key: "`k`<br>[プレビュー](a/b" });
  });

  // A header this projection wrote once and writes no more.
  //
  // A document's environments are read off its own headers, and a header this
  // projection cannot place is taken for an environment — so a retired one
  // forgotten here would give every already-delivered set an axis nobody
  // declared, on the next reading of it, from a change that was only ever about
  // what to stop writing.
  it("still recognises the column it used to write", () => {
    const delivered = [
      "| 設定項目 | 説明 | デフォルト値 | staging | production | 定義場所 |",
      "| --- | --- | --- | --- | --- | --- |",
      "| `Listen` | p | 80 | 80 | 8080 | [main.yml:3](../main.yml#L3) |",
      "",
    ].join("\n");
    expect(declaredInstances(delivered)).toEqual(["staging", "production"]);
    const shape = tableShape(delivered.split("\n")[0].split("|").slice(1, -1).map((h) => h.trim()), [], "ja");
    expect(shape.values).toEqual([3, 4]);
    expect(shape.rest).toEqual([5]);
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

// One control of the product's screen, written into a handed-over set — the
// same reading the sheet's own viewer puts above the rows that spell it
// (composite.ts). Until this existed the control was the one thing a reader saw
// on screen and not in the document they were given.
describe("a control in a handed-over set", () => {
  const CONTROL = {
    control: { ja: "検知モード" },
    description: { ja: "検出時に何が起きるかを指定します。" },
    of: ["detect", "permanent"],
    modes: [
      { label: { ja: "無効" }, values: { detect: "false", permanent: "false" } },
      { label: { ja: "一時的に停止" }, values: { detect: "true", permanent: "false" } },
    ],
  };
  const sheet = (params: unknown[], instances?: string[]) =>
    ({ name: "s", ...(instances === undefined ? {} : { instances }), categories: [{ name: "c", params }] }) as unknown as SheetData["sheets"][number];

  const pair = [
    { key: "detect", value: "true", default: "false", description: { ja: "d" }, composite: CONTROL },
    { key: "permanent", default: "false", description: { ja: "p" }, composite: CONTROL },
  ];

  it("writes the control as a row, with the choice the rows spell", () => {
    const md = renderSheetMarkdown(toMarkdownSheet(sheet(pair), "ja"));
    const line = md.split("\n").find((l) => l.includes("検知モード"))!;
    expect(line).toContain("**検知モード**");
    // Its value is the mode; its default is what a fresh install spells.
    expect(line).toContain("一時的に停止");
    expect(line).toContain("無効");
    expect(line).toContain("検出時に何が起きるかを指定します。");
    // No code span: that is what marks it as not a parameter.
    expect(line.split("|")[1]).not.toContain("`");
  });

  it("does not come back as a row", () => {
    // It has no key and no address. Read as a row it would be one the model
    // does not have, reported as added on every read of a delivered set.
    const doc = toMarkdownSheet(sheet(pair), "ja");
    const back = parseSheetMarkdown(renderSheetMarkdown(doc), [], "ja");
    expect(back.sections[0]!.rows.map((r) => r.key)).toEqual(["detect", "permanent"]);
  });

  it("writes nothing where the set carries only part of the tuple", () => {
    const md = renderSheetMarkdown(toMarkdownSheet(sheet([pair[0]]), "ja"));
    expect(md).not.toContain("**検知モード**");
    expect(md).toContain("detect");
  });

  it("answers per environment", () => {
    const perEnv = [
      { key: "detect", description: { ja: "d" }, default: "false", composite: CONTROL, instances: [{ name: "stg", value: "true" }, { name: "prod", value: "false" }] },
      { key: "permanent", default: "false", description: { ja: "p" }, composite: CONTROL },
    ];
    const md = renderSheetMarkdown(toMarkdownSheet(sheet(perEnv, ["stg", "prod"]), "ja"));
    const line = md.split("\n").find((l) => l.includes("**検知モード**"))!;
    const cells = line.split("|").map((c) => c.trim());
    expect(cells.slice(-3, -1)).toEqual(["一時的に停止", "無効"]);
  });
});

// A document nothing deploys is not a preview of anything.
describe("the word a row's address wears", () => {
  const sheet = () =>
    ({ name: "aws", categories: [{ name: "alb", params: [{ key: "idle_timeout", value: "60", description: { ja: "d" } }] }] }) as unknown as SheetData["sheets"][number];

  it("says the ordinary word for a file that gets deployed", () => {
    const doc = toMarkdownSheet(sheet(), "ja", { preview: () => "artifacts/httpd.conf#L4" });
    expect(renderSheetMarkdown(doc)).toContain("[プレビュー](artifacts/httpd.conf#L4)");
  });

  it("says the document's own word when the caller names one", () => {
    // A Terraform module's `.tf` is authored and never deployed — the viewer's
    // button says so, and the set must not disagree with it.
    const doc = toMarkdownSheet(sheet(), "ja", { preview: () => ({ href: "artifacts/main.tf#L4", word: "ソース" }) });
    const md = renderSheetMarkdown(doc);
    expect(md).toContain("[ソース](artifacts/main.tf#L4)");
    expect(md).not.toContain("プレビュー");
  });
});
