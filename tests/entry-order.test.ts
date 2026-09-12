// An entry point registers a renderer and then starts the app, and the order
// matters: the app renders its first document DURING startup, and whatever is
// not registered by then is not there when it is asked for.
//
// A static `import` is HOISTED. Written at the bottom of the file — where the
// intent is plainly "start the app last" — it still runs FIRST, so both entries
// started the app before registering anything. Measured, on real files:
//
//   app-mermaid.ts  every diagram stayed a block of text. Visible, and pinned
//                   by tests/mermaid-runtime.test.ts, which also makes the
//                   order stop mattering for that half.
//   app-md.ts       a sheet whose model IS its markdown opened with its prose
//                   unrendered — the raw text, until something else caused a
//                   re-render. NOT visible: the tables look right, and only the
//                   paragraphs between them are wrong. That is this file's
//                   subject.
//
// Run in a CHILD PROCESS, which is the only place the property exists to be
// observed: an entry point starts the app the first time it is evaluated, and
// by the time this file runs in the suite another test has already imported the
// app module — so importing the entry here would register a renderer for an app
// that started long ago, and prove nothing. The two alternatives were worse:
// the shipped bundle is minified, so the names this depends on are not in it,
// and reading the source only tells you what was written, which looked correct.

import { describe, it, expect } from "bun:test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PAYLOAD = {
  metadata: { title: "d" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "doc",
          categories: [],
          // `mode: "sheet"` is the one shape whose markdown is rendered in the
          // browser rather than at build time — so it is the one that needs
          // the renderer to be there before the first render.
          document: { html: "", markdown: "# doc\n\n**emphasised** prose\n", mode: "sheet" },
        },
      ],
    },
  ],
};

const script = (): string => `
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
location.hash = "#1";
const el = (id, text) => {
  const s = document.createElement("script");
  s.type = "application/json";
  s.id = id;
  s.textContent = text;
  document.body.appendChild(s);
};
document.body.innerHTML = '<div id="app"></div>';
el("sheet-data", ${JSON.stringify(JSON.stringify(PAYLOAD))});
el("sheet-config", '{"review":false,"lang":"ja"}');
await import("${root}/src/html/app-md.ts");
console.log(JSON.stringify({ doc: document.querySelector(".rs-md-prose")?.innerHTML ?? "" }));
`;

describe("a markdown-backed sheet is rendered the moment the file opens", () => {
  it("renders its prose, rather than showing the markdown that produces it", () => {
    const out = Bun.spawnSync(["bun", "-e", script()], { cwd: root, stderr: "pipe" });
    expect(out.exitCode, out.stderr.toString().slice(0, 400)).toBe(0);
    const last = out.stdout.toString().trim().split("\n").at(-1) ?? "";
    const { doc } = JSON.parse(last) as { doc: string };
    expect(doc).toContain("<strong>emphasised</strong>");
    expect(doc).not.toContain("**");
  });
});
