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
      { target: { sheet: "os", path: ["httpd.conf"], key: "Listen", instance: "local" }, unit: "server", component: "httpd.conf", kind: "value", expected: "80" },
      { target: { sheet: "os", path: ["httpd.conf"], key: "Listen", instance: "prod" }, unit: "server", component: "httpd.conf", kind: "value", expected: "80" },
      { target: { sheet: "os", path: ["httpd.conf"], key: "pw", instance: "local" }, unit: "server", component: "httpd.conf", kind: "value", quiet: true },
      { target: { sheet: "os", path: ["httpd.conf"], key: "Timeout", instance: "local" }, unit: "server", component: "httpd.conf", kind: "default-in-force", expected: "60" },
      { target: { sheet: "os", path: ["httpd.conf"], key: "Gone", instance: "local" }, unit: "server", component: "httpd.conf", kind: "absent" },
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
  it("says what each item is, in the words of the claim it checks", () => {
    const b = renderTestDoc(plan(), results(), "server", { includeDefaults: true });
    expect(b["test:items"]).toContain("`Listen` が設定どおりであること");
    expect(b["test:items"]).toContain("`Timeout` が製品の既定値のままであること");
    expect(b["test:items"]).toContain("`Gone` が設定されていないこと");
  });

  it("puts each environment in its own section, with when it ran and where", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).toContain("## local");
    expect(b["test:items"]).toContain("実施日時: 2026-09-07T07:36:49Z ／ 対象ホスト: web01, web02");
    // …and an environment nobody ran says so rather than looking blank.
    expect(b["test:items"]).toContain("## prod");
    expect(b["test:items"]).toContain("実施日時: — ／ 対象ホスト: — （未実施）");
  });

  it("carries the verdict, the day, how it was checked and where to look again", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:items"]).toContain("| OK | 2026-09-07 | デプロイ済みファイル | web01 /etc/httpd/conf/httpd.conf:12 |");
    expect(b["test:items"]).toContain("NG");
    expect(b["test:items"]).toContain("未実施");
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
    // 4 items shown (the default-in-force one is counted separately): Listen×2,
    // pw, Gone. Answered: all but the not_run one.
    expect(b["test:summary"]).toContain("| 実施済み | 3 |");
    expect(b["test:summary"]).toContain("| 未実施 | 1 |");
    expect(b["test:summary"]).toContain("| 判定 | OK 2 / NG 1 |");
  });

  it("renders the items that have no row behind them, with their answers", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:functional"]).toContain("local: 起動・停止ができること");
    expect(b["test:functional"]).toContain("OK");
    expect(b["test:functional"]).toContain("prod: 起動・停止ができること");
  });

  // The claim the whole derivation exists to make, stated where a reader looks
  // for the method.
  it("states how items are raised, and that the coverage is derived", () => {
    const b = renderTestDoc(plan(), results(), "server");
    expect(b["test:taxonomy"]).toContain("大項目");
    expect(b["test:taxonomy"]).toContain("小項目");
    expect(b["test:taxonomy"]).toContain("漏れた場合は生成が失敗する");
  });

  it("refuses a unit this plan does not have", () => {
    expect(() => renderTestDoc(plan(), results(), "nope")).toThrow(/server/);
  });

  it("lists what the project put out of scope, with the reason", () => {
    const md = renderExcluded([{ unit: "server", sheet: "os", key: "db-password", reason: { ja: "DBA の管轄" }, owner: "DBA" }], "server");
    expect(md).toContain("`db-password`");
    expect(md).toContain("DBA の管轄");
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
