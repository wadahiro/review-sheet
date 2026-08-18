// Document recipe: a sheet that is PROSE rather than a table of parameters.
//
// A parameter sheet is rarely the whole of what a review needs. The migration
// policy the values were chosen under, the acceptance procedure, the diagram
// the topology only makes sense against — these travel with the sheet or they
// travel as a second attachment nobody opens. This puts them in the same file,
// as an ordinary sheet: it takes a tab, sits in a group, and appears in the
// outline, because it is declared in `sheets:` alongside every other sheet and
// nothing downstream treats it specially except where it has no rows.
//
//   sheets:
//     - name: migration policy
//       recipe: document
//       file: docs/migration-policy.md
//       nav_depth: 3
//
// Images are EMBEDDED, not linked: the deliverable is one file that gets mailed
// around and opened from a local disk, so a relative `<img>` would be a broken
// icon the moment it left the checkout, and an absolute URL would make the
// document fetch from the network of whoever opened it. Both are refused here
// by failing the build rather than by rendering something subtly wrong — a
// missing diagram is exactly the kind of loss this tool exists to make loud.

import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type { SheetInputs } from "../assemble.js";
import { renderMarkdown, imageRefs } from "../markdown.js";

// By extension: the bytes are not sniffed. A file named `.png` that is not one
// is a broken document either way, and guessing from content would let it
// render as something the author did not write.
const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

const schema = {
  type: "object",
  required: ["file"],
  properties: {
    // The markdown, relative to the build spec. Image paths inside it are
    // relative to THIS file, the way every markdown editor already reads them.
    file: { type: "string" },
    // Heading levels the outline lists: 2 (the default) shows h1 and h2, 0
    // shows none. A cap rather than a hand-written list because the document
    // is edited far more often than the build spec, and a list would silently
    // stop matching the moment a heading was reworded.
    nav_depth: { type: "integer", minimum: 0, maximum: 6 },
  },
  additionalProperties: false,
};

// The directory part of a SPEC-RELATIVE path, as plain string math: an image is
// resolved against the markdown's own directory, and `io.resolve` does the rest.
// No path module — a recipe reaches the filesystem only through its injected
// I/O, and this is the one piece of that which is not I/O at all.
const dirOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i + 1);
};

const extOf = (href: string): string => {
  const clean = href.split(/[?#]/)[0];
  const i = clean.lastIndexOf(".");
  return i < 0 ? "" : clean.slice(i + 1).toLowerCase();
};

const toBase64 = (bytes: Uint8Array): string => {
  // `btoa` over a binary string: available in Bun and in every browser, and it
  // avoids importing Buffer into a module the browser build also parses.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
};

export const documentRecipe: SheetRecipe = {
  name: "document",
  schema,
  load(sheetSpec: Record<string, JsonValue>, io: RecipeIO): SheetInputs {
    const name = String(sheetSpec.name);
    const file = String(sheetSpec.file);
    const navDepth = typeof sheetSpec.nav_depth === "number" ? sheetSpec.nav_depth : undefined;

    const source = io.readFile(io.resolve(file));
    if (source === null) throw new Error(`document: sheet "${name}" — markdown file not found: ${file}`);

    const base = dirOf(file);
    const bad: string[] = [];
    const cache = new Map<string, { mime: string; base64: string }>();

    const load = (href: string): { mime: string; base64: string } | null => {
      const cached = cache.get(href);
      if (cached) return cached;
      // A remote reference cannot be embedded, and following it would defeat
      // the one property the output guarantees.
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
      const mime = MIME[extOf(href)];
      if (!mime) return null;
      const bytes = io.readBinary?.(io.resolve(base + href));
      if (!bytes) return null;
      const got = { mime, base64: toBase64(bytes) };
      cache.set(href, got);
      return got;
    };

    // Resolved BEFORE rendering, so every unusable reference is reported at
    // once rather than the build dying on the first one — the same reason
    // assembleSheets collects its category and binding failures.
    for (const href of imageRefs(source)) {
      if (!load(href)) bad.push(href);
    }
    if (bad.length > 0) {
      throw new Error(
        `document: sheet "${name}" (${file}) references ${bad.length} image(s) it cannot embed: ${bad.join(", ")}. ` +
          `The output is one self-contained file, so each must be a readable local path with a known image extension ` +
          `(${Object.keys(MIME).join(", ")}) — a remote URL cannot be embedded and would make the document fetch over the network when opened.`
      );
    }

    // Namespaced by the SHEET, because the ids have to be unique across the
    // whole document and a heading text is not: three sheets that each write
    // "## ツリー" would otherwise carry one id between them. Only the active
    // sheet's body is ever in the DOM, so it is not the body that breaks — the
    // outline lists every sheet's entries at once and marks the current one by
    // comparing ids, so one id shared by three entries lights all three.
    //
    // From the sheet's NAME, not its position: the name is the sheet's identity
    // (it is what a review target names), and a prefix keyed on the order
    // sheets happen to be declared in would re-point every heading anchor the
    // moment one is inserted above.
    const idPrefix = `rs-doc-${name.replace(/[^A-Za-z0-9\u00A0-\uFFFF]+/g, "-").replace(/^-+|-+$/g, "") || "sheet"}-`;
    const { html, headings } = renderMarkdown(source, load, { navDepth, idPrefix });

    // The source and the images travel with the rendered html, so a viewer
    // that lets someone edit the document can render what they typed. Every
    // image was already read to embed it, so this costs no extra I/O — and
    // omitting it would mean an edited document quietly losing its pictures.
    const images: Record<string, string> = {};
    for (const [href, img] of cache) images[href] = `data:${img.mime};base64,${img.base64}`;

    return {
      name,
      instances: io.instances,
      // The markdown this page was rendered from. It is a real file in the
      // project, so an edit made in the browser has somewhere to go back to —
      // exactly as a value edit goes back to its config file — and without the
      // path the change could only be reported, never acted on.
      sourceFile: io.resolve(file),
      layers: [],
      embedded: [],
      document: {
        html,
        markdown: source,
        ...(Object.keys(images).length > 0 ? { images } : {}),
        ...(headings.length > 0 ? { headings } : {}),
      },
    };
  },
};

registerRecipe(documentRecipe);
