// The viewer, plus a markdown renderer.
//
// A second entry point rather than a flag: this is the ONLY module that imports
// marked, so a document built from `app.ts` cannot carry it however the build
// is configured. generate.ts picks this entry when a sheet has an editable
// document — see markdown-runtime.ts for why the cost is worth avoiding
// elsewhere.

import { setMarkdownRenderer } from "./markdown-runtime.js";
import { renderMarkdown } from "../markdown.js";

// Images were embedded as data URIs at BUILD time, so they are in the html and
// not in the markdown. Re-rendering an edit resolves each reference against the
// map the build left behind; a reference the build never saw cannot be embedded
// here — there is no filesystem — and is dropped by the same rule that governs
// a remote URL.
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

import "./app.js";
