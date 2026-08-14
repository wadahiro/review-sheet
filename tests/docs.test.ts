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

// The `sheet.yml` section is a hand-written list of what may go in that file,
// and a hand-written list of a schema rots the moment the schema gains a
// field. It already had: `group:` and `groups:` — the sheet-group hierarchy a
// whole document's navigation is built from — were reachable only by reading
// providers/project.ts or one line of README.md, so an agent working from the
// skill concluded the file held `categories:` and `under_key:` and nothing
// else, and went looking for the hierarchy in the assembler instead.
//
// Read off the TYPE DECLARATION rather than a list maintained beside it, so
// this cannot pass by being updated in lockstep with itself: adding a field to
// ProjectMetaDoc/ProjectMetaSheetDoc/ProjectMetaParam and not writing it down
// fails here.
describe("sheet.yml schema is documented", () => {
  const skill = readFileSync(join(root, "skills", "review-sheet", "SKILL.md"), "utf-8");
  const source = readFileSync(join(root, "src", "providers", "project.ts"), "utf-8");

  // Scoped to the section, not the whole file: SKILL.md mentions a DICTIONARY's
  // own `group:` in several unrelated places, and a whole-file search passes on
  // those while the sheet field stays undocumented — the exact false negative
  // that let this gap survive.
  const heading = "### The project's `sheet.yml`";
  const start = skill.indexOf(heading);
  const section = skill.slice(start, skill.indexOf("\n### ", start + heading.length));

  test("the section exists", () => {
    expect(start, `${heading} not found in SKILL.md`).toBeGreaterThan(-1);
    expect(section.length).toBeGreaterThan(500);
  });

  // Only the multi-line `= {\n … \n};` declarations: a one-line type would let
  // the non-greedy match run on into the NEXT type's body and silently report
  // that one's fields as this one's.
  const fieldsOf = (typeName: string): string[] => {
    const m = source.match(new RegExp(`export type ${typeName} = \\{\\n([\\s\\S]*?)\\n\\};`));
    if (!m) throw new Error(`no multi-line type ${typeName} in src/providers/project.ts`);
    const fields = [...m[1].matchAll(/^ {2}([a-z_]+)\??:/gm)].map((x) => x[1]);
    if (fields.length === 0) throw new Error(`no fields parsed out of ${typeName}`);
    return fields;
  };

  for (const typeName of ["ProjectMetaDoc", "ProjectMetaSheetDoc", "ProjectMetaParam"]) {
    for (const field of fieldsOf(typeName)) {
      test(`${typeName}.${field} appears in the sheet.yml section`, () => {
        expect(
          new RegExp(`(^|[^a-z_])${field}:`, "m").test(section),
          `\`${field}:\` (${typeName}) is a field of sheet.yml that the "${heading}" section never mentions — ` +
            `document it there, or a reader of the skill cannot know it exists`
        ).toBe(true);
      });
    }
  }
});
