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
    // A sheet that exists only to compare: it opens side by side and has no
    // stacked reading to return to.
    {
      name: "versions",
      group: "srv",
      instances: ["staging"],
      compare_components: "always",
      categories: [
        { name: "19.0.2", params: [{ key: "db", value: "postgres", description: "Store" }] },
        { name: "26.7.3", params: [{ key: "db", value: "postgres", description: "Store" }] },
      ],
    },
    {
      name: "offered",
      group: "srv",
      instances: ["staging"],
      // …and a deployed path, so the ORDER of the two things written under the
      // title is exercised: the path is told from prose by being first.
      file_path: "/etc/app.conf",
      compare_components: true,
      categories: [
        { name: "a", params: [{ key: "x", value: "1", description: "X" }] },
        { name: "b", params: [{ key: "x", value: "2", description: "X" }] },
      ],
    },
    // A second sheet pointing into the SAME file. In a folder one file is one
    // file, so it belongs to neither in particular — and naming one of them
    // would leave the other's rows with no way in.
    {
      name: "also",
      group: "srv",
      instances: ["staging", "production"],
      categories: [{ name: "Basic", params: [{ key: "Listen", value: "8080", description: "Port", default: "80" }] }],
    },
    {
      name: "web",
      group: "srv",
      instances: ["staging", "production"],
      file_path: "/etc/httpd/conf/httpd.conf",
      categories: [
        {
          // A component the project calls one thing and the page another — the
          // identity is `alb`, the reader sees the name its author gave it.
          name: "alb",
          label: { ja: "SSO 公開エンドポイント" },
          categories: [
            {
              name: "Basic",
              params: [
                { key: "idle", value: "60", description: "Idle", default: "60" },
                { key: "idle[1]", value: "60", description: "Idle", default: "60" },
              ],
            },
          ],
        },
        {
          name: "Basic",
          params: [
            { key: "Listen", value: "8080", description: "Port", default: "80", remarks: "note" },
            // The product's own name for the setting, its own name for a value,
            // and a default column showing what the DISTRIBUTION shipped rather
            // than what the product documents — three facts a table cannot say.
            {
              key: "selinux",
              label: { ja: "SELINUX" },
              value: "disabled",
              default: "enforcing",
              options: [{ value: "disabled", label: { ja: "読み込まない" } }],
              description: "Mode",
            },
            { key: "ServerRoot", value: "/etc/httpd", default: "/usr/local/apache", baseline: "/etc/httpd", description: "Root" },
            // The vendor shipped it and the product documents no default of its
            // own — the column still holds the vendor's, and this project set
            // the value to the same string.
            { key: "Port", value: "80", baseline: "80", description: "Port" },
            // Per environment, and they agree — which is what a SHARED row
            // looks like too, and the sheet marks the two differently.
            {
              key: "region",
              description: "Region",
              instances: [
                { name: "staging", value: "ap-northeast-1" },
                { name: "production", value: "ap-northeast-1" },
              ],
            },
            // A line one environment's FILE does not have, which is not the
            // same as leaving it at the default.
            {
              key: "only-staging",
              description: "Debug",
              absent_where_unlisted: true,
              instances: [{ name: "staging", value: "on" }],
            },
            // …and one whose only value is in an environment this sheet does
            // not carry at all: empty in every column it HAS, and still a row.
            {
              key: "local-only",
              description: "Dummy",
              absent_where_unlisted: true,
              // Emptied by the narrowing a delivery does: its one value was in
              // an environment this document does not carry.
              instances: [],
            },
            // The vendor shipped it and this file dropped it — unset, but not
            // because nobody ever set it, and the sheet keeps it on the page.
            { key: "dropped", origin: "baseline", baseline: "On", description: "Dropped" },
            // A BLOCK the vendor shipped and this file dropped. Its "value" is
            // the block's own argument, which is what the block is.
            {
              key: 'Directory["/var/www"]',
              container: { name: "Directory" },
              value: '"/var/www"',
              origin: "baseline",
              description: "Block",
            },
            {
              key: 'Directory["/var/www"].Options',
              container_path: [{ path: 'Directory["/var/www"]' }],
              value: "Indexes",
              description: "Options",
            },
            // A block whose opening carries no argument: the model has no row
            // for it at all, only the indent of what is inside.
            {
              key: "IfModule[0].LogLevel",
              container_path: [{ path: "IfModule[0]", name: "IfModule" }],
              value: "warn",
              description: "Level",
            },
            // A SECOND block with the same word for a heading. Three
            // `<IfModule>` openings are three blocks and one word, so the
            // heading cannot be what their rows are keyed by.
            {
              key: "IfModule[1].LogFormat",
              container_path: [{ path: "IfModule[1]", name: "IfModule" }],
              value: "combined",
              description: "Format",
            },
            // …and one this project is deliberately not reviewing here.
            {
              key: "pw",
              value: "REF",
              description: "Secret",
              out_of_scope: { reason: { ja: "デプロイ時に供給される" }, owner: "Platform / SRE" },
            },
            // A setting whose value IS its presence, and the product's own word
            // for it.
            { key: "http", value: "true", presence: true, presence_label: { ja: "許可" }, default: "true", description: "Service" },
            // …and one the product has no word of its own for: the sheet says
            // it in the reader's language, and a row carrying nothing at all
            // reads as an ordinary `true`.
            { key: "cockpit", value: "true", presence: true, default: "true", description: "Service" },
            // Where the default was READ — a distribution's shipped file rather
            // than the product's documentation.
            { key: "driftfile", value: "/var/lib/chrony/drift", default: "/var/lib/chrony/drift", default_from: "/etc/chrony.conf", description: "Drift" },
            { key: "Timeout", value: "60", default: "60", origin: "default", description: "Idle timeout" },
            { key: "ServerName", description: "Name", instances: [{ name: "staging", value: "a" }, { name: "production", value: "b" }] },
          ],
        },
      ],
    },
  ],
  artifacts: [
    // Scoped to a COMPONENT, so the way into the file is resolved against the
    // category path — which is the identity's, not the displayed one.
    {
      id: "alb",
      sheet: "web",
      component: "alb",
      source_file: "modules/alb/main.tf",
      nature: "source",
      lines: [
        { text: 'resource "aws_lb" "this" {', kind: "verbatim" },
        // ONE line, two rows — what a `count`ed resource writes: every copy is
        // addressed by the same line of the source.
        { text: "  idle_timeout = 60", kind: "verbatim", key: "idle", keys: ["idle", "idle[1]"] },
      ],
    },
    {
      id: "web-also",
      sheet: "also",
      source_file: "roles/web/templates/httpd.conf.j2",
      deployed_path: "/etc/httpd/conf/httpd.conf",
      instances: ["staging", "production"],
      lines: [
        { text: "# managed", kind: "verbatim" },
        { text: "Listen 8080", kind: "substituted", key: "Listen" },
      ],
    },
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

function draw(payload: unknown, tab: number): HTMLElement {
  document.body.innerHTML = "";
  location.hash = `#${tab}`;
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
//
// THE WHOLE PAGE, not the main column. Scoped to `.rs-main` this compared the
// table and nothing around it, and a seventh difference sat in the half it did
// not read for as long as it existed: the chapter tree and the breadcrumb named
// a chapter by its PATH in one reading and by its own name in the other. It was
// found by opening the file — which is what a comparison is supposed to make
// unnecessary.
//
// The chrome that is ABOUT the reading rather than the document is left out,
// and only that: a page holding a folder says so, and offers to open another.
const CHROME = /^(表示中|フォルダを開く|1ファイルで保存)/;

function seen(host: HTMLElement): string[] {
  const out: string[] = [];
  for (const el of host.querySelectorAll("h1,h2,h3,h4,th,td,p,li,button,a,code,summary,label")) {
    const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text === "" || CHROME.test(text)) continue;
    out.push(`${String(el.className).replace(/\s+/g, " ").trim() || el.tagName.toLowerCase()}: ${text}`);
  }
  return out;
}

// The set, written from the model exactly as the CLI writes it.
function writtenSet(): ReturnType<typeof toMarkdownSet> {
  const carried = carriedDocuments(MODEL.artifacts as never, ["staging", "production"]);
  const index = buildArtifactIndex(MODEL.artifacts as never);
  return toMarkdownSet(MODEL as never, "ja", {
    documents: carried,
    preview: (sheet) => (row, categoryPath) => {
      const hit = index.previewFor(sheet.name, categoryPath.join("/"), row.key);
      const doc = carried[MODEL.artifacts.indexOf(hit as never)];
      return doc === undefined ? undefined : addressOf([doc], row.key);
    },
  });
}

// Rendered ONE AT A TIME and read before the next: `draw` empties the document,
// so holding both hosts and reading them afterwards reads one live tree and one
// that has been torn out — which passes and compares nothing.
async function bothWays(tab = 1, act: (host: HTMLElement) => void = () => {}): Promise<{ embedded: string[]; folder: string[] }> {
  setMarkdownRenderer((source, images, opts) => renderMarkdown(source, () => null, opts));
  const { files } = writtenSet();
  const read = readMarkdownSet(files.map((f) => ({ path: f.path, text: f.text })), "ja");
  expect(read.problems).toEqual([]);
  // A state change redraws on a microtask, so what `act` asked for is not on
  // screen until it has been let run.
  const one = async (payload: unknown): Promise<string[]> => {
    const host = draw(payload, tab);
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
  // EVERY page, not the first: the sheets differ in shape — one compares its
  // components, one is an ordinary table — and a difference lives in whichever
  // shape nobody looked at.
  it("shows the reader the same page", async () => {
    for (let tab = 1; tab <= MODEL.sheets.length; tab++) {
      const { embedded, folder } = await bothWays(tab);
      expect(folder, `page ${tab} differs`).toEqual(embedded);
    }
  });

  // The heading says what the page says, and the IDENTITY comes back intact —
  // which the comparison above cannot see, because identity is not appearance:
  // it is what an anchor, a row address and a change set resolve through, and
  // all three would keep working while quietly meaning another component.
  it("keeps a component's identity under the name the page shows", () => {
    setMarkdownRenderer((source, images, opts) => renderMarkdown(source, () => null, opts));
    const { files } = writtenSet();
    const page = files.find((f) => f.path.endsWith("web.md"))!;
    expect(page.text).toContain("<!-- rs:name=alb -->\n## SSO 公開エンドポイント");
    const read = readMarkdownSet(files.map((f) => ({ path: f.path, text: f.text })), "ja");
    const web = read.sheets.find((x) => x.display === "web")!;
    const top = (web.categories as { name: string; display?: string }[])[0]!;
    expect(top.name).toBe("alb");
    expect(top.display).toBe("SSO 公開エンドポイント");
  });

  it("…and the same page in the other orientation", async () => {
    // The toggle is part of it: a reading the set could not offer is a
    // difference the first comparison cannot see, because it never gets there.
    const { embedded, folder } = await bothWays(3, (host) => {
      const btn = [...host.querySelectorAll("button.rs-view-btn")].find((b) => (b.textContent ?? "").includes("転置")) as HTMLButtonElement;
      expect(btn, "no orientation toggle on this page").not.toBeUndefined();
      btn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    expect(folder).toEqual(embedded);
  });
});
