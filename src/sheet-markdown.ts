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
import type { Sheet } from "./types.js";
import { pickLang } from "./types.js";
import type { Lang } from "./html/i18n.js";
import { controlGroups, withControlsTogether, modeOf as controlMode, defaultModeOf as controlDefaultMode } from "./composite.js";

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

// One row, as the markdown carries it. `key` is the identity — visible, in the
// first column, never a hidden anchor: an anchor a reviewer cannot see is one
// they break by reflowing a table, and this project does not build load-bearing
// state nobody can see.
export type MarkdownRow = {
  key: string;
  // This row is a CONTROL of the product's screen, not a parameter (types.ts's
  // `composite`): the rows under it are what the files hold, and this is the
  // one thing an operator actually set. It has no key, no source and no review
  // target, so it is written WITHOUT the code span every real row's key carries
  // — which is what the reader skips it by (`isControlRow`). Without that it
  // would come back as a row the model does not have, and every read of a
  // delivered set would report one invented row per control.
  //
  // It exists because the viewer shows it and, until it did, a delivered
  // markdown set did not — one model read two ways depending on which half of
  // this tool the reader was holding.
  control?: true;
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
  // The way into the file this row is a LINE OF: a relative address, with the
  // line as its fragment, or nothing. Written by the CALLER
  // (`ProjectionOptions.preview`), because how far it is from this document to
  // that file is a fact about where the document was put, which the projection
  // does not know — and the projection turns it into the link, so the words on
  // it are the same on every row of every document.
  //
  // It rides in the KEY cell rather than a column of its own. A column is a
  // question asked of every row, and this is not one: it is the same affordance
  // the sheet's own viewer puts under a row's key, and putting it anywhere else
  // would make the two readings of one document look like two documents.
  preview?: string;
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
  // What the TITLE says, when that is not the identity. A sheet carries a
  // label, the file it is written to is named by it, and a page whose heading
  // says something else reads as the wrong file — `OS基本情報.md` opening on
  // `# os baseline`. Absent, the identity is the title, which is what every
  // document written before this had.
  title?: string;
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

// How the projection is written when the markdown IS what a reader holds —
// a handed-over sheet — rather than a listing beside the model it came from.
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
  // Where the file this row is a line of sits, relative to THIS document, with
  // the line as a `#L<n>` fragment — or undefined for a row no file has a line
  // for, which gets nothing rather than an address that opens nothing. The
  // category path comes with it because which of a sheet's files a row belongs
  // to is answered by its outermost category (`artifact-index.ts`).
  //
  // This is the half of the projection that makes a handed-over set navigable:
  // the reader, or the assistant they hand it to, opens the deployed file at
  // the line and sees the setting in its own context — the `{% if %}` around
  // it, the block it is in — which is what a value on its own cannot be judged
  // against.
  preview?: (p: ParamData, categoryPath: string[]) => string | undefined;
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

function rowOf(p: ParamData, instances: string[], l: Lang, path: string[], opts: ProjectionOptions = {}): MarkdownRow {
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
    ...(opts.preview === undefined ? {} : { preview: cell(opts.preview(p, path) ?? "") }),
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
// The control a set of rows spells, as a row of the same table, above them —
// the reading the sheet's own viewer puts there (composite.ts). Written here so
// a handed-over set says what the viewer says; without it the control was the
// one thing a reader saw on screen and not in the document they were given.
//
// It is not a parameter: no key, no address, no review target (`control: true`,
// which is also what the reader skips it by). Its value columns hold the choice
// each environment's tuple spells, and its default column what a fresh install
// spells — both read off the rows beneath it, every time, so the two cannot
// drift.
function controlRowOf(group: ParamData[], instances: string[], l: Lang): MarkdownRow {
  const c = group[0]!.composite!;
  const cols = instances.length > 0 ? instances : [""];
  const values: Record<string, string> = {};
  for (const col of cols) values[col] = controlMode(group, col === "" ? undefined : col, l)?.label ?? "";
  return {
    key: pickLang(c.control, l) ?? "",
    control: true as const,
    values,
    default: controlDefaultMode(group, l)?.label ?? "",
    description: pickLang(c.description, l) ?? "",
    remarks: "",
  };
}

function rowsOf(params: ParamData[], instances: string[], l: Lang, path: string[], opts: ProjectionOptions): MarkdownRow[] {
  const groups = controlGroups(params, l);
  // Brought together at the first of them, exactly as the viewer does: the
  // product's screen shows them as one control, and the dictionary's order
  // scatters them.
  const ordered = withControlsTogether(params, groups);
  const emitted = new Set<ParamData[]>();
  const withControls = (rows: MarkdownRow[], from: ParamData[]): MarkdownRow[] => {
    const out: MarkdownRow[] = [];
    from.forEach((p, n) => {
      const g = groups.get(p);
      if (g !== undefined && !emitted.has(g)) {
        emitted.add(g);
        out.push(controlRowOf(g, instances, l));
      }
      const row = rows[n];
      if (row !== undefined) out.push(row);
    });
    return out;
  };
  const out: MarkdownRow[] = [];
  if (opts.indent !== true)
    return withControls(
      ordered.map((p) => rowOf(p, instances, l, path, opts)),
      ordered
    );
  const cols = instances.length > 0 ? instances : [""];
  const blank = Object.fromEntries(cols.map((c) => [c, ""]));
  const drawn = new Set<string>();
  for (const p of ordered) {
    const g = groups.get(p);
    if (g !== undefined && !emitted.has(g)) {
      emitted.add(g);
      out.push(controlRowOf(g, instances, l));
    }
    (p.container_path ?? []).forEach((b, depth) => {
      if (drawn.has(b.path)) return;
      drawn.add(b.path);
      // A block the params themselves already state (a `container` row) is not
      // drawn twice.
      // A container ROW's own key IS the block's address, so that is what says
      // "this block already has a row of its own".
      if (ordered.some((q) => q.container !== undefined && q.key === b.path)) return;
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
    out.push(rowOf(p, instances, l, path, opts));
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
        rows: rowsOf(c.params ?? [], instances, l, here, opts),
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

// A header this projection USED to write and never writes again.
//
// Recognised for as long as documents carrying it exist. A column whose header
// this document cannot place is read as an ENVIRONMENT (`tableShape`), so
// forgetting one would turn every already-delivered set's retired column into a
// bogus environment on the next reading — the document would grow an axis
// nobody declared, from a change that was only ever about what to stop writing.
//
// 定義場所 / "Written in" was where the value is written in the REPOSITORY. It
// is gone because neither reader used it: the recipient has no repository for
// the link to resolve in, and whoever does has the AI prompt, which groups
// every change by `## File:` already. What a row points at now is the file the
// value LANDS in, which is what the sheet is about.
const RETIRED_HEADS: readonly string[] = ["定義場所", "Written in"];

// The one word the address wears, on every row of every sheet.
//
// Uniform, deliberately, and not the file name: the file is named by the
// heading the rows sit under, and a row-by-row `httpd.conf:34` asks the reader
// to work out what it is each time — directly after a column of repository
// addresses was removed, which is the reading it would invite. One word learnt
// once is the whole affordance. The same word the viewer's own button carries
// (`i18n.ts`'s `artifactTitle`), because they are the same thing.
const PREVIEW_BY_LANG = { ja: "プレビュー", en: "Preview" } as const;

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
  const PREVIEW = PREVIEW_BY_LANG[doc.lang] ?? PREVIEW_BY_LANG.ja;
  const cols = valueColumns(doc);
  // A column nobody on this sheet has anything for is not written at all — the
  // sheet itself drops them (`descPresent`/`remarksPresent`), and a document
  // full of empty cells is harder to edit, not more complete.
  const shown = columnsOf(doc);
  const out: string[] = [];
  // The sheet's name, so a file that has been saved and reopened still says
  // which sheet it is — and so a reviewer editing two of them cannot mix them up.
  out.push(`# ${doc.title ?? doc.sheet}`, "");
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
      // The address goes UNDER the key, in the same cell — the place the
      // sheet's own viewer puts it. NOT escaped as a cell: this is a link, and
      // escaping it would put the brackets on the page instead of the address
      // behind them. A `|` in a path would end the cell, so the one character a
      // table cannot hold is the one thing removed.
      const address =
        (row.preview ?? "") === ""
          ? ""
          : `<br>[${PREVIEW}](${(row.preview ?? "").replace(/\|/g, "\\|")})`;
      const cells = [
        row.control === true
          ? `${indent}**${escapeCell(row.key.slice(indent.length))}**`
          : `${indent}\`${escapeCell(row.key.slice(indent.length))}\`${address}`,
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

// A key cell holds two things: the row's identity, and — where this document
// carries the file the row is a line of — the way into it (`MarkdownRow.preview`).
//
// Split before EITHER is read. The key is the row's identity, so an address
// left stuck to it would make every row a row the model does not have, and the
// change set would report the whole sheet rewritten. Every reader of the cell
// goes through here, including the viewer's (`html/md-sheet.ts`), so there is
// one answer to "what is this row called" rather than one per reader.
//
// Anchored on the closing backtick, which is what the key is always written
// inside: a cell that does not end in a complete link after one is left whole,
// so a hand-written key holding brackets is still just a key.
//
// The break between the two is a `<br>` in the TEXT and a newline once the cell
// has been through `unescapeCell` — which `parseMarkdownBlocks` does on the way
// in, so the viewer reads the second form and the change set reads the first.
// Both are the same cell, so both are matched here; a splitter that knew only
// the written form failed silently in exactly one of its two callers.
const PREVIEW_LINK = /`(?:(?:<br\s*\/?>|\r?\n)\[[^\]]*\]\(([^)]*)\))\s*$/i;

export function splitKeyCell(cell: string): { key: string; preview?: string } {
  const m = PREVIEW_LINK.exec(cell);
  if (m === null) return { key: cell };
  return { key: `${cell.slice(0, m.index)}\``, preview: m[1] };
}

// A row of a table this projection wrote that is NOT a parameter — see
// MarkdownRow.control. Told by the absence of the code span every real row's
// key carries, which is structural rather than a convention about wording: the
// writer above puts one on every key it writes, and only here does it not.
export const isControlRow = (cell: string): boolean => !cell.includes("`");

const stripKey = (cell: string): string => {
  const indent = /^ */.exec(cell)![0];
  const { key } = splitKeyCell(cell.slice(indent.length).trim());
  return indent + unescapeCell(key.replace(/^`(.*)`$/s, "$1"));
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
      // A control of the product's screen, not a parameter: it has no key, so
      // reading it as a row would put one the model does not have into every
      // read of a delivered set.
      if (isControlRow((row.cells[0] ?? "").trim())) continue;
      const name = splitKeyCell((row.cells[0] ?? "").trim()).key.replace(/^`(.*)`$/s, "$1").trim();
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
  [...Object.values(HEAD_BY_LANG.ja), ...Object.values(HEAD_BY_LANG.en), ...RETIRED_HEADS].filter(
    (h) => h !== HEAD_BY_LANG.ja.value && h !== HEAD_BY_LANG.en.value
  )
);

// Is this page a parameter SHEET, or prose?
//
// A page of a handed-over set is one or the other, and until this existed it
// was always read as a sheet — so a prose document's tables were read as rows
// and their headers as ENVIRONMENTS. Measured on a real delivery: a prose
// record came back as about a thousand rows across fourteen environments, each
// named after one of its own columns. The HTML rendered the same document as
// prose the whole time, which is the asymmetry a set is supposed not to have.
//
// The signal is the projection's OWN key header, in either language: a table
// this tool wrote always leads with it, and a table it did not write has no
// reason to. Read off the header rather than declared anywhere, for the same
// reason the chapters are read off the directories — a declaration is prose
// somebody may reword, and an assistant asked to tidy a document will.
//
// What it costs is stated rather than hidden: a page whose key column somebody
// RENAMED stops being read as a sheet. The parse is positional everywhere else
// precisely so a reviewer may translate or rename a column, and this is the one
// header that now has to survive. It is the cheaper half of the trade — a
// renamed column loses one page's rows, and no signal at all turned every prose
// document in the set into a sheet of nonsense.
const KEY_HEADS: ReadonlySet<string> = new Set<string>([HEAD_BY_LANG.ja.key, HEAD_BY_LANG.en.key]);
const DEFAULT_HEADS: ReadonlySet<string> = new Set<string>([HEAD_BY_LANG.ja.default, HEAD_BY_LANG.en.default]);

export function looksLikeParamSheet(markdown: string): boolean {
  // TWO of the projection's heads, not one, and the second is not caution: a
  // document THIS TOOL writes already uses the key head for something that is
  // not a sheet. `testdoc.ts`'s excluded-settings table is headed
  // `excludedCols` — the key head, a reason and an owner — which is prose ABOUT
  // settings rather than a sheet of them, and on that one table a whole
  // quarter-megabyte record was read as a thousand rows. So the collision is
  // structural rather than incidental, and a signal that cannot tell those two
  // apart is not a signal. The DEFAULT column is the second one because this
  // projection always writes it (the header array holds it unconditionally,
  // unlike description and remarks), so requiring it rules nothing out that
  // this tool produced.
  return parseMarkdownBlocks(markdown).some(
    (b) => b.kind === "table" && KEY_HEADS.has((b.head[0] ?? "").trim()) && b.head.slice(1).some((h) => DEFAULT_HEADS.has(h.trim()))
  );
}

// A table that reads like one of this projection's, with its KEY column wearing
// some other name.
//
// The one case reading a page as prose is the wrong answer: somebody renamed or
// mistyped the header this now depends on, and their rows quietly stopped being
// rows. Reported only for that — a document full of ordinary tables (a test
// record, a decision log) is prose, is read as prose, and a warning on every
// one of them is a warning nobody reads by the third set.
//
// The evidence is the DEFAULT head, and deliberately only that one. It is the
// column this projection always writes AND one nothing else asks for, which is
// the pair that makes it a signal. The description and remarks heads are
// neither: `testdoc.ts` ends every item row with the remarks head, as any
// table might, and counting it reported one generated record twenty-eight
// times over as a sheet with a renamed key column. A warning that fires on a
// document this tool wrote itself is a warning nobody reads by the third set.
export function renamedKeyColumns(markdown: string): string[] {
  const out: string[] = [];
  for (const b of parseMarkdownBlocks(markdown)) {
    if (b.kind !== "table") continue;
    const first = (b.head[0] ?? "").trim();
    if (KEY_HEADS.has(first)) continue;
    if (b.head.slice(1).some((h) => DEFAULT_HEADS.has(h.trim()))) out.push(first);
  }
  return out;
}

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
        // …and the same here: a control is display, and a read-back set is the
        // model. See MarkdownRow.control.
        if (isControlRow((cells[0] ?? "").trim())) continue;
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

// One sheet's rows, as the text. Written with the options a handed-over
// document needs: the parent/child indent a paper sheet has, and an empty value
// cell for a row nobody set (see `ProjectionOptions`).
//
// The one entry point that takes a model sheet and returns text — everything
// above it is the projection in pieces, and a caller that assembles them itself
// would be deciding those two options again, differently.
export function sheetToMarkdown(
  sheet: Sheet,
  lang: Lang,
  preview?: (p: ParamData, categoryPath: string[]) => string | undefined,
  title?: string
): string {
  const doc = toMarkdownSheet(sheet as unknown as SheetData["sheets"][number], lang, {
    indent: true,
    markUnset: true,
    ...(preview === undefined ? {} : { preview }),
  });
  return renderSheetMarkdown(title === undefined || title === doc.sheet ? doc : { ...doc, title });
}
