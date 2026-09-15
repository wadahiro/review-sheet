// The document a project wrote, with the tables put into it.
//
// What is asserted is the division: the prose is untouched, the marked regions
// are replaced whole, and a marker or a block with no counterpart is an error
// rather than an empty section nobody notices.

import { describe, it, expect } from "bun:test";
import { renderTestDoc, renderExcluded, injectBlocks, unitDocuments } from "../src/testdoc";
import { toMarkdownSet } from "../src/md-set";
import { readMarkdownSet } from "../src/md-read";
import { looksLikeParamSheet } from "../src/sheet-markdown";
import type { SheetData } from "../src/prompt";
import type { TestPlan } from "../src/testplan";
import type { TestResults } from "../src/testresults";

const plan = (): TestPlan =>
  ({
    metadata: { title: "t" },
    units: [
      {
        name: "server",
        label: { ja: "SSO サーバ" },
        declaration: { method: { ja: "実機のファイルを読む" }, functional: [{ ja: "起動・停止ができること" }] },
        sheets: ["os"],
      },
    ],
    items: [
      { target: { sheet: "os", path: ["httpd.conf"], key: "Listen", instance: "local" }, unit: "server", sheetLabel: { ja: "OS 基盤" }, component: "httpd.conf", kind: "value", decider: "project", expected: "80" },
      { target: { sheet: "os", path: ["httpd.conf"], key: "Listen", instance: "prod" }, unit: "server", component: "httpd.conf", kind: "value", decider: "project", expected: "80" },
      { target: { sheet: "os", path: ["httpd.conf"], key: "pw", instance: "local" }, unit: "server", component: "httpd.conf", kind: "value", decider: "project", quiet: true },
      { target: { sheet: "os", path: ["httpd.conf"], key: "Timeout", instance: "local" }, unit: "server", component: "httpd.conf", kind: "default-in-force", decider: "product-default", expected: "60" },
      { target: { sheet: "os", path: ["httpd.conf"], key: "Gone", instance: "local" }, unit: "server", component: "httpd.conf", kind: "absent", decider: "vendor-removed" },
    ],
    functional: [
      { unit: "server", text: { ja: "起動・停止ができること" }, intrusive: false, instance: "local" },
      { unit: "server", text: { ja: "起動・停止ができること" }, intrusive: false, instance: "prod" },
      { unit: "server", id: "restart", text: { ja: "再起動できること" }, intrusive: true, instance: "local" },
      { unit: "server", id: "restart", text: { ja: "再起動できること" }, intrusive: true, instance: "prod" },
    ],
  }) as TestPlan;

const results = (): TestResults => ({
  runs: { local: { at: "2026-09-07T07:36:49Z", hosts: ["web01", "web02"] } },
  results: [
    { target: { sheet: "os", key: "Listen", instance: "local" }, status: "pass", detail: "デプロイ済みファイル", evidence: { host: "web01", file: "/etc/httpd/conf/httpd.conf", line: 12 } },
    { target: { sheet: "os", key: "Listen", instance: "prod" }, status: "not_run", reason: "本番は未構築" },
    { target: { sheet: "os", key: "pw", instance: "local" }, status: "pass" },
    { target: { sheet: "os", key: "Timeout", instance: "local" }, status: "pass" },
    { target: { sheet: "os", key: "Gone", instance: "local" }, status: "fail", actual: "on" },
  ],
  functional: [{ unit: "server", item: "起動・停止ができること", instance: "local", status: "pass" }],
});

describe("the tables a document is given", () => {
  // The item is the SETTING; what to expect of it belongs in the column whose
  // whole job is to say so. Carrying it as a sentence put the same nine
  // characters on 997 of 1,012 rows of a real record while the expected column
  // sat empty for the exceptions.
  it("names the setting, and lets the expected column say what to expect", () => {
    const b = renderTestDoc(plan(), results(), "server", { includeDefaults: true });
    const row = (key: string): string =>
      b["test:items"].split("\n").find((l) => l.includes(`\`${key}\``)) ?? "";
    expect(row("Listen")).toContain("| `Listen` | `80` | 本案件で設定 |");
    // …a row still on the product's own default says WHICH, beside the value.
    expect(row("Timeout")).toContain("| `Timeout` | `60` | 製品の既定値 |");
    // …and one the vendor shipped and this project removed has no value to
    // state, so the column states the absence itself.
    expect(row("Gone")).toContain("| `Gone` | （設定なし） | ベンダ配布から削除 |");
  });

  // An expectation that IS the empty string is a setting turned off, not a row
  // with nothing to expect — and rendered blank the two are the same cell.
  it("says so when what is expected is emptiness itself", () => {
    const p = plan();
    p.items = [
      { target: { sheet: "os", path: ["a"], key: "user", instance: "local" }, unit: "server", component: "a", kind: "value", decider: "project", expected: "" },
      { target: { sheet: "os", path: ["a"], key: "rp", instance: "local" }, unit: "server", component: "a", kind: "default-in-force", decider: "product-default", expected: "" },
    ] as never;
    const b = renderTestDoc(p, { results: [] } as never, "server", { includeDefaults: true });
    const row = (k: string): string => b["test:items"].split("\n").find((l) => l.includes(`\`${k}\``)) ?? "";
    expect(row("user")).toContain("| `user` | （空） | 本案件で設定 |");
    expect(row("rp")).toContain("| `rp` | （空） | 製品の既定値 |");
  });

  // The taxonomy names three levels; a reader has to be able to point at each
  // of them ON THE PAGE. The 中項目 is the SHEET, and it used to render nowhere
  // at all — the only heading inside an environment was the component, which is
  // addressing detail INSIDE a sheet, unlabelled and easily read as the level
  // the taxonomy was talking about.
  it("names the level of every heading, and puts the sheet where the taxonomy says it is", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).toContain("### SSO サーバ (local)");
    expect(b["test:items"]).toContain("#### OS 基盤");
  });

  // …and the component moves into the table, because it is what each row is
  // ABOUT and because a client identified by a URL makes an unreadable heading.
  it("carries the component as a column of the row it belongs to", () => {
    const b = renderTestDoc(plan(), results(), "server");
    const head = b["test:items"].split("\n").find((l) => l.startsWith("| No."))!;
    expect(head).toContain("対象");
    expect(head).toContain("小項目");
    expect(b["test:items"]).toContain("| httpd.conf |");
  });

  it("puts each environment in its own section, with when it ran and where", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).toContain("### SSO サーバ (local)");
    expect(b["test:items"]).toContain("実施日時: 2026-09-07T07:36:49Z ／ 対象ホスト: web01, web02");
    // …and an environment nobody ran says so rather than looking blank.
    expect(b["test:items"]).toContain("### SSO サーバ (prod)");
    expect(b["test:items"]).toContain("実施日時: — ／ 対象ホスト: — （未実施）");
  });

  it("carries the verdict, how it was checked and where to look again", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).toContain("| OK | デプロイ済みファイル | web01 /etc/httpd/conf/httpd.conf:12 |");
    expect(b["test:items"]).toContain("NG");
    expect(b["test:items"]).toContain("未実施");
  });

  // The heading of every section already says when the run was and which hosts
  // it reached. Repeating that date down a thousand rows says nothing new — and
  // this record is committed and read as a diff, so a re-run that found exactly
  // the same answers used to rewrite every row of it.
  it("does not repeat the run's own date on every row", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).toContain("実施日時: 2026-09-07T07:36:49Z");
    expect(b["test:items"].split("2026-09-07").length - 1).toBe(1);
    expect(b["test:items"]).not.toContain("| 実施日 |");
  });

  // The property all of the above is for, stated directly: the record is
  // committed and reviewed as a diff, so a run that found the same answers on a
  // different day must produce the same document but for the line that says
  // when it ran.
  it("differs only in the heading when a later run finds the same answers", () => {
    const first = renderTestDoc(plan(), results(), "server")["test:items"];
    const later = results();
    later.runs = { local: { at: "2026-10-01T09:00:00Z", hosts: ["web01", "web02"] } };
    const second = renderTestDoc(plan(), later, "server")["test:items"];
    const differing = first
      .split("\n")
      .map((l, i) => [l, second.split("\n")[i]] as const)
      .filter(([a, b]) => a !== b);
    expect(differing.map(([a]) => a)).toEqual([
      "実施日時: 2026-09-07T07:36:49Z ／ 対象ホスト: web01, web02",
    ]);
  });

  // …and says it where the row knows something the heading does not: an answer
  // carried over from an earlier day, which is the whole reason the column
  // exists.
  it("says the day of an answer the run did not produce", () => {
    const older = results();
    older.results[2] = { ...older.results[2], at: "2026-08-30T01:00:00Z" };
    const b = renderTestDoc(plan(), older, "server");
    expect(b["test:items"]).toContain("| 実施日 |");
    expect(b["test:items"]).toContain("2026-08-30");
    // Only that one: every other row was answered by this run.
    expect(b["test:items"].split("2026-08-30").length - 1).toBe(1);
  });

  // A record that says "not run" and keeps the reason to itself is the shape a
  // silent gap takes: 3,058 answers on a real record carried one and the
  // delivered document showed none of them.
  it("says why an item was not run", () => {
    const b = renderTestDoc(plan(), results(), "server");
    const row = b["test:items"].split("\n").find((l) => l.includes("`Listen`") && l.includes("未実施")) ?? "";
    expect(row).toContain("本番は未構築");
    // …and an item that WAS run says nothing there — the column is for the gap.
    const ran = b["test:items"].split("\n").find((l) => l.includes("`Listen`") && l.includes("| OK |")) ?? "";
    expect(ran.endsWith("|  |")).toBe(true);
  });

  // The plan withheld the value; the document prints the verdict without it.
  it("prints a secret's verdict and never its value", () => {
    const b = renderTestDoc(plan(), results(), "server");
    const line = b["test:items"].split("\n").find((l) => l.includes("`pw`")) ?? "";
    expect(line).toContain("OK");
    expect(line).toContain("—");
  });

  // Two thousand "still on the default" rows are a real check and not what a
  // reviewer signs, so they are counted rather than enumerated — unless asked
  // for.
  it("counts the unset-parameter items instead of listing them", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).not.toContain("`Timeout`");
    expect(b["test:summary"]).toContain("設定していない 1 項目");
    const all = renderTestDoc(plan(), results(), "server", { includeDefaults: true });
    expect(all["test:items"]).toContain("`Timeout`");
  });

  it("computes the summary rather than trusting a written one", () => {
    const b = renderTestDoc(plan(), results(), "server");
    // 4 rows shown (the default-in-force one is counted separately): Listen×2,
    // pw, Gone — plus the 4 functional items, which are items of this unit test
    // and not a postscript to it. Answered: 3 rows and 1 functional.
    expect(b["test:summary"]).toContain("| テスト項目数 | 8（local 5 / prod 3） |");
    expect(b["test:summary"]).toContain("| 実施済み | 4 |");
    expect(b["test:summary"]).toContain("| 未実施 | 4 |");
    expect(b["test:summary"]).toContain("| 判定 | OK 3 / NG 1 |");
  });

  // An item with no row behind it is still an item of THIS environment's unit
  // test, so it is a sub-heading inside that environment rather than a section
  // of its own at the end. Splitting them by where they came from made a reader
  // answer "is prod finished" in two places; the environment is the one axis.
  it("puts the items that have no row behind them inside their environment", () => {
    const b = renderTestDoc(plan(), results(), "server");
    const items = b["test:items"];
    const at = (s: string): number => items.indexOf(s);
    expect(at("### SSO サーバ (local)")).toBeLessThan(at("#### 機能確認"));
    expect(at("#### 機能確認")).toBeLessThan(at("### SSO サーバ (prod)"));
    // Two of them, one per environment, and neither carries the environment in
    // its own text any more — the heading above it says which.
    expect(items.split("#### 機能確認").length - 1).toBe(2);
    expect(items).not.toContain("local: 起動・停止ができること");
    // The answered one reads OK; the numbering continues the environment's.
    expect(items).toMatch(/\| \d+ \| 起動・停止ができること \| OK \|/);
    // …and there is no separate block to inject any more.
    expect(b["test:functional"]).toBeUndefined();
  });

  // A judge answers by the declaration's id where it was given one. The prose
  // is what a reader sees and what a project may reword; joining on it was a
  // join that breaks silently the day someone fixes a typo.
  it("joins a functional answer by its id, not by the sentence", () => {
    const r = results();
    r.functional = [{ unit: "server", id: "restart", item: "文言はあとで変わった", instance: "local", status: "fail" }];
    const b = renderTestDoc(plan(), r, "server");
    expect(b["test:items"]).toMatch(/\| 再起動できること \| NG \|/);
  });

  // An intrusive item nobody ran did not fall through a gap: it was never
  // permitted. A bare 未実施 cannot tell a reader which of the two happened.
  it("says why an intrusive item was not run", () => {
    const b = renderTestDoc(plan(), results(), "server");
    const row = b["test:items"].split("\n").find((l) => l.includes("再起動できること")) ?? "";
    expect(row).toContain("未実施");
    expect(row).toContain("実行者が明示的に許可したときだけ実施する項目");
  });

  // The levels' names and the rule for raising items are the PROJECT's words —
  // an organisation's test standard states them, and quoting one organisation's
  // sentences inside a general-purpose tool would publish them to every other
  // project it builds. What the tool adds is where each level actually is on
  // the page it just wrote.
  it("renders the project's classification, and says where each level is", () => {
    const p = plan();
    p.units[0].declaration.taxonomy = [
      { level: { ja: "大項目" }, raised: { ja: "サーバ単位" } },
      { level: { ja: "中項目" }, raised: { ja: "コンポーネント単位" } },
      { level: { ja: "小項目" }, raised: { ja: "設定を網羅" } },
    ];
    const b = renderTestDoc(p, results(), "server");
    expect(b["test:taxonomy"]).toContain("大項目");
    expect(b["test:taxonomy"]).toContain("サーバ単位");
    // This unit HAS functional items, so its middle level is not "a sheet of
    // the detailed design" any more and its rows are not all derived. Saying so
    // would describe a page the reader is not holding.
    expect(b["test:taxonomy"]).toContain("および「機能確認」");
    expect(b["test:taxonomy"]).toContain("機能確認は宣言した項目を並べる");
  });

  // …and a unit with none of them keeps the plainer sentence, for the same reason.
  it("says where each level is for the page it actually wrote", () => {
    const p = plan();
    p.functional = [];
    p.units[0].declaration.taxonomy = [
      { level: { ja: "大項目" }, raised: { ja: "サーバ単位" } },
      { level: { ja: "中項目" }, raised: { ja: "コンポーネント単位" } },
      { level: { ja: "小項目" }, raised: { ja: "設定を網羅" } },
    ];
    const b = renderTestDoc(p, results(), "server");
    expect(b["test:taxonomy"]).toContain("詳細設計のシート。その環境の中の見出しで、項目表ごとに1つ");
    expect(b["test:taxonomy"]).not.toContain("機能確認");
  });

  // …and nothing of its own when the project stated nothing. A document that
  // asks for the block anyway gets injectBlocks' "a marker nothing produced".
  it("offers no classification the project did not write", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:taxonomy"]).toBeUndefined();
  });

  // Two components of one sheet share a key space BY DESIGN — a federation
  // sheet has `config.usernameLDAPAttribute[0]` under every provider — so an
  // answer index keyed by sheet+key alone gives every one of them the LAST
  // component's answer. Measured on a real record: the internal-ldap row showed
  // supplier-ldap's verdict, its date, its evidence and (once evidence became a
  // link) opened supplier-ldap's line in the collected document.
  it("gives each component its own answer, not the last one's", () => {
    const p = plan();
    p.items = [
      { target: { sheet: "os", path: ["corp"], key: "attr", instance: "local" }, unit: "server", component: "corp", kind: "value", decider: "project", expected: "sAMAccountName" },
      { target: { sheet: "os", path: ["partner"], key: "attr", instance: "local" }, unit: "server", component: "partner", kind: "value", decider: "project", expected: "uid" },
    ] as never;
    const r = results();
    r.results = [
      { target: { sheet: "os", path: ["corp"], key: "attr", instance: "local" }, status: "pass", evidence: { host: "n1", file: "/realm", line: 845 } },
      { target: { sheet: "os", path: ["partner"], key: "attr", instance: "local" }, status: "fail", actual: "uid", evidence: { host: "n1", file: "/realm", line: 1071 } },
    ] as never;
    const b = renderTestDoc(p, r, "server");
    const rows = b["test:items"].split("\n").filter((l) => l.includes("`attr`"));
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("| corp |");
    expect(rows[0]).toContain("OK");
    expect(rows[0]).toContain(":845");
    expect(rows[1]).toContain("| partner |");
    expect(rows[1]).toContain("NG");
    expect(rows[1]).toContain(":1071");
  });

  it("refuses a unit this plan does not have", () => {
    expect(() => renderTestDoc(plan(), results(), "nope")).toThrow(/server/);
  });

  it("lists what the project put out of scope, with the reason", () => {
    const md = renderExcluded([{ unit: "server", sheet: "os", key: "db-password", reason: { ja: "DBA の管轄" }, owner: "DBA" }], "server");
    expect(md).toContain("`db-password`");
    expect(md).toContain("DBA の管轄");
  });

  // Two components of one sheet exclude the same key by design — a federation
  // sheet's bind credential, once per provider. Without the component the two
  // lines are identical, and a reader cannot tell which one each is about.
  it("says which component an exclusion belongs to", () => {
    const md = renderExcluded(
      [
        { unit: "server", sheet: "ldap", component: "corp", key: "config.bindCredential[0]", reason: { ja: "秘密" } },
        { unit: "server", sheet: "ldap", component: "partner", key: "config.bindCredential[0]", reason: { ja: "秘密" } },
      ],
      "server"
    );
    const rows = md.split("\n").filter((l) => l.includes("bindCredential"));
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain("ldap > corp >");
    expect(rows[1]).toContain("ldap > partner >");
  });
});

describe("putting them into the document", () => {
  const doc = [
    "# httpd 単体テスト",
    "",
    "## （１）テスト方法",
    "人が書いた文章。ここは触られない。",
    "",
    "## （３）テスト項目・結果",
    "<!-- test:items:start -->",
    "古い表",
    "<!-- test:items:end -->",
    "",
    "おわりの文章。",
  ].join("\n");

  it("replaces what is between the markers and nothing else", () => {
    const out = injectBlocks(doc, { "test:items": "| a |\n| --- |" });
    expect(out).toContain("人が書いた文章。ここは触られない。");
    expect(out).toContain("おわりの文章。");
    expect(out).toContain("| a |");
    expect(out).not.toContain("古い表");
    // …and the markers survive, or the next run has nowhere to write.
    expect(out).toContain("<!-- test:items:start -->");
    expect(out).toContain("<!-- test:items:end -->");
  });

  it("is idempotent", () => {
    const once = injectBlocks(doc, { "test:items": "X" });
    expect(injectBlocks(once, { "test:items": "X" })).toBe(once);
  });

  // The two directions are not symmetric, and the asymmetry is the point. A
  // block carrying ANSWERS must land somewhere — losing it loses the run.
  it("refuses to drop a block that carries answers", () => {
    const noItems = doc.replace("<!-- test:items:start -->", "").replace("<!-- test:items:end -->", "");
    expect(() => injectBlocks(noItems, { "test:items": "X" }, ["test:items"])).toThrow(/test:items/);
  });

  // …while a summary or a taxonomy table is a restatement of something the
  // document still holds, so a project may simply not want it.
  it("lets a document take only the blocks it wants", () => {
    const out = injectBlocks(doc, { "test:items": "X", "test:summary": "Y", "test:taxonomy": "Z" }, ["test:items"]);
    expect(out).toContain("X");
    expect(out).not.toContain("Y");
  });

  it("refuses a marker nothing produced", () => {
    const asks = doc + "\n<!-- test:functional:start -->\n<!-- test:functional:end -->\n";
    expect(() => injectBlocks(asks, { "test:items": "X" })).toThrow(/test:functional/);
  });
});

// The method is declared once, where the plan reads it, and rendered where the
// document asks for it — never written twice.
describe("the method a project declared", () => {
  it("is rendered from the declaration", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:method"]).toBe("実機のファイルを読む");
  });
});

// Which document holds which unit's record. It was a line in a shell script per
// unit, so a unit somebody forgot to add produced no record at all: its items
// were planned, answered and counted, the build exited 0, and the chapter
// simply did not exist. That is the one failure this whole area refuses.
describe("where each unit's record is written", () => {
  const twoUnits = (): TestPlan =>
    ({
      metadata: { title: "t" },
      units: [
        { name: "a", declaration: { method: { ja: "m" }, document: "record A" }, sheets: ["sa"] },
        { name: "b", declaration: { method: { ja: "m" }, document: "record B" }, sheets: ["sb"] },
      ],
      items: [
        { target: { sheet: "sa", path: ["c"], key: "k1", instance: "stg" }, unit: "a", kind: "value", decider: "project", expected: "1" },
        { target: { sheet: "sb", path: ["c"], key: "k2", instance: "stg" }, unit: "b", kind: "value", decider: "project", expected: "2" },
      ],
      functional: [],
    }) as TestPlan;
  const sheets = [
    { name: "record A", source_file: "docs/a.md", document: { text: "" } },
    { name: "record B", source_file: "docs/b.md", document: { text: "" } },
  ];

  it("is the file the document sheet it names already says it came from", () => {
    expect(unitDocuments(twoUnits(), sheets)).toEqual([
      { unit: "a", path: "docs/a.md" },
      { unit: "b", path: "docs/b.md" },
    ]);
  });

  // The whole point: a unit with items and no document named is an error, not a
  // unit quietly skipped.
  it("refuses a unit that has items and names no document", () => {
    const p = twoUnits();
    delete p.units[1].declaration.document;
    expect(() => unitDocuments(p, sheets)).toThrow(/no document for 1 unit\(s\) with items: b/);
  });

  // …while a unit not tested in this phase has no items, and its statement
  // stands in for them wherever the project put it.
  it("asks for nothing from a unit with no items", () => {
    const p = twoUnits();
    p.units[1] = { name: "b", declaration: { not_tested: { ja: "対象外" } }, sheets: ["sb"] };
    p.items = p.items.filter((i) => i.unit === "a");
    expect(unitDocuments(p, sheets).map((d) => d.unit)).toEqual(["a"]);
  });

  // A name that resolves to nothing is a typo, and it must not read as "no
  // document declared" — the two need different fixes.
  it("names what is wrong with a document it cannot resolve", () => {
    const p = twoUnits();
    p.units[1].declaration.document = "record Z";
    expect(() => unitDocuments(p, sheets)).toThrow(/b: no sheet named "record Z"/);
    p.units[1].declaration.document = "record B";
    expect(() => unitDocuments(p, [{ name: "record A", source_file: "docs/a.md", document: { text: "" } }, { name: "record B", document: { text: "" } }])).toThrow(
      /does not say which file it was read from/
    );
    expect(() => unitDocuments(p, [{ name: "record A", source_file: "docs/a.md", document: { text: "" } }, { name: "record B", source_file: "x.md" }])).toThrow(
      /is not a document sheet/
    );
  });
});


// A record this tool wrote, carried in a set and read back.
//
// The join nothing covered, and the one that was wrong in both directions. The
// set wrote a document sheet as its TITLE and nothing else, because the
// projection walks categories and a document has none; and once the prose did
// travel, the reader took it for a parameter sheet — because this file heads
// its excluded-settings table with the projection's own key column
// (`excludedCols`), so the collision is between two halves of this tool rather
// than anything a project did.
//
// Each half had tests of its own. Their meeting had none.
describe("a record of this tool's own, through a set", () => {
  // Assembled the way a project's own document holds these: the blocks this
  // file renders, under headings somebody wrote.
  const record = (): string => {
    const blocks = renderTestDoc(plan(), results(), "server");
    return [
      "# Record",
      "",
      "What this record covers.",
      "",
      ...Object.values(blocks).flatMap((b) => ["## Items", "", b, ""]),
      "## Out of scope",
      "",
      renderExcluded([{ unit: "server", sheet: "os", key: "pw", reason: { ja: "secret" }, owner: "ops" }], "server"),
      "",
    ].join("\n");
  };

  const model = (): SheetData =>
    ({
      metadata: { title: "t" },
      groups: [{ name: "rec", display: "Records" }],
      sheets: [{ name: "unit", display: "Unit", group: "rec", categories: [], document: { html: "<p>x</p>", markdown: record() } }],
    }) as unknown as SheetData;

  it("carries the record, not just the sheet's name", () => {
    const page = toMarkdownSet(model(), "ja").files.find((f) => f.path === "Records/Unit.md")!;
    // The item table this file writes, in the delivered file.
    expect(page.text).toContain("| 1 | httpd.conf | `Listen` |");
    expect(page.text).toContain("| os > `pw` | secret | ops |");
    expect(page.text.length).toBeGreaterThan(1000);
  });

  // The table this file heads with the projection's own key column is the
  // reason one head cannot decide what a page is.
  it("is still read as prose, though it uses the key column for its own table", () => {
    const text = record();
    expect(text).toContain("設定項目");
    expect(looksLikeParamSheet(text)).toBe(false);

    const { files } = toMarkdownSet(model(), "ja");
    const read = readMarkdownSet(files.map((f) => ({ path: f.path, text: f.text })), "ja");
    const back = read.sheets.find((x) => x.display === "Unit")!;
    expect(back.document.mode).toBeUndefined();
    expect(back.categories).toEqual([]);
    expect(back.instances).toEqual([]);
    expect(read.problems.filter((x) => x.includes("read as prose"))).toEqual([]);
  });
});

// A row whose name is not a name anybody set. Three of Keycloak's realm fields
// are written by ONE control of the admin console, and no operator ever set
// `permanentLockout` — they set "Brute Force Mode", once.
describe("a row the product's screen has no field for", () => {
  const CONTROL = {
    label: { ja: "ブルートフォースモード", en: "Brute Force Mode" },
    of: ["bruteForceProtected", "permanentLockout"],
    modes: [{ label: { ja: "無効" }, values: { bruteForceProtected: "false", permanentLockout: "false" } }],
  };
  const withControl = (): TestPlan =>
    ({
      metadata: { title: "t" },
      units: [{ name: "server", declaration: { method: { ja: "API を読む" } }, sheets: ["realm"] }],
      items: [
        { target: { sheet: "realm", path: ["Security"], key: "bruteForceProtected", instance: "prod" }, unit: "server", component: "Security", kind: "value", decider: "project", expected: "true", control: CONTROL },
        { target: { sheet: "realm", path: ["Security"], key: "permanentLockout", instance: "prod" }, unit: "server", component: "Security", kind: "value", decider: "project", expected: "false", control: CONTROL },
        // Its own field on the same screen — not part of the control, and named
        // by the product in its own right.
        { target: { sheet: "realm", path: ["Security"], key: "failureFactor", instance: "prod" }, unit: "server", component: "Security", kind: "value", decider: "project", expected: "5", label: { ja: "最大ログイン失敗回数", en: "Max login failures" } },
        // …and one the product names not at all.
        { target: { sheet: "realm", path: ["Security"], key: "waitIncrementSeconds", instance: "prod" }, unit: "server", component: "Security", kind: "value", decider: "project", expected: "60" },
      ],
      functional: [],
    }) as TestPlan;

  const items = (lang: "ja" | "en" = "ja"): string[] =>
    renderTestDoc(withControl(), { results: [] } as TestResults, "server", { lang })
      ["test:items"]!.split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| No.") && !l.startsWith("| ---"));

  it("names the control each row is part of, so one row alone can be traced to the screen", () => {
    const cells = items().map((l) => l.split("|")[3]!.trim());
    expect(cells).toEqual([
      "ブルートフォースモード / `bruteForceProtected`",
      "ブルートフォースモード / `permanentLockout`",
      // Its own name, not the control's — it is a field of its own.
      "最大ログイン失敗回数 / `failureFactor`",
      // Nothing to put in front of the key, so nothing is.
      "`waitIncrementSeconds`",
    ]);
  });

  it("adds no item for the control itself", () => {
    // The mode is a function of the values, so a check of it could neither fail
    // while they pass nor pass while one fails — and the API has no field of
    // that name to have read. Three rows in, three rows out.
    expect(items()).toHaveLength(4);
    expect(items().map((l) => l.split("|")[1]!.trim())).toEqual(["1", "2", "3", "4"]);
  });

  it("names it in the reader's language", () => {
    expect(items("en")[0]).toContain("Brute Force Mode / `bruteForceProtected`");
  });
});

// The instant is the fact; the zone is how a reader meets it.
describe("a record read in the reader's own zone", () => {
  const planAt = (): TestPlan =>
    ({
      metadata: { title: "t" },
      units: [{ name: "server", declaration: { method: { ja: "読む" } }, sheets: ["os"] }],
      items: [
        { target: { sheet: "os", path: ["c"], key: "Listen", instance: "local" }, unit: "server", component: "c", kind: "value", decider: "project", expected: "80" },
      ],
      functional: [],
    }) as TestPlan;
  // 23:30Z on the 14th is 08:30 on the 15th in Tokyo — the case where taking
  // the date off the instant is not merely raw but wrong.
  const resultsAt = (runAt: string, rowAt: string): TestResults => ({
    runs: { local: { at: runAt, hosts: ["web01"] } },
    results: [{ target: { sheet: "os", key: "Listen", instance: "local" }, status: "pass", at: rowAt }],
  });
  const items = (opts: Record<string, unknown>, runAt = "2026-09-14T23:30:00Z", rowAt = "2026-09-14T23:30:00Z"): string =>
    renderTestDoc(planAt(), resultsAt(runAt, rowAt), "server", opts)["test:items"]!;

  it("prints the instant exactly as recorded when no zone is given", () => {
    expect(items({ lang: "ja" })).toContain("2026-09-14T23:30:00Z");
  });

  it("reads it in the zone, keeping the offset", () => {
    // Without the offset a record says "08:30" and cannot be lined up with a
    // log on the host, which is why it carries a time at all.
    expect(items({ lang: "ja", timezone: "Asia/Tokyo" })).toContain("2026-09-15 08:30:00 +09:00");
  });

  it("moves the per-row date with it", () => {
    // The row's own date is printed only when it differs from the run's. Here
    // they are the same instant, so nothing is printed — and that agreement is
    // itself what the zone has to preserve.
    const tokyo = items({ lang: "ja", timezone: "Asia/Tokyo" }, "2026-09-14T23:30:00Z", "2026-09-15T02:00:00Z");
    // 02:00Z on the 15th is 11:00 on the 15th in Tokyo — the same DAY as the
    // run, so the column stays empty, where reading both in UTC would have
    // shown the 15th against a run dated the 14th.
    expect(tokyo).not.toContain("2026-09-15 ／");
    const utc = items({ lang: "ja" }, "2026-09-14T23:30:00Z", "2026-09-15T02:00:00Z");
    expect(utc).toContain("2026-09-15");
  });
});

// A table cell ends at a `|`, and an address is free to hold one.
describe("an address with a pipe in it", () => {
  const piped = "journalctl -u keycloak | grep X | tail -1";
  const carried = [{ instance: "local", host: "web01", at: "2026-09-07T07:36:49Z", sheet: "os", command: piped, text: "x\n" }];
  const withCommand = (): TestResults => {
    const r = results();
    r.results[0] = { target: { sheet: "os", key: "Listen", instance: "local" }, status: "pass", evidence: { host: "web01", command: piped } };
    return { ...r, evidence: carried };
  };

  it("does not end the row it is written in", () => {
    const row = renderTestDoc(plan(), withCommand(), "server", { includeDefaults: true })
      ["test:items"].split("\n")
      .find((l) => l.includes("Listen") && l.includes("journalctl"))!;
    // The columns after the evidence one are still there — an unescaped pipe
    // takes the rest of the row with it, the link included.
    expect(row.split(/(?<!\\)\|/).length).toBe(renderTestDoc(plan(), results(), "server", { includeDefaults: true })
      ["test:items"].split("\n").find((l) => l.includes("Listen") && l.includes("web01"))!.split(/(?<!\\)\|/).length);
    expect(row).toContain("rs-evidence:");
  });
});
