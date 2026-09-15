// A written-out markdown set, read back as a document the viewer can render.
//
// This is the other half of the delivery. A recipient with no repository and no
// toolchain holds a folder of markdown, edits it (or has an assistant edit it),
// and then has to be able to LOOK at it — and markdown in a plain reader is a
// wall of pipe characters. The viewer already knows how to draw such a page as
// the sheet it is — it lifts the text into the model and hands it to the
// sheet's own renderer (`liftMarkdownSheet`, `document.mode: "sheet"`) — so what
// is missing is only the step that turns a folder into the shape it renders:
// chapters, sheets, and the text of each.
//
// The CHAPTERS come from the directory structure, not from the index. The index
// is prose somebody may reformat — and an assistant asked to tidy a document
// will — while the directories are where the files actually are. The index is
// read for one thing only: the ORDER, which nothing else carries.
//
// Pure: it is given the files, it does not read them.

import { liftMarkdownSheet, declaredInstances, looksLikeParamSheet, renamedKeyColumns, parseSheetMarkdown, withoutDeployedPath, comparesComponents } from "./sheet-markdown.js";
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
    // Where this sheet's rows land, and how the page is read — both stated by
    // the page itself, so a set carries no number the reader cannot see.
    file_path?: string;
    compare_components?: boolean | "always";
    // `mode: "sheet"` on a page whose markdown IS a parameter table, absent on
    // one that is prose — the viewer switches on exactly this, and a set holds
    // both kinds (see `looksLikeParamSheet`).
    document: { html: ""; markdown: string; mode?: "sheet" };
  }[];
  // Everything in the folder that is not a sheet: the rendered artifacts, the
  // authored sources, the collected evidence. Carried so a page that embeds the
  // set can OPEN them — a link into the folder resolves by itself while the
  // folder is there, and stops the moment the document is somewhere else.
  //
  // `sheet` and `keys` are how a row gets its "show me this line in the file"
  // back. A set writes that address under the row's key; the lift takes it off
  // (it is not part of the key) and hands it here, so the artifact index can be
  // built over these documents exactly as it is over a model's previews — which
  // is what lets the sheet's own renderer draw the chip with nothing new told
  // to it. `keys` is by 1-based line, as the address names it.
  documents: { path: string; text: string; keys?: Record<number, string[]>; keyless?: string[] }[];
  problems: string[];
};

const INDEX = "index.md";
// What a set written before the split called its index. Recognised for as long
// as those sets exist: forgetting it would make one unreadable rather than
// merely out of date.
const LEGACY_INDEX = "README.md";

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

// WHICH file is the index — the one carrying the stamp, not the one wearing the
// name.
//
// A name is a convention and this set carries other people's files: the sources
// it hands over are harvested from real repositories, and a repository is
// exactly the kind of place that has a `README.md` in it. Resolved by name, the
// set's root would then be wherever that vendored file happened to be, decided
// by the order a folder picker enumerated — which is not a decision at all.
//
// The stamp is what a set actually asserts about itself (`md-set.ts`'s
// `index`), so it is what says "a set is here". The NAME is the fallback, for a
// set written before this and for one whose stamp a hand-edit removed.
const STAMPED = /<!--\s*(?:rs|review-sheet):model\s/;

function indexOf(files: SetFile[]): { index?: SetFile; many?: SetFile[] } {
  const stamped = files.filter((f) => f.path.endsWith(".md") && STAMPED.test(f.text));
  // TWO stamped indexes is a delivery inside a delivery, or a folder chosen
  // above several of them. Never guessed at: the two are different documents
  // and picking one silently shows a reader the wrong one.
  if (stamped.length > 1) return { many: stamped };
  if (stamped.length === 1) return { index: stamped[0] };
  const named = files.filter((f) => f.path === INDEX || f.path.endsWith(`/${INDEX}`) || f.path === LEGACY_INDEX || f.path.endsWith(`/${LEGACY_INDEX}`));
  // Shallowest wins where a name is all there is: a vendored one is inside the
  // set, and the set's own is at its root.
  const best = [...named].sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  return best === undefined ? {} : { index: best };
}

// The set's ROOT is the directory its index is in, and every path is read from
// there.
//
// Whoever is choosing a folder is a person, and the folder they mean is not
// always the one they pick: the delivery holds the page beside the set, so
// picking the level ABOVE is the obvious mistake and it did not look like one —
// the set read fine and quietly grew a chapter named after its own directory,
// which renumbered every chapter under it. A wrong document rather than a
// refusal, which is the failure this project spends most of its effort on.
//
// Named by nothing: whatever the directory is CALLED, the index is what says a
// set is there — a recipient is free to rename the folder, and one of them will.
function fromTheIndex(files: SetFile[], index: SetFile | undefined): SetFile[] {
  if (index === undefined) return files;
  const at = index.path.lastIndexOf("/");
  if (at < 0) return files;
  const root = index.path.slice(0, at + 1);
  // Anything outside it is not part of this set — a sibling of the folder that
  // was meant, which is exactly what picking the level above sweeps in.
  return files.filter((f) => f.path.startsWith(root)).map((f) => ({ ...f, path: f.path.slice(root.length) }));
}

export function readMarkdownSet(all: SetFile[], lang: Lang = "ja"): ReadSet {
  const problems: string[] = [];
  const prose: string[] = [];
  const found = indexOf(all);
  if (found.many !== undefined) {
    return {
      metadata: {},
      groups: [],
      sheets: [],
      documents: [],
      problems: [
        `this folder holds ${found.many.length} documents, not one — ${found.many.map((f) => f.path).join(", ")}. ` +
          `Choose the folder one of them is in.`,
      ],
    };
  }
  const files = fromTheIndex(all, found.index);
  // The same file, at its path within the set.
  const at = found.index?.path.lastIndexOf("/") ?? -1;
  const indexPath = found.index === undefined ? undefined : found.index.path.slice(at + 1);
  const index = indexPath === undefined ? undefined : files.find((f) => f.path === indexPath);
  // Everything else in the folder — the artifacts, the sources, the evidence —
  // is CARRIED, not read as a sheet.
  //
  // "A `.md` that is not the index" was the whole test, and the carried files
  // are other people's: a module handed over under `sources/` brings its own
  // `README.md`, and a config sample can be markdown. Read as a page, such a
  // file becomes a sheet the model does not have, filed under a chapter named
  // after the directory it was carried in — and it looks exactly like a sheet
  // somebody added. The three directory names are the same discriminator
  // `documentPreviews` below already reads a carried file's KIND from, so
  // nothing new decides it.
  const carriedFile = (path: string): boolean =>
    path.split("/").some((seg) => seg === "artifacts" || seg === "sources" || seg === "evidence");
  const pages = files.filter((f) => f !== index && f.path.endsWith(".md") && !carriedFile(f.path));
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
  // Which document each page's rows point into, and at which line — see
  // `ReadSet["documents"]`.
  // …from EVERY page that points into it. One file is one file here, and a
  // realm document is pointed into by seven sheets of one real delivery — so it
  // belongs to none of them in particular, and the index answers for any (see
  // `artifact-index.ts`).
  const keyed = new Map<string, { keys: Record<number, string[]>; keyless: string[] }>();
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
    // WHERE this sheet's rows land, lifted out of the page and into the field
    // the sheet's own heading shows it from. Left in the markdown it would be
    // read twice — as the page's subtitle and again as a paragraph of its body
    // — which is the one thing a page built from the model does not do.
    const deployed = parseSheetMarkdown(markdown, [], lang).file;
    const lifted = liftMarkdownSheet(markdown, declaredInstances(markdown) ?? [], lang);
    sheets.push({
      name,
      display,
      ...(group === undefined ? {} : { group }),
      ...(deployed === undefined ? {} : { file_path: deployed }),
      // …and how the page is READ, which the page says itself.
      ...(comparesComponents(markdown) === undefined ? {} : { compare_components: comparesComponents(markdown)! }),
      instances: declaredInstances(markdown) ?? [],
      categories: lifted.categories as unknown[],
      document: { html: "", markdown: deployed === undefined ? markdown : withoutDeployedPath(markdown), mode: "sheet" },
    });
    for (const { key, href } of lifted.addresses) {
      const [at = "", frag = ""] = decodeURI(href).split("#");
      const line = /^L(\d+)$/.exec(frag);
      const held = keyed.get(at) ?? { keys: {} as Record<number, string[]>, keyless: [] };
      // An address with no line: the row's only line is one this environment
      // does not render, and a carried file does not have those (md-set.ts). So
      // the document is the row's and has no line for it — which is a way into
      // the file, just not into a line of it.
      if (line === null) {
        if (!held.keyless.includes(key)) held.keyless.push(key);
        keyed.set(at, held);
        continue;
      }
      // EVERY row the line is, not the first of them. One line IS several rows
      // often enough to matter: a `count`ed resource writes one line that every
      // one of its copies is addressed by, and a directive holding two settings
      // is two rows — so first-wins left the second, third and fourth of them
      // with no way into the file. The model says the same thing with
      // `ArtifactLine.keys`; this is where a set says it.
      const at_ = Number(line[1]);
      held.keys[at_] = [...(held.keys[at_] ?? []), ...(held.keys[at_]?.includes(key) === true ? [] : [key])];
      keyed.set(at, held);
    }
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
    documents: files
      .filter((f) => f !== index && (!f.path.endsWith(".md") || carriedFile(f.path)))
      .map((f) => ({ path: f.path, text: f.text, ...(keyed.get(f.path) ?? {}) })),
    problems,
  };
}

// The carried files, as documents the panel can show.
//
// WHICH kind each is, is read off the directory it is in — `artifacts`,
// `sources`, `evidence` — which is the same thing that put it there
// (`md-set.ts`). A file in none of them is still shown; what is unknown is only
// the sentence in the panel's header.
export function documentPreviews(documents: ReadSet["documents"]): ArtifactPreview[] {
  return documents.map((d) => {
    const segs = d.path.split("/");
    const kind = segs.find((s) => s === "artifacts" || s === "sources" || s === "evidence");
    const under = kind === undefined ? [] : segs.slice(segs.indexOf(kind) + 1);
    // An evidence path names the environment and the host before the file.
    const observed =
      kind === "evidence" && under.length >= 2
        ? { host: under[1]!, at: "", instance: under[0]! }
        : undefined;
    // …and an artifact names WHICH ENVIRONMENTS before the file, always —
    // `common` when it is the same in all of them (md-documents.ts). That level
    // is the set's own bookkeeping and not part of the path the file lands on,
    // so the panel drops it: a reader opening `/etc/httpd/conf/httpd.conf`
    // should meet that name and not `common/etc/httpd/conf/httpd.conf`.
    const covers = kind === "artifacts" && under.length >= 2 ? under[0]! : undefined;
    const file = kind === "artifacts" && covers !== undefined ? under.slice(1) : under;
    return {
      // The PATH is the id, because that is what a link names — the panel is
      // opened by matching one against the other.
      id: d.path,
      // No sheet: a file in a folder belongs to whichever pages point into it,
      // which is often several — see `artifact-index.ts` for what the index
      // does with that.
      sheet: "",
      source_file: file.length > 0 ? file.join("/") : d.path,
      // …and which environments it covers, where the folder says so. `common`
      // covers every one, which is what carrying no list already means.
      ...(covers === undefined || covers === "common" ? {} : { instances: covers.split("+") }),
      ...(d.keyless === undefined || d.keyless.length === 0 ? {} : { keyless: d.keyless }),
      nature: kind === "sources" ? ("source" as const) : kind === "evidence" ? ("observed" as const) : ("artifact" as const),
      ...(observed === undefined ? {} : { observed: { host: observed.host, at: observed.at }, instances: [observed.instance] }),
      // The rows each line IS, where a page said so. This is what gives a row
      // back its "show me this line in the file" — the artifact index reads
      // exactly this from a model's previews, so nothing downstream of it has
      // to know which half of the delivery it is looking at.
      lines: d.text
        .replace(/\n$/, "")
        .split("\n")
        .map((text, i) => ({
          text,
          kind: "verbatim" as const,
          ...(d.keys?.[i + 1] === undefined ? {} : { key: d.keys[i + 1]![0]!, keys: d.keys[i + 1]! }),
        })),
    };
  });
}
