// The viewer, plus a markdown renderer.
//
// A second entry point rather than a flag: this is the ONLY module that imports
// marked, so a document built from `app.ts` cannot carry it however the build
// is configured. generate.ts picks this entry when a sheet's markdown IS the
// page (`mode: "sheet"`) and so must be rendered in the browser — see
// markdown-runtime.ts for why the cost is worth avoiding elsewhere.

import { setMarkdownRenderer } from "./markdown-runtime.js";
import { renderMarkdown } from "../markdown.js";

// Images were embedded as data URIs at BUILD time, so a reference resolves
// against the map the build left behind; one the build never saw cannot be
// embedded here — there is no filesystem — and is dropped by the same rule that
// governs a remote URL.
setMarkdownRenderer((source, images, opts) =>
  renderMarkdown(
    source,
    (href) => {
      const uri = images[href];
      if (uri === undefined) return null;
      const m = /^data:([^;]+);base64,(.*)$/.exec(uri);
      return m === null ? null : { mime: m[1], base64: m[2] };
    },
    opts
  )
);

// DYNAMIC, because a static import is HOISTED: written at the bottom of this
// file it still runs BEFORE the registration above, which is the whole point of
// this module. The app then renders its first document with no renderer in
// hand — and a markdown-backed sheet opens with its prose unrendered, until
// something else causes a re-render.
//
// Found while fixing the same mistake in app-mermaid.ts, where it was visible
// (no diagram at all). Here it was not: the tables look right, and only the
// paragraphs between them are wrong.
await import("./app.js");
