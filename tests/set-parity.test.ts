// One document, one appearance.
//
// A delivery is the same model twice: the page that carries it, and the folder
// it is written as — which the same page reads back when a recipient drops it.
// The two used to differ in five visible ways at once (a heading showing the
// chapter path, the deployed path missing, no orientation toggle, a plain link
// where the sheet puts a chip, a blank cell where it puts a dash), and every one
// of them was invisible from either side alone: each reading looked right until
// it was put beside the other.
//
// So the guarantee is a COMPARISON rather than a list of assertions about one
// side. It renders the real component tree both ways and diffs what a reader
// would see — which is the only thing that can fail when a sixth difference is
// introduced by a change to either half.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root, payloadOfSet } from "../src/html/app";
import { readMarkdownSet } from "../src/md-read";
import { toMarkdownSet } from "../src/md-set";
import { carriedDocuments, addressOf } from "../src/md-documents";
import { buildArtifactIndex } from "../src/artifact-index";
import { setMarkdownRenderer } from "../src/html/markdown-runtime";
import { renderMarkdown } from "../src/markdown";

// In a NESTED chapter, with both row shapes, an unset row, a remark and a
// deployed file — the page's own subtitle, the orientation toggle and the
// preview chip all need one.
const MODEL = {
  metadata: { title: "d", project: "p" },
  groups: [{ name: "design", display: "Detailed design", groups: [{ name: "srv", display: "Web tier" }] }],
  sheets: [
    {
      name: "web",
      group: "srv",
      instances: ["staging", "production"],
      file_path: "/etc/httpd/conf/httpd.conf",
      categories: [
        {
          name: "Basic",
          params: [
            { key: "Listen", value: "8080", description: "Port", default: "80", remarks: "note" },
            { key: "Timeout", value: "60", default: "60", origin: "default", description: "Idle timeout" },
            { key: "ServerName", description: "Name", instances: [{ name: "staging", value: "a" }, { name: "production", value: "b" }] },
          ],
        },
      ],
    },
  ],
  artifacts: [
    {
      id: "web",
      sheet: "web",
      source_file: "roles/web/templates/httpd.conf.j2",
      deployed_path: "/etc/httpd/conf/httpd.conf",
      instances: ["staging", "production"],
      lines: [
        { text: "# managed", kind: "verbatim" },
        { text: "Listen 8080", kind: "substituted", key: "Listen" },
      ],
    },
  ],
};

function draw(payload: unknown): HTMLElement {
  document.body.innerHTML = "";
  location.hash = "#1";
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(h(Root as never, { payload, reviewEnabled: false, initialLang: "ja", server: false } as never), host);
  return host;
}

// What a reader SEES, as a list: every element that carries text, with the
// class that decides how it looks. Not the html — two trees may differ in
// wrapping without a reader being able to tell, and a diff nobody can see is a
// test that fails for no reason somebody can act on.
//
// The TAG is deliberately not compared, only the class and the text: the
// preview chip is a button where the model answers it and a link where the set
// carries the address, which is one appearance and two mechanisms.
function seen(host: HTMLElement): string[] {
  const main = host.querySelector(".rs-main") ?? host;
  const out: string[] = [];
  for (const el of main.querySelectorAll("h1,h2,h3,h4,th,td,p,li,button,a,code")) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text !== "") out.push(`${String(el.className).replace(/\s+/g, " ").trim() || el.tagName.toLowerCase()}: ${text}`);
  }
  return out;
}

// Rendered ONE AT A TIME and read before the next: `draw` empties the document,
// so holding both hosts and reading them afterwards reads one live tree and one
// that has been torn out — which passes and compares nothing.
async function bothWays(act: (host: HTMLElement) => void = () => {}): Promise<{ embedded: string[]; folder: string[] }> {
  setMarkdownRenderer((source, images, opts) => renderMarkdown(source, () => null, opts));
  const carried = carriedDocuments(MODEL.artifacts as never, ["staging", "production"]);
  const index = buildArtifactIndex(MODEL.artifacts as never);
  const { files } = toMarkdownSet(MODEL as never, "ja", {
    documents: carried,
    preview: (sheet) => (row, categoryPath) => {
      const hit = index.previewFor(sheet.name, categoryPath.join("/"), row.key);
      const doc = carried[MODEL.artifacts.indexOf(hit as never)];
      return doc === undefined ? undefined : addressOf([doc], row.key);
    },
  });
  const read = readMarkdownSet(files.map((f) => ({ path: f.path, text: f.text })), "ja");
  expect(read.problems).toEqual([]);
  // A state change redraws on a microtask, so what `act` asked for is not on
  // screen until it has been let run.
  const one = async (payload: unknown): Promise<string[]> => {
    const host = draw(payload);
    act(host);
    await new Promise((r) => setTimeout(r, 0));
    return seen(host);
  };
  return {
    embedded: await one({ metadata: MODEL.metadata, versions: [{ version: "current", sheets: MODEL.sheets, groups: MODEL.groups, artifacts: MODEL.artifacts }] }),
    folder: await one(payloadOfSet({ title: "d" } as never, read)),
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("the same model, carried and read back", () => {
  it("shows the reader the same page", async () => {
    const { embedded, folder } = await bothWays();
    expect(folder).toEqual(embedded);
  });

  it("…and the same page in the other orientation", async () => {
    // The toggle is part of it: a reading the set could not offer is a
    // difference the first comparison cannot see, because it never gets there.
    const { embedded, folder } = await bothWays((host) => {
      const btn = [...host.querySelectorAll("button.rs-view-btn")].find((b) => (b.textContent ?? "").includes("転置")) as HTMLButtonElement;
      expect(btn, "no orientation toggle on this page").not.toBeUndefined();
      btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(folder).toEqual(embedded);
  });
});
