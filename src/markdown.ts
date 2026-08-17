// Markdown -> one self-contained HTML fragment, for a sheet that is a DOCUMENT
// rather than a table of parameters (recipes/document.ts).
//
// A pure core with its I/O injected, like every other stage here: it never
// reads a file. Resolving `![](diagram.png)` against the markdown's own
// directory, and turning it into bytes, is the caller's job — this module only
// says which hrefs it needs and what to do with what comes back.
//
// It runs at IMPORT time, not in the browser. That is what keeps the promise
// the rest of the tool makes: the model is self-contained, so `generate` still
// takes nothing but JSON and the viewer bundle carries no markdown parser.
// Every image is already bytes by the time the model exists.

import { Marked, type Tokens } from "marked";

export type DocHeading = {
  // 1..6, as written. Carried through so the outline can indent the way the
  // document reads rather than flattening every heading to one level.
  level: number;
  text: string;
  // The id baked into the rendered HTML. The outline resolves it with
  // getElementById, exactly as it does a category anchor.
  id: string;
};

export type RenderedDocument = {
  html: string;
  // ONLY the headings the outline is meant to show (see `navDepth`) — the model
  // then states what the navigation is, instead of restating a rule the viewer
  // would have to apply again and could apply differently.
  headings: DocHeading[];
};

// Reading one image the document references. `null` = not there; the caller of
// renderMarkdown decides what that means (documentRecipe fails the build).
export type ImageResolver = (href: string) => { mime: string; base64: string } | null;

export type MarkdownOptions = {
  // Heading levels listed in the outline: 2 = h1 and h2. 0 = none.
  navDepth?: number;
  // Prefix for the ids baked into headings. Only one sheet is ever rendered at
  // a time, so uniqueness within the document is enough; the prefix exists to
  // keep these out of the id space the parameter views use.
  idPrefix?: string;
};

// Raw HTML written inside the markdown, filtered to a display-only allowlist.
//
// The output of this tool is ONE file that gets mailed around and opened
// locally, so a tag from a document can reach the whole page: `position:fixed`
// covers the sheet, a stray `id` collides with a nav anchor, a `<script>` runs
// with the same rights as the viewer. None of that is what someone writing
// `<br>` in a table cell is asking for, and a table cell that needs a line
// break is the actual reason this is not simply escaped — GFM has no other way
// to write one, and these sheets are full of tables.
//
// Default-deny, on both tags and attributes: a tag not named here is escaped
// (shown, not run), and an attribute not named for its tag is dropped. `id`,
// `class` and `style` are deliberately absent from every list.
const ALLOWED_TAGS: Record<string, readonly string[]> = {
  br: [],
  img: ["src", "alt", "title", "width", "height"],
  abbr: ["title"],
  details: ["open"],
  summary: [],
  sub: [],
  sup: [],
  kbd: [],
  mark: [],
  small: [],
  s: [],
  u: [],
  del: [],
  ins: [],
};

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A src/href a self-contained file can honour: an inlined image, and nothing
// else. A remote URL is not merely unsupported — it would make the deliverable
// phone home when opened, from whatever network the reviewer is on.
const isInlineSrc = (v: string): boolean => v.startsWith("data:image/");

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function sanitizeFragment(raw: string, resolveImage: ImageResolver): string {
  return raw.replace(TAG, (whole, closing: string, rawName: string, attrs: string, selfClose: string) => {
    const name = rawName.toLowerCase();
    const allowed = ALLOWED_TAGS[name];
    if (!allowed) return escapeHtml(whole);
    if (closing) return `</${name}>`;

    const kept: string[] = [];
    ATTR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = ATTR.exec(attrs)) !== null) {
      const attr = m[1].toLowerCase();
      if (!allowed.includes(attr)) continue;
      const value = m[2] ?? m[3] ?? m[4] ?? "";
      if (attr === "src") {
        const inlined = inlineImage(value, resolveImage);
        if (!isInlineSrc(inlined)) return escapeHtml(whole);
        kept.push(`src="${escapeHtml(inlined)}"`);
        continue;
      }
      kept.push(m[2] === undefined && m[3] === undefined && m[4] === undefined ? attr : `${attr}="${escapeHtml(value)}"`);
    }
    return `<${name}${kept.length > 0 ? " " + kept.join(" ") : ""}${selfClose ? " /" : ""}>`;
  });
}

// An image reference becomes the image. A `data:` href is already inline and is
// left alone; anything else is asked of the resolver, and a resolver that says
// "not there" gets the href back unchanged so the CALLER can report which file
// is missing — this core has no business deciding whether that is fatal.
function inlineImage(href: string, resolveImage: ImageResolver): string {
  if (href.startsWith("data:")) return href;
  const got = resolveImage(href);
  return got ? `data:${got.mime};base64,${got.base64}` : href;
}

// Heading text for the outline: what a reader sees, with the inline markup
// taken off. Built from the tokens rather than by stripping the rendered HTML,
// so `## \`http-port\` の変更` lists as `http-port の変更` and not as markup.
function plainText(tokens: Tokens.Generic[] | undefined, fallback: string): string {
  if (!tokens || tokens.length === 0) return fallback;
  const out: string[] = [];
  const walk = (list: Tokens.Generic[]): void => {
    for (const tk of list) {
      const nested = tk.tokens as Tokens.Generic[] | undefined;
      if (nested && nested.length > 0) walk(nested);
      else if (typeof tk.text === "string") out.push(tk.text);
    }
  };
  walk(tokens);
  return out.join("").trim() || fallback;
}

// An id from the heading's own text. Non-ASCII is kept for the reason
// encodeIdPart (html/app.ts) keeps it: it is legal in an id, and these are
// resolved with getElementById rather than as a selector or a URL. A collision
// gets a counter, so two 「前提」 headings stay two entries that go to two
// places — the failure this tool exists to avoid, in miniature.
function slugify(text: string, taken: Map<string, number>, prefix: string, ordinal: number): string {
  const base = text.replace(/[\s/\\?#[\]@!$&'()*+,;=%"<>{}|^`~.:]+/g, "-").replace(/^-+|-+$/g, "");
  const stem = base.length > 0 ? base : `h${ordinal}`;
  const seen = taken.get(stem) ?? 0;
  taken.set(stem, seen + 1);
  return `${prefix}${stem}${seen > 0 ? `-${seen + 1}` : ""}`;
}

// A source line break between two Japanese characters is not a space.
//
// Markdown folds a single newline inside a paragraph into a space, which is
// right for English — the words either side of it need separating. Japanese
// does not separate words that way, so the same rule drops a space into the
// middle of a sentence, at whatever column the author's editor happened to
// wrap. The text then reads with a gap that is not in the source and breaks at
// a point nobody chose.
//
// So the newline is removed when both sides are CJK, and kept (becoming a
// space) otherwise — `もの。\nOS` keeps its space, because a Latin word set
// against Japanese does want one.
//
// Applied to TEXT tokens only: a fenced block, an inline code span and a raw
// HTML block are each their own token type, so none of them is touched.
const CJK = "\\u3000-\\u303F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFF60\\uFFE0-\\uFFE6";
const CJK_FOLD = new RegExp(`([${CJK}])\\n(?=[${CJK}])`, "g");

const foldCjkBreaks = (text: string): string => text.replace(CJK_FOLD, "$1");

export function renderMarkdown(source: string, resolveImage: ImageResolver, opts: MarkdownOptions = {}): RenderedDocument {
  const navDepth = opts.navDepth ?? 2;
  const idPrefix = opts.idPrefix ?? "rs-doc-";
  const headings: DocHeading[] = [];
  const taken = new Map<string, number>();
  let ordinal = 0;

  const marked = new Marked({ gfm: true });
  marked.use({
    // Before rendering, so the headings collected below see the same text the
    // page does — an outline entry and its heading must not differ by a space.
    walkTokens(token) {
      if (token.type === "text" && typeof token.text === "string") token.text = foldCjkBreaks(token.text);
    },
    renderer: {
      heading(token: Tokens.Heading): string {
        ordinal += 1;
        const text = plainText(token.tokens, token.text);
        const id = slugify(text, taken, idPrefix, ordinal);
        if (token.depth <= navDepth) headings.push({ level: token.depth, text, id });
        // The id goes on EVERY heading, not only the listed ones: search can
        // land on a heading the outline chose not to show, and an anchorless
        // heading would make that jump go nowhere.
        return `<h${token.depth} id="${escapeHtml(id)}">${this.parser.parseInline(token.tokens)}</h${token.depth}>\n`;
      },
      image(token: Tokens.Image): string {
        const src = inlineImage(token.href, resolveImage);
        const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}"${title} />`;
      },
      html(token: Tokens.HTML | Tokens.Tag): string {
        return sanitizeFragment(token.text, resolveImage);
      },
    },
  });

  const html = marked.parse(source, { async: false });
  return { html, headings };
}

// Every image href the document references, in order, so the caller can resolve
// them itself and report the ones it cannot find BEFORE anything is rendered.
// Separate from rendering because reporting is the caller's job and a core that
// threw here would decide that for it.
export function imageRefs(source: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (href: string): void => {
    if (href.startsWith("data:") || seen.has(href)) return;
    seen.add(href);
    out.push(href);
  };
  const marked = new Marked({ gfm: true });
  marked.use({
    walkTokens(token) {
      if (token.type === "image") add((token as Tokens.Image).href);
    },
  });
  marked.parse(source, { async: false });
  // Raw `<img>` never becomes an image token, so the same allowlist pass the
  // renderer applies has to be reflected here or a raw tag's file would go
  // unreported — the one silent gap this function exists to close.
  for (const m of source.matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    add(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}
