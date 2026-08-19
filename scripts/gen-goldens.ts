// Freeze what every parser extracts, TODAY, so a refactor can prove it changed
// nothing.
//
// The container work rebuilds each tree-bearing parser around a per-NODE record
// and derives `source.path` from it. That is a rewrite of the code that decides
// row identity for every structured format at once, and the only claim worth
// making about it is the strongest one: every field every parser already emits
// is byte-identical afterwards, with the new `containers` field the sole
// addition. A record made AFTER the refactor cannot state that — so this runs
// first, and its output is committed.
//
// Stored as a HASH per file rather than the entries themselves: the full dump
// is several megabytes of machine output nobody reads, and a hash over the same
// serialization detects any change just as exactly. When one does change,
// `--detail <file>` prints that file's entries so the diff is diagnosable.

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { getParser, resolveParser } from "../src/parser";
import "../src/parsers/index.js";

export const GOLDEN_FILE = "tests/goldens/extraction.json";

// Everything the repo owns, minus what it merely vendors. A parser reading a
// dependency's YAML is not a fact about this project.
const FIND =
  `find tests/fixtures examples -type f ` +
  `-not -path "*/.venv/*" -not -path "*/node_modules/*" -not -path "*/out/*" ` +
  `-not -path "*/collections/*" -not -name "*.lock"`;

export type GoldenRow = { file: string; parser: string; count: number; sha: string; format?: string };

// A format that is never detected from a filename and only ever DECLARED
// (`templates[].format` / `static_files[].format`) is unreachable from a walk
// over files — `space` is deliberately one of them, so covering it means
// declaring it here exactly as a project would. The same file may also appear
// under its detected parser; both readings are real, so both are pinned.
const DECLARED: { file: string; format: string }[] = [
  { file: "tests/fixtures/parsers/chrony.conf", format: "space" },
];

// One entry, spelled out in full. Field order is fixed here rather than left to
// object-key order so the hash cannot move for a reason nobody intended.
const serialize = (e: Record<string, unknown>): string =>
  JSON.stringify([
    e.categoryPath,
    e.key,
    e.value,
    (e.source as Record<string, unknown> | undefined)?.file,
    (e.source as Record<string, unknown> | undefined)?.line,
    (e.source as Record<string, unknown> | undefined)?.column,
    (e.source as Record<string, unknown> | undefined)?.end_line,
    (e.source as Record<string, unknown> | undefined)?.anchor,
    (e.source as Record<string, unknown> | undefined)?.path,
    e.description,
    e.default,
    e.remarks,
    e.out_of_scope,
    e.extra,
    e.sheet,
  ]);

export function extractionFor(file: string, format?: string): { parser: string; lines: string[] } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return null; // binary, unreadable — not a parser fact
  }
  const parser = format ? getParser(format) : resolveParser(file, text);
  if (!parser) return null;
  let entries;
  try {
    entries = parser.extract(text, file, {});
  } catch (e) {
    // A parser THROWING is itself behavior worth freezing: the refactor must
    // not turn a throw into a silent empty result, which would look like
    // "nothing to extract" rather than "this broke".
    return { parser: parser.name, lines: [`THREW ${e instanceof Error ? e.message : String(e)}`] };
  }
  return { parser: parser.name, lines: entries.map((e) => serialize(e as never)) };
}

export function buildGoldens(files: string[]): GoldenRow[] {
  const out: GoldenRow[] = [];
  const add = (file: string, format?: string): void => {
    const got = extractionFor(file, format);
    if (!got) return;
    out.push({
      file,
      parser: got.parser,
      count: got.lines.length,
      sha: createHash("sha256").update(got.lines.join("\n")).digest("hex").slice(0, 16),
      ...(format ? { format } : {}),
    });
  };
  for (const file of files.sort()) add(file);
  for (const d of DECLARED) add(d.file, d.format);
  return out;
}

// A file read two ways is two rows, so the identity has to say which reading.
export const goldenKey = (r: GoldenRow): string => (r.format ? `${r.file}#${r.format}` : r.file);

export const goldenFiles = (): string[] => execSync(FIND, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);

if (import.meta.main) {
  const detail = process.argv.indexOf("--detail");
  if (detail !== -1) {
    const file = process.argv[detail + 1];
    const fmt = process.argv[detail + 2];
    const got = extractionFor(file, fmt);
    if (!got) { console.error(`no parser resolves ${file}`); process.exit(1); }
    console.error(`# ${file} (${got.parser}, ${got.lines.length} entries)`);
    for (const l of got.lines) console.log(l);
  } else {
    const rows = buildGoldens(goldenFiles());
    writeFileSync(GOLDEN_FILE, JSON.stringify(rows, null, 2) + "\n");
    const byParser = new Map<string, number>();
    for (const r of rows) byParser.set(r.parser, (byParser.get(r.parser) ?? 0) + r.count);
    console.error(`wrote ${GOLDEN_FILE}: ${rows.length} file(s)`);
    for (const [p, n] of [...byParser].sort((a, b) => b[1] - a[1])) console.error(`  ${p.padEnd(12)} ${n}`);
  }
}
