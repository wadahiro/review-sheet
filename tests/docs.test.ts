import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import "../src/parsers/index.js";
import { listParsers } from "../src/parser.js";
import { renderParserPage, renderParserIndex, renderReadmeTable } from "../src/parser-docs.js";

const root = join(import.meta.dir, "..");

describe("docs sync", () => {
  const parsers = listParsers();

  for (const p of parsers) {
    if (!p.meta) continue;
    test(`formats/${p.name}.md exists and matches renderParserPage`, () => {
      const path = join(root, "skills", "review-sheet", "formats", `${p.name}.md`);
      expect(existsSync(path), `${path} not found — run \`bun run docs\``).toBe(true);
      const disk = readFileSync(path, "utf-8");
      expect(disk, `${p.name}.md out of sync — run \`bun run docs\``).toBe(renderParserPage(p));
    });
  }

  test("SKILL.md parsers marker block matches renderParserIndex", () => {
    const skillPath = join(root, "skills", "review-sheet", "SKILL.md");
    const content = readFileSync(skillPath, "utf-8");
    const start = "<!-- parsers:start -->";
    const end = "<!-- parsers:end -->";
    const si = content.indexOf(start);
    const ei = content.indexOf(end);
    expect(si, "parsers:start marker not found in SKILL.md").toBeGreaterThan(-1);
    expect(ei, "parsers:end marker not found in SKILL.md").toBeGreaterThan(-1);
    const block = content.slice(si + start.length, ei).trim();
    expect(block, "SKILL.md parsers block out of sync — run `bun run docs`").toBe(renderParserIndex(parsers));
  });

  test("README.md parsers marker block matches renderReadmeTable", () => {
    const readmePath = join(root, "README.md");
    const content = readFileSync(readmePath, "utf-8");
    const start = "<!-- parsers:start -->";
    const end = "<!-- parsers:end -->";
    const si = content.indexOf(start);
    const ei = content.indexOf(end);
    expect(si, "parsers:start marker not found in README.md").toBeGreaterThan(-1);
    expect(ei, "parsers:end marker not found in README.md").toBeGreaterThan(-1);
    const block = content.slice(si + start.length, ei).trim();
    expect(block, "README.md parsers block out of sync — run `bun run docs`").toBe(renderReadmeTable(parsers));
  });
});
