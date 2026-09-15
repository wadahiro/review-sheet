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
import { sheetsInOrder } from "./prompt.js";
import type { Lang } from "./html/i18n.js";
import { createHash } from "crypto";
import { sheetToMarkdown } from "./sheet-markdown.js";
import { EVIDENCE_SCHEME, parseEvidenceRef } from "./evidence.js";
import { NO_NAV_MARKER } from "./markdown.js";

export type MarkdownFile = { path: string; text: string };

export type MarkdownSetOptions = {
  // The way into the file each row is a LINE OF, as an address relative to the
  // sheet the row is in. Given the SHEET, not its path: which of a sheet's
  // files a row belongs to is answered per sheet and per category
  // (`artifact-index.ts`), and the documents this set carries are already
  // written relative to the sheet's own directory — so there is no relative
  // arithmetic left for the caller to do, only the lookup.
  //
  // Omit it and no row carries an address.
  // The address a row's key cell carries, and optionally the word on it — a
  // document nothing deploys is not a "preview" of anything (see
  // MarkdownRow.previewWord).
  preview?: (
    sheet: SheetData["sheets"][number]
  ) => ((p: ParamData, categoryPath: string[]) => string | { href: string; word?: string } | undefined) | undefined;
  // What the model was when this set was written. Carried in the INDEX and
  // nowhere else: it identifies the set, and a stamp on every file is a stamp
  // to forget on one of them.
  stamp?: string;
  // …and which environments it was narrowed to, when it was. A delivery covers
  // some of them and is stamped over THAT model, so `verify --md` handed the
  // whole one computes a different hash and reports a set that is perfectly
  // current as stale. Recorded so it can narrow the same way instead of the
  // reader having to remember which flags built the set.
  instances?: string[];
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
  // and the reader who opened a chapter would have to leave it to see what
  // that chapter is describing.
  //
  // `id` is the PREVIEW the document was written from, which is what a
  // record's in-text evidence links name — see `withDocumentLinks`.
  documents?: { id: string; path: string; text: string; sheet: string }[];
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
  const problems: string[] = [];
  // The walk itself is shared with the page that draws this document
  // (`sheetsInOrder`): the tab a reader opens and the file a set holds have to
  // be the same sheet, and two walks that must agree are two walks that will
  // not. What stays here is the DIRECTORY each chapter is, and the report.
  const placed: Placed[] = sheetsInOrder(data.sheets, data.groups).map(({ sheet, chapters }) => {
    if (chapters.length === 0 && sheet.group !== undefined) {
      problems.push(
        `sheet "${sheet.name}" names chapter "${sheet.group}", which this document has no chapter for — written at the top level`
      );
    }
    return { sheet, dir: chapters.map((g) => slug(g.display ?? g.name)) };
  });
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
    const title = sheet.display ?? sheet.name;
    const body = documentBody(sheet, title) ?? sheetToMarkdown(sheet as never, lang, opts.preview?.(sheet), title);
    // A sheet that wrote nothing but its own name. Rows and prose are the only
    // two things a sheet is made of, so a file with neither is a sheet that did
    // not travel — the failure this whole area exists to prevent, and one that
    // looks exactly like a sheet which is simply short.
    if (!hasBody(body)) {
      problems.push(`sheet "${sheet.name}" was written as its title and nothing else — it carries neither rows nor prose`);
    }
    const mine = (opts.documents ?? []).filter((d) => d.sheet === sheet.name);
    const linked = withDocumentLinks(body, mine, (id) => problems.push(
      `sheet "${sheet.name}" links to evidence this set does not carry (${id}) — the link is left as it was and opens nothing here`
    ));
    sheets.push({ path: finalPath, text: linked });
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
      // `carriedDocuments` gives every document a path of its own, so reaching
      // here means two of them ARE the same document, emitted twice.
      if (!documents.some((x) => x.path === d.path && x.text === d.text)) {
        problems.push(`two documents are written at ${d.path} — only the first is kept`);
      }
      continue;
    }
    seen.add(d.path);
    documents.push(d);
  }

  // …and whether anything can REACH each of them.
  //
  // The set used to open every page with a list of the files it carries, which
  // is how a plain markdown reader got to one at all. It stopped being the way
  // in — a row carries the address of the line it is written at, and a verdict
  // the address of the bytes it was read from — and once both were true the
  // list was 65 of 65 files that some row or verdict already reached, sitting
  // above the content on every page. Measured on a real delivery.
  //
  // What the list also did, silently, was make an unreachable file look
  // reachable. A file no row points at — an artifact whose lines carry no row
  // keys, evidence no verdict cites — has no way in at all now, and that is
  // worth SAYING rather than papering over with a link nobody asked for. Asked
  // of the pages this run actually wrote, never of the model, because a page is
  // the only thing that can answer it.
  const reached = new Set<string>();
  for (const page of sheets) {
    const at = page.path.split("/").slice(0, -1);
    for (const m of page.text.matchAll(/\]\(([^)]+)\)/g)) {
      const raw = decodeURI((m[1] ?? "").split("#")[0] ?? "");
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/") || raw === "") continue;
      const out: string[] = [...at];
      for (const seg of raw.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
        else out.push(seg);
      }
      reached.add(out.join("/"));
    }
  }
  const stranded = documents.filter((d) => !reached.has(d.path)).map((d) => d.path);
  if (stranded.length > 0) {
    problems.push(
      `${stranded.length} carried file(s) are in the set with no page linking to them, so a reader has no way to reach them: ` +
        `${stranded.slice(0, 5).join(", ")}${stranded.length > 5 ? `, +${stranded.length - 5} more` : ""}`
    );
  }

  const paths = new Map(placed.map((p, i) => [p.sheet.name, sheets[i]!.path]));
  return {
    files: [{ path: "README.md", text: index(data, paths, lang, opts.stamp, opts.instances) }, ...sheets, ...documents],
    problems,
  };
}

// A record's evidence links, as PATHS in this set.
//
// The links are written by `evidenceCell` over the DOCUMENT's own id
// (`rs-evidence:observed <env> <host> <file>`), which is right for a page built
// from the model: the viewer holds those documents and opens them by that name.
// A set holds them as FILES, and nothing in a set knows that name — a page read
// back out of a folder identifies a document by where it is (`md-read.ts`), so
// every one of those links resolved to nothing. Measured on a real delivery:
// 347 of them, in the one document the evidence exists for.
//
// Rewritten to the same kind of address every row of every sheet already
// carries — relative to the file the link is in, which is what makes a
// handed-over set navigable. Two things follow from that and neither is a side
// effect: the record opens its evidence in a plain markdown reader, with no
// viewer at all, and the viewer resolves it by the one name a set has for a
// document instead of needing a second one reconstructed from the path — which
// a command's file name cannot carry anyway (`commandFile` cuts and slugs it).
//
// A link naming a document this set does NOT carry is left exactly as it was
// and reported: there is nothing to point it at, and a path invented for it
// would be the affordance-that-opens-nothing wearing a working link's clothes.
function withDocumentLinks(body: string, mine: { id: string; path: string }[], missing: (id: string) => void): string {
  const at = new Map(mine.map((d) => [d.id, d.path]));
  return body.replace(new RegExp(`\\]\\(${EVIDENCE_SCHEME}([^)]*)\\)`, "g"), (whole, ref: string) => {
    const { id, line } = parseEvidenceRef(`${EVIDENCE_SCHEME}${ref}`);
    const to = at.get(id);
    if (to === undefined) {
      missing(id);
      return whole;
    }
    // The fragment stays OUTSIDE the encoding: `md-read`'s rebase splits on it,
    // and an encoded `#` would make the line number part of the file name.
    return `](${href(to)}${line === undefined ? "" : `#L${line}`})`;
  });
}

// A sheet whose model is a DOCUMENT is written as that document.
//
// `sheetToMarkdown` projects CATEGORIES, and a prose document has none — so
// such a sheet came out as its title and nothing else. Measured on a real
// delivery: four sheets and a quarter of a megabyte of prose, gone with no
// error and no warning. The HTML carried them the whole time, which is what
// made it invisible: the two shapes are meant to be one model, and only one of
// them was reading this half of it.
//
// The document's own h1 is dropped exactly as `markdown.ts` drops it when
// rendering: the page already shows the sheet's heading, which carries the
// label in the reader's language where a markdown h1 carries one language, so
// keeping both put the same words twice, a line apart. The SHEET's title is
// written in its place, because that is the name the chapter tree, the index
// and the read-back all call this page.
function documentBody(sheet: SheetData["sheets"][number], title: string): string | undefined {
  const text = sheet.document?.markdown;
  if (text === undefined || text.trim() === "") return undefined;
  // The FIRST heading, and only if it is an h1 — the same test markdown.ts
  // makes. A document that opens at h2 has no title to drop, and a later h1 is
  // a section of a flat document rather than its name.
  const first = /^[ \t]*(#{1,6})[ \t]+[^\n]*\n?/m.exec(text);
  const without =
    first !== null && first[1] === "#"
      ? text.slice(0, first.index) + text.slice(first.index + first[0].length)
      : text;
  return `# ${title}\n\n${withNavMarkers(without.replace(/^\s*\n+/, ""), sheet.document?.headings)}`;
}

// …and which of its headings the outline leaves out, marked at the heading.
//
// The model states that as a DEPTH (`nav_depth`), and a set carries the text
// and not the model — so a page read back out of a folder had to guess, and
// both guesses are wrong in one direction or the other (markdown.ts's `notNav`
// has the numbers). The fact belongs to one heading, so it is written beside
// that heading: it moves when the heading moves, a recipient deletes the line
// to put a heading in the outline and adds it to take one out, and a heading
// they write themselves is IN — which is the right default for a document
// somebody maintains by hand, since a heading that silently fails to appear is
// not something they would think to look for.
//
// WHICH ones, read off the model's own list rather than from a declaration this
// function would have to be told: the build selects by depth and nothing else,
// so the deepest heading it listed IS the depth. A list it did not carry at all
// (a page whose outline is empty) marks nothing — there is no depth to read,
// and guessing one would take entries away from a page that never had any.
//
// Fences are tracked, because `#` inside one is code and a marker inserted
// there would be written INTO the code the reader is meant to see.
function withNavMarkers(text: string, headings: { level: number }[] | undefined): string {
  if (headings === undefined || headings.length === 0) return text;
  const depth = Math.max(...headings.map((h) => h.level));
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const open = /^\s*(```+|~~~+)/.exec(line);
    if (fence !== undefined) {
      if (open !== null && open[1]!.startsWith(fence)) fence = undefined;
      out.push(line);
      continue;
    }
    if (open !== null) {
      fence = open[1]!.slice(0, 3);
      out.push(line);
      continue;
    }
    const head = /^(#{1,6})[ \t]/.exec(line);
    if (head !== null && head[1]!.length > depth) out.push(NO_NAV_MARKER);
    out.push(line);
  }
  return out.join("\n");
}

// The index: the chapter tree, in the order the document declares it, as links.
//
// This is where the ORDER lives, which is why the files carry no numbers. A
// reader opens this first and an assistant is pointed at it; both then follow a
// link rather than guessing which file a chapter is.
function index(
  data: SheetData,
  paths: Map<string, string>,
  lang: Lang,
  stamp: string | undefined,
  narrowed: string[] | undefined
): string {
  const title = data.metadata?.title ?? (lang === "ja" ? "パラメータシート" : "Parameter sheet");
  const out: string[] = [];
  // …and which LANGUAGE it was written in, beside the environments. Both are
  // narrowings of the model that decide what the set contains, and the paths
  // are one of them: a file is named by its sheet's own `display`, which is
  // resolved per language, so a reader checking the set against the model has
  // to project it the same way to know which files to expect. A set written
  // before this says nothing, and `verify` tries both spellings for it.
  if (stamp !== undefined)
    out.push(
      `<!-- review-sheet:model ${stamp}${narrowed === undefined || narrowed.length === 0 ? "" : ` instances=${narrowed.join(",")}`} lang=${lang} -->`,
      ""
    );
  out.push(`# ${title}`, "");

  const meta = data.metadata;
  if (meta?.project !== undefined || meta?.version !== undefined || meta?.generated_at !== undefined) {
    const label =
      lang === "ja"
        ? { project: "プロジェクト", version: "バージョン", at: "作成日時", item: "項目", value: "値" }
        : { project: "Project", version: "Version", at: "Generated", item: "Item", value: "Value" };
    // Markdown REQUIRES a header row, so a table written with empty ones opens
    // with a blank one — which reads as an index with a hole in it rather than
    // as a table that needs no heading.
    out.push(`| ${label.item} | ${label.value} |`, "| --- | --- |");
    if (meta.project !== undefined) out.push(`| ${label.project} | ${meta.project} |`);
    if (meta.version !== undefined) out.push(`| ${label.version} | ${meta.version} |`);
    if (meta.generated_at !== undefined) out.push(`| ${label.at} | ${meta.generated_at} |`);
    out.push("");
  }

  // What to do with this folder, before anything else in it.
  //
  // The recipient of a set like this has no toolchain and did not ask for one.
  // If it is not obvious in three lines what to edit, what to read it with, and
  // what NOT to touch, the folder loses to the spreadsheet it replaced — not on
  // any argument about formats, but because nobody could tell what it was for.
  out.push(
    ...(lang === "ja"
      ? [
          "## この文書の使い方",
          "",
          "- **直すのはこのフォルダの `.md`** です。AI に「この表のこの値を直して」と頼めます。",
          "- **読むのは `viewer.html`** です。ダブルクリックで開きます。",
          "- **`.md` を直したら、`viewer.html` の「フォルダを開く」から `sheet` フォルダを選んで**ください。直した内容が表示されます。",
          "  （ウィンドウへのドラッグでも入りますが、ファイルとして開いたページではブラウザが拒否することがあります。）",
          "- そのあと **「1ファイルで保存」** を押すと `sheet.html` が1枚できます。以後はそれを開くだけで、フォルダを選ぶ必要はありません。",
          "- `viewer.html` や `sheet.html` 自身を編集しても意味がありません。次に作り直した時点で消えます。",
          "",
        ]
      : [
          "## How to use this",
          "",
          "- **Edit the `.md` files in this folder.** You can ask an assistant to change a value in a table.",
          "- **Read it with `viewer.html`.** Double-click to open it.",
          "- **When you have edited the `.md`, press \"Open folder\" in `viewer.html` and choose the `sheet` folder.** It shows what you changed.",
          "  (Dragging the folder onto the window works too, but a page opened as a local file may have its drops refused by the browser.)",
          "- Then press **Save as one file** for a single `sheet.html`. Open that from then on — no folder, no dragging.",
          "- Editing `viewer.html` or `sheet.html` does nothing: the next rebuild replaces what they show.",
          "",
        ])
  );

  out.push(lang === "ja" ? "## 目次" : "## Contents", "");

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
export function stampOf(indexText: string): { stamp: string; instances?: string[]; lang?: Lang } | undefined {
  const m = /<!--\s*review-sheet:model\s+([0-9a-f]+)(?:\s+instances=([^\s>-]+))?(?:\s+lang=(ja|en))?\s*-->/.exec(indexText);
  if (m === null) return undefined;
  return {
    stamp: m[1]!,
    ...(m[2] === undefined ? {} : { instances: m[2].split(",") }),
    ...(m[3] === undefined ? {} : { lang: m[3] as Lang }),
  };
}

// A page that says its own name and nothing else.
//
// The one thing `verify --md` can hold a committed set to without forbidding
// the edits it exists for. The set is MEANT to be hand-maintained — a value
// corrected, a remark reworded, a row struck out — so nothing about its
// CONTENT can be compared with what this tool would write today. What is not
// an edit is a page losing everything: a sheet cut down to its heading, a
// document sheet that never carried its prose. Same rule `toMarkdownSet`
// applies at the writing end, read from the other side.
export const hasBody = (text: string): boolean => /\n\s*\S/.test(text.replace(/^#[^\n]*\n/, ""));
