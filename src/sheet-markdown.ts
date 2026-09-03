// A sheet as markdown, and the mechanical extraction of what somebody changed
// in it.
//
// The editing a generated sheet offers today is pinpoint: two fields per cell,
// plus adding and striking rows. What a recipient will want to change cannot be
// specified in advance, so this is the other end of that trade — the whole sheet
// as text, edited freely.
//
// The write-back is deliberately NOT deterministic. A markdown edit has no
// source map (that is the same reason a document sheet's page is held, see
// apply.ts), so the destination is an AI with the repository in front of it.
// What must be mechanical is the DIFF: an AI handed "here is the old text and
// the new text" would be re-deriving what changed, and re-deriving it
// differently each time. So this module computes the change set — per row, per
// field, with the row's own source location attached from the model — and hands
// that over instead.
//
// The projection is deliberately narrow. A row has ~25 fields and most are
// plumbing or product facts; the table carries the ones a reviewer acts on, and
// ANYTHING ELSE can still be said in prose beside the table, which is preserved
// and reported. Full flexibility does not require every field to be a column —
// it requires that nothing a person writes is thrown away.

import type { SheetData, CategoryData, ParamData } from "./prompt.js";
import { pickLang } from "./types.js";
import type { Lang } from "./html/i18n.js";

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

// One row, as the markdown carries it. `key` is the identity — visible, in the
// first column, never a hidden anchor: an anchor a reviewer cannot see is one
// they break by reflowing a table, and this project does not build load-bearing
// state nobody can see.
export type MarkdownRow = {
  key: string;
  // One entry per column the table has: per environment on a sheet that has
  // them, and `{ "": value }` on one that does not. A row holding a single
  // SHARED value repeats it across the columns, which is what the sheet's own
  // stacked view shows and what `origin: common` asserts.
  values: Record<string, string>;
  // That row was shared, rather than holding a value per environment. Read off
  // the MODEL, never recoverable from the text — the two render identically —
  // and carried because a change to one column of a shared row is a structural
  // decision, not an edit (apply refuses it outright: HELD_REASON_SHARED_INSTANCE).
  // Absent on a parsed row for exactly that reason: the diff asks the original.
  shared?: true;
  default: string;
  description: string;
  remarks: string;
};

// A heading and the rows under it. The heading path IS the category path, so
// moving a row between headings is how a reviewer says it belongs elsewhere.
export type MarkdownSection = {
  path: string[];
  rows: MarkdownRow[];
  // Everything under this heading that is not the table: whatever the reviewer
  // wrote. Kept verbatim, never parsed for meaning.
  prose: string;
};

export type MarkdownSheet = {
  sheet: string;
  instances: string[];
  // WHICH language the prose in this document is. `description`/`remarks` are
  // LangText and the projection collapses them to one language (with the usual
  // cross-language fallback), so an edit to a description is an edit to
  // whichever language happened to render — and a change set that does not say
  // which would have the reader write a Japanese override over an English
  // string. Carried on the document, not per row: one rendering, one language.
  lang: Lang;
  sections: MarkdownSection[];
  // Prose before the first heading.
  prose: string;
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// A pipe would end the cell and a newline would end the row. Both are rare in
// real data (measured on a real project: 1 value with a pipe, 0 with a newline,
// 6 descriptions with one) and neither may be lost, so both are escaped rather
// than stripped — and the escape is reversed exactly on the way back, which is
// what the round-trip test holds this to.
function escapeCell(text: string): string {
  return (
    text
      .replace(/\\/g, "\\\\")
      .replace(/\|/g, "\\|")
      // A `<br>` the TEXT itself contains, before one is written for a newline —
      // otherwise the two are the same string on the way back and the reader
      // turns the author's own tag into a line break. Not in any of the 1536
      // rows measured, which is exactly why it needed a test rather than a
      // reading: the data happened not to hold one.
      .replace(/<br(\s*\/?)>/gi, "&lt;br$1&gt;")
      .replace(/\r?\n/g, "<br>")
  );
}

function unescapeCell(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&lt;br(\s*\/?)&gt;/gi, "<br$1>")
    .replace(/\\\|/g, "|")
    .replace(/\\\\/g, "\\");
}

// A table cell cannot hold leading or trailing whitespace: every markdown
// renderer trims it, and so does anyone editing the row by hand. So the
// PROJECTION is trimmed too, which is what makes it canonical —
// `parse(render(project(x)))` equals `project(x)`, and a diff of an untouched
// document is empty.
//
// Not cosmetic. One real dictionary description ends in a space (extraction
// noise, invisible to every reader); without this, that row and every row like
// it would report as changed in a document nobody had touched, and a change set
// that cries wolf is one nobody reads.
const cell = (text: string): string => text.trim();

const lang = (v: unknown, l: Lang): string => {
  const picked = typeof v === "string" ? v : pickLang(v as never, l);
  return cell(picked ?? "");
};

// How the projection is written when the markdown IS the sheet (full-edit mode)
// rather than an editing surface over a model that is still there.
export type ProjectionOptions = {
  // A row inside a block is written under it, indented, and named by its own
  // leaf — the parent/child display a paper parameter sheet has always had, and
  // the shape the model already carries in `container_path`. Off by default, so
  // a projection over a live model keeps every key verbatim.
  indent?: boolean;
  // Nothing was decided here: the value cell is left EMPTY and the default
  // column carries what applies. That is the paper sheet's own convention, and
  // it is what makes "hide the rows nobody set" a rule about the TEXT — which
  // is all a document has once the model is gone.
  markUnset?: boolean;
};

const INDENT = "  ";

// The row's own name under the block that holds it. `container` rows name the
// block itself; everything else drops the parent's prefix, which is exactly
// what the sheet's key column shows (`keyLeaf` in html/app.ts).
function leafKey(p: ParamData): string {
  if (p.container) return p.container.name ?? p.key;
  const parent = (p.container_path ?? [])[(p.container_path ?? []).length - 1];
  const key = p.key.startsWith("@") ? p.key.slice(1) : p.key;
  return parent && key.startsWith(`${parent.path}.`) ? key.slice(parent.path.length + 1) : key;
}

const unset = (p: ParamData): boolean => p.origin === "default" || p.origin === "baseline";

function rowOf(p: ParamData, instances: string[], l: Lang, opts: ProjectionOptions = {}): MarkdownRow {
  const values: Record<string, string> = {};
  const shared = !(p.instances && p.instances.length > 0);
  const cols = instances.length > 0 ? instances : [""];
  const blank = opts.markUnset === true && unset(p);
  for (const name of cols) {
    values[name] = blank
      ? ""
      : cell(shared ? (p.value ?? "") : (p.instances!.find((i) => i.name === name)?.value ?? ""));
  }
  // What applies to a row nobody set. Usually the documented default; for a
  // value only ever OBSERVED (a plan's `change.after`, where the dictionary
  // records no default) it is the observation, because leaving both columns
  // empty would say nothing at all about a row that does have a value in force.
  const observed = shared ? p.value : p.instances?.[0]?.value;
  const applies = p.baseline ?? p.default ?? (blank ? observed : undefined);
  const depth = opts.indent === true ? (p.container_path ?? []).length : 0;
  return {
    key: INDENT.repeat(depth) + cell(opts.indent === true ? leafKey(p) : p.key),
    values,
    ...(shared ? { shared: true as const } : {}),
    default: cell(applies ?? ""),
    description: lang(p.description, l),
    remarks: lang(p.remarks, l),
  };
}

// The rows of one category, with the blocks that hold them drawn in.
//
// A block whose opening carries no argument has no row in the model — there is
// no decision in `[Service]` beyond the fact that it groups — but its level IS
// an indent step, and an indent step nothing explains is worse than no indent:
// the reader sees a setting pushed one level in under nothing. The sheet's own
// viewer draws those blocks from the chain its rows carry; a document has to
// WRITE them, because the chain is the indentation and nothing else remains.
//
// They are not rows: no value, no description, nothing keyed by them. They
// appear and disappear with their contents, here as on the sheet.
function rowsOf(params: ParamData[], instances: string[], l: Lang, opts: ProjectionOptions): MarkdownRow[] {
  const out: MarkdownRow[] = [];
  if (opts.indent !== true) return params.map((p) => rowOf(p, instances, l, opts));
  const cols = instances.length > 0 ? instances : [""];
  const blank = Object.fromEntries(cols.map((c) => [c, ""]));
  const drawn = new Set<string>();
  for (const p of params) {
    (p.container_path ?? []).forEach((b, depth) => {
      if (drawn.has(b.path)) return;
      drawn.add(b.path);
      // A block the params themselves already state (a `container` row) is not
      // drawn twice.
      // A container ROW's own key IS the block's address, so that is what says
      // "this block already has a row of its own".
      if (params.some((q) => q.container !== undefined && q.key === b.path)) return;
      out.push({
        key: INDENT.repeat(depth) + cell(containerLeaf(b.path)),
        values: { ...blank },
        shared: true as const,
        default: "",
        description: "",
        remarks: "",
      });
    });
    if (p.container !== undefined) drawn.add(p.key);
    out.push(rowOf(p, instances, l, opts));
  }
  return out;
}

// The name a block goes by: `Directory` for `Directory["/var/www"]`, `Service`
// for `Service` — what KIND of block it is, which is what the sheet's key
// column shows and what its argument sits beside rather than inside.
const containerLeaf = (path: string): string => (path.split(".").pop() ?? path).replace(/\[.*\]$/, "");

export function toMarkdownSheet(
  sheet: SheetData["sheets"][number],
  l: Lang = "ja",
  opts: ProjectionOptions = {}
): MarkdownSheet {
  const instances = sheet.instances ?? [];
  const sections: MarkdownSection[] = [];
  const walk = (cats: CategoryData[] | undefined, path: string[]): void => {
    for (const c of cats ?? []) {
      const here = [...path, c.name];
      // EVERY category, including one whose rows are all in its children. Its
      // heading is what makes the structure self-describing: without it a
      // nested category is written at a depth whose parent was never named, and
      // reading the document back cannot recover which level it was on.
      sections.push({
        path: here,
        rows: rowsOf(c.params ?? [], instances, l, opts),
        // The section's own paragraph, which is editable prose like a remark —
        // so it round-trips through this document rather than reading as
        // something the reviewer just wrote.
        prose: lang(c.note, l),
      });
      walk(c.categories, here);
    }
  };
  walk(sheet.categories, []);
  return { sheet: sheet.name, instances, lang: l, sections, prose: "" };
}

// The column a value goes in. A Pattern A row has one; a Pattern B sheet has one
// per environment, and a Pattern A row on such a sheet repeats its shared value
// across them — which is what `origin: common` already asserts, and what the
// stacked view shows.
function valueColumns(doc: MarkdownSheet): string[] {
  return doc.instances.length > 0 ? doc.instances : [""];
}

// The header row is written in the document's OWN language — the same one the
// descriptions rendered in. It is never read back: the parse is positional
// (see `parseSheetMarkdown`), so a reviewer may rename a column, translate the
// row, or leave it as it is, and the document still reads.
const HEAD_BY_LANG = {
  ja: { key: "設定項目", value: "設定値", default: "デフォルト値", description: "説明", remarks: "備考" },
  en: { key: "Parameter", value: "Value", default: "Default", description: "Description", remarks: "Remarks" },
} as const;

// The columns, in the order the SHEET puts them — key, description, default,
// then one per environment, then remarks (`leadingLines` in html/app.ts). Not an
// order of this projection's own: a reader who has the sheet in front of them
// and the same sheet as markdown must not have to re-learn where to look.
type MarkdownColumns = { description: boolean; remarks: boolean };
const columnsOf = (doc: MarkdownSheet): MarkdownColumns => ({
  description: doc.sections.some((s) => s.rows.some((r) => r.description !== "")),
  remarks: doc.sections.some((s) => s.rows.some((r) => r.remarks !== "")),
});

// Which columns of a document are environments.
//
// The TABLE says it, and nothing else does: a column is an environment unless
// it is one this projection writes for something else (the key, the
// description, the default, the remark). There is no declaration to keep beside
// it, and therefore no way for a declaration and a header row to disagree —
// which is what a per-sheet `環境: …` line, tried first, kept threatening to do.
//
// The consequence is stated rather than hidden: a column somebody adds for
// something that is NOT an environment ("担当者") reads as one. It renders as a
// value column and is offered in the column filter; nothing writes it back,
// because write-back resolves against the model, which has no such environment.
// Naming it `備考` — the projection's own word for a column of prose — is how a
// reader says it is not an axis.
export function declaredInstances(markdown: string): string[] | undefined {
  const names: string[] = [];
  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.kind !== "table") continue;
    block.head.forEach((h, n) => {
      if (n === 0 || DOC_HEADS.has(h) || h === HEAD_BY_LANG.ja.value || h === HEAD_BY_LANG.en.value) return;
      if (!names.includes(h)) names.push(h);
    });
  }
  return names.length > 0 ? names : undefined;
}

// Adding an environment to a document, and taking one out.
//
// A mechanical edit of the TEXT, because the text is the model: the declaration
// line and every table move together, so the two can never disagree — which is
// the failure a heuristic ("a column that does not look like ours must be an
// environment") leaves the door open to. And it is not an edit anyone would
// make by hand on a sheet of 300 rows.
//
// The column goes after the environment it follows in the declaration, so the
// order a reader sets is the order they see.
export function withEnvironment(markdown: string, name: string, after?: string): string {
  return editTables(markdown, (cells, kind, head) => {
    const env = valueColumnsOf(head);
    if (env.length === 0 || env.some((n) => head[n].trim() === name)) return cells;
    const put = after === undefined ? env[env.length - 1] + 1 : (env.find((n) => head[n].trim() === after) ?? env[env.length - 1]) + 1;
    const cell = kind === "head" ? ` ${name} ` : kind === "rule" ? " --- " : "  ";
    return [...cells.slice(0, put), cell, ...cells.slice(put)];
  });
}

export function withoutEnvironment(markdown: string, name: string): string {
  return editTables(markdown, (cells, kind, head) => {
    const at = valueColumnsOf(head).find((n) => head[n].trim() === name);
    if (at === undefined) return cells;
    return [...cells.slice(0, at), ...cells.slice(at + 1)];
  });
}

export function renameEnvironment(markdown: string, from: string, to: string): string {
  return editTables(markdown, (cells, kind, head) => {
    if (kind !== "head") return cells;
    const at = valueColumnsOf(head).find((n) => head[n].trim() === from);
    return at === undefined ? cells : cells.map((c, n) => (n === at ? ` ${to} ` : c));
  });
}

// The value columns of ONE header row, by the same rule `declaredInstances`
// uses: everything that is not a column this projection writes for something
// else. The header row is the only thing consulted, so a table's own columns
// are its own business — which is what makes them editable per table.
function valueColumnsOf(head: string[]): number[] {
  const out: number[] = [];
  head.forEach((h, n) => {
    const name = h.trim();
    if (n === 0 || DOC_HEADS.has(name)) return;
    out.push(n);
  });
  return out;
}

// Every table line of the document, rewritten cell by cell. The head row is the
// one after which a rule follows; the rule is the `| --- |` line.
function editTables(
  markdown: string,
  edit: (cells: string[], kind: "head" | "rule" | "row", head: string[]) => string[]
): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let headCells: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!TABLE_ROW.test(line)) {
      headCells = null;
      out.push(line);
      continue;
    }
    const cells = line.split("|").slice(1, -1);
    const isRule = cells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c));
    const isHead = !isRule && i + 1 < lines.length && SEPARATOR.test(lines[i + 1]);
    if (isHead) headCells = cells;
    const kind = isHead ? "head" : isRule ? "rule" : "row";
    // A line that is not part of a table this document wrote (no header above
    // it) is left exactly as it is.
    if (kind === "row" && headCells === null) {
      out.push(line);
      continue;
    }
    out.push(`|${edit(cells, kind, (isHead ? cells : headCells) ?? []).join("|")}|`);
  }
  return out.join("\n");
}

export function renderSheetMarkdown(doc: MarkdownSheet): string {
  const HEAD = HEAD_BY_LANG[doc.lang] ?? HEAD_BY_LANG.ja;
  const cols = valueColumns(doc);
  // A column nobody on this sheet has anything for is not written at all — the
  // sheet itself drops them (`descPresent`/`remarksPresent`), and a document
  // full of empty cells is harder to edit, not more complete.
  const shown = columnsOf(doc);
  const out: string[] = [];
  // The sheet's name, so a file that has been saved and reopened still says
  // which sheet it is — and so a reviewer editing two of them cannot mix them up.
  out.push(`# ${doc.sheet}`, "");
  if (doc.prose) out.push(doc.prose, "");
  for (const section of doc.sections) {
    out.push(`${"#".repeat(Math.min(6, section.path.length + 1))} ${section.path[section.path.length - 1]}`, "");
    if (section.prose) out.push(section.prose, "");
    // A heading whose rows are all in its children gets no table. An empty one
    // is noise on every nested sheet, and the parse already tolerates a heading
    // with nothing under it.
    if (section.rows.length === 0) continue;
    const header = [
      HEAD.key,
      ...(shown.description ? [HEAD.description] : []),
      HEAD.default,
      ...cols.map((c) => c || HEAD.value),
      ...(shown.remarks ? [HEAD.remarks] : []),
    ];
    out.push(`| ${header.join(" | ")} |`);
    out.push(`| ${header.map(() => "---").join(" | ")} |`);
    for (const row of section.rows) {
      // The indent goes OUTSIDE the code span: inside it, it is text — and the
      // whole point is that a person can add or remove it with the space bar.
      const indent = /^ */.exec(row.key)![0];
      const cells = [
        `${indent}\`${escapeCell(row.key.slice(indent.length))}\``,
        ...(shown.description ? [escapeCell(row.description)] : []),
        escapeCell(row.default),
        ...cols.map((c) => escapeCell(row.values[c] ?? "")),
        ...(shown.remarks ? [escapeCell(row.remarks)] : []),
      ];
      out.push(`| ${cells.join(" | ")} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

function splitCells(line: string): string[] {
  const inner = TABLE_ROW.exec(line)![1];
  // Split on unescaped pipes only — `\|` is a pipe inside a cell.
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") {
      cur += "\\|";
      i++;
      continue;
    }
    if (inner[i] === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += inner[i];
  }
  cells.push(cur);
  // Trimmed, EXCEPT the leading spaces of the first cell: that indent is the
  // parent/child relationship, written the way a person writes one, and a trim
  // that ate it would make the hierarchy unwritable by hand.
  // The renderer pads every cell with one space on each side, so exactly one
  // leading space is the delimiter's and anything beyond it is the author's.
  return cells.map((c, i) => (i === 0 ? c.replace(/^ /, "").replace(/\s+$/, "") : c.trim()));
}

const stripKey = (cell: string): string => {
  const indent = /^ */.exec(cell)![0];
  return indent + unescapeCell(cell.slice(indent.length).trim().replace(/^`(.*)`$/s, "$1"));
};

// A row nobody has set: every value cell empty, the default column carrying
// what applies. The rule is about the TEXT — which is all there is — and it
// stays true when somebody types a value in, which is exactly when the row
// should stop being hidden.
export const rowIsUnset = (cells: string[], values: number[]): boolean =>
  values.length > 0 && values.every((n) => (cells[n] ?? "").trim() === "");

// Which rows survive the "hide what nobody set" filter, decided bottom-up so a
// block outlives its own emptiness for as long as it holds something.
export function visibleRows(
  rows: { indent: number; cells: string[] }[],
  values: number[],
  showDefaults: boolean
): boolean[] {
  if (showDefaults) return rows.map(() => true);
  const out = rows.map((r) => !rowIsUnset(r.cells, values));
  for (let i = rows.length - 1; i >= 0; i--) {
    if (out[i]) continue;
    for (let j = i + 1; j < rows.length && rows[j].indent > rows[i].indent; j++) {
      if (out[j]) {
        out[i] = true;
        break;
      }
    }
  }
  return out;
}

// The rows a document states, as the shape the rest of the viewer already
// reads. Not a way back to the model — there is none, and the document is the
// model now — but the comparison view, the search index and anything else that
// asks "what rows are on this sheet" can be answered from the text with no
// second implementation.
//
// Everything the model carries and the text does not (origin, source, options,
// out-of-scope) is simply absent, which is what makes it safe: a view built
// from this can only show what the document says.
export function markdownToCategories(text: string, instances: string[], l: Lang = "ja"): CategoryData[] {
  const root: CategoryData[] = [];
  const stack: CategoryData[] = [];
  const cols = instances.length > 0 ? instances : [""];
  const blocks = parseMarkdownBlocks(text);
  for (const block of blocks) {
    if (block.kind === "heading") {
      if (block.depth === 1) continue;
      const depth = Math.max(1, block.depth - 1);
      const cat: CategoryData = { name: block.text };
      stack.length = depth - 1;
      const parent = stack[depth - 2];
      if (parent === undefined) root.push(cat);
      else parent.categories = [...(parent.categories ?? []), cat];
      stack[depth - 1] = cat;
      continue;
    }
    if (block.kind === "prose") {
      // A paragraph beside a table is the section's own note — the same field a
      // modelled sheet carries it in, so it is searched and shown the same way.
      const into = stack[stack.length - 1];
      if (into !== undefined) into.note = [into.note, block.text].filter(Boolean).join("\n\n");
      continue;
    }
    if (block.kind !== "table") continue;
    const shape = tableShape(block.head, instances, l);
    const into = stack[stack.length - 1];
    if (into === undefined) continue;
    const chain: string[] = [];
    const params: ParamData[] = into.params ?? [];
    // Which rows nobody set, decided by the SAME rule the body hides by: a
    // container has no value of its own and must not be filed as unset while it
    // still holds something, or the outline and the page disagree about what
    // exists.
    const shown = visibleRows(block.rows, shape.values, false);
    for (const [n, row] of block.rows.entries()) {
      const name = (row.cells[0] ?? "").trim().replace(/^`(.*)`$/s, "$1").trim();
      chain.length = Math.min(row.indent, chain.length);
      chain[row.indent] = name;
      const values = shape.values.map((n) => (row.cells[n] ?? "").trim());
      const names = shape.values.map((n) => block.head[n]);
      const same = new Set(values).size <= 1;
      const key = chain.slice(0, row.indent + 1).join(".");
      params.push({
        key,
        // Named by the column's own header: which environments a table carries
        // is the table's business, and a name read off a list somewhere else
        // would put a value under the wrong one the moment they differ.
        ...(names.some((n) => n !== "") && !same
          ? { instances: names.map((name, i) => ({ name, value: values[i] ?? "" })) }
          : { value: values[0] ?? "" }),
        ...(shape.default >= 0 && (row.cells[shape.default] ?? "").trim() !== ""
          ? { default: (row.cells[shape.default] ?? "").trim() }
          : {}),
        ...(shape.description >= 0 && (row.cells[shape.description] ?? "").trim() !== ""
          ? { description: (row.cells[shape.description] ?? "").trim() }
          : {}),
        ...(shape.rest.length > 0 && (row.cells[shape.rest[0]] ?? "").trim() !== ""
          ? { remarks: (row.cells[shape.rest[0]] ?? "").trim() }
          : {}),
        // Nothing is set here: the document says so by leaving every value cell
        // empty, and this is that fact in the shape the viewer knows it by.
        ...(shown[n] ? {} : { origin: "default" as const }),
      } as ParamData);
    }
    into.params = params;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Blocks, for rendering
// ---------------------------------------------------------------------------
//
// The projection above answers "which rows does this document state" — it is
// how a change set is computed, and it is deliberately narrow: six fields, the
// ones a review acts on.
//
// This answers a different question: "what is written here", for a viewer that
// has nothing else to show. A document nobody has edited yet is the projection
// written out; a document somebody HAS edited is whatever they wrote — a column
// they added, a table with three rows and a paragraph under it, a heading over
// nothing. So the blocks keep the table as it stands (its own header row, its
// own cells) rather than filing it into six named fields, and everything that
// is not a heading or a table stays prose.

// `line` is where the block is WRITTEN, 1-based, and a table row carries its
// own: it is what a double click on the page resolves to, so the editor opens
// on the line somebody pointed at instead of on whatever a search over the
// rendered text happened to match first. Required, not optional — a block this
// parse produced always came from somewhere.
export type MarkdownBlock =
  | { kind: "heading"; depth: number; text: string; line: number }
  | { kind: "table"; head: string[]; rows: { indent: number; cells: string[]; line: number }[]; line: number }
  | { kind: "prose"; text: string; line: number };

// Leading spaces of the key cell, in levels: the parent/child relationship,
// written the way a person writes one. Two spaces a level, and an odd number
// rounds down rather than being refused — a document is not a grammar to obey.
const INDENT_WIDTH = 2;

export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n");
  const out: MarkdownBlock[] = [];
  let prose: string[] = [];
  let proseAt = 0;
  const flush = (): void => {
    const body = prose.join("\n").replace(/^\n+|\n+$/g, "");
    // The blank lines the trim took off are lines too: the block starts at the
    // first one that carries something.
    if (body !== "") out.push({ kind: "prose", text: body, line: proseAt + prose.findIndex((l) => l.trim() !== "") + 1 });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const h = HEADING.exec(lines[i]);
    if (h) {
      flush();
      out.push({ kind: "heading", depth: h[1].length, text: h[2], line: i + 1 });
      continue;
    }
    if (TABLE_ROW.test(lines[i]) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      flush();
      const head = splitCells(lines[i]).map((c) => c.trim());
      const line = i + 1;
      i += 1;
      const rows: { indent: number; cells: string[]; line: number }[] = [];
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]) && !SEPARATOR.test(lines[i + 1])) {
        const cells = splitCells(lines[++i]);
        const lead = /^ */.exec(cells[0] ?? "")![0].length;
        rows.push({
          indent: Math.floor(lead / INDENT_WIDTH),
          cells: cells.map((c, n) => unescapeCell(n === 0 ? c.trim() : c)),
          line: i + 1,
        });
      }
      out.push({ kind: "table", head, rows, line });
      continue;
    }
    if (prose.length === 0) proseAt = i;
    prose.push(lines[i]);
  }
  flush();
  return out;
}

// Which column is which, for a viewer that must lay a hand-edited table out the
// way the sheet lays its own out. Same rule the parse uses: the value columns
// are found BY NAME (the environments, or the one "value" header), and the rest
// follows from where they start. A table nobody generated — one the reviewer
// wrote from scratch — resolves to "key, then values", which is the least this
// can claim and still be true.
export type TableShape = { key: 0; description: number; default: number; values: number[]; rest: number[] };

// The headers this projection writes for the columns that are NOT values. They
// are how a column added beside the values is told from a column added after
// them: everything in the value block that is not one of these is a value.
const DOC_HEADS: ReadonlySet<string> = new Set<string>(
  [...Object.values(HEAD_BY_LANG.ja), ...Object.values(HEAD_BY_LANG.en)].filter((h) => h !== HEAD_BY_LANG.ja.value && h !== HEAD_BY_LANG.en.value)
);

// Which columns of ONE table are environments.
//
// The document's environment SET decides — the names it knows — and the table
// decides which of them it uses, by having the column or not. Two questions,
// two places, and neither can contradict the other: a header that names an
// environment is a value column, a header that does not is a column of prose,
// and a table simply omits the environments it does not cover.
//
// With no set to consult (a document nobody generated, or one from before the
// set existed) the fallback is the older reading: a column this projection
// would not have written for anything else is a value.
export function tableShape(head: string[], instances: string[], l: Lang = "ja"): TableShape {
  const cols = instances.length > 0 ? instances : [""];
  const firstValueHead = cols[0] || (HEAD_BY_LANG[l] ?? HEAD_BY_LANG.ja).value;
  const found = head.findIndex((h, n) => n > 0 && h === firstValueHead);
  const valuesAt = found >= 2 ? found : found === 1 ? 1 : head.length >= 3 + cols.length ? 3 : 2;
  // The declared environments, by name — and then whatever else the document
  // put among them.
  //
  // An environment ADDED by hand is the case this is for: full editing means
  // the document can say things the model does not know yet, and a column
  // written beside `production` is one of them. It is taken as a value column
  // (and reported as a new environment), rather than filed as a stray column
  // whose values would then read as documentation. What stops that from
  // swallowing a `備考` somebody appended is the list above: a column this
  // projection would have written for something else is never a value.
  const known = new Set(instances);
  const singleValue: ReadonlySet<string> = new Set<string>([HEAD_BY_LANG.ja.value, HEAD_BY_LANG.en.value]);
  const values: number[] = [];
  for (let n = 1; n < head.length; n++) {
    const name = head[n];
    if (singleValue.has(name)) {
      // A sheet with no environments has one value column, and this is its
      // header — the projection's own word for "the value".
      values.push(n);
      continue;
    }
    if (known.size > 0) {
      if (known.has(name)) values.push(n);
      continue;
    }
    if (n >= valuesAt && !DOC_HEADS.has(name)) values.push(n);
  }
  // Where the values begin decides what precedes them: the key, optionally a
  // description, and the default.
  const firstValue = values.length > 0 ? values[0] : valuesAt;
  const description = firstValue >= 3 ? 1 : -1;
  const dflt = firstValue >= 2 ? firstValue - 1 : -1;
  // EVERY column this table has and none of the roles above claimed — not just
  // the ones after the values. A column somebody inserted in the middle used to
  // fall between the roles and be rendered nowhere: the document still held it,
  // and the page did not show it, which is the one failure this project refuses
  // to leave silent.
  const taken = new Set([0, description, dflt, ...values]);
  const rest: number[] = [];
  for (let n = 1; n < head.length; n++) if (!taken.has(n)) rest.push(n);
  return { key: 0, description, default: dflt, values, rest };
}

// Parse an edited document back into the same projection the renderer produced.
//
// Never throws on a malformed table: a reviewer edits this by hand, and a parse
// that dies takes the whole edit with it. A line that does not read as a table
// row stays PROSE, which is preserved and reported — the diff then says "this
// section has prose the original did not", which is exactly what happened.
export function parseSheetMarkdown(text: string, instances: string[], l: Lang = "ja"): MarkdownSheet {
  const lines = text.split("\n");
  const doc: MarkdownSheet = { sheet: "", instances, lang: l, sections: [], prose: "" };
  const cols = instances.length > 0 ? instances : [""];
  let path: string[] = [];
  let section: MarkdownSection | null = null;
  let prose: string[] = [];

  const flushProse = (): void => {
    const text = prose.join("\n").replace(/^\n+|\n+$/g, "");
    if (section) section.prose = [section.prose, text].filter(Boolean).join("\n\n");
    else doc.prose = [doc.prose, text].filter(Boolean).join("\n\n");
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = HEADING.exec(line);
    if (h) {
      flushProse();
      const depth = h[1].length;
      if (depth === 1 && doc.sheet === "") {
        doc.sheet = h[2];
        section = null;
        continue;
      }
      // Heading depth 2 is the top category level (the renderer writes
      // `path.length + 1`), so the path is the stack cut to this depth.
      path = [...path.slice(0, depth - 2), h[2]];
      section = { path: [...path], rows: [], prose: "" };
      doc.sections.push(section);
      continue;
    }
    // A table starts where a header row is followed by a separator.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && SEPARATOR.test(lines[i + 1])) {
      flushProse();
      // Which columns this table has, read off ITS OWN header row rather than
      // assumed. A sheet with no descriptions writes no description column, and
      // a count alone cannot say which one is missing — `key, description,
      // default, value` and `key, default, value, remarks` are both four.
      //
      // So the VALUE columns are found by name (they are the environment names,
      // or the one "value" header), and everything else follows from where they
      // start: what precedes them is the key, optionally a description, and the
      // default; what follows is the remarks. A renamed header falls back to
      // the canonical layout rather than failing.
      const head = splitCells(lines[i]).map((c) => c.trim());
      const firstValueHead = cols[0] || (HEAD_BY_LANG[l] ?? HEAD_BY_LANG.ja).value;
      const found = head.findIndex((h, n) => n > 0 && h === firstValueHead);
      const valuesAt = found >= 2 ? found : head.length >= 3 + cols.length ? 3 : 2;
      const at = {
        description: valuesAt >= 3 ? 1 : -1,
        default: valuesAt - 1,
        values: valuesAt,
      };
      const hasDescription = at.description >= 0;
      const hasRemarks = head.length > valuesAt + cols.length;
      i += 1;
      while (i + 1 < lines.length && TABLE_ROW.test(lines[i + 1]) && !SEPARATOR.test(lines[i + 1])) {
        const cells = splitCells(lines[++i]);
        const values: Record<string, string> = {};
        cols.forEach((c, n) => (values[c] = unescapeCell(cells[at.values + n] ?? "")));
        const row: MarkdownRow = {
          key: stripKey(cells[0] ?? ""),
          values,
          default: unescapeCell(cells[at.default] ?? ""),
          description: hasDescription ? unescapeCell(cells[at.description] ?? "") : "",
          remarks: hasRemarks ? unescapeCell(cells[at.values + cols.length] ?? "") : "",
        };
        if (section) section.rows.push(row);
        else doc.sections.push((section = { path: [""], rows: [row], prose: "" }));
      }
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return doc;
}
