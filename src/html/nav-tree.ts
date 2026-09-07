// The chapters of a document SET, beside the text rather than above it.
//
// A tab strip is right while a document is a handful of sheets: every one of
// them is visible at once, and picking one is a click. A delivery that carries
// requirements, design, build and test is fifty to a hundred and fifty sheets
// three or four chapters deep, and a strip of that many tabs is a menu nobody
// can see — the overflow button becomes the real navigation, which is a
// dropdown you have to search.
//
// So `nav: book` (types.ts) draws this instead: the declared group tree, the
// sheets under the chapters they belong to, and the current sheet's own
// headings under it. The tab strip is untouched and stays the default.
//
// Three rules decide most of what is here:
//
//   - Every entry is an `<a href="#n">`, not a div with a click handler. The
//     hash IS the document's state (the viewer has always keyed the active
//     sheet by it), so middle-click and ⌘-click open a second copy at the right
//     place, and a link somebody pastes lands where they were.
//   - Numbers are DERIVED from the declared order and used for display only.
//     Inserting a chapter moves every number after it; nothing links by number,
//     so nothing breaks.
//   - The tree always expands to the current sheet, whatever was collapsed by
//     hand. A jump that lands in a collapsed chapter shows no highlight, which
//     reads as a jump that missed.

import { html } from "htm/preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import type { SheetData, SheetGroupData } from "../prompt.js";
import type { Messages } from "./i18n.js";
import { pickLang } from "../types.js";

type Group = SheetGroupData;

// One line of the tree: a chapter or a sheet. Flat, in reading order, because
// that is also the order the arrow keys move in — a tree rendered from a nested
// structure and navigated from a flat one is two orders that can disagree.
export type TreeEntry = {
  kind: "group" | "sheet";
  name: string;
  // `${kind}:${name}` — what the tree refers to itself by. A group's name and a
  // sheet's name live in different namespaces and can be the same word, so a
  // containment list stated in bare names would hide one when the other was
  // collapsed.
  key: string;
  label: string;
  number: string;
  depth: number;
  // Sheets only: which sheet this is, for the hash and the highlight.
  index?: number;
  // Groups only: the names of every entry inside it, so collapsing hides them
  // and expanding to the current sheet knows what to open.
  contains?: string[];
  parent?: string;
};

// The tree as lines, numbered. A chapter's own sheets come FIRST, before its
// child chapters: that is the order a document is written in — an introduction,
// then the sections.
export function treeEntries(
  groups: Group[] | undefined,
  sheets: SheetData["sheets"],
  lang: "ja" | "en"
): TreeEntry[] {
  const out: TreeEntry[] = [];
  const label = (s: SheetData["sheets"][number]): string => pickLang(s.label, lang) ?? s.display ?? s.name;

  const walk = (list: Group[], prefix: number[], depth: number, parent: string | undefined, offset = 0): void => {
    list.forEach((g, i) => {
      const number = [...prefix, offset + i + 1];
      const at = out.length;
      out.push({
        kind: "group",
        name: g.name,
        key: `group:${g.name}`,
        label: pickLang(g.label, lang) ?? g.name,
        number: number.join("."),
        depth,
        contains: [],
        ...(parent === undefined ? {} : { parent: `group:${parent}` }),
      });
      let n = 0;
      for (const [index, s] of sheets.entries()) {
        if (s.group !== g.name) continue;
        n += 1;
        out.push({
          kind: "sheet",
          name: s.name,
          key: `sheet:${s.name}`,
          label: label(s),
          number: [...number, n].join("."),
          depth: depth + 1,
          index,
          parent: `group:${g.name}`,
        });
      }
      // The chapters inside it are numbered AFTER its own sheets: they share
      // one sequence, because a reader counts what is under the heading, not
      // what kind of thing each one is. Numbering them from 1 again gave a
      // sheet and a chapter the same number.
      walk(g.groups ?? [], number, depth + 1, g.name, n);
      // Everything that came out of this chapter, at any depth below it.
      out[at].contains = out.slice(at + 1).map((e) => e.key);
    });
  };

  if (groups === undefined || groups.length === 0) {
    // A document with no chapters is still a list, and still reads better as
    // one than as a strip once it is long.
    sheets.forEach((s, index) => out.push({ kind: "sheet", name: s.name, key: `sheet:${s.name}`, label: label(s), number: String(index + 1), depth: 0, index }));
    return out;
  }
  walk(groups, [], 0, undefined);
  // A sheet whose group is not in the tree would otherwise be in the document
  // and in no chapter — impossible while assemble checks both directions, and
  // listed here rather than dropped if it ever becomes possible.
  const placed = new Set(out.filter((e) => e.kind === "sheet").map((e) => e.index));
  sheets.forEach((s, index) => {
    if (placed.has(index)) return;
    out.push({ kind: "sheet", name: s.name, key: `sheet:${s.name}`, label: label(s), number: "", depth: 0, index });
  });
  return out;
}

// Where the reader is: the chapters above this sheet AND the sheet itself.
//
// The leaf was left out at first, reasoning from the top of a page — where the
// name is already in the tree and in the page's own heading, and a third copy
// says nothing. That is the wrong state to reason from. SCROLLED, the heading
// has gone by, the tree's highlight may be outside the tree's own scroll, and
// the sticky category headers name sections with no document above them: the
// one place still saying which document this is was the bar, and it was the
// one place not saying it.
//
// So the leaf is here, last and emphasized — and it survives a narrow window,
// since the crumbs give way from the left. The page's own heading stays where
// it is: it is what the PRINTER puts at the top of the page (the bar is not
// printed at all), it holds the sheet's own actions, and it is where a jump
// lands. Three places, three jobs — the tree says where in the set, the
// heading titles the page, and this says where you are right now.
export function chapterPath(
  groups: Group[] | undefined,
  sheets: SheetData["sheets"],
  activeSheet: number,
  lang: "ja" | "en",
  numbering: boolean
): string[] {
  const entries = treeEntries(groups, sheets, lang);
  const current = entries.find((e) => e.kind === "sheet" && e.index === activeSheet);
  if (current === undefined) return [];
  const name = (e: TreeEntry): string => (numbering && e.number !== "" ? `${e.number} ${e.label}` : e.label);
  return [...entries.filter((e) => e.kind === "group" && e.contains?.includes(current.key)).map(name), name(current)];
}

// Which chapters are open. Collapsing is the reader's, and remembered; the
// chapters that lead to where they are now are opened whatever they collapsed,
// because a highlight nobody can see is a jump that looks broken.
//
// Remembered PER DOCUMENT. Every copy of every generated file opened from a
// file:// URL shares one storage area, so a single key meant one document's
// collapsed chapters silently applied to the next one opened — and chapter
// names repeat across documents (`params`, `build`), so what it collapsed there
// was arbitrary. The same reasoning, and the same key, as the unsaved edits
// (app.ts's getStorageKey).
// The control, not a bullet. A text triangle at 0.65rem repeated down a hundred
// rows reads as punctuation somebody sprinkled over the panel — which is what a
// reader called it. One thin chevron, recessive until its row is under the
// pointer, TURNED rather than swapped: the rotation is what says the state
// changed, and it is the only motion in here.
const caret = (open: boolean): VNode => html`
  <svg class=${`rs-caret ${open ? "rs-caret-open" : ""}`} width="9" height="9" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
       aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
`;

const storeKey = (docKey: string): string => `rs-nav-collapsed:${docKey}`;

// What the reader has CLOSED — chapters and sheets alike. Everything is open
// until they close it, which is what a navigation pane does everywhere else
// (Word's shows every heading, expanded, and lets you fold what you do not
// want). Closed-by-default was tried for a sheet's own sections on the grounds
// that a hundred documents' headings would be a wall; measured on a real
// document set that is 339 rows, which is a scroll, not a wall — and the price
// of the other default was a click before you could see what a document
// contained.
type NavState = { closed: string[] };
const loadState = (docKey: string): NavState => {
  try {
    const raw = localStorage.getItem(storeKey(docKey));
    const got = raw === null ? null : (JSON.parse(raw) as { closed?: string[]; collapsed?: string[] } | string[]);
    if (Array.isArray(got)) return { closed: got };
    return { closed: got?.closed ?? got?.collapsed ?? [] };
  } catch {
    return { closed: [] };
  }
};
const saveState = (docKey: string, closed: Set<string>): void => {
  try {
    localStorage.setItem(storeKey(docKey), JSON.stringify({ closed: [...closed] }));
  } catch {
    /* a document opened from a file:// URL may have no storage */
  }
};

// The headings INSIDE the sheet a reader is on. The tree is one panel and shows
// one thing — where you are in the set, and where you are in the document — so
// there is no second list to explain, and no question of which one to use.
export type NavHeading = { sheetIndex: number; id: string; name: string; depth: number; current: boolean };

export function NavTree({ sheets, groups, activeSheet, numbering, lang, headings, filter, onFilter, docKey, onSelect, onJumpHeading, t }: {
  sheets: SheetData["sheets"];
  groups?: SheetData["groups"];
  activeSheet: number;
  numbering: boolean;
  lang: "ja" | "en";
  // Every sheet's own headings, in its own order. A sheet the reader is not on
  // shows them when they open it — without going there, which is the point:
  // seeing what is inside a document is not the same as reading it.
  headings: NavHeading[];
  // What the tree is filtered to. HELD BY THE PAGE, not by this component:
  // hiding the tree unmounts it, and a filter that a reader had to type again
  // every time they took the panel away and brought it back is a filter that
  // punishes them for using the space.
  filter: string;
  onFilter: (value: string) => void;
  // Which document this is, so one document's collapsed chapters are not
  // another's — see storeKey.
  docKey: string;
  onSelect: (idx: number) => void;
  onJumpHeading: (id: string) => void;
  t: Messages;
}): VNode {
  const entries = treeEntries(groups, sheets, lang);
  // One set: what the reader has closed. A chapter hides what is under it; a
  // sheet hides its own sections.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(loadState(docKey).closed));
  const bodyRef = useRef<HTMLElement | null>(null);

  // The chapters that lead to the current sheet, opened. Recomputed whenever
  // the sheet changes — including a jump from search into a chapter the reader
  // had collapsed, which is the case that reads as broken without this.
  useEffect(() => {
    const current = entries.find((e) => e.kind === "sheet" && e.index === activeSheet);
    if (current === undefined) return;
    const ancestors = entries.filter((e) => e.kind === "group" && e.contains?.includes(current.key)).map((e) => e.key);
    setCollapsed((prev) => {
      if (!ancestors.some((a) => prev.has(a))) return prev;
      const next = new Set(prev);
      for (const a of ancestors) next.delete(a);
      saveState(docKey, next);
      return next;
    });
  }, [activeSheet, sheets, groups]);

  // …and it is brought into view. With a hundred entries the current one is
  // often outside the panel's own scroll, and a jump from search then lands on
  // a highlight nobody can see — the same failure as landing in a collapsed
  // chapter, one scroll position further out.
  useEffect(() => {
    const el = bodyRef.current?.querySelector(".rs-navtree-current");
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [activeSheet, collapsed]);

  const hidden = (e: TreeEntry): boolean =>
    entries.some((g) => g.kind === "group" && collapsed.has(g.key) && g.contains?.includes(e.key));

  const needle = filter.trim().toLowerCase();
  const matches = (e: TreeEntry): boolean =>
    needle === "" ||
    e.label.toLowerCase().includes(needle) ||
    e.number.startsWith(needle) ||
    // A chapter stays while anything inside it matches, or filtering a tree
    // would show a result with no idea of where it is.
    (e.contains ?? []).some((k) => {
      const inside = entries.find((x) => x.key === k);
      return inside !== undefined && (inside.label.toLowerCase().includes(needle) || inside.number.startsWith(needle));
    });

  const shown = entries.filter((e) => matches(e) && (needle !== "" || !hidden(e)));

  const toggle = (name: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      saveState(docKey, next);
      return next;
    });

  // Arrow keys move, left/right close and open, Enter follows — the pattern a
  // tree is expected to answer to, over real links so the mouse keeps its own.
  const onKeyDown = (e: KeyboardEvent, at: number): void => {
    const move = (to: number): void => {
      e.preventDefault();
      const next = bodyRef.current?.querySelectorAll<HTMLElement>("[data-nav-row]")[to];
      next?.focus();
    };
    const entry = shown[at];
    if (e.key === "ArrowDown") move(Math.min(at + 1, shown.length - 1));
    else if (e.key === "ArrowUp") move(Math.max(at - 1, 0));
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(shown.length - 1);
    else if (e.key === "ArrowRight" && entry?.kind === "group" && collapsed.has(entry.key)) toggle(entry.key);
    else if (e.key === "ArrowLeft" && entry?.kind === "group" && !collapsed.has(entry.key)) toggle(entry.key);
    else if (e.key === "ArrowLeft" && entry?.parent !== undefined) {
      const parentAt = shown.findIndex((x) => x.key === entry.parent);
      if (parentAt >= 0) move(parentAt);
    }
  };

  return html`
    <aside class="rs-navtree" aria-label=${t.navOutline}>
      <div class="rs-navtree-head">
        <input class="rs-navtree-filter" type="search" value=${filter} aria-label=${t.navFilter}
               placeholder=${t.navFilter} onInput=${(e: Event) => onFilter((e.target as HTMLInputElement).value)} />
      </div>
      <nav class="rs-navtree-body rs-scroll-thin" ref=${bodyRef}>
        ${/* The front matter is NOT listed here. It was, for one round, because
              taking the tab strip away had left it unreachable — and then the
              path grew a root that goes there, from the sticky bar, which works
              with this panel hidden. Two entries to one page, under two
              different names, is the duplication this document keeps shedding.
              The tree lists the chapters and the documents in them. */ ""}
        ${shown.map((e, at) => {
          const current = e.kind === "sheet" && e.index === activeSheet;
          const open = !collapsed.has(e.key);
          // The sheet's own headings, shown unless the reader folded this sheet
          // — so what a document contains is visible without going to it. The
          // one being READ always shows them, whatever was folded, for the same
          // reason a jump opens the chapter it lands in.
          const mine = e.kind === "sheet" ? headings.filter((h) => h.sheetIndex === e.index) : [];
          const showHeadings = e.kind === "sheet" && (current || !collapsed.has(e.key));
          return html`
            <div key=${e.key} style=${`--rs-parent-depth:${e.depth}`}>
            <div class=${`rs-navtree-row rs-navtree-d${Math.min(e.depth, 4)} ${current ? "rs-navtree-current" : ""}`}
                 style=${`--rs-nav-depth:${e.depth}`}>
              ${/* The fold at the row's left, where every tree a reader has used
                    puts it — and the number as part of the NAME rather than in
                    a column of its own, which is how a word processor's
                    navigation pane shows a numbered heading. A column of
                    numbers is what put an empty gutter between the fold and its
                    subject; inline, the two questions "how deep" and "which
                    one" are answered by the indent and by the text, and nothing
                    is spent on a third device. */ ""}
              ${e.kind === "group" || mine.length > 0
                ? html`<button class="rs-navtree-caret"
                               aria-expanded=${e.kind === "group" ? open : showHeadings}
                               aria-label=${(e.kind === "group" ? open : showHeadings) ? t.navCollapse : t.navExpand}
                               onClick=${() => toggle(e.key)}>${caret(e.kind === "group" ? open : showHeadings)}</button>`
                : html`<span class="rs-navtree-caret" aria-hidden="true"></span>`}
              ${e.kind === "group"
                ? html`
                    <a class="rs-navtree-item rs-navtree-group" href=${`#${(entries.find((x) => x.kind === "sheet" && e.contains?.includes(x.key))?.index ?? 0) + 1}`}
                       data-nav-row tabIndex=${at === 0 ? 0 : -1}
                       onKeyDown=${(ev: KeyboardEvent) => onKeyDown(ev, at)}
                       onClick=${(ev: MouseEvent) => {
                         if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                         ev.preventDefault();
                         toggle(e.key);
                       }}>
                      <span class="rs-navtree-label">${numbering && e.number !== "" ? `${e.number} ${e.label}` : e.label}</span>
                    </a>
                  `
                : html`
                    <a class="rs-navtree-item" href=${`#${(e.index ?? 0) + 1}`}
                       data-nav-row tabIndex=${at === 0 ? 0 : -1}
                       aria-current=${current ? "page" : undefined}
                       onKeyDown=${(ev: KeyboardEvent) => onKeyDown(ev, at)}
                       onClick=${(ev: MouseEvent) => {
                         if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                         ev.preventDefault();
                         onSelect(e.index ?? 0);
                       }}>
                      <span class="rs-navtree-label">${numbering && e.number !== "" ? `${e.number} ${e.label}` : e.label}</span>
                    </a>
                  `}
            </div>
            ${showHeadings && mine.length > 0 && html`
              <div class="rs-navtree-headings">
                ${mine.map((h) => html`
                  <div class=${`rs-navtree-row rs-navtree-heading ${h.current ? "rs-navtree-here" : ""}`} key=${h.id}
                       ${/* Counted from the DOCUMENT, not from the panel: the
                             block already begins where the document's own name
                             does, so a section's depth is how far it sits
                             inside its document — capped, since a fourth-level
                             heading is still a heading of that document. */ ""}
                       style=${`--rs-nav-depth:${Math.min(h.depth, 3) - 1}`}>
                    <span class="rs-navtree-caret" aria-hidden="true"></span>
                    <a class="rs-navtree-item" href=${`#${(e.index ?? 0) + 1}`}
                       onClick=${(ev: MouseEvent) => {
                         if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                         ev.preventDefault();
                         onJumpHeading(h.id);
                       }}>
                      <span class="rs-navtree-label">${h.name}</span>
                    </a>
                  </div>
                `)}
              </div>
            `}
            </div>
          `;
        })}
        ${shown.length === 0 && html`<p class="rs-navtree-empty">${t.navNoMatch}</p>`}
      </nav>
    </aside>
  `;
}
