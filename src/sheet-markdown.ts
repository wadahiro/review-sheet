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
import type { Sheet, ColumnDefinition } from "./types.js";
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
  // Drawn to hold other rows, and nothing else. Carries the block's own PATH,
  // which is its identity — the heading shows the leaf, and several blocks can
  // share one. See where it is pushed.
  block?: string;
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
  // The WORD the address wears, when it is not the ordinary one. A document
  // nothing deploys is not a preview of anything — see html/i18n.ts's
  // `artifactTitle` — and the set must not call it one while the viewer does
  // not. Absent means the ordinary word for the document's language.
  previewWord?: string;
  // Three facts a table cannot state, written into the cell they are about as
  // an invisible comment (`cellMark`). All three are about the PRODUCT, never
  // about this installation's values — which is what makes them safe in a
  // document somebody maintains by hand: an edit to a value cannot make them
  // wrong, because they do not describe a value.
  //
  //   label     the product's own name for the setting, which the sheet shows
  //             above the key. 677 of one real delivery's 1557 rows have one.
  //   product   the documented default, when the DEFAULT COLUMN is showing the
  //             distribution's shipped value instead (`ParameterBase.baseline`)
  //             — two different facts that share one column, and the sheet
  //             compares the value against this one to decide whether anybody
  //             decided anything. Without it a value the project set read as
  //             "same as the default" and lost its mark.
  //   options   what the product CALLS each value (`ParamOption`), so a stored
  //             `1` still reads as "One Level".
  label?: string;
  product?: string;
  options?: { value: string; label: string }[];
  // …and three the table states AMBIGUOUSLY rather than not at all.
  //
  //   perEnv    this row holds a value PER ENVIRONMENT, and they happen to
  //             agree. One value repeated across every column is what a SHARED
  //             row looks like too, and the sheet marks a shared value with a
  //             border — so 168 rows of one real delivery wore a mark the model
  //             does not give them. Written only where they agree, because a
  //             row whose columns differ says it itself.
  //   absent    where this row has no value, the environment's FILE does not
  //             have the line — which is not the same as leaving it at the
  //             default, and the sheet says so in the cell.
  //   presence  the product's own word for "this is set", for a setting whose
  //             value IS its presence.
  perEnv?: true;
  absent?: true;
  // The product's own word for a setting whose value IS its presence. The
  // EMPTY string where the product has no word of its own but the row is still
  // one of those: the sheet then says it in its own words, and a row carrying
  // nothing at all reads as an ordinary `true`.
  presence?: string;
  // Where this row's default was READ, when a distribution's shipped file
  // supplied it rather than the product's documentation. The sheet prints it
  // beside the default, because a product's own documentation and the file a
  // distribution ships disagree often enough that a default with no source
  // reads as broken.
  defaultFrom?: string;
  // The grouping the sheet's own layout DISPLACED, kept on the row: a sheet
  // headed by the file its rows land in still shows the product's own grouping,
  // as sub-headings the page draws from this. 298 rows of one real delivery,
  // and without it four such headings simply were not there.
  subCategory?: string[];
  // The CONTROL this row is, resolved to one language — see `ParameterBase
  // .composite`. On the control's own row and nowhere else: it describes that
  // row, and the model repeats it on every field of the tuple only because a
  // field is where it is discovered. Written as one object because it IS one —
  // a name, a help line, which fields it writes and what each of its choices
  // writes into them — and there is no reading of that as a column.
  composite?: string;
  // Every value cell is empty and the row is NOT one nobody set: its value is
  // in an environment this document does not carry. A delivery narrowed to some
  // of them produces exactly this, and reports it — 5 rows of one real delivery
  // — and read back by the "all cells empty means nobody set it" rule those
  // rows disappeared from the page altogether.
  elsewhere?: true;
  // This row is unset because the VENDOR shipped the setting and this file
  // dropped it — not because nobody ever set it. The sheet keeps such a row on
  // the page (the absence IS the decision) while a row nobody set is behind a
  // toggle, and both are written with empty value cells, so the text alone
  // reads the first as the second and the row disappears.
  vendor?: true;
  // …and WHY this row is not being reviewed here, which is the project's own
  // decision and the one thing the sheet prints under a key that is not the
  // product's (`OutOfScope.reason`).
  outOfScope?: string;
  // …and WHO owns the thing excluded, where the exclusion names one. The sheet
  // prints it beside the reason, so carrying one without the other is half an
  // exclusion.
  outOfScopeOwner?: string;
};

// A heading and the rows under it. The heading path IS the category path, so
// moving a row between headings is how a reviewer says it belongs elsewhere.
export type MarkdownSection = {
  // What the headings SAY. The identity is `names`, one per level, and only
  // where it differs from what is said — see NAME_MARKER.
  path: string[];
  names?: (string | undefined)[];
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
  // WHERE this sheet's rows land on the host, when the sheet is about a
  // deployed file. Written as a lone code span under the title, which is the
  // same thing the sheet's own page shows under its heading — a set that left
  // it out made one document say two different things about itself depending
  // on whether it was opened from the model or read back out of a folder. Not
  // prose: a reader may write prose here, and a fact this projection is
  // responsible for must not be mixed into text nobody parses.
  file?: string;
  // Read side by side, one column per component — see COMPARE_MARKER.
  compare?: boolean | "always";
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
  // The address a row's key cell carries, and optionally the word on it (a
  // document nothing deploys is not a "preview" — see MarkdownRow.previewWord).
  preview?: (p: ParamData, categoryPath: string[]) => string | { href: string; word?: string } | undefined;
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
  // A CONTAINER is never blanked. Its "value" is the block's own argument —
  // `Directory` / `"/var/www"` — which is what the block IS, not a setting
  // anybody left unset, and the sheet shows it in the value column either way.
  // Blanked, it moved to the default column, where the same string reads as
  // something the product suggests.
  const blank = opts.markUnset === true && unset(p) && p.container === undefined;
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
  const label = lang(p.label, l);
  const options = (p.options ?? [])
    .map((o) => ({ value: o.value, label: lang(o.label, l) }))
    .filter((o) => o.label !== "" && o.label !== o.value);
  return {
    key: INDENT.repeat(depth) + cell(opts.indent === true ? leafKey(p) : p.key),
    values,
    ...(shared ? { shared: true as const } : {}),
    // The product's own name for the setting, and for each of its values. Only
    // where it differs from the key: the same string twice is one question, and
    // the sheet does not print it twice either.
    ...(label !== "" && label !== p.key ? { label } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(!shared && new Set(Object.values(values)).size <= 1 ? { perEnv: true as const } : {}),
    // …and never a CONTAINER, which has no value of its own by nature: a block
    // is not a row whose values went somewhere else.
    ...(p.container === undefined && !unset(p) && Object.values(values).every((v) => v === "")
      ? { elsewhere: true as const }
      : {}),
    ...(p.origin === "baseline" ? { vendor: true as const } : {}),
    ...(lang(p.out_of_scope?.reason, l) === "" ? {} : { outOfScope: lang(p.out_of_scope?.reason, l) }),
    ...(p.out_of_scope?.owner === undefined ? {} : { outOfScopeOwner: p.out_of_scope.owner }),
    ...(p.absent_where_unlisted === true ? { absent: true as const } : {}),
    ...(p.presence === true ? { presence: lang(p.presence_label, l) } : {}),
    ...(p.default_from === undefined ? {} : { defaultFrom: p.default_from }),
    ...(p.sub_category === undefined ? {} : { subCategory: p.sub_category }),
    // …and the documented default, when the column is showing the vendor's.
    // WHENEVER the column is showing the vendor's, even where the product
    // documents no default of its own: an empty marker still says which of the
    // two the column holds, and without it a value this project set to what the
    // distribution ships read as "the default, untouched".
    ...(p.baseline !== undefined ? { product: p.default ?? "" } : {}),
    default: cell(applies ?? ""),
    description: saysWhatItsControlSays(p, l) ? "" : lang(p.description, l),
    remarks: lang(p.remarks, l),
    ...(() => {
      if (opts.preview === undefined) return {};
      const at = opts.preview(p, path);
      if (at === undefined) return { preview: cell("") };
      const href = typeof at === "string" ? at : at.href;
      const word = typeof at === "string" ? undefined : at.word;
      return { preview: cell(href), ...(word === undefined ? {} : { previewWord: word }) };
    })(),
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
    // The control's HELP is not in here: it is the description cell of this very
    // row, and saying it twice is how one of the two starts being the stale
    // one — which is exactly what the row under it already avoids by leaving
    // its own description blank when the control's says the same thing.
    composite: JSON.stringify({
      control: pickLang(c.control, l) ?? "",
      of: c.of,
      modes: c.modes.map((m) => ({ label: pickLang(m.label, l) ?? "", values: m.values })),
    }),
    values,
    default: controlDefaultMode(group, l)?.label ?? "",
    description: pickLang(c.description, l) ?? "",
    remarks: "",
  };
}

// A field of a CONTROL whose help IS the control's own. The product has no help
// for the field — it has help for the thing an operator sets — so the control's
// line says it and the rows under it do not, exactly as the viewer does.
const saysWhatItsControlSays = (p: ParamData, l: Lang): boolean =>
  p.composite?.description !== undefined && pickLang(p.composite.description, l) === pickLang(p.description, l);

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
        // Structure, not a row the model has. A block whose opening carries no
        // argument is no decision of anybody's — the model states it only as
        // the INDENT of the rows inside it — but a table has no other way to
        // put those rows under something, so the projection draws the opening.
        // Read back without this, it came home as a row the model never had:
        // one per block, on every sheet whose rows sit in blocks.
        // …and WHICH block: three `<IfModule>` openings are three blocks and
        // one word, so the heading cannot be their identity. The rows inside
        // them are keyed by it, and without it the second and third block's
        // rows collided with the first's.
        block: b.path,
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
  const walk = (cats: CategoryData[] | undefined, path: string[], ids: (string | undefined)[]): void => {
    for (const c of cats ?? []) {
      // The heading says what the PAGE says. A component is free to be an alias
      // for something the reader knows by another name, and the sheet's own
      // heading shows that other name — so a page carrying the identity showed
      // the reader a word the same document does not use anywhere else.
      const shown = pickLang(c.label, l) ?? c.display ?? c.name;
      const here = [...path, shown];
      const named = [...ids, shown === c.name ? undefined : c.name];
      // …and the same path in IDENTITIES, which is what the caller resolves a
      // row's file by (`ProjectionOptions.preview` is answered per sheet and
      // per category, against the names the model uses). Handing it the
      // displayed path stopped three sheets of a real delivery finding their
      // files at all — every one of them a sheet whose components are named
      // for the reader rather than by their own key.
      const ids_ = here.map((x, n) => named[n] ?? x);
      // EVERY category, including one whose rows are all in its children. Its
      // heading is what makes the structure self-describing: without it a
      // nested category is written at a depth whose parent was never named, and
      // reading the document back cannot recover which level it was on.
      sections.push({
        path: here,
        ...(named.some((n) => n !== undefined) ? { names: named } : {}),
        rows: rowsOf(c.params ?? [], instances, l, ids_, opts),
        // The section's own paragraph, which is editable prose like a remark —
        // so it round-trips through this document rather than reading as
        // something the reviewer just wrote.
        prose: lang(c.note, l),
      });
      walk(c.categories, here, named);
    }
  };
  walk(sheet.categories, [], []);
  return {
    sheet: sheet.name,
    instances,
    lang: l,
    sections,
    ...(sheet.file_path === undefined ? {} : { file: sheet.file_path }),
    ...(sheet.compare_components === undefined || sheet.compare_components === false
      ? {}
      : { compare: sheet.compare_components }),
    prose: "",
  };
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
  // The deployed path stays the FIRST thing under the title: that is how it is
  // told apart from prose when the page is read back, and a marker written
  // between the two put it back into the body as a paragraph.
  if (doc.file) out.push(`\`${doc.file}\``, "");
  if (doc.compare !== undefined) out.push(compareMarker(doc.compare), "");
  if (doc.prose) out.push(doc.prose, "");
  for (const section of doc.sections) {
    const id = section.names?.[section.path.length - 1];
    if (id !== undefined) out.push(nameMarker(id));
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
          : `<br>[${row.previewWord ?? PREVIEW}](${(row.preview ?? "").replace(/\|/g, "\\|")})`;
      // The product's own words, after the address, so the reader that splits
      // the key off the address never sees them — they are taken out first.
      const about =
        (row.label === undefined ? "" : cellMark("label", row.label)) +
        (row.options ?? []).map((o) => cellMark("option", `${o.value}=${o.label}`)).join("") +
        (row.perEnv === true ? cellMark("perenv", "") : "") +
        (row.absent === true ? cellMark("absent", "") : "") +
        (row.elsewhere === true ? cellMark("elsewhere", "") : "") +
        (row.vendor === true ? cellMark("vendor", "") : "") +
        (row.block === undefined ? "" : cellMark("block", row.block)) +
        (row.outOfScope === undefined ? "" : cellMark("oos", row.outOfScope)) +
        (row.outOfScopeOwner === undefined ? "" : cellMark("oosowner", row.outOfScopeOwner)) +
        (row.presence === undefined ? "" : cellMark("presence", row.presence)) +
        (row.defaultFrom === undefined ? "" : cellMark("from", row.defaultFrom)) +
        (row.subCategory === undefined ? "" : cellMark("sub", row.subCategory.join(" / ")));
      const cells = [
        row.control === true
          ? `${indent}**${escapeCell(row.key.slice(indent.length))}**${row.composite === undefined ? "" : cellMark("composite", row.composite)}`
          : `${indent}\`${escapeCell(row.key.slice(indent.length))}\`${address}${about}`,
        ...(shown.description ? [escapeCell(row.description)] : []),
        escapeCell(row.default) + (row.product === undefined ? "" : cellMark("product", row.product)),
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

// A fact about the heading on the next line, written beside it.
//
// The same shape `markdown.ts`'s `rs:no-nav` uses, and for the same reason: a
// heading's IDENTITY is not its text — a project may name a component `alb` and
// call it 「SSO 公開エンドポイント」 on the page — and the set has to carry both
// or one of the two readings is wrong. The page used to carry the identity and
// show it, so a delivered sheet said `alb` where the same document built from
// the model said the name its author gave it.
//
// Beside the heading rather than in a table somewhere: it moves when the
// heading moves, a recipient renaming a section changes the words and leaves
// the identity alone, and there is no key to go stale. Invisible in every
// markdown reader, and it passes `sanitizeFragment` untouched (that rewrites
// TAGS).
//
// Written ONLY when the two differ, so a document whose headings are their own
// identity carries nothing at all.
const NAME_MARKER = /^\s*<!--\s*rs:name=(.*?)\s*-->\s*$/;

// ANY of this projection's markers, on a line of its own.
//
// Every reader of a page has to step over them, and one that does not is not
// merely ignoring a fact — it reads the line as PROSE, and prose reaches the
// page as the words it is. The general rule rather than one test per marker:
// the readers here were taught `rs:name` and a `rs:compare` written two lines
// later still landed in the lead, taking the deployed path into the same block
// and stopping THAT from being lifted. One rule, so a marker added later is
// stepped over by everything that predates it.
const MARKER_LINE = /^\s*<!--\s*rs:[^>]*-->\s*$/;
export const nameMarker = (name: string): string => `<!-- rs:name=${name} -->`;

// …and how this SHEET is read: side by side, one column per component, rather
// than as sections stacked down the page. A sheet that exists only to compare
// (`compare_components: "always"`) opens that way and has no stacked reading to
// return to, and the set carried the tables and not the choice — so ten sheets
// of one real delivery opened stacked, with an orientation toggle instead of
// the comparison they are for.
//
// At the top of the page, because it is about the whole page, and in the same
// spelling as every other fact this projection writes beside the thing it is
// about.
//
// TWO readings, because the model has two: a sheet that exists only to compare
// opens that way (`always`), and one that merely offers it keeps its stacked
// reading and puts a control on the heading. Carrying only the first left ten
// sheets of one real delivery opening stacked and two more without the control
// — the same fact, wrong in two different directions.
const COMPARE_MARKER = /^\s*<!--\s*rs:compare(?:=(always|offer))?\s*-->\s*$/m;
export const compareMarker = (how: boolean | "always"): string =>
  `<!-- rs:compare=${how === "always" ? "always" : "offer"} -->`;

export function comparesComponents(text: string): boolean | "always" | undefined {
  const m = COMPARE_MARKER.exec(text);
  if (m === null) return undefined;
  // A marker with no value predates the two spellings and meant `always`.
  return m[1] === "offer" ? true : "always";
}
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

// A fact about ONE CELL, written inside it.
//
// The same idea as the marker above a heading, where a heading is not what the
// fact is about. A row cannot have one written above it — a comment between two
// table rows ends the table — so it goes in the cell, invisible in any markdown
// reader and stripped before anything reads what the cell SAYS.
//
// That last part is why this is a comment rather than more text: the key cell's
// text is the row's identity, the string the copy button yields and the one a
// change set targets. The product's own name for the setting is a second thing
// to say about the row, and a cell saying two things is a cell that cannot be
// copied.
//
// `>` is encoded, because the value is inside `<!-- -->` and a `-->` in it would
// close the comment early; `|` is left to `escapeCell`, which every cell goes
// through and which the reader undoes before this runs.
const CELL_MARK = /<!--\s*rs:([a-z]+)=([^]*?)\s*-->/g;
export const cellMark = (kind: string, value: string): string =>
  `<!-- rs:${kind}=${escapeCell(value).replace(/>/g, "&gt;")} -->`;

export function cellMarks(cell: string): { text: string; marks: { kind: string; value: string }[] } {
  const marks: { kind: string; value: string }[] = [];
  CELL_MARK.lastIndex = 0;
  const text = cell.replace(CELL_MARK, (_whole, kind: string, value: string) => {
    marks.push({ kind, value: value.replace(/&gt;/g, ">") });
    return "";
  });
  return { text: text.trimEnd(), marks };
}

export function splitKeyCell(cell: string): { key: string; preview?: string; marks: { kind: string; value: string }[] } {
  const { text, marks } = cellMarks(cell);
  const m = PREVIEW_LINK.exec(text);
  if (m === null) return { key: text, marks };
  return { key: `${text.slice(0, m.index)}\``, preview: m[1], marks };
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
// …and, optionally, where each row said its line is. The address is written
// under the key (`md-set.ts`) and is taken OFF the key before the row is built,
// so it would be lost here — and it is the one thing the lifted model cannot
// otherwise recover: a page read back out of a folder has no source map, so
// without it every row loses its "show me this line in the file".
//
// Handed out through the SAME walk that decides the key rather than by a second
// pass, because a row's key is a chain over the rows above it — a second walk
// deriving it again is a second place for the two to disagree about which row
// an address belongs to.
export type RowAddress = { key: string; href: string };

// A control of the product's screen, as one page states it — see MarkdownRow's
// `composite`. Already resolved to the page's language, which is why it is not
// `ParameterBase["composite"]`: that one carries every language the model has.
type CompositeControl = {
  control: string;
  description?: string;
  of: string[];
  modes: { label: string; values: Record<string, string> }[];
};

export function markdownToCategories(text: string, instances: string[], l: Lang = "ja"): CategoryData[] {
  return liftMarkdownSheet(text, instances, l).categories;
}

// …and everything else the page says, in one walk.
//
// `lead` is the prose above the first heading. It used to be dropped, which was
// invisible while a second renderer drew these pages from the text — it showed
// the paragraph and nothing else knew it existed. With one renderer the model
// IS what is drawn, so anything the lift drops is gone from the page, and a
// paragraph somebody wrote under the title is exactly the kind of thing this
// project does not lose quietly.
//
// `columns` is the other half of not losing anything: a page may carry a column
// this projection has no field for — a recipient added one, or renamed the one
// it does have — and the sheet's own table shows what the MODEL says, so a
// column with nowhere to go would come out under another column's heading.
// Every table column past the first unrecognised one becomes a declared
// trailing column, carried on the rows as `extra`, which is the model's own way
// of saying "a column this document has and this tool did not predict".
export type LiftedSheet = {
  categories: CategoryData[];
  lead: string;
  addresses: RowAddress[];
  columns: ColumnDefinition[];
};

// A column's field name, from its heading. Stable, so the same heading on two
// tables of one page is one column rather than two that look alike.
const columnField = (head: string): string => `md:${head}`;

export function liftMarkdownSheet(text: string, instances: string[], l: Lang = "ja"): LiftedSheet {
  const addresses: RowAddress[] = [];
  const columns: ColumnDefinition[] = [];
  const lead: string[] = [];
  const root: CategoryData[] = [];
  const stack: CategoryData[] = [];
  const cols = instances.length > 0 ? instances : [""];
  const blocks = parseMarkdownBlocks(text);
  for (const block of blocks) {
    if (block.kind === "heading") {
      if (block.depth === 1) continue;
      const depth = Math.max(1, block.depth - 1);
      // The NAME is the identity — the anchors, the row addresses and a change
      // set all resolve through it — and `display` is what the page says. A
      // page carrying no marker is its own identity, which is every page
      // written before this and every heading a reader adds.
      const cat: CategoryData = { name: block.name ?? block.text, ...(block.name === undefined ? {} : { display: block.text }) };
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
      // One above the first heading belongs to the SHEET and has no category to
      // be a note of, so it is carried out separately rather than dropped.
      const into = stack[stack.length - 1];
      if (into === undefined) lead.push(block.text);
      else into.note = [into.note, block.text].filter(Boolean).join("\n\n");
      continue;
    }
    if (block.kind !== "table") continue;
    const shape = tableShape(block.head, instances, l);
    const into = stack[stack.length - 1];
    if (into === undefined) continue;
    const chain: string[] = [];
    // The control whose fields the rows below it are, until they are past.
    let control: CompositeControl | undefined;
    // …and what each step of it SAYS, which is not what it is.
    const shownChain: string[] = [];
    const params: ParamData[] = into.params ?? [];
    // Which rows nobody set, decided by the SAME rule the body hides by: a
    // container has no value of its own and must not be filed as unset while it
    // still holds something, or the outline and the page disagree about what
    // exists.
    const shown = visibleRows(block.rows, shape.values, false);
    // WHICH unclaimed column is the remarks one: the one wearing that heading,
    // in either language, and no other.
    const remarksAt = shape.rest.find(
      (at) => (block.head[at] ?? "").trim() === HEAD_BY_LANG.ja.remarks || (block.head[at] ?? "").trim() === HEAD_BY_LANG.en.remarks
    ) ?? -1;
    for (const [n, row] of block.rows.entries()) {
      // A control of the product's screen, not a parameter: it has no key, so
      // reading it as a row would put one the model does not have into every
      // read of a delivered set.
      const split = splitKeyCell((row.cells[0] ?? "").trim());
      if (isControlRow(cellMarks((row.cells[0] ?? "").trim()).text)) {
        // A CONTROL of the product's screen. Not a row — it has no key and
        // nothing the files hold — but it says what it is, and the rows under
        // it are what the reader came to see it above. Kept until they are
        // read, then put on each of them: that is where the model carries it,
        // because a field is where the control is discovered.
        const said = split.marks.find((m) => m.kind === "composite")?.value;
        const help = shape.description >= 0 ? (row.cells[shape.description] ?? "").trim() : "";
        control =
          said === undefined
            ? undefined
            : { ...(JSON.parse(said) as CompositeControl), ...(help === "" ? {} : { description: help }) };
        continue;
      }
      const shownName = split.key.replace(/^`(.*)`$/s, "$1").trim();
      // A block's IDENTITY is its path and its heading is the leaf of it: three
      // `<IfModule>` openings are three blocks and one word. Every other row is
      // its own identity.
      const blockPath = split.marks.find((m) => m.kind === "block")?.value;
      const name = blockPath !== undefined && blockPath !== "" ? blockPath : shownName;
      // The product's own words, taken back off the cells they were written
      // into. `label` shows above the key; `option` names a value; `product` is
      // the documented default, which means the column beside it is showing the
      // vendor's shipped value instead — see `cellMark`.
      const label = split.marks.find((m) => m.kind === "label")?.value;
      const options = split.marks
        .filter((m) => m.kind === "option")
        .map((m) => ({ value: m.value.slice(0, m.value.indexOf("=")), label: m.value.slice(m.value.indexOf("=") + 1) }))
        .filter((o) => o.value !== "");
      const dflt = shape.default >= 0 ? cellMarks(row.cells[shape.default] ?? "") : { text: "", marks: [] };
      const product = dflt.marks.find((m) => m.kind === "product")?.value;
      const has = (kind: string): boolean => split.marks.some((m) => m.kind === kind);
      const presence = split.marks.find((m) => m.kind === "presence")?.value;
      chain.length = Math.min(row.indent, chain.length);
      chain[row.indent] = name;
      shownChain.length = Math.min(row.indent, shownChain.length);
      shownChain[row.indent] = shownName;
      const values = shape.values.map((n) => (row.cells[n] ?? "").trim());
      const names = shape.values.map((n) => block.head[n]);
      // One value across every column is a SHARED row — unless the page says
      // this row holds one per environment and they merely agree, which is the
      // one case the table states ambiguously. Re-checked against the values
      // rather than believed: an edit that makes two columns differ makes the
      // row per-environment whatever the marker said, so a stale marker cannot
      // outlive the edit that stales it.
      const same = new Set(values).size <= 1 && !has("perenv");
      const key = chain.slice(0, row.indent + 1).join(".");
      if (split.preview !== undefined) addresses.push({ key, href: split.preview });
      // A block the projection drew so its contents could sit under something
      // is not a row: it is already in the chain above, which is what the rows
      // inside it are named and indented by.
      if (has("block")) continue;
      // The blocks this row sits in, and whether it IS one. The document says
      // both with its indent: the rows above it at shallower indents are the
      // blocks, and a row something is indented UNDER is a block itself. The
      // sheet's own renderer reads exactly these two fields to indent a row and
      // to show it by its leaf — without them a nested row came out at the left
      // margin wearing its whole dotted address, which is the redundancy the
      // block rows exist to remove.
      const holds = (block.rows[n + 1]?.indent ?? 0) > row.indent;
      // Every other column, under its OWN heading rather than under the
      // remarks one. The first unclaimed column used to become remarks
      // whatever it was called, which reads as this tool renaming a column
      // somebody wrote — and then two of them would have collided in it.
      let extra: Record<string, string> | undefined;
      for (const at of shape.rest) {
        if (at === remarksAt) continue;
        const head = (block.head[at] ?? "").trim();
        const text = (row.cells[at] ?? "").trim();
        if (head === "") continue;
        if (!columns.some((c) => c.field === columnField(head))) columns.push({ field: columnField(head), header: head });
        if (text === "") continue;
        extra = { ...extra, [columnField(head)]: text };
      }
      params.push({
        key,
        // …with the block's own NAME on each step. The sheet draws a heading
        // for a block whose row is not on screen and takes the words from
        // there, so a step carrying only a path drew an empty one — a heading
        // with nothing in it, above rows that need it to say which block they
        // are in.
        ...(row.indent > 0
          ? { container_path: chain.slice(0, row.indent).map((p, i) => ({ path: p, name: shownChain[i] ?? p })) }
          : {}),
        ...(holds ? { container: { name } } : {}),
        // Named by the column's own header: which environments a table carries
        // is the table's business, and a name read off a list somewhere else
        // would put a value under the wrong one the moment they differ.
        ...(names.some((n) => n !== "") && !same
          ? {
              // An environment with NOTHING in its cell is not in the list at
              // all when the row says its absence is the FILE's — "this
              // environment does not have the line" and "this environment
              // leaves it at the default" are two different facts, and an
              // empty entry states the second about the first.
              instances: names
                .map((name, i) => ({ name, value: values[i] ?? "" }))
                .filter((x) => !has("absent") || x.value !== ""),
            }
          : { value: values[0] ?? "" }),
        // What the column SHOWS is the vendor's shipped value when a documented
        // default came with it, and the documented default otherwise — the two
        // share one column on the sheet, and which of them is in it is what
        // decides the column's own heading and whether a value counts as set.
        ...(dflt.text.trim() === ""
          ? {}
          : product === undefined
            ? { default: dflt.text.trim() }
            : { baseline: dflt.text.trim(), ...(product === "" ? {} : { default: product }) }),
        ...(shape.description >= 0 && (row.cells[shape.description] ?? "").trim() !== ""
          ? { description: (row.cells[shape.description] ?? "").trim() }
          : {}),
        ...(remarksAt >= 0 && (row.cells[remarksAt] ?? "").trim() !== ""
          ? { remarks: (row.cells[remarksAt] ?? "").trim() }
          : {}),
        ...(label === undefined ? {} : { label }),
        ...(options.length === 0 ? {} : { options }),
        ...(has("absent") ? { absent_where_unlisted: true as const } : {}),
        ...(presence === undefined
          ? {}
          : { presence: true as const, ...(presence === "" ? {} : { presence_label: presence }) }),
        ...(split.marks.find((m) => m.kind === "from") === undefined
          ? {}
          : { default_from: split.marks.find((m) => m.kind === "from")!.value }),
        ...(split.marks.find((m) => m.kind === "sub") === undefined
          ? {}
          : { sub_category: split.marks.find((m) => m.kind === "sub")!.value.split(" / ") }),
        ...(control === undefined || !control.of.includes(key) ? {} : { composite: control }),
        ...(extra === undefined ? {} : { extra }),
        // Nothing is set here: the document says so by leaving every value cell
        // empty, and this is that fact in the shape the viewer knows it by.
        // Nothing is set here: the document says so by leaving every value cell
        // empty, and this is that fact in the shape the viewer knows it by —
        // unless the row says its values are in an environment this document
        // does not carry, which looks identical and is not the same thing.
        ...(has("vendor")
          ? { origin: "baseline" as const }
          : shown[n] || has("elsewhere")
            ? {}
            : { origin: "default" as const }),
        ...(split.marks.find((m) => m.kind === "oos") === undefined
          ? {}
          : {
              out_of_scope: {
                reason: split.marks.find((m) => m.kind === "oos")!.value,
                ...(split.marks.find((m) => m.kind === "oosowner") === undefined
                  ? {}
                  : { owner: split.marks.find((m) => m.kind === "oosowner")!.value }),
              },
            }),
      } as ParamData);
    }
    into.params = params;
  }
  return { categories: root, lead: lead.join("\n\n"), addresses, columns };
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
  // `name` is the heading's IDENTITY when it is not its text — see NAME_MARKER.
  | { kind: "heading"; depth: number; text: string; name?: string; line: number }
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
  // The identity the NEXT heading carries, when a marker states one. Never
  // prose: rendered as prose it would reach the page as text, since a category
  // note is shown as the words it is rather than as markup.
  let named: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (MARKER_LINE.test(lines[i])) {
      const marker = NAME_MARKER.exec(lines[i]);
      if (marker !== null) named = marker[1];
      continue;
    }
    const h = HEADING.exec(lines[i]);
    if (h) {
      flush();
      out.push({ kind: "heading", depth: h[1].length, text: h[2], ...(named === undefined ? {} : { name: named }), line: i + 1 });
      named = undefined;
      continue;
    }
    named = undefined;
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
// A lone code span on a line of its own — what `renderSheetMarkdown` writes the
// deployed path as.
const DEPLOYED_PATH = /^`([^`\n]+)`$/;

// …and the same page with that line taken out, for a reader that shows the
// field itself. Only the one this projection wrote: the first lone code span
// under the title, and nothing else.
export function withoutDeployedPath(text: string): string {
  return text.replace(/^(#[^\n]*\n\n)`[^`\n]+`\n\n/, "$1");
}

export function parseSheetMarkdown(text: string, instances: string[], l: Lang = "ja"): MarkdownSheet {
  const lines = text.split("\n");
  const doc: MarkdownSheet = { sheet: "", instances, lang: l, sections: [], prose: "" };
  const cols = instances.length > 0 ? instances : [""];
  let path: string[] = [];
  let section: MarkdownSection | null = null;
  let prose: string[] = [];

  const flushProse = (): void => {
    const text = prose.join("\n").replace(/^\n+|\n+$/g, "");
    // The line under the title, when it is a lone code span and nothing has
    // been read yet: that is where this projection writes the deployed path,
    // so it is read back as the FIELD rather than left in the prose for the
    // reader to meet twice — once as the page's own subtitle and once as a
    // paragraph of its body.
    const only = DEPLOYED_PATH.exec(text);
    if (only !== null && section === null && doc.file === undefined && doc.prose === "") {
      doc.file = only[1];
      prose = [];
      return;
    }
    if (section) section.prose = [section.prose, text].filter(Boolean).join("\n\n");
    else doc.prose = [doc.prose, text].filter(Boolean).join("\n\n");
    prose = [];
  };

  // The identity the next heading carries, when a marker states one. Kept out
  // of the prose for the same reason `parseMarkdownBlocks` keeps it out.
  let named: string | undefined;
  let names: (string | undefined)[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (MARKER_LINE.test(line)) {
      const marker = NAME_MARKER.exec(line);
      if (marker !== null) named = marker[1];
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flushProse();
      const depth = h[1].length;
      if (depth === 1 && doc.sheet === "") {
        doc.sheet = h[2];
        section = null;
        named = undefined;
        continue;
      }
      // Heading depth 2 is the top category level (the renderer writes
      // `path.length + 1`), so the path is the stack cut to this depth.
      path = [...path.slice(0, depth - 2), h[2]];
      names = [...names.slice(0, depth - 2), named];
      section = {
        path: [...path],
        ...(names.some((n) => n !== undefined) ? { names: [...names] } : {}),
        rows: [],
        prose: "",
      };
      named = undefined;
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
  preview?: (p: ParamData, categoryPath: string[]) => string | { href: string; word?: string } | undefined,
  title?: string
): string {
  const doc = toMarkdownSheet(sheet as unknown as SheetData["sheets"][number], lang, {
    indent: true,
    markUnset: true,
    ...(preview === undefined ? {} : { preview }),
  });
  return renderSheetMarkdown(title === undefined || title === doc.sheet ? doc : { ...doc, title });
}
