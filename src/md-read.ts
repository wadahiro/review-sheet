// A written-out markdown set, read back as a document the viewer can render.
//
// This is the other half of the delivery. A recipient with no repository and no
// toolchain holds a folder of markdown, edits it (or has an assistant edit it),
// and then has to be able to LOOK at it — and markdown in a plain reader is a
// wall of pipe characters. The viewer already knows how to lay a markdown table
// out as the sheet it is (`document.mode: "sheet"`, html/md-sheet.ts), so what
// is missing is only the step that turns a folder into the shape it renders:
// chapters, sheets, and the text of each.
//
// The CHAPTERS come from the directory structure, not from the index. The index
// is prose somebody may reformat — and an assistant asked to tidy a document
// will — while the directories are where the files actually are. The index is
// read for one thing only: the ORDER, which nothing else carries.
//
// Pure: it is given the files, it does not read them.

import { markdownToCategories, declaredInstances, looksLikeParamSheet, renamedKeyColumns } from "./sheet-markdown.js";
import type { Lang } from "./html/i18n.js";
import type { ArtifactPreview } from "./types.js";

export type SetFile = { path: string; text: string };

export type ReadSet = {
  metadata: { title?: string };
  groups: { name: string; display: string; groups?: ReadSet["groups"] }[];
  sheets: {
    name: string;
    display: string;
    group?: string;
    instances: string[];
    categories: unknown[];
    // `mode: "sheet"` on a page whose markdown IS a parameter table, absent on
    // one that is prose — the viewer switches on exactly this, and a set holds
    // both kinds (see `looksLikeParamSheet`).
    document: { html: ""; markdown: string; mode?: "sheet" };
  }[];
  // Everything in the folder that is not a sheet: the rendered artifacts, the
  // authored sources, the collected evidence. Carried so a page that embeds the
  // set can OPEN them — a link into the folder resolves by itself while the
  // folder is there, and stops the moment the document is somewhere else.
  documents: { path: string; text: string }[];
  problems: string[];
};

const INDEX = "README.md";

// A page's links, rebased on the SET rather than on the page.
//
// Every address a sheet carries is written relative to the file it is in, which
// is what makes the markdown navigable in a plain reader. The viewer is one
// page for the whole set, so those addresses resolve against IT — off by
// exactly the sheet's own depth, and silently: the link is there, it looks
// right, and it opens nothing. Measured on a real set: every source link in
// every sheet below the top level.
//
// Rewritten on the way in, not at render: this is the step that knows where
// each page was, and the text is not written back anywhere.
export function rebase(markdown: string, dir: string): string {
  if (dir === "") return markdown;
  return markdown.replace(/\]\(([^)]+)\)/g, (whole, href: string) => {
    // A scheme, a root-relative path and a bare fragment are already absolute
    // against something that is not this page.
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/") || href.startsWith("#")) return whole;
    const [path = "", frag = ""] = href.split(/(#.*)$/);
    const parts = `${dir}/${decodeURI(path)}`.split("/");
    const out: string[] = [];
    for (const seg of parts) {
      if (seg === "" || seg === ".") continue;
      // A `..` with nothing left to pop CLIMBS OUT of the set, and is kept.
      // A set written inside the repository it describes is the ordinary case
      // — the addresses point at the real configuration, which is above it —
      // and swallowing the climb turned every one of them into a path inside
      // the set, pointing at nothing.
      if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push(seg);
    }
    return `](${encodeURI(out.join("/")).replace(/\(/g, "%28").replace(/\)/g, "%29")}${frag})`;
  });
}

// The title a page carries, which is what the reader has been calling this
// sheet — and the file name is only a filesystem's version of it. A page with
// no title at all is named by its file, which is the last thing left.
function titleOf(text: string, path: string): string {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path.replace(/\.md$/, "").split("/").pop() ?? path;
}

// The order the index states, as a list of paths. Read by following the links:
// what an entry SAYS can be reworded, what it points at is the file.
export function orderOf(indexText: string): string[] {
  const out: string[] = [];
  for (const m of indexText.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = m[1]!;
    if (/^[a-z][a-z0-9+.-]*:/.test(raw) || raw.startsWith("/")) continue;
    const at = decodeURI(raw.split("#")[0]!);
    if (at.endsWith(".md") && !out.includes(at)) out.push(at);
  }
  return out;
}

export function readMarkdownSet(files: SetFile[], lang: Lang = "ja"): ReadSet {
  const problems: string[] = [];
  const prose: string[] = [];
  const index = files.find((f) => f.path === INDEX || f.path.endsWith(`/${INDEX}`));
  // Everything else in the folder — the artifacts, the evidence — is carried,
  // not read as a sheet. A sheet is a `.md` that is not the index.
  const pages = files.filter((f) => f !== index && f.path.endsWith(".md"));
  if (pages.length === 0) problems.push("this folder holds no sheet — a set is an index and one .md per sheet");

  const order = index === undefined ? [] : orderOf(index.text);
  if (index === undefined) problems.push(`no ${INDEX}: the chapters are in the folders, but their order is not`);
  const rank = (p: string): number => {
    const at = order.indexOf(p);
    return at < 0 ? order.length : at;
  };
  const sorted = [...pages].sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path));

  // The chapters are the directories the sheets are in, named by their own
  // segments. Built from what is THERE rather than from what the index says
  // about it, so a reworded index still opens the document it is an index of.
  const groups: ReadSet["groups"] = [];
  const byPath = new Map<string, ReadSet["groups"][number]>();
  const chapterOf = (dirs: string[]): string | undefined => {
    let here: ReadSet["groups"] = groups;
    let key = "";
    for (const d of dirs) {
      key = key === "" ? d : `${key}/${d}`;
      let g = byPath.get(key);
      if (g === undefined) {
        g = { name: key, display: d };
        byPath.set(key, g);
        here.push(g);
      }
      g.groups ??= [];
      here = g.groups;
    }
    return key === "" ? undefined : key;
  };

  const sheets: ReadSet["sheets"] = [];
  const named = new Set<string>();
  for (const f of sorted) {
    const parts = f.path.split("/");
    const dirs = parts.slice(0, -1);
    const group = chapterOf(dirs);
    const display = titleOf(f.text, f.path);
    // The sheet's identity is its PATH: two chapters may well hold a sheet with
    // the same title (`Keycloak (realm)` in the design chapter and in the
    // migration one), and a name that collided would make them one sheet —
    // silently, since the second would simply overwrite the first.
    const name = f.path.replace(/\.md$/, "");
    if (named.has(name)) problems.push(`two files are at ${f.path}`);
    named.add(name);
    const markdown = rebase(f.text, dirs.join("/"));
    // A page is a parameter SHEET or it is PROSE, and the text says which
    // (`looksLikeParamSheet`). Read as a sheet, a document's tables become rows
    // and their headers become environments — measured on a real delivery, a
    // record `testdoc.ts` had written came back as about a thousand rows across
    // fourteen environments, each named after one of its own columns, while the
    // HTML rendered the same document as prose. Two halves of this tool
    // disagreeing about its own output, not a project doing anything unusual.
    // `mode` is what the viewer switches on, so it is what carries the answer.
    if (!looksLikeParamSheet(markdown)) {
      // Only the case where prose is the WRONG answer: a table that reads like
      // one of the projection's with its key column renamed. Ordinary prose
      // with ordinary tables is not remarked on — see `renamedKeyColumns`.
      for (const head of renamedKeyColumns(markdown)) prose.push(`${f.path} (${head})`);
      sheets.push({
        name,
        display,
        ...(group === undefined ? {} : { group }),
        instances: [],
        categories: [],
        // No `html`: nothing built this, so there is nothing rendered to carry.
        // The viewer renders the markdown itself when it finds one without the
        // other — the same renderer a markdown-backed sheet already brings.
        document: { html: "", markdown },
      });
      continue;
    }
    sheets.push({
      name,
      display,
      ...(group === undefined ? {} : { group }),
      instances: declaredInstances(markdown) ?? [],
      categories: markdownToCategories(markdown, declaredInstances(markdown) ?? [], lang) as unknown[],
      document: { html: "", markdown, mode: "sheet" },
    });
  }

  // Never silent where prose is the wrong answer: "this page has no rows" and
  // "this page's rows were not recognised" look identical on screen, and only
  // one of them is the document somebody wrote.
  for (const at of prose) {
    problems.push(
      `${at}: a table here has this projection's own columns but not its key column, so the page is read as prose and its rows are not rows. ` +
        `Name the first column 設定項目 (or Parameter) to have it read as a sheet.`
    );
  }

  // An empty chapter would be a heading in the tree with nothing under it. It
  // cannot arise from the directories — they are the directories sheets are in
  // — and is pruned anyway, because that is cheaper than finding out later.
  const prune = (gs: ReadSet["groups"]): ReadSet["groups"] =>
    gs.filter((g) => {
      g.groups = g.groups === undefined ? undefined : prune(g.groups);
      if (g.groups?.length === 0) delete g.groups;
      return sheets.some((s) => s.group === g.name) || (g.groups?.length ?? 0) > 0;
    });

  return {
    metadata: { ...(index === undefined ? {} : { title: titleOf(index.text, INDEX) }) },
    groups: prune(groups),
    sheets,
    documents: files.filter((f) => !f.path.endsWith(".md")).map((f) => ({ path: f.path, text: f.text })),
    problems,
  };
}

// The carried files, as documents the panel can show.
//
// WHICH kind each is, is read off the directory it is in — `artifacts`,
// `sources`, `evidence` — which is the same thing that put it there
// (`md-set.ts`). A file in none of them is still shown; what is unknown is only
// the sentence in the panel's header.
export function documentPreviews(documents: { path: string; text: string }[]): ArtifactPreview[] {
  return documents.map((d) => {
    const segs = d.path.split("/");
    const kind = segs.find((s) => s === "artifacts" || s === "sources" || s === "evidence");
    const under = kind === undefined ? [] : segs.slice(segs.indexOf(kind) + 1);
    // An evidence path names the environment and the host before the file.
    const observed =
      kind === "evidence" && under.length >= 2
        ? { host: under[1]!, at: "", instance: under[0]! }
        : undefined;
    return {
      // The PATH is the id, because that is what a link names — the panel is
      // opened by matching one against the other.
      id: d.path,
      sheet: "",
      source_file: under.length > 0 ? under.join("/") : d.path,
      nature: kind === "sources" ? ("source" as const) : kind === "evidence" ? ("observed" as const) : ("artifact" as const),
      ...(observed === undefined ? {} : { observed: { host: observed.host, at: observed.at }, instances: [observed.instance] }),
      lines: d.text.replace(/\n$/, "").split("\n").map((text) => ({ text, kind: "verbatim" as const })),
    };
  });
}
