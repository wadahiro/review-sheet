import { describe, it, expect } from "bun:test";
import { Window } from "happy-dom";
import { generateHtml } from "../src/html/generate";
import { readGzipBlock } from "../src/html/compress";
import simpleFixture from "./fixtures/simple.json";
import multiInstanceFixture from "./fixtures/multi-instance.json";
import hierarchicalFixture from "./fixtures/hierarchical.json";
import nestedWideFixture from "./fixtures/nested-wide.json";
import manySheetsFixture from "./fixtures/many-sheets.json";
import type { ParameterSheetInput, VersionedSheetInput } from "../src/types";


// The model, the viewer and the stylesheet travel COMPRESSED — see
// html/compress.ts for why and by how much. A test asking "is this in the file"
// asks it of the payload, which is where it is; the assertions themselves are
// unchanged, since what they are about did not change.
const expand = (html: string): string =>
  html +
  ["sheet-data-gz", "sheet-app-gz", "sheet-style-gz"].map((id) => readGzipBlock(html, id) ?? "").join("\n");

describe("generateHtml", () => {
  it("generates valid HTML from Pattern A data", async () => {
    const html = expand(await generateHtml(simpleFixture as ParameterSheetInput));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Parameter Sheet</title>");
    expect(html).toContain('"sheet-data"');
    expect(html).toContain("net.ipv4.tcp_fin_timeout");
  });

  it("generates valid HTML from Pattern B data", async () => {
    const html = expand(await generateHtml(
      multiInstanceFixture as ParameterSheetInput
    ));
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Application Settings</title>");
    expect(html).toContain("development");
    expect(html).toContain("production");
  });

  it("generates valid HTML from nested categories (multiple heading levels)", async () => {
    const html = expand(await generateHtml(hierarchicalFixture as ParameterSheetInput));
    expect(html).toContain("<!DOCTYPE html>");
    // The three nesting levels (Network Settings > bonding > bond0) all carry
    // through to the embedded sheet data.
    expect(html).toContain("Network Settings");
    expect(html).toContain("bonding");
    expect(html).toContain("bond0");
    expect(html).toContain("BONDING_MASTER");
  });

  it("generates valid HTML from nested categories containing a wide instance table", async () => {
    const html = expand(await generateHtml(nestedWideFixture as ParameterSheetInput));
    expect(html).toContain("<!DOCTYPE html>");
    // Deep heading levels...
    expect(html).toContain("Region: ap-northeast");
    expect(html).toContain("Zone: tokyo-1a");
    expect(html).toContain("App Servers");
    // ...wrapping a wide (many-instance) Pattern B table.
    expect(html).toContain("web-tok-01");
    expect(html).toContain("web-osa-05");
    expect(html).toContain("app.setting_00");
  });

  it("generates valid HTML for many sheets (overflow tabs)", async () => {
    const html = expand(await generateHtml(manySheetsFixture as ParameterSheetInput));
    expect(html).toContain("<!DOCTYPE html>");
    expect((manySheetsFixture as ParameterSheetInput).sheets.length).toBeGreaterThan(10);
    // Every sheet name carries through, including ones that overflow into the menu.
    expect(html).toContain("Apache HTTPD");
    expect(html).toContain("Grafana");
    expect(html).toContain("Prometheus");
  });

  it("overrides the title with the title option", async () => {
    const html = expand(await generateHtml(simpleFixture as ParameterSheetInput, {
      title: "Custom Title",
    }));
    expect(html).toContain("<title>Custom Title</title>");
  });

  it("disables the review UI config with review: false", async () => {
    const html = expand(await generateHtml(simpleFixture as ParameterSheetInput, {
      review: false,
    }));
    expect(html).toContain('"review":false');
  });

  it("enables the review UI config with review: true", async () => {
    const html = expand(await generateHtml(simpleFixture as ParameterSheetInput, {
      review: true,
    }));
    expect(html).toContain('"review":true');
  });

  // Editing is off unless asked for. A delivered sheet that silently accepted
  // edits would let the recipient change values nobody knows changed.
  it("keeps editing off by default", async () => {
    const html = expand(await generateHtml(simpleFixture as ParameterSheetInput));
    expect(html).toContain('"edit":false');
  });

  it("enables editing with edit: true", async () => {
    const html = expand(await generateHtml(simpleFixture as ParameterSheetInput, {
      edit: true,
    }));
    expect(html).toContain('"edit":true');
  });

  // A "</script>" anywhere in the embedded text ends the element early and the
  // rest of the document becomes markup. The app's own source contains one (it
  // reads its embedded history back out), and any config value could too — so
  // this is a live failure, not a hypothetical, and it looks like a blank page.
  // The payload blocks are base64, and base64 has no "<" in its alphabet — so a
  // value that spells `</script>` cannot end the element it sits in, whatever
  // it says. That used to take an escaping pass over every embedded string;
  // compression removed the class of bug rather than the bug.
  describe("embedded text cannot end its own script element", () => {
    const parse = (html: string): Document => {
      const w = new Window();
      w.document.write(html);
      return w.document as unknown as Document;
    };
    const scriptsOf = (html: string): string[] =>
      [...parse(html).querySelectorAll("script")].map((e) => e.textContent ?? "");

    it("keeps the app bundle whole", async () => {
      const raw = await generateHtml(simpleFixture as ParameterSheetInput, { edit: true });
      // theme, config, reviews, style-gz, data-gz, app-gz, bootstrap.
      expect(scriptsOf(raw)).toHaveLength(7);
      const app = readGzipBlock(raw, "sheet-app-gz") ?? "";
      expect(app.length).toBeGreaterThan(10_000);
      // Truncation happens INSIDE the bundle, so the tail is what proves it whole.
      expect(app.trimEnd().endsWith("</script>")).toBe(false);
    });

    it("survives a value that closes a script tag", async () => {
      const nasty = JSON.parse(JSON.stringify(simpleFixture)) as ParameterSheetInput;
      nasty.sheets[0].categories[0].params![0].value = '</script><h1>gotcha</h1>';
      const raw = await generateHtml(nasty);
      // Not in the file as text at all — it is inside the compressed block.
      expect(raw).not.toContain("gotcha");
      expect(readGzipBlock(raw, "sheet-data-gz") ?? "").toContain("gotcha");
      expect(parse(raw).querySelector("h1")).toBeNull();
    });

    it("leaves nothing in a payload block that could close it", async () => {
      const raw = await generateHtml(simpleFixture as ParameterSheetInput);
      for (const id of ["sheet-style-gz", "sheet-data-gz", "sheet-app-gz"]) {
        const at = raw.indexOf(`id="${id}"`);
        const body = raw.slice(raw.indexOf(">", at) + 1, raw.indexOf("</script>", at));
        expect(body).toMatch(/^[A-Za-z0-9+/=\s]+$/);
      }
    });
  });

  it("carries capabilities.apply:false through the embedded payload for a single-version input", async () => {
    const input: ParameterSheetInput = {
      ...(simpleFixture as ParameterSheetInput),
      capabilities: { apply: false },
    };
    const html = expand(await generateHtml(input));
    expect(html).toContain('"capabilities":{"apply":false}');
  });

  it("carries capabilities.apply:false through the embedded payload for a versioned document", async () => {
    const input: VersionedSheetInput = {
      metadata: { title: "Versioned" },
      capabilities: { apply: false },
      versions: [
        { version: "1.0", sheets: (simpleFixture as ParameterSheetInput).sheets },
      ],
    };
    const html = expand(await generateHtml(input));
    expect(html).toContain('"capabilities":{"apply":false}');
  });
});

// Every test above asserts on the HTML as a STRING, which is why a broken JSX
// template once shipped a file containing all the right substrings and a blank
// page: htm threw at mount, nothing rendered, and no test noticed because the
// viewer suite renders the Preact tree directly rather than the bundle.
//
// This one executes the generated bundle. It does not test any feature — it
// tests that the thing we hand to a reader comes up at all.
describe("generateHtml: the bundle actually runs", () => {
  async function renderBundle(html: string): Promise<{ text: string; errors: string[] }> {
    const window = new Window({ url: "http://localhost/" });
    const errors: string[] = [];
    // happy-dom's Event is not the DOM lib's Event, and the listener signature
    // is all this needs — typed structurally rather than imported, so the test
    // does not depend on happy-dom's internal type layout.
    (window as unknown as { addEventListener: (t: string, l: (e: { message?: string }) => void) => void })
      .addEventListener("error", (e) => errors.push(String(e.message ?? e)));
    const realError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.join(" "));
    try {
      window.document.write(html);
      await new Promise((r) => setTimeout(r, 400));
      return { text: (window.document.body.textContent ?? "").trim(), errors };
    } finally {
      console.error = realError;
    }
  }

  it("mounts without throwing and puts the sheet on the page", async () => {
    const html = expand(await generateHtml(multiInstanceFixture as ParameterSheetInput));
    const { text, errors } = await renderBundle(html);
    expect(errors).toEqual([]);
    // A blank page is ~0 characters; a rendered sheet is thousands. The exact
    // number is not the assertion — "something is there" is.
    expect(text.length).toBeGreaterThan(200);
  });
});


// Which viewer the page carries, and therefore what it weighs. Three entries:
// the plain one, the one that can re-render markdown (43 KB more), and the one
// that can draw diagrams (3.3 MB more). A sheet must pay only for what it uses,
// and "uses" is decided by the document itself, not by a flag somebody sets.
describe("generateHtml: the page carries only the viewer it needs", () => {
  const withDocument = (html: string, mermaid: boolean): ParameterSheetInput => ({
    metadata: { title: "d" },
    sheets: [
      {
        name: "doc",
        categories: [],
        document: { html, ...(mermaid ? { mermaid: true as const } : {}) },
      },
    ],
  }) as ParameterSheetInput;

  const appOf = (out: string): string => readGzipBlock(out, "sheet-app-gz") ?? "";

  it("leaves the diagram renderer out of a document that draws none", async () => {
    const out = await generateHtml(withDocument("<p>x</p>", false), { edit: true });
    expect(appOf(out).length).toBeLessThan(1_000_000);
  });

  it("carries it for a document that draws one — even read-only", async () => {
    // A diagram is NOT already rendered in a read-only copy: the build has no
    // browser, so the page draws it. That makes this independent of editing.
    const out = await generateHtml(withDocument('<pre class="mermaid">graph LR</pre>', true), {});
    expect(appOf(out).length).toBeGreaterThan(1_000_000);
  });

  // The whole point of the split: a sheet with no document at all is unchanged.
  it("leaves both out of a sheet with no document", async () => {
    const out = await generateHtml(simpleFixture as ParameterSheetInput);
    expect(appOf(out).length).toBeLessThan(1_000_000);
  });
});
