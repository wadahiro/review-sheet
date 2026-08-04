import { describe, it, expect } from "bun:test";
import { registerParser, resolveParser, getParser, listParsers, type ConfigParser } from "../src/parser";
import { extractFile } from "../src/extract";
import { computeApply } from "../src/apply";
import type { SheetData, ReviewItem } from "../src/prompt";

// A tiny custom parser for a fake ".myconf" extension
const myParser: ConfigParser = {
  name: "myconf",
  priority: 50,
  detect: (file) => file.endsWith(".myconf"),
  extract: (content, _file) => {
    // Simple "key->value" format
    return content.split("\n").filter(l => l.includes("->")).map((line, i) => {
      const [k, v] = line.split("->").map(s => s.trim());
      return { categoryPath: ["Custom"], key: k, value: v, source: { line: i + 1, anchor: k } };
    });
  },
  locate: (content, source, expected) => {
    const lines = content.split("\n");
    const anchor = source.anchor;
    if (!anchor) return { error: "no anchor", status: "unmapped" as const };
    const idx = lines.findIndex(l => l.includes(anchor) && l.includes(expected));
    if (idx >= 0) return { value: expected };
    return { error: "not found" };
  },
  edit: (content, source, current, suggested) => {
    const lines = content.split("\n");
    const anchor = source.anchor;
    if (!anchor) return { status: "error", reason: "no anchor" };
    const idx = lines.findIndex(l => l.includes(anchor) && l.includes(current));
    if (idx < 0) return { status: "error", reason: "not found" };
    const before = lines[idx];
    lines[idx] = before.replace(current, suggested);
    return { status: "applied", content: lines.join("\n"), before, after: lines[idx] };
  },
};

describe("custom parser registration", () => {
  it("registers and resolves a custom parser by name", () => {
    registerParser(myParser);
    expect(getParser("myconf")).toBe(myParser);
  });

  it("detect resolves to custom parser for .myconf files", () => {
    registerParser(myParser);
    const resolved = resolveParser("/etc/app.myconf", "foo -> bar");
    expect(resolved?.name).toBe("myconf");
  });

  it("extractFile uses the custom parser for .myconf files", () => {
    registerParser(myParser);
    const entries = extractFile("host -> localhost\nport -> 8080\n", "/etc/app.myconf");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ key: "host", value: "localhost" });
    expect(entries[1]).toMatchObject({ key: "port", value: "8080" });
  });

  it("computeApply uses the custom parser to edit .myconf files", () => {
    registerParser(myParser);
    const content = "host -> localhost\nport -> 8080";
    const data: SheetData = {
      sheets: [{
        name: "S",
        file_path: "/etc/app.myconf",
        categories: [{
          name: "Custom",
          params: [
            { key: "port", value: "8080", source: { line: 2, anchor: "port" } },
          ],
        }],
      }],
    };
    const reviews: ReviewItem[] = [{
      id: "r1",
      status: "pending",
      target: { sheet: "S", category: "Custom", param: "port", field: "value" },
      changes: [{ field: "value", current: "8080", suggested: "9090" }],
    }];
    const out = computeApply(data, reviews, (_path) => content);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("port -> 9090");
  });
});
