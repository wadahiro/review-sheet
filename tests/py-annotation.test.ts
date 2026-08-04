import { describe, it, expect } from "bun:test";
import { extractFile, buildInput } from "../src/extract";
import { getParser } from "../src/parser";
import { computeApply } from "../src/apply";
import { inspectPy } from "../src/parsers/py";
import type { SheetData, ReviewItem } from "../src/prompt";

const py = `# @rs:config sheet: ストレージ
# @rs:category テーブル
MAX_CONN = 5            # @rs 最大接続数 @rs:default 10
config = {
    "table_name": "sessions",   # @rs テーブル名
}
`;

describe("py annotation extract", () => {
  const entries = extractFile(py, "/x/conf.py");

  it("extracts module assignments and dict entries (keys unquoted)", () => {
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey["MAX_CONN"]).toMatchObject({ value: "5", default: "10", description: "最大接続数", source: { path: "MAX_CONN" } });
    // dict string value shown unquoted; structural path uses the unquoted key
    expect(byKey["table_name"]).toMatchObject({ value: "sessions", source: { path: "config.table_name" } });
  });

  it("inspectPy resolves config and category", () => {
    const r = inspectPy(py);
    expect(r.config).toMatchObject({ sheet: "ストレージ" });
    expect(r.entries[0].categoryPath).toEqual(["テーブル"]);
  });
});

describe("py annotation edit", () => {
  const ts = getParser("py")!;
  const entries = extractFile(py, "/x/conf.py");

  it("edits a number RHS in place", () => {
    const e = entries.find((x) => x.key === "MAX_CONN")!;
    const r = ts.edit(py, e.source, "5", "20");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("MAX_CONN = 20            # @rs 最大接続数 @rs:default 10");
  });

  it("re-quotes a string RHS on write-back", () => {
    const e = entries.find((x) => x.key === "table_name")!;
    const r = ts.edit(py, e.source, "sessions", "events");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain('"table_name": "events",');
  });
});

function review(p: Partial<ReviewItem> & { target: ReviewItem["target"] }): ReviewItem {
  return { id: "r", status: "pending", ...p };
}

describe("py annotation end-to-end apply", () => {
  it("applies a verified change back to the .py source", () => {
    const data = buildInput([{ file: "/x/conf.py", content: py }]) as SheetData;
    const reviews = [
      review({
        target: { sheet: "ストレージ", category: "テーブル", param: "MAX_CONN", field: "value" },
        changes: [{ field: "value", current: "5", suggested: "20" }],
      }),
    ];
    const read = (path: string): string | null => (path === "/x/conf.py" ? py : null);
    const out = computeApply(data, reviews, read);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("MAX_CONN = 20");
  });
});
