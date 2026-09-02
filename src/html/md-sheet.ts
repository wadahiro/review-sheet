// A sheet whose model IS its markdown, laid out the way the sheet lays itself
// out.
//
// The difference from `DocumentBody` (markdown rendered as a page) is the whole
// point of full-edit mode: what the recipient maintains is text, but what they
// LOOK AT should be the parameter sheet they were given — the same columns in
// the same order, the same code face on a key, the same indent under a block.
// A markdown renderer produces a markdown table; this produces the sheet's.
//
// It reads only the text. There is no model behind it, so there is no origin,
// no dictionary, no review target — and no way for the page to disagree with
// what somebody typed, which is what makes the artifact maintainable by hand.

import { h, type VNode } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { parseMarkdownBlocks, tableShape, rowIsUnset, visibleRows, type MarkdownBlock } from "../sheet-markdown.js";
export { rowIsUnset, visibleRows } from "../sheet-markdown.js";
import { getMarkdownRenderer } from "./markdown-runtime.js";
import { navAnchorId, paramAnchorId } from "./anchors.js";
import { showCellTool, hideCellToolSoon } from "./cell-tool.js";
import type { Messages } from "./i18n.js";

const html = htm.bind(h);

// Inline markdown, for one cell.
//
// Its own renderer, deliberately: a cell is a name, a value or a sentence —
// code spans, emphasis, links — and handing each of a sheet's ~1500 cells to a
// full markdown parser costs more than it returns. Everything not recognised is
// escaped and shown as written, which is the only safe reading of text somebody
// typed.
const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPE[c]);

export function inlineMarkdown(text: string): string {
  const out: string[] = [];
  // Code spans first and whole: their content is literal, so nothing inside one
  // may be re-read as markup.
  for (const part of text.split(/(`[^`]*`)/g)) {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      out.push(`<code>${escapeHtml(part.slice(1, -1))}</code>`);
      continue;
    }
    out.push(
      escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        // A newline inside a cell was written as <br> by the projection and
        // escaped back to text on the way in; this is the display end of it.
        .replace(/\n/g, "<br>")
    );
  }
  return out.join("");
}

export type MarkdownSheetProps = {
  markdown: string;
  instances: string[];
  lang: "ja" | "en";
  sheetIndex: number;
  // Hidden environment columns, by name — the same control the sheet has.
  hiddenInstances: Set<string>;
  showDefaults: boolean;
  // Which model row each document row was written from, and how to open the
  // file a row's line lives in. Both optional: a row somebody wrote themselves
  // is in neither, and gets no affordance — the same rule the sheet follows for
  // a row no file has a line for.
  rowKeys?: Record<string, string>;
  sheetName?: string;
  artifact?: { idFor: (sheet: string, category: string, key: string) => string | undefined; open: (id: string, key: string) => void };
  // Open the editor at this section. The whole page is one text, so "edit this
  // part" is the editor opened at the line the part starts on — the reader
  // points at what they can see, rather than scrolling a thousand lines for it.
  onEditSection?: (headingLine: string) => void;
  t: Messages;
};

// The SAME ids the modelled sheet puts on its headings and rows (anchors.ts):
// the outline and the search palette are built from categories derived from
// this very text, and an id computed differently here is an entry that jumps
// nowhere.
const anchorId = (sheetIndex: number, path: string[]): string => navAnchorId(sheetIndex, path.join("/"));

// One table, with the header that follows it.
//
// Its own component because the following header is stateful — a ref on each
// half and a scroll listener between them — and a sheet has many tables. The
// mechanism is the sheet's own (`ParamTable`): a table that fits stays in flow
// and the CSS sticky header does the work; one wider than the viewport scrolls
// inside itself, where a CSS sticky header cannot follow, so the header is
// lifted out and kept aligned by hand.
function MarkdownTable({
  block,
  path,
  instances,
  lang,
  sheetIndex,
  hiddenInstances,
  showDefaults,
  rowKeys,
  sheetName,
  artifact,
  t,
}: {
  block: Extract<MarkdownBlock, { kind: "table" }>;
  path: string[];
  instances: string[];
  lang: "ja" | "en";
  sheetIndex: number;
  hiddenInstances: Set<string>;
  showDefaults: boolean;
  rowKeys?: Record<string, string>;
  sheetName?: string;
  artifact?: MarkdownSheetProps["artifact"];
  t: Messages;
}) {
  // Which leading columns stay put while the values scroll — the sheet's own
  // control, on the sheet's own classes. 1 is the key, 2 adds the description,
  // 3 adds the default.
  const [freeze, setFreeze] = useState(1);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);

  const shape = tableShape(block.head, instances, lang);
  const visibleValues = shape.values.filter((n) => !hiddenInstances.has(block.head[n]));
  // In the DOCUMENT's own order, and every column it has: which role a column
  // plays decides how it is styled, never whether it is shown. A column nobody
  // predicted is still a column somebody wrote.
  const roleOf = (n: number): string =>
    n === shape.key
      ? "rs-col-key"
      : n === shape.description
        ? "rs-col-description"
        : n === shape.default
          ? "rs-col-default"
          : shape.values.includes(n)
            ? "rs-col-value"
            : "rs-col-remarks";
  const columns = block.head
    .map((_, n) => n)
    .filter((n) => !shape.values.includes(n) || visibleValues.includes(n))
    .map((n) => ({ at: n, cls: roleOf(n) }));
  // Which rows are on screen. A row nobody set is hidden — but a row that HOLDS
  // others is not one of those: a block (`Unit`, `<Directory>`) has no value of
  // its own by nature, and hiding it would leave its contents indented under a
  // heading that is not there. Decided from the bottom up: a container stays
  // for as long as anything under it does.
  const visible = visibleRows(block.rows, shape.values, showDefaults);
  // Addresses are computed over the WHOLE table — a hidden row is still an
  // ancestor of the ones under it — and filtered afterwards.
  const addressed = rowAddresses(block.rows, [...path]);
  const rows = block.rows.map((r, n) => ({ row: r, address: addressed[n] })).filter((_, n) => visible[n]);

  const freezePos: Record<string, number> = { "rs-col-key": 1, "rs-col-description": 2, "rs-col-default": 3 };
  const maxFreeze = shape.description >= 0 ? 3 : 2;
  const effFreeze = Math.max(0, Math.min(freeze, maxFreeze));
  // A sheet with environments is wide by nature, and a wide table scrolls
  // inside itself — where a CSS sticky header has nothing to stick to. Same
  // condition the sheet uses.
  const splitHeader = instances.length > 0 && visibleValues.length > 0;

  // Both halves lay themselves out from the SAME widths — every column of a
  // split table has one (`--rs-w-*`), so nothing is left to share out and the
  // two cannot drift. Measuring one and writing the numbers onto the other was
  // tried first and is worse: it needs a layout pass to have happened, and a
  // header sized from a body column narrower than its own heading overflows
  // into the next column.

  // The lifted header follows the body's horizontal scroll.
  useEffect(() => {
    if (!splitHeader) return;
    const body = wrapperRef.current;
    const head = headRef.current;
    if (!body || !head) return;
    const sync = (): void => {
      head.scrollLeft = body.scrollLeft;
    };
    body.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => body.removeEventListener("scroll", sync);
  }, [splitHeader, effFreeze, rows.length]);

  if (rows.length === 0) return null;

  const headerRow = html`
    <tr>${columns.map((c) => {
      const pos = freezePos[c.cls];
      const label = block.head[c.at] ?? "";
      if (pos === undefined) return html`<th key=${c.at} class=${c.cls}>${label}</th>`;
      const frozen = effFreeze >= pos;
      return html`
        <th key=${c.at} class=${`${c.cls} ${frozen ? "rs-col-frozen" : ""}`}>
          <div class="rs-th-inner">
            <span>${label}</span>
            <button type="button" class=${`rs-pin ${frozen ? "rs-pin-on" : ""}`}
                    aria-pressed=${frozen} title=${frozen ? t.unfreezeColumnTip : t.freezeColumnTip}
                    onClick=${() => setFreeze(effFreeze === pos ? pos - 1 : pos)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill=${frozen ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
            </button>
          </div>
        </th>
      `;
    })}</tr>`;

  // What a cell SAYS, as text: the markdown taken off it. This is what a copy
  // yields, and what is compared against the default — the value as the table
  // means it, not as it is written.
  const plain = (cell: string): string =>
    cell
      .trim()
      .replace(/^`(.*)`$/s, "$1")
      .replace(/<br\s*\/?>/gi, "\n")
      .trim();

  const bodyRows = rows.map(({ row, address }, n) => {
    // The file this row's line is in, when the row is still one the model wrote
    // and the sheet has a preview holding its line.
    const modelKey = rowKeys?.[address];
    const previewId =
      modelKey === undefined || artifact === undefined || sheetName === undefined
        ? undefined
        : artifact.idFor(sheetName, path[0] ?? "", modelKey);
    return html`
      <tr key=${n} class="rs-param-row" id=${paramAnchorId(sheetIndex, path.join("/"), rowKey(address))}>
        ${columns.map((c) => {
          const text = plain(row.cells[c.at] ?? "");
          // The three statements the sheet's own value cells make, read off the
          // text: nothing is set here, it is set to what the default already
          // says, or it is a value of this project's own.
          const dflt = shape.default >= 0 ? plain(row.cells[shape.default] ?? "") : "";
          const state =
            c.cls !== "rs-col-value"
              ? ""
              : text === ""
                ? "rs-cell-unset"
                : text === dflt
                  ? "rs-same-as-default"
                  : "rs-changed";
          // Copying a value is worth as much here as on the sheet, and it is the
          // one cell action a document can offer: the floating toolbar is the
          // sheet's own (cell-tool.ts), told that copy is all there is.
          const hover = (e: Event): void =>
            showCellTool({
              rect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
              target: { sheet: sheetName ?? "" },
              field: "",
              effectiveValue: text,
              hasReview: false,
              canCopy: true,
              reviewEnabled: false,
              editEnabled: false,
              hasEdit: false,
              canDelete: false,
              rowDeleted: false,
              scroller: (e.currentTarget as HTMLElement).closest(".rs-table-wrapper"),
            });
          return html`
          <td key=${c.at} class=${`${c.cls} ${state}`}
              style=${c.cls === "rs-col-key" ? `--rs-block-depth:${row.indent}` : ""}
              onMouseEnter=${text === "" ? undefined : hover}
              onMouseLeave=${text === "" ? undefined : hideCellToolSoon}>
            ${/* An empty value cell claims nothing on its own, and what it
                  means here is something: nobody set this, so the product's
                  default applies — which the default column beside it states.
                  Left blank, "not set" and "set to nothing" read the same. */ ""}
            ${state === "rs-cell-unset"
              ? html`<span class="rs-unset-label">${t.usesDefault}</span>`
              : html`<span dangerouslySetInnerHTML=${{ __html: inlineMarkdown(row.cells[c.at] ?? "") }}></span>`}
            ${c.cls === "rs-col-key" && previewId !== undefined && html`
              <span class="rs-key-subline">
                <button class="rs-artifact-chip" title=${t.artifactOpen}
                        onClick=${(e: Event) => { e.stopPropagation(); artifact!.open(previewId, modelKey!); }}>
                  ${t.artifactTitle}
                </button>
              </span>
            `}
          </td>
        `;
        })}
      </tr>
    `;
  });

  // A split table is laid out from fixed widths on BOTH halves; an unsplit one
  // sizes to its content, as the sheet's own tables do.
  const cls = `rs-param-table rs-param-table-wide ${splitHeader ? "rs-param-table-fixed " : ""}rs-freeze-${effFreeze}`;
  return splitHeader
    ? html`
        <div class="rs-table-split">
          <div class="rs-sticky-head" ref=${headRef}>
            <table class=${cls}><thead>${headerRow}</thead></table>
          </div>
          <div class="rs-table-wrapper rs-split-body" ref=${wrapperRef}>
            <table class=${cls}><tbody>${bodyRows}</tbody></table>
          </div>
        </div>
      `
    : html`
        <div class="rs-table-wrapper" ref=${wrapperRef}>
          <table class=${cls}>
            <thead>${headerRow}</thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      `;
}

// The sheet's body: its sections, nested as the sheet nests them.
//
// Nested, not flat, because that is what the sheet's own layout rules read — a
// category's heading sticks below its parent's by `--rs-depth`, and a heading
// that is a SIBLING of its table sticks to nothing. The tree is rebuilt from
// the heading depths, which is the only structure a markdown document has.
export function MarkdownSheetBody({
  markdown,
  instances,
  lang,
  sheetIndex,
  hiddenInstances,
  showDefaults,
  rowKeys,
  sheetName,
  artifact,
  onEditSection,
  t,
}: MarkdownSheetProps) {
  const renderProse = getMarkdownRenderer();

  type Section = { path: string[]; depth: number; blocks: MarkdownBlock[]; children: Section[] };
  const root: Section = { path: [], depth: 0, blocks: [], children: [] };
  const stack: Section[] = [root];
  for (const block of parseMarkdownBlocks(markdown)) {
    if (block.kind === "heading") {
      // The first `#` is the sheet's own name — the page already carries it as
      // its heading, so repeating it would print the title twice.
      if (block.depth === 1) continue;
      const depth = Math.max(1, block.depth - 1);
      stack.length = Math.min(stack.length, depth);
      const parent = stack[stack.length - 1] ?? root;
      const section: Section = { path: [...parent.path, block.text], depth, blocks: [], children: [] };
      parent.children.push(section);
      stack.push(section);
      continue;
    }
    stack[stack.length - 1].blocks.push(block);
  }

  const renderBlocks = (section: Section) =>
    section.blocks.map((block, i) => {
      if (block.kind === "prose") {
        // Prose is a page's own writing and gets a page's renderer — a
        // paragraph, a list, a fenced block. Without one (a document built with
        // no markdown runtime) the text is shown as written rather than dropped.
        const rendered =
          renderProse === null
            ? null
            : renderProse(block.text, {}, { idPrefix: `rs-md-${sheetIndex}-${section.path.join("-")}-p${i}-` }).html;
        return rendered === null
          ? html`<p key=${i} class="rs-category-note">${block.text}</p>`
          : html`<div key=${i} class="rs-doc rs-md-prose" dangerouslySetInnerHTML=${{ __html: rendered }}></div>`;
      }
      if (block.kind !== "table") return null;
      return html`
        <${MarkdownTable} key=${i} block=${block} path=${section.path} instances=${instances} lang=${lang}
                          sheetIndex=${sheetIndex} hiddenInstances=${hiddenInstances} showDefaults=${showDefaults}
                          rowKeys=${rowKeys} sheetName=${sheetName} artifact=${artifact} t=${t} />
      `;
    });

  // Is there anything under this heading right now? A section whose rows are
  // all hidden — the "rows nobody set" filter — must go with them, heading and
  // all: a heading over nothing reads as a rendering fault, and the outline
  // (built from the same text, by the same rule) has already dropped it, so a
  // heading left here is one the outline cannot reach.
  const hasSomethingVisible = (section: Section): boolean =>
    section.blocks.some((b) =>
      b.kind === "prose"
        ? b.text.trim() !== ""
        : b.kind === "table"
          ? visibleRows(b.rows, tableShape(b.head, instances, lang).values, showDefaults).some(Boolean)
          : false
    ) || section.children.some(hasSomethingVisible);

  const renderSection = (section: Section, i: number): VNode | VNode[] | null => {
    if (!hasSomethingVisible(section)) return null;
    const Tag = section.depth <= 1 ? "h3" : section.depth === 2 ? "h4" : "h5";
    return html`
      <div key=${i} id=${anchorId(sheetIndex, section.path)}
           class=${`rs-category rs-depth-${section.depth}`} style=${`--rs-depth:${section.depth}`}>
        <div class="rs-category-header">
          ${/* The action goes INSIDE the heading, as the sheet's own does: the
                coloured bar IS the heading element, and a sibling beside it
                takes width from the bar — which then stops short of the button
                and reads as a bar somebody cut off. */ ""}
          <${Tag}>
            <span class="rs-cat-label">${section.path[section.path.length - 1]}</span>
            ${onEditSection !== undefined && html`
              <span class="rs-header-actions">
                <button class="rs-head-tool" title=${t.docEdit} aria-label=${t.docEdit}
                        onClick=${() => onEditSection(`${"#".repeat(section.depth + 1)} ${section.path[section.path.length - 1]}`)}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  <span class="rs-tool-label">${t.docEditShort}</span>
                </button>
              </span>
            `}
          </${Tag}>
        </div>
        ${renderBlocks(section)}
        ${section.children.map((child, n) => renderSection(child, n))}
      </div>
    `;
  };

  const out = html`
    <div class="rs-md-sheet">
      ${renderBlocks(root)}
      ${root.children.map((child, i) => renderSection(child, i))}
    </div>
  `;
  return out;
}

// The key the derived categories give this row: the chain of names, joined —
// see `markdownToCategories`. Taken off the address so the two cannot drift.
const rowKey = (address: string): string => address.slice(address.indexOf(" ") + 1);

// Every row's address: the heading path it is under, and the chain of names
// that leads to it. The same address `full-edit-apply.ts` computes over the
// model, which is what lets a document row find the row it was written from.
export function rowAddresses(rows: { indent: number; cells: string[] }[], path: string[]): string[] {
  const ancestors: string[] = [];
  return rows.map((row) => {
    const name = (row.cells[0] ?? "").trim().replace(/^`(.*)`$/s, "$1").trim();
    ancestors.length = Math.min(row.indent, ancestors.length);
    const chain = [...ancestors, name];
    ancestors[row.indent] = name;
    return `${path.join("/")} ${chain.join(".")}`;
  });
}
