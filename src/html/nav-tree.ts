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
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
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

// Bring the current document into the panel — and only when NONE of it is
// there, so a reader who can see where they are is left where they put the
// panel.
//
// What counts as "where they are" is the document's whole BLOCK, its own row
// plus the sections under it, not the row alone. A reader reading the ninth
// section of a document has scrolled its title off the top of this panel on
// purpose; testing the row would call that lost and haul the panel back up, and
// the section they were actually looking at goes off the bottom in exchange —
// which is the same failure as not showing them anything, one step further on.
//
// Scrolled WITHIN the panel, never with scrollIntoView: that scrolls every
// ancestor that can move, the PAGE behind this one included — the outline
// drawer this replaced carries the same warning for the same reason.
//
// When it does move, it moves with ROOM. The obvious version travels the
// smallest distance that makes the row fit, which lands it hard against
// whichever edge it came from: the row is on screen and everything under it —
// the rest of its own chapter — is not. A third of the way down shows the row
// and what follows it, which is what somebody looking for their place reads.
const reveal = (body: HTMLElement, row: Element, asked = false): void => {
  const c = body.getBoundingClientRect();
  const block = (row.parentElement ?? row).getBoundingClientRect();
  if (!asked && block.bottom > c.top && block.top < c.bottom) return;
  const r = row.getBoundingClientRect();
  body.scrollTop = Math.max(0, body.scrollTop + r.top - c.top - c.height / 3);
};

// The arrow the edge marker carries: the same stroke as the fold's chevron, so
// the panel has one drawing vocabulary rather than a chevron and an arrow.
const arrow = (up: boolean): VNode => html`
  <svg class="rs-navtree-away-arrow" width="11" height="11" viewBox="0 0 24 24" fill="none"
       stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points=${up ? "6 15 12 9 18 15" : "6 9 12 15 18 9"} />
  </svg>
`;

// THE READER'S PLACE, as one row: the section being read when there is one and
// the document otherwise.
//
// One definition for both the marker and the button it is, or they disagree
// about what "your place" means — and they did. The marker was judged on the
// document's whole block, so a reader inside a long document could scroll the
// section they were reading right off the panel and be told nothing, because
// the title above it was still on screen; then the button, when it finally
// appeared, went to that title rather than to where they had been.
const placeRow = (body: HTMLElement): Element | null =>
  body.querySelector(".rs-navtree-here") ?? body.querySelector(".rs-navtree-current");

// The section the address names, or null when it names only a document.
const sectionOfAddress = (): string | null => {
  const raw = location.hash.replace("#", "");
  const slash = raw.indexOf("/");
  if (slash < 0) return null;
  try { return decodeURIComponent(raw.slice(slash + 1)) || null; } catch { return null; }
};

// The row that stands for a section id. Walked rather than selected, because
// these ids come from a document's own headings and carry whatever a heading
// carried — quotes, brackets, a slash — and a selector would have to escape
// them all correctly to find one row.
const rowFor = (body: HTMLElement, id: string): HTMLElement | null => {
  for (const row of body.querySelectorAll<HTMLElement>("[data-nav-id]")) {
    if (row.getAttribute("data-nav-id") === id) return row;
  }
  return null;
};

// As near the top as it goes — "as near" because the end of a list cannot reach
// it, and the browser clamps that for us.
const toTop = (body: HTMLElement, row: Element): void => {
  const r = row.getBoundingClientRect();
  const c = body.getBoundingClientRect();
  body.scrollTop = Math.max(0, body.scrollTop + r.top - c.top - 8);
};

const storeKey = (docKey: string): string => `rs-nav-collapsed:${docKey}`;

// What the reader has CLOSED — chapters and sheets alike. Everything is open
// until they close it, which is what a navigation pane does everywhere else
// (Word's shows every heading, expanded, and lets you fold what you do not
// want). Closed-by-default was tried for a sheet's own sections on the grounds
// that a hundred documents' headings would be a wall; measured on a real
// document set that is 339 rows, which is a scroll, not a wall — and the price
// of the other default was a click before you could see what a document
// contained.
//
// What is kept here is what the reader FOLDED, and nothing else. Where the
// panel is scrolled was kept too, for a while, and it was the wrong idea in the
// most ordinary way: it made the panel's position a second source of truth
// beside the address, and every load then had to arbitrate between them. Four
// rounds of that produced four different wrong answers. The address already
// says where the reader is; the panel is aimed at it, and there is nothing to
// reconcile.
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
const saveState = (docKey: string, patch: Partial<NavState>): void => {
  try {
    localStorage.setItem(storeKey(docKey), JSON.stringify({ ...loadState(docKey), ...patch }));
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
  // Which sheet the panel has already been moved FOR — see the effect that
  // brings the current row into view.
  const scrolledFor = useRef<number | null>(null);

  // Where the document being read has gone, when it is not on this panel:
  // "up" or "down", and null while any of it is in view. This is what lets the
  // panel STAY where the reader put it — the question "where am I" gets an
  // answer that costs them nothing, instead of an answer that moves the list
  // out from under them.
  const [away, setAway] = useState<"up" | "down" | null>(null);
  const checkAway = (): void => {
    const body = bodyRef.current;
    const row = body === null ? null : placeRow(body);
    if (body === null || row === null) { setAway(null); return; }
    const c = body.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    setAway(r.bottom <= c.top ? "up" : r.top >= c.bottom ? "down" : null);
  };

  // AIMED AT THE ADDRESS, once, before the first paint.
  //
  // The address already says where the reader is — the sheet, and the section
  // inside it (app.ts keeps `#<sheet>/<section>` current as they read). So the
  // panel puts that row as near the top as it goes, and there is nothing to
  // reconcile: no stored panel position to weigh against the address, no
  // reload-or-arrival to tell apart, nothing that a rebuild of the document can
  // invalidate. Four earlier rounds all failed in the same shape — a second
  // source of truth for where the reader is, and a rule for choosing between
  // the two — and each rule was right about one case and wrong about the next.
  //
  // A layout effect, because doing it after paint is a panel that starts at the
  // top and jumps.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body === null) return;
    const section = sectionOfAddress();
    const row = (section === null ? null : rowFor(body, section)) ?? body.querySelector(".rs-navtree-current");
    if (row !== null) toTop(body, row);
    scrolledFor.current = activeSheet;
    const watch = (): void => checkAway();
    body.addEventListener("scroll", watch);
    return () => body.removeEventListener("scroll", watch);
  }, [docKey]);

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
      saveState(docKey, { closed: [...next] });
      return next;
    });
  }, [activeSheet, sheets, groups]);

  // …and it is brought into view. With a hundred entries the current one is
  // often outside the panel's own scroll, and a jump from search then lands on
  // a highlight nobody can see — the same failure as landing in a collapsed
  // chapter, one scroll position further out.
  //
  // Once per sheet ARRIVED AT, which is not the same as once per run of this
  // effect. It has to run on a collapse too, since the row a jump lands on does
  // not exist until the chapters above it have opened — but a collapse is also
  // what a reader does by hand, and scrolling then is the panel refusing to
  // stay where it was put: fold a chapter at the end of a long set and the
  // panel jumps back to whatever is being read, every time.
  useEffect(() => {
    const body = bodyRef.current;
    const el = body?.querySelector(".rs-navtree-current");
    if (body === null || body === undefined || el === null || el === undefined) { setAway(null); return; }
    if (scrolledFor.current !== activeSheet) {
      scrolledFor.current = activeSheet;
      reveal(body, el);
    }
  }, [activeSheet, collapsed, filter]);

  // The marker answers for the panel AS IT NOW STANDS, and what it is about —
  // the section being read — changes as the reader scrolls the page, without
  // this panel being touched at all. Watching only the panel's own scroll left
  // it stale in exactly the case it exists for: the reader moves down the text,
  // the marked row moves with them, and nothing here noticed.
  const hereId = headings.find((h) => h.current)?.id ?? null;
  useEffect(() => { checkAway(); }, [hereId, activeSheet, collapsed, filter]);

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
      saveState(docKey, { closed: [...next] });
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
      <div class="rs-navtree-scroller">
      ${away !== null && html`
        <button class=${`rs-navtree-away rs-navtree-away-${away}`} title=${t.navHere} aria-label=${t.navHere}
                onClick=${() => {
                  const body = bodyRef.current;
                  if (body === null || body === undefined) return;
                  const el = placeRow(body);
                  if (el !== null) { reveal(body, el, true); checkAway(); }
                }}>
          ${arrow(away === "up")}
          <span class="rs-navtree-away-label">${t.navHere}</span>
        </button>`}
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
                       data-nav-id=${h.id}
                       ${/* Counted from the DOCUMENT, not from the panel: the
                             block already begins where the document's own name
                             does, so a section's depth is how far it sits
                             inside its document.
                             Capped at the FOURTH level, not the third. A test
                             record's sections are h4 — a component inside an
                             environment inside the results — and flattening
                             them onto their parent's indent said they were its
                             siblings, which is the one thing an outline is for.
                             Beyond four the panel is 19rem wide and the label
                             is what a reader needs, so the nesting stops
                             showing and the heading still gets its entry. */ ""}
                       style=${`--rs-nav-depth:${Math.min(h.depth, 4) - 1}`}>
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
      </div>
    </aside>
  `;
}
