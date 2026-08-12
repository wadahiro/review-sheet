import { describe, it, expect } from "bun:test";
import { Window } from "happy-dom";
import { generateHtml } from "../src/html/generate";
import simpleFixture from "./fixtures/simple.json";
import multiInstanceFixture from "./fixtures/multi-instance.json";
import hierarchicalFixture from "./fixtures/hierarchical.json";
import nestedWideFixture from "./fixtures/nested-wide.json";
import manySheetsFixture from "./fixtures/many-sheets.json";
import type { ParameterSheetInput, VersionedSheetInput } from "../src/types";

describe("generateHtml", () => {
  it("generates valid HTML from Pattern A data", async () => {
    const html = await generateHtml(simpleFixture as ParameterSheetInput);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Parameter Sheet</title>");
    expect(html).toContain('"sheet-data"');
    expect(html).toContain("net.ipv4.tcp_fin_timeout");
  });

  it("generates valid HTML from Pattern B data", async () => {
    const html = await generateHtml(
      multiInstanceFixture as ParameterSheetInput
    );
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Application Settings</title>");
    expect(html).toContain("development");
    expect(html).toContain("production");
  });

  it("generates valid HTML from nested categories (multiple heading levels)", async () => {
    const html = await generateHtml(hierarchicalFixture as ParameterSheetInput);
    expect(html).toContain("<!DOCTYPE html>");
    // The three nesting levels (Network Settings > bonding > bond0) all carry
    // through to the embedded sheet data.
    expect(html).toContain("Network Settings");
    expect(html).toContain("bonding");
    expect(html).toContain("bond0");
    expect(html).toContain("BONDING_MASTER");
  });

  it("generates valid HTML from nested categories containing a wide instance table", async () => {
    const html = await generateHtml(nestedWideFixture as ParameterSheetInput);
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
    const html = await generateHtml(manySheetsFixture as ParameterSheetInput);
    expect(html).toContain("<!DOCTYPE html>");
    expect((manySheetsFixture as ParameterSheetInput).sheets.length).toBeGreaterThan(10);
    // Every sheet name carries through, including ones that overflow into the menu.
    expect(html).toContain("Apache HTTPD");
    expect(html).toContain("Grafana");
    expect(html).toContain("Prometheus");
  });

  it("overrides the title with the title option", async () => {
    const html = await generateHtml(simpleFixture as ParameterSheetInput, {
      title: "Custom Title",
    });
    expect(html).toContain("<title>Custom Title</title>");
  });

  it("disables the review UI config with review: false", async () => {
    const html = await generateHtml(simpleFixture as ParameterSheetInput, {
      review: false,
    });
    expect(html).toContain('"review":false');
  });

  it("enables the review UI config with review: true", async () => {
    const html = await generateHtml(simpleFixture as ParameterSheetInput, {
      review: true,
    });
    expect(html).toContain('"review":true');
  });

  it("carries capabilities.apply:false through the embedded payload for a single-version input", async () => {
    const input: ParameterSheetInput = {
      ...(simpleFixture as ParameterSheetInput),
      capabilities: { apply: false },
    };
    const html = await generateHtml(input);
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
    const html = await generateHtml(input);
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
    const html = await generateHtml(multiInstanceFixture as ParameterSheetInput);
    const { text, errors } = await renderBundle(html);
    expect(errors).toEqual([]);
    // A blank page is ~0 characters; a rendered sheet is thousands. The exact
    // number is not the assertion — "something is there" is.
    expect(text.length).toBeGreaterThan(200);
  });
});
