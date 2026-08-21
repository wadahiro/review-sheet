// Whether this document can DRAW the diagrams it contains.
//
// The same arrangement markdown-runtime.ts uses, and for a much larger reason:
// mermaid bundles to 3.3 MB minified, against a 158 KB viewer. A sheet with no
// diagram must not carry it, so it is REGISTERED rather than imported —
// `app-mermaid.ts` is a third entry point that registers the real one, and
// generate.ts builds from that entry only when a document actually draws
// something.
//
// Why the page and not the build: this build never starts a browser (that is
// what makes it reproducible offline), and mermaid needs one to measure text.
// A picture rendered elsewhere and pasted in would also stop matching its
// source the moment somebody edits the diagram in the viewer, which is the
// failure the document editor already has to avoid.
export type MermaidRunner = (root: ParentNode) => void;

// The two halves — "here is a renderer" and "here is something to draw" —
// arrive in an order nobody chooses, so neither may assume it is first.
//
// A static `import` is HOISTED: the entry point that registers the renderer has
// already started the app, and the app has already rendered its first document,
// by the time the registration line runs. Measured on a real file: the diagram
// elements were in the page, the renderer was in the bundle, and the one call
// that would have joined them had come and gone. Nothing failed. The picture
// was simply not there.
//
// A factory rather than module-level state so the rule can be tested at all: a
// module keeps its registration for the life of the page, and a test cannot ask
// it to forget.
export function createMermaidGate(): {
  set: (r: MermaidRunner) => void;
  run: (root: ParentNode | null) => void;
} {
  let runner: MermaidRunner | null = null;
  // A root that asked to be drawn before there was anything to draw with. One
  // is enough: it is the page's document body, and it is released as soon as it
  // is served — a second delivery would parse a diagram out of the svg the
  // first one drew.
  let pending: ParentNode | null = null;
  return {
    set(r) {
      runner = r;
      if (pending !== null) {
        const root = pending;
        pending = null;
        r(root);
      }
    },
    // Draw every diagram under `root` that has not been drawn yet. Where the
    // page carries no renderer AT ALL the source shows as text, which is what a
    // reader of the markdown file sees too — not an error, and not a blank
    // space.
    run(root) {
      if (root === null) return;
      if (runner === null) {
        pending = root;
        return;
      }
      runner(root);
    },
  };
}

const gate = createMermaidGate();

export const setMermaidRunner = gate.set;
export const runMermaid = gate.run;
