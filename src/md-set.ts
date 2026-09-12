// The sheet set as markdown: one file per sheet, the chapter tree as directories.
//
// NOT one document. A real sheet runs to thousands of rows — measured at about
// 190 bytes a row, so a four-thousand-row project is three quarters of a
// megabyte — and the thing a recipient is meant to do with this is hand ONE
// sheet to an assistant and say "change this value". One file per sheet is the
// unit that makes that possible, and it is not a shape invented here: the model
// already says a document is a tree of chapters holding sheets (`groups`), and
// this writes that tree to disk.
//
// Paths are NAMES, never chapter numbers. The numbers are derived from the
// declared order and move the moment a chapter is inserted (see types.ts's
// `numbering`), so numbering the files would rename every one of them for a
// change that altered nothing — taking the git history and every link with it.
//
// Pure: it returns the files, it does not write them.

import type { SheetData, ParamData } from "./prompt.js";
import type { Lang } from "./html/i18n.js";
import { createHash } from "crypto";
import { sheetToMarkdown } from "./sheet-markdown.js";

export type MarkdownFile = { path: string; text: string };

export type MarkdownSetOptions = {
  // The address column: where each row is written, as a link from the file the
  // row is in. Given the sheet's own path so the caller does the relative
  // arithmetic once per sheet; omit it and no document carries the column.
  source?: (sheetPath: string) => ((p: ParamData) => string | undefined) | undefined;
  // What the model was when this set was written. Carried in the INDEX and
  // nowhere else: it identifies the set, and a stamp on every file is a stamp
  // to forget on one of them.
  stamp?: string;
  // The documents a sheet's rows are ABOUT, carried into the set as files: the
  // rendered artifact, the authored source it came from, the bytes a host was
  // found holding. Written where the caller says and listed under the sheet
  // that describes them, so a recipient with no repository can still open what
  // a row is talking about — which is the difference between a handed-over set
  // and a table of values with nowhere to go.
  //
  // Composed by the caller, because what may travel is the judge's decision
  // (see evidence.ts) and where these sit on disk is the delivery's.
  // `path` is RELATIVE TO THE SHEET'S OWN DIRECTORY, not to the set: a
  // rendered artifact belongs beside the chapter that describes it and a
  // collected file beside the record that cites it, because that is the
  // structure the document already has. A single `artifacts/` bucket at the
  // root would be a second, type-shaped arrangement laid over the chapters —
  // and the reader who opened 詳細設計 would have to leave it to see what it
  // is describing.
  documents?: { path: string; text: string; sheet: string; label: string }[];
};

// A path segment that survives a filesystem, a zip and a URL — and stays the
// NAME. Japanese is kept: the name is what the reader and the assistant refer
// to, and transliterating it would invent a second name for the same chapter.
// Only what actually breaks a path is replaced.
export function slug(name: string): string {
  const out = name
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  return out === "" ? "sheet" : out;
}

// A path, as a markdown link destination.
//
// `encodeURI` leaves parentheses alone, and a destination is terminated by the
// first `)` — so a sheet named `Keycloak (realm)` produced a link that stopped
// halfway through its own filename. Measured on a real document: 33 of its
// entries, every one of them a name with a bracket in it, and every one of them
// silently opening nothing.

export const href = (path: string): string => encodeURI(path).replace(/\(/g, "%28").replace(/\)/g, "%29");

type Placed = { sheet: SheetData["sheets"][number]; dir: string[] };

// Which chapter each sheet sits in, in the order the document declares. A sheet
// whose group is in no chapter of the tree is placed at the ROOT rather than
// dropped — losing a sheet is the failure this project refuses to let happen
// quietly — and it is reported as well.
function place(data: SheetData): { placed: Placed[]; problems: string[] } {
  const placed: Placed[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  const walk = (groups: SheetData["groups"], dir: string[]): void => {
    for (const g of groups ?? []) {
      const here = [...dir, slug(g.display ?? g.name)];
      for (const s of data.sheets) {
        if (s.group !== g.name || seen.has(s.name)) continue;
        seen.add(s.name);
        placed.push({ sheet: s, dir: here });
      }
      walk(g.groups, here);
    }
  };
  walk(data.groups, []);

  for (const s of data.sheets) {
    if (seen.has(s.name)) continue;
    if (s.group !== undefined) {
      problems.push(
        `sheet "${s.name}" names chapter "${s.group}", which this document has no chapter for — written at the top level`
      );
    }
    placed.push({ sheet: s, dir: [] });
  }
  return { placed, problems };
}

export function toMarkdownSet(
  data: SheetData,
  lang: Lang = "ja",
  opts: MarkdownSetOptions = {}
): { files: MarkdownFile[]; problems: string[] } {
  const { placed, problems } = place(data);
  const sheets: MarkdownFile[] = [];
  const carried: MarkdownFile[] = [];
  const taken = new Map<string, string>();

  for (const { sheet, dir } of placed) {
    const path = [...dir, `${slug(sheet.display ?? sheet.name)}.md`].join("/");
    // Two names that spell the same path would overwrite one another, and the
    // survivor would be whichever came last. Reported, and the second gets a
    // path of its own rather than silently replacing the first.
    const clash = taken.get(path);
    const finalPath = clash === undefined ? path : path.replace(/\.md$/, `-${sheets.length + 1}.md`);
    if (clash !== undefined) {
      problems.push(`"${sheet.name}" and "${clash}" both spell ${path} — the second is written as ${finalPath}`);
    }
    taken.set(path, sheet.name);
    const body = sheetToMarkdown(sheet as never, lang, opts.source?.(finalPath), sheet.display ?? sheet.name);
    const mine = (opts.documents ?? []).filter((d) => d.sheet === sheet.name);
    sheets.push({ path: finalPath, text: withDocuments(body, finalPath, mine, lang) });
    const under = dir.join("/");
    for (const d of mine) carried.push({ path: under === "" ? d.path : `${under}/${d.path}`, text: d.text });
  }

  // Two sheets of one chapter describing the same deployed file would write it
  // twice at one path, and the reader would get whichever came last. Reported,
  // and only the first is written — which of the two is right is not this
  // module's to decide, and quietly picking one is the failure it would hide.
  const seen = new Set<string>();
  const documents: MarkdownFile[] = [];
  for (const d of carried) {
    if (seen.has(d.path)) {
      if (!documents.some((x) => x.path === d.path && x.text === d.text)) {
        problems.push(`two documents are written at ${d.path} — only the first is kept`);
      }
      continue;
    }
    seen.add(d.path);
    documents.push(d);
  }

  const paths = new Map(placed.map((p, i) => [p.sheet.name, sheets[i]!.path]));
  return {
    files: [{ path: "README.md", text: index(data, paths, lang, opts.stamp) }, ...sheets, ...documents],
    problems,
  };
}

// The files this sheet describes, listed under its title as ordinary prose.
//
// Not a heading of its own: the sheet's categories are the `##` level and a
// heading here would become one of them — a section with no rows, in the parse
// and in every reading of it. Prose before the first section is exactly where
// something about the whole sheet belongs.
function withDocuments(
  body: string,
  sheetPath: string,
  mine: NonNullable<MarkdownSetOptions["documents"]>,
  lang: Lang
): string {
  if (mine.length === 0) return body;
  const lead = lang === "ja" ? "このシートが記述するファイル:" : "The files this sheet describes:";
  const block = [lead, "", ...mine.map((d) => `- [${d.label}](${href(d.path)})`), ""].join("\n");
  // The title is the first line and is followed by a blank one — that is what
  // `sheetToMarkdown` writes, and if it ever stops writing it this must be
  // seen to fail rather than quietly put the list somewhere else.
  const m = /^(# [^\n]*\n\n)/.exec(body);
  if (m === null) throw new Error(`${sheetPath}: no title to put the file list under`);
  return body.slice(0, m[1]!.length) + block + "\n" + body.slice(m[1]!.length);
}

// The index: the chapter tree, in the order the document declares it, as links.
//
// This is where the ORDER lives, which is why the files carry no numbers. A
// reader opens this first and an assistant is pointed at it; both then follow a
// link rather than guessing which file a chapter is.
function index(data: SheetData, paths: Map<string, string>, lang: Lang, stamp: string | undefined): string {
  const title = data.metadata?.title ?? (lang === "ja" ? "パラメータシート" : "Parameter sheet");
  const out: string[] = [];
  if (stamp !== undefined) out.push(`<!-- review-sheet:model ${stamp} -->`, "");
  out.push(`# ${title}`, "");

  const meta = data.metadata;
  if (meta?.project !== undefined || meta?.version !== undefined || meta?.generated_at !== undefined) {
    const label =
      lang === "ja"
        ? { project: "プロジェクト", version: "バージョン", at: "作成日時" }
        : { project: "Project", version: "Version", at: "Generated" };
    out.push("| | |", "| --- | --- |");
    if (meta.project !== undefined) out.push(`| ${label.project} | ${meta.project} |`);
    if (meta.version !== undefined) out.push(`| ${label.version} | ${meta.version} |`);
    if (meta.generated_at !== undefined) out.push(`| ${label.at} | ${meta.generated_at} |`);
    out.push("");
  }

  const link = (s: SheetData["sheets"][number]): string =>
    `[${s.display ?? s.name}](${href(paths.get(s.name) ?? "")})`;

  const walk = (groups: SheetData["groups"], depth: number): void => {
    for (const g of groups ?? []) {
      out.push(`${"  ".repeat(depth)}- ${g.display ?? g.name}`);
      for (const s of data.sheets) if (s.group === g.name) out.push(`${"  ".repeat(depth + 1)}- ${link(s)}`);
      walk(g.groups, depth + 1);
    }
  };
  walk(data.groups, 0);
  for (const s of data.sheets) if (s.group === undefined) out.push(`- ${link(s)}`);
  out.push("");
  return out.join("\n");
}

// Which model a written-out set came from.
//
// Not a hash of the FILES: those are what is being judged, and a set somebody
// hand-edited must still be recognisable as having come from this model — the
// question `verify` asks is "does the committed markdown still describe the
// model beside it", and the answer has to survive a typo fixed in a remark.
//
// Recomputed, never stored twice: `generate` writes it into the index and
// `verify` computes it again from the model it is given. Which means the two
// must be given the SAME model — a set written for one delivery's environments
// is a different set from one written for all of them, and says so.
export function modelStamp(model: unknown): string {
  return createHash("sha256").update(JSON.stringify(model)).digest("hex").slice(0, 16);
}

// The stamp a written-out index carries, or undefined for a set that predates
// it — or one whose index somebody replaced. Read by scanning, because the
// index is markdown and this is a comment in it.
export function stampOf(indexText: string): string | undefined {
  return /<!--\s*review-sheet:model\s+([0-9a-f]+)\s*-->/.exec(indexText)?.[1];
}
