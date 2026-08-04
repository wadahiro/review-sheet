import { describe, it, expect } from "bun:test";
import { extractFile, buildInput } from "../src/extract";
import { getParser } from "../src/parser";
import { inspectTs, lintTs } from "../src/parsers/ts";
import { computeApply } from "../src/apply";
import type { SheetData, ReviewItem } from "../src/prompt";

const cdk = `/* @rs:category ストレージ */
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    /* @rs:category バケット */
    new s3.Bucket(this, 'Data', {
      bucketName: 'my-app-data',  // @rs バケット名 @rs:default なし
      versioned: true,            // @rs バージョニング
    });

    /* @rs:category テーブル */
    new dynamodb.Table(this, 'Sessions', {
      readCapacity: 5,            // @rs 読取容量
      removalPolicy: RemovalPolicy.RETAIN, // @rs 削除ポリシー
      timeout: Duration.seconds(30), // @rs タイムアウト
    });
  }
}
`;

describe("ts annotation extract", () => {
  const entries = extractFile(cdk, "/x/storage-stack.ts");

  it("only extracts @rs-annotated properties", () => {
    expect(entries.length).toBe(5);
  });

  it("value is the verbatim RHS expression (incl. wrapped values)", () => {
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e.value]));
    expect(byKey["bucketName"]).toBe("my-app-data"); // quotes stripped for display
    expect(byKey["readCapacity"]).toBe("5");
    expect(byKey["removalPolicy"]).toBe("RemovalPolicy.RETAIN");
    expect(byKey["timeout"]).toBe("Duration.seconds(30)");
  });

  it("accumulates category by lexical scope, outer→inner", () => {
    const bucket = entries.find((e) => e.key === "bucketName")!;
    const table = entries.find((e) => e.key === "readCapacity")!;
    expect(bucket.categoryPath).toEqual(["ストレージ", "バケット"]);
    expect(table.categoryPath).toEqual(["ストレージ", "テーブル"]);
  });

  it("keeps the property name as key and puts the leading text in description", () => {
    const bucket = entries.find((e) => e.key === "bucketName")!;
    expect(bucket.description).toBe("バケット名");
    expect(bucket.default).toBe("なし");
    expect(bucket.source.path).toBe("StorageStack.Data.bucketName");
  });

  it("buildInput nests categories and carries the default through", () => {
    const input = buildInput([{ file: "/x/storage-stack.ts", content: cdk }]);
    const sheet = input.sheets[0];
    const storage = sheet.categories.find((c) => c.name === "ストレージ")!;
    const bucket = storage.categories!.find((c) => c.name === "バケット")!;
    const p = bucket.params!.find((x) => x.key === "bucketName")!;
    expect(p).toMatchObject({ value: "my-app-data", default: "なし" });
  });
});

// Proves the ExtractOptions path actually reaches the parser: a caller can
// get a non-default marker recognised purely by passing `opts.marker` —
// there is no process-wide setter to call instead. If this only worked
// because some earlier test in the same process left a marker set somewhere,
// the second assertion (default marker sees nothing) would fail — that is
// the point of asserting both directions.
describe("ts annotation extract — marker via ExtractOptions", () => {
  const src = `export class X {
  constructor() {
    new Y(this, 'Z', {
      port: 8080, // @review custom marker port
    });
  }
}
`;

  it("recognises a non-default marker when passed through opts", () => {
    const entries = extractFile(src, "/x/custom-marker.ts", undefined, { marker: "@review" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "port", value: "8080" });
  });

  it("the default marker (@rs) — what a call with no opts falls back to — does not match", () => {
    const entries = extractFile(src, "/x/custom-marker.ts");
    expect(entries).toHaveLength(0);
  });
});

describe("ts annotation leading-comment forms", () => {
  const src = `export const a = {
  // @rs バケット名
  // @rs:remarks 命名規則 <app>-data-<env>
  bucketName: "x",
  /* @rs テーブル名
   * @rs:default sessions */
  tableName: "y",
};
`;
  const entries = extractFile(src, "/x/a.ts");

  it("merges consecutive // lines above a value as one annotation", () => {
    const b = entries.find((e) => e.key === "bucketName")!;
    expect(b).toMatchObject({ value: "x", description: "バケット名", remarks: "命名規則 <app>-data-<env>" });
  });

  it("supports a multi-line block comment above a value", () => {
    const t = entries.find((e) => e.key === "tableName")!;
    expect(t).toMatchObject({ value: "y", description: "テーブル名", default: "sessions" });
  });
});

describe("ts annotation edit (direct parser)", () => {
  const ts = getParser("ts")!;
  const src = extractFile(cdk, "/x/storage-stack.ts");
  const readCap = src.find((e) => e.key === "readCapacity")!;

  it("replaces the RHS range, preserving surrounding formatting", () => {
    const r = ts.edit(cdk, readCap.source, "5", "10");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("readCapacity: 10,            // @rs 読取容量");
    expect(r.content).toContain("timeout: Duration.seconds(30)"); // untouched
  });

  it("re-quotes a string literal on write-back (value is shown unquoted)", () => {
    const bucket = src.find((e) => e.key === "bucketName")!;
    const r = ts.edit(cdk, bucket.source, "my-app-data", "other-bucket");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("bucketName: 'other-bucket',");
  });

  it("rejects an edit that would break syntax (re-parse guard)", () => {
    const r = ts.edit(cdk, readCap.source, "5", "}");
    expect(r.status).toBe("error");
  });

  it("errors when current value does not match", () => {
    const r = ts.edit(cdk, readCap.source, "999", "10");
    expect(r.status).toBe("error");
  });
});

function review(p: Partial<ReviewItem> & { target: ReviewItem["target"] }): ReviewItem {
  return { id: "r", status: "pending", ...p };
}

describe("ts annotation end-to-end apply", () => {
  it("applies a verified value change back to the .ts source", () => {
    const data = buildInput([{ file: "/x/storage-stack.ts", content: cdk }]) as SheetData;
    const reviews = [
      review({
        target: { sheet: "storage-stack.ts", category: "ストレージ/テーブル", param: "readCapacity", field: "value" },
        changes: [{ field: "value", current: "5", suggested: "10" }],
      }),
    ];
    const read = (path: string): string | null => (path === "/x/storage-stack.ts" ? cdk : null);
    const out = computeApply(data, reviews, read);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("readCapacity: 10,");
  });
});

const dev = `/* @rs:config sheet: ストレージ instance: dev */
/* @rs:category テーブル */
export const config = {
  readCapacity: 1,   // @rs 読取容量 @rs:default 1
};
`;
const prod = `/* @rs:config sheet: ストレージ instance: prod */
/* @rs:category テーブル */
export const config = {
  readCapacity: 25,  // @rs 読取容量 @rs:default 1
};
`;

describe("ts annotation inspect / lint", () => {
  it("inspectTs returns config, resolved entries and warnings", () => {
    const r = inspectTs(dev);
    expect(r.config).toMatchObject({ sheet: "ストレージ", instance: "dev" });
    expect(r.entries[0]).toMatchObject({ categoryPath: ["テーブル"], key: "readCapacity", value: "1" });
  });

  it("lintTs flags @rs in /** */ and inline :category", () => {
    const bad = `/** @rs:config sheet: S */
new s3.Bucket(this, 'X', /* @rs:category Bad */ { name: 'y' });
`;
    const rules = lintTs(bad).map((i) => i.rule);
    expect(rules).toContain("no-jsdoc");
    expect(rules).toContain("category-own-line");
  });

  it("lintTs passes a clean file", () => {
    expect(lintTs(dev)).toEqual([]);
  });
});

describe("ts annotation @rs:config wiring", () => {
  it("overrides the sheet name and merges files into one sheet", () => {
    const input = buildInput([
      { file: "/x/dev.ts", content: dev },
      { file: "/x/prod.ts", content: prod },
    ]);
    expect(input.sheets.length).toBe(1);
    expect(input.sheets[0].name).toBe("ストレージ");
  });

  it("groups same-key values across files into a Pattern B InstanceParameter", () => {
    const input = buildInput([
      { file: "/x/dev.ts", content: dev },
      { file: "/x/prod.ts", content: prod },
    ]);
    const cat = input.sheets[0].categories.find((c) => c.name === "テーブル")!;
    const p = cat.params!.find((x) => x.key === "readCapacity")!;
    expect("instances" in p).toBe(true);
    if (!("instances" in p) || !p.instances) return;
    expect(p.instances.map((i) => [i.name, i.value, i.source?.file])).toEqual([
      ["dev", "1", "/x/dev.ts"],
      ["prod", "25", "/x/prod.ts"],
    ]);
  });

  it("applies an instance change to that instance's own file", () => {
    const data = buildInput([
      { file: "/x/dev.ts", content: dev },
      { file: "/x/prod.ts", content: prod },
    ]) as SheetData;
    const reviews = [
      review({
        target: { sheet: "ストレージ", category: "テーブル", param: "readCapacity", instance: "prod", field: "value" },
        changes: [{ field: "value", current: "25", suggested: "50" }],
      }),
    ];
    const read = (path: string): string | null =>
      path === "/x/dev.ts" ? dev : path === "/x/prod.ts" ? prod : null;
    const out = computeApply(data, reviews, read);
    expect(out.applied).toBe(1);
    const f = out.files.find((x) => x.path === "/x/prod.ts")!;
    expect(f.content).toContain("readCapacity: 50,");
  });
});
