// Registering the renderer and asking for a draw, in either order.
//
// The order is not something a caller can arrange: a static `import` is
// HOISTED, so the entry point that registers the renderer has already started
// the app — and the app has already rendered its first document — by the time
// the registration line runs. Measured on a real file: the diagram elements
// were in the page, the renderer was in the bundle, and the one call that would
// have joined them had come and gone. Nothing failed; the picture was simply
// not there.

import { describe, it, expect, beforeEach } from "bun:test";
import { createMermaidGate } from "../src/html/mermaid-runtime";

const root = (): ParentNode => ({ querySelectorAll: () => [] }) as unknown as ParentNode;

describe("the diagram renderer and the page find each other", () => {
  let drawn: ParentNode[];
  let gate: ReturnType<typeof createMermaidGate>;
  beforeEach(() => {
    drawn = [];
    gate = createMermaidGate();
  });
  const setMermaidRunner = (r: (x: ParentNode) => void): void => gate.set(r);
  const runMermaid = (r: ParentNode | null): void => gate.run(r);

  it("draws when the request comes after the renderer", () => {
    setMermaidRunner((x) => drawn.push(x));
    const r = root();
    runMermaid(r);
    expect(drawn).toEqual([r]);
  });

  // The order that actually happens.
  it("draws when the renderer comes after the request", () => {
    const r = root();
    runMermaid(r);
    setMermaidRunner((x) => drawn.push(x));
    expect(drawn).toEqual([r]);
  });

  // Once is once: a renderer registered twice must not redraw a root that was
  // already drawn, or a diagram is parsed from the svg it was drawn into.
  it("holds one request only, and lets it go once it is served", () => {
    const r = root();
    runMermaid(r);
    setMermaidRunner((x) => drawn.push(x));
    setMermaidRunner((x) => drawn.push(x));
    expect(drawn).toEqual([r]);
  });

  it("does nothing at all where no renderer is ever registered", () => {
    // Nothing to assert but the absence of a throw: the page then shows the
    // diagram's source as text, which is what a reader of the markdown sees.
    expect(() => runMermaid(null)).not.toThrow();
  });
});
