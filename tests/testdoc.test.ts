// The document a project wrote, with the tables put into it.
//
// What is asserted is the division: the prose is untouched, the marked regions
// are replaced whole, and a marker or a block with no counterpart is an error
// rather than an empty section nobody notices.

import { describe, it, expect } from "bun:test";
import { renderTestDoc, renderExcluded, injectBlocks } from "../src/testdoc";
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

  it("carries the verdict, the day, how it was checked and where to look again", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).toContain("| OK | 2026-09-07 | デプロイ済みファイル | web01 /etc/httpd/conf/httpd.conf:12 |");
    expect(b["test:items"]).toContain("NG");
    expect(b["test:items"]).toContain("未実施");
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
