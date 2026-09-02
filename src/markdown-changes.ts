// What changed in a hand-maintained sheet, said in as few words as carry it.
//
// The reader is a model with a budget, and a line diff of a parameter sheet
// spends most of it on text nobody touched: a row's description sits in the
// same line as its value, so moving one character reprints a paragraph twice.
// Measured on a real sheet, one changed value cost ~1400 tokens as a diff and
// ~30 as the statement below.
//
// So the change is computed per CELL, against the addresses the document itself
// states — its headings, and the chain of names its indentation makes — and
// what cannot be said that way (a section written, a paragraph, a column) is
// named as itself. A line diff is kept for exactly one job: proving that
// nothing changed which none of the above accounted for, and showing whatever
// did.

import { parseMarkdownBlocks, tableShape } from "./sheet-markdown.js";
import { unifiedDiff } from "./diff-text.js";
import type { Lang } from "./html/i18n.js";

export type RowRef = { path: string[]; chain: string[] };

export type MarkdownChange =
  // A cell of a row both documents have. `column` is the header it sits under.
  | { kind: "cell"; row: RowRef; column: string; before: string; after: string }
  | { kind: "row-added"; row: RowRef; cells: Record<string, string> }
  | { kind: "row-removed"; row: RowRef }
  // The same row, under a different heading.
  | { kind: "row-moved"; chain: string[]; from: string[]; to: string[] }
  | { kind: "section-added"; path: string[] }
  | { kind: "section-removed"; path: string[] }
  | { kind: "prose"; path: string[]; before: string; after: string }
  | { kind: "columns"; path: string[]; before: string[]; after: string[] }
  // A VALUE column this document has and the sheet's declaration does not: the
  // reader added an environment. Its own statement, because it is its own
  // decision — a layer of configuration, and the files behind it — and not a
  // column of documentation somebody widened the table with.
  | { kind: "environment-added"; path: string[]; name: string; values: Record<string, string> }
  | { kind: "environment-removed"; path: string[]; name: string };

export type MarkdownChangeReport = {
  changes: MarkdownChange[];
  // Changed lines nothing above explained. Empty on every document these rules
  // cover; non-empty is the honest way to say "there is more here than I can
  // name", rather than reporting a subset as if it were everything.
  unaccounted: string;
};

type Row = { row: RowRef; cells: Record<string, string> };
type Section = { path: string[]; prose: string; head: string[]; values: string[] };
type Doc = { rows: Map<string, Row>; sections: Map<string, Section> };

// What this projection calls the key column, in both languages: a table line
// starting with one is the header row.
const KEY_HEADS: ReadonlySet<string> = new Set<string>(["設定項目", "Parameter"]);

const keyOf = (r: RowRef): string => `${r.path.join("/")} ${r.chain.join(".")}`;
const stripCode = (cell: string): string =>
  cell
    .trim()
    .replace(/^`(.*)`$/s, "$1")
    .trim();

function read(markdown: string, instances: string[], lang: Lang): Doc {
  const rows = new Map<string, Row>();
  const sections = new Map<string, Section>();
  const path: string[] = [];
  const at = (): string => path.join("/");
  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.kind === "heading") {
      if (block.depth === 1) continue;
      const depth = Math.max(1, block.depth - 1);
      path.length = depth - 1;
      path.push(block.text);
      if (!sections.has(at())) sections.set(at(), { path: [...path], prose: "", head: [], values: [] });
      continue;
    }
    const section = sections.get(at()) ?? { path: [...path], prose: "", head: [], values: [] };
    sections.set(at(), section);
    if (block.kind === "prose") {
      section.prose = [section.prose, block.text].filter(Boolean).join("\n\n");
      continue;
    }
    section.head = block.head;
    const shape = tableShape(block.head, instances, lang);
    section.values = shape.values.map((n) => block.head[n]);
    const ancestors: string[] = [];
    for (const row of block.rows) {
      const name = stripCode(row.cells[0] ?? "");
      ancestors.length = Math.min(row.indent, ancestors.length);
      const chain = [...ancestors, name];
      ancestors[row.indent] = name;
      const cells: Record<string, string> = {};
      // Keyed by the HEADER, not by position: a column somebody inserted must
      // not make every column after it read as changed.
      block.head.forEach((h, n) => {
        if (n === shape.key) return;
        cells[h] = (row.cells[n] ?? "").trim();
      });
      const ref = { path: [...path], chain };
      rows.set(keyOf(ref), { row: ref, cells });
    }
  }
  return { rows, sections };
}

export function markdownChangeReport(
  before: string,
  after: string,
  instances: string[],
  lang: Lang = "ja"
): MarkdownChangeReport {
  const was = read(before, instances, lang);
  const now = read(after, instances, lang);
  const changes: MarkdownChange[] = [];
  // What the statements below account for: the ROWS they name (by the name in
  // the key cell) and the prose they carry. The leftover check reads a changed
  // line and asks whether something already speaks for it — matching on the
  // row's name rather than on the line's exact text, because a line is
  // reformatted by anyone who re-aligns a table and the row is still the row.
  const explainedRows = new Set<string>();
  const explainedText = new Set<string>();
  const explainRow = (chain: string[]): void => {
    explainedRows.add(chain[chain.length - 1]);
  };
  const explainText = (...blocks: string[]): void => {
    for (const b of blocks) for (const l of b.split("\n")) if (l.trim() !== "") explainedText.add(l.trim());
  };

  // --- sections ------------------------------------------------------------
  for (const [key, section] of now.sections) {
    if (was.sections.has(key)) continue;
    changes.push({ kind: "section-added", path: section.path });
  }
  for (const [key, section] of was.sections) {
    if (now.sections.has(key)) continue;
    changes.push({ kind: "section-removed", path: section.path });
  }
  for (const [key, section] of now.sections) {
    const old = was.sections.get(key);
    if (section.prose !== (old?.prose ?? "")) {
      changes.push({ kind: "prose", path: section.path, before: old?.prose ?? "", after: section.prose });
      explainText(section.prose, old?.prose ?? "");
    }
    if (old !== undefined && old.head.length > 0 && section.head.join("|") !== old.head.join("|")) {
      // An environment is named before the columns are, so its own decision is
      // not buried in "the header row changed".
      const wasValues = new Set(old.values);
      const nowValues = new Set(section.values);
      const added = [...nowValues].filter((n) => !wasValues.has(n));
      const removed = [...wasValues].filter((n) => !nowValues.has(n));
      for (const name of added) {
        const values: Record<string, string> = {};
        for (const row of now.rows.values()) {
          if (row.row.path.join("/") !== section.path.join("/")) continue;
          const v = row.cells[name] ?? "";
          if (v !== "") values[row.row.chain.join(".")] = v;
        }
        changes.push({ kind: "environment-added", path: section.path, name, values });
      }
      for (const name of removed) changes.push({ kind: "environment-removed", path: section.path, name });
      // A column added or removed rewrites EVERY line of its table, so every row
      // of this section is accounted for by the statements above — otherwise
      // the leftover check would print the whole table back, which is the cost
      // this report exists to avoid.
      for (const row of [...was.rows.values(), ...now.rows.values()]) {
        if (row.row.path.join("/") === section.path.join("/")) explainRow(row.row.chain);
      }
      const rest = (head: string[], values: Set<string>): string[] => head.filter((h) => !values.has(h));
      if (rest(old.head, wasValues).join("|") !== rest(section.head, nowValues).join("|")) {
        changes.push({ kind: "columns", path: section.path, before: old.head, after: section.head });
      }
    }
  }

  // --- rows ----------------------------------------------------------------
  // A row that is gone from one heading and present under another is the same
  // row, MOVED — reported once, rather than as a removal and an addition that
  // the reader has to notice are the same thing.
  //
  // Matched by the row's own NAME, not by the chain that led to it: moving a
  // row is usually moving it out from under the block it was in, so the chain
  // is exactly what changed. Only when the name is unique on both sides — one
  // row gone, one arrived — since anything else is a guess about which went
  // where, and two statements are better than one wrong one.
  const leaf = (row: Row): string => row.row.chain[row.row.chain.length - 1];
  const countBy = (rows: Row[]): Map<string, Row[]> => {
    const out = new Map<string, Row[]>();
    for (const r of rows) out.set(leaf(r), [...(out.get(leaf(r)) ?? []), r]);
    return out;
  };
  const goneRows = [...was.rows].filter(([key]) => !now.rows.has(key)).map(([, row]) => row);
  const arrivedRows = [...now.rows].filter(([key]) => !was.rows.has(key)).map(([, row]) => row);
  const goneByName = countBy(goneRows);
  const arrivedByName = countBy(arrivedRows);
  const goneFrom = new Map<string, Row>();
  const arrivedAt = new Map<string, Row>();
  for (const [name, rows] of goneByName) {
    const there = arrivedByName.get(name);
    if (rows.length === 1 && there?.length === 1) {
      goneFrom.set(name, rows[0]);
      arrivedAt.set(name, there[0]);
    }
  }

  for (const [key, row] of now.rows) {
    const old = was.rows.get(key);
    if (old === undefined) {
      const from = goneFrom.get(row.row.chain[row.row.chain.length - 1]);
      if (from !== undefined) {
        changes.push({ kind: "row-moved", chain: row.row.chain, from: from.row.path, to: row.row.path });
      } else {
        changes.push({ kind: "row-added", row: row.row, cells: row.cells });
      }
      explainRow(row.row.chain);
      continue;
    }
    for (const [column, value] of Object.entries(row.cells)) {
      const previous = old.cells[column];
      if (previous === undefined || previous === value) continue;
      changes.push({ kind: "cell", row: row.row, column, before: previous, after: value });
      explainRow(row.row.chain);
    }
  }
  for (const [key, row] of was.rows) {
    if (now.rows.has(key)) continue;
    if (arrivedAt.has(row.row.chain[row.row.chain.length - 1])) {
      explainRow(row.row.chain);
      continue; // already reported as a move
    }
    changes.push({ kind: "row-removed", row: row.row });
    explainRow(row.row.chain);
  }

  // --- whatever is left ----------------------------------------------------
  // A changed line no statement above covers. On a document these rules cover
  // this is empty; when it is not, the lines themselves are shown, because a
  // report that quietly omits what it could not name is worse than a long one.
  const accountedFor = (line: string): boolean => {
    const body = line.slice(1);
    if (body.trim() === "") return true; // a blank line carries nothing of its own
    if (/^#{1,6} /.test(body.trim())) return true; // a heading: its section says it
    if (/^\s*\|/.test(body)) {
      // A table line: a header rule, a header row, or a row whose name is named
      // by one of the statements above.
      const cells = body.split("|").map((c) => c.trim());
      if (cells.every((c) => c === "" || /^-{3,}$/.test(c))) return true;
      // The header row: what changed about it is said by the column and
      // environment statements, which name it far better than two printed rows.
      if (KEY_HEADS.has(cells[1] ?? "")) return true;
      const name = stripCode(cells[1] ?? "");
      return explainedRows.has(name);
    }
    return explainedText.has(body.trim());
  };
  const leftover = unifiedDiff(before, after, 0)
    .split("\n")
    .filter((l) => l.startsWith("+") || l.startsWith("-"))
    .filter((l) => !accountedFor(l));

  return { changes, unaccounted: leftover.join("\n") };
}

// The report, as text for whoever applies it. Compact by construction: an
// address, a column and the two values, and nothing that has not changed.
const clip = (text: string, max = 300): string =>
  text.length <= max ? text : `${text.slice(0, max)}… (${text.length} chars)`;

const where = (row: RowRef): string => `${row.path.join("/")} > ${row.chain.join(".")}`;

export function renderMarkdownChanges(changes: MarkdownChange[]): string {
  const out: string[] = [];
  for (const c of changes) {
    switch (c.kind) {
      case "cell":
        out.push(`~ ${where(c.row)} [${c.column}]: "${clip(c.before)}" -> "${clip(c.after)}"`);
        break;
      case "row-added": {
        const cells = Object.entries(c.cells)
          .filter(([, v]) => v !== "")
          .map(([k, v]) => `${k}="${clip(v, 120)}"`)
          .join(" ");
        out.push(`+ row ${where(c.row)}${cells ? ` — ${cells}` : ""}`);
        break;
      }
      case "row-removed":
        out.push(`- row ${where(c.row)}`);
        break;
      case "row-moved":
        out.push(`> row ${c.chain.join(".")}: ${c.from.join("/")} -> ${c.to.join("/")}`);
        break;
      case "section-added":
        out.push(`+ section ${c.path.join("/")}`);
        break;
      case "section-removed":
        out.push(`- section ${c.path.join("/")}`);
        break;
      case "prose":
        out.push(`~ note ${c.path.join("/") || "(sheet)"}: "${clip(c.after)}"`);
        break;
      case "environment-added": {
        const shown = Object.entries(c.values)
          .slice(0, 6)
          .map(([k, v]) => `${k}="${clip(v, 80)}"`)
          .join(" ");
        const more = Object.keys(c.values).length - 6;
        out.push(
          `+ environment ${c.name} (${c.path.join("/")}) — this sheet does not declare it; add the layer` +
            (shown ? `\n    ${shown}${more > 0 ? ` (+${more} more)` : ""}` : "")
        );
        break;
      }
      case "environment-removed":
        out.push(`- environment ${c.name} (${c.path.join("/")})`);
        break;
      case "columns":
        out.push(`~ columns ${c.path.join("/")}: ${c.before.join(" | ")} -> ${c.after.join(" | ")}`);
        break;
    }
  }
  return out.join("\n");
}
