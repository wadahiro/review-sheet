// Generates per-format docs and injects index/table into SKILL.md and README.md.
// Run: bun run scripts/gen-docs.ts

import { writeFileSync, mkdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import "../src/parsers/index.js";
import { listParsers } from "../src/parser.js";
import { renderParserPage, renderParserIndex, renderReadmeTable } from "../src/parser-docs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function injectMarker(content: string, marker: string, block: string): string {
  const start = `<!-- ${marker}:start -->`;
  const end = `<!-- ${marker}:end -->`;
  const si = content.indexOf(start);
  const ei = content.indexOf(end);
  if (si === -1 || ei === -1) throw new Error(`Markers not found: ${marker}`);
  return content.slice(0, si + start.length) + "\n" + block + "\n" + content.slice(ei);
}

const parsers = listParsers();

// Write per-format pages
const formatsDir = join(root, "skills", "review-sheet", "formats");
mkdirSync(formatsDir, { recursive: true });

for (const p of parsers) {
  if (!p.meta) continue;
  const page = renderParserPage(p);
  writeFileSync(join(formatsDir, `${p.name}.md`), page, "utf-8");
  console.log(`wrote skills/review-sheet/formats/${p.name}.md`);
}

// Inject into SKILL.md
const skillPath = join(root, "skills", "review-sheet", "SKILL.md");
const skillContent = readFileSync(skillPath, "utf-8");
const skillInjected = injectMarker(skillContent, "parsers", renderParserIndex(parsers));
writeFileSync(skillPath, skillInjected, "utf-8");
console.log("updated skills/review-sheet/SKILL.md");

// Inject into README.md
const readmePath = join(root, "README.md");
const readmeContent = readFileSync(readmePath, "utf-8");
const readmeInjected = injectMarker(readmeContent, "parsers", renderReadmeTable(parsers));
writeFileSync(readmePath, readmeInjected, "utf-8");
console.log("updated README.md");
