// The viewer, plus a markdown renderer, plus a diagram renderer.
//
// A third entry point rather than a flag, for the reason app-md.ts is a second
// one: this is the ONLY module that imports mermaid, so a document built from
// either other entry cannot carry it however the build is configured. It
// includes the markdown renderer too — a document that draws a diagram is one
// somebody may edit, and 43 KB beside 3.3 MB is not a distinction worth a
// fourth entry.
//
// generate.ts picks this entry when a document actually draws something; see
// mermaid-runtime.ts for why the cost is worth avoiding elsewhere.

import mermaid from "mermaid";
import { setMermaidRunner } from "./mermaid-runtime.js";

// `startOnLoad: false` because the page renders its documents itself, and a
// diagram appears when its sheet does — or again when somebody edits it.
//
// `securityLevel: "strict"` is not a default worth taking on trust here: a
// document's markdown is already filtered to a display-only allowlist (see
// markdown.ts), and a diagram's labels must not be the way around it. Strict
// sanitises label html and refuses click handlers.
mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  // Every character comes from the page: a webfont would be a request, and the
  // one property this output guarantees is that opening it makes none.
  fontFamily: "inherit",
});

setMermaidRunner((root) => {
  const nodes = [...root.querySelectorAll<HTMLElement>("pre.mermaid")].filter(
    (el) => el.dataset.rsDrawn !== "1"
  );
  if (nodes.length === 0) return;
  // Marked BEFORE the render: mermaid replaces the element's content with the
  // svg, and a second pass over an already-drawn diagram would try to parse the
  // svg as diagram source. `mermaid.run` is asynchronous, so the marker cannot
  // wait for it — a sheet switched to and back before it settles would queue
  // the same nodes twice.
  for (const el of nodes) el.dataset.rsDrawn = "1";
  // A diagram that does not parse leaves its own message in place of the
  // picture; the rest of the page is not the caller's to lose.
  void mermaid.run({ nodes, suppressErrors: true });
});

// DYNAMIC, because a static import is hoisted: written at the bottom of this
// file it would still run BEFORE the registration above, which is the whole
// point of this module. mermaid-runtime.ts no longer depends on the order —
// see the note there — and this keeps the ordinary path in the ordinary order
// rather than leaning on the recovery.
await import("./app-md.js");
