// Whether this document can render markdown for itself.
//
// Rendering happens at BUILD time: the generated file carries the finished
// HTML, and neither the markdown source nor a renderer. Letting someone edit a
// document sheet means putting the renderer in the page — about 43 KB on a
// 145 KB viewer, which every sheet would pay even though most carry no document
// at all.
//
// So the renderer is REGISTERED rather than imported. `app.ts` asks for one and
// does without if there is none; `app-md.ts` is a second entry point that
// registers the real one and then starts the same app, and generate.ts builds
// from that entry only when the document actually needs it. A static import in
// app.ts would defeat the whole arrangement — the bundler would pull marked in
// for everyone.

import type { RenderedDocument } from "../markdown.js";

export type MarkdownRenderer = (
  source: string,
  images: Record<string, string>,
  opts: { navDepth?: number; idPrefix?: string }
) => RenderedDocument;

let renderer: MarkdownRenderer | null = null;

export function setMarkdownRenderer(r: MarkdownRenderer): void {
  renderer = r;
}

export function getMarkdownRenderer(): MarkdownRenderer | null {
  return renderer;
}
