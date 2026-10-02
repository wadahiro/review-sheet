// A PROSE SHEET, NARROWED BY WHAT ITS OWN MARKERS SAY.
//
// A `recipe: document` sheet has no parameters, so every kind of narrowing
// `--instances` performs had nothing to take hold of and passed straight over
// it. A unit-test record is exactly that kind of sheet AND is written per
// environment, so a delivery for one environment carried every other
// environment's results, in full, under their own headings.
//
// The heading already says which environment it is, in words — and reading those
// words back would be a program trusting prose a recipient may reword. So the
// fact is written beside the thing it is about, as every other marker in this
// tool is, and states the document's SHAPE rather than a value.

import { describe, it, expect } from "bun:test";
import { restrictInstances, formatRestrictReport } from "../src/restrict";
import { dropInstanceSections, instanceMark, renderMarkdown } from "../src/markdown";

const record = (): string =>
  [
    "# Record",
    "",
    "## Items",
    "",
    instanceMark("local"),
    "### Unit (local)",
    "",
    "| No. | verdict |",
    "| --- | --- |",
    "| 1 | OK |",
    "",
    instanceMark("prod"),
    "### Unit (prod)",
    "",
    "prod body",
    "",
    "## Out of scope",
    "",
    "this belongs to no environment",
    "",
  ].join("\n");

describe("the sections an environment owns", () => {
  it("removes the ones no delivered environment claims", () => {
    const { text, dropped } = dropInstanceSections(record(), new Set(["prod"]));
    expect(dropped).toEqual(["local"]);
    expect(text).toContain("### Unit (prod)");
    expect(text).not.toContain("### Unit (local)");
    expect(text).not.toContain("| 1 | OK |");
  });

  // A section ends where the next heading of its own level or above begins —
  // which is the rule a reader already sees. Anything the markers do not cover
  // is the project's own prose and is left exactly as written.
  it("stops at the next heading of its own level or above", () => {
    const { text } = dropInstanceSections(record(), new Set(["local"]));
    expect(text).toContain("## Out of scope");
    expect(text).toContain("this belongs to no environment");
    expect(text).toContain("### Unit (local)");
    expect(text).not.toContain("prod body");
  });

  it("changes nothing when every environment is delivered", () => {
    const whole = record();
    expect(dropInstanceSections(whole, new Set(["local", "prod"])).text).toBe(whole);
  });

  // THE SAME RULE IN BOTH FORMS the document is held in: the markdown an editor
  // and a markdown set are given, and the html the page shows. A delivery whose
  // two readings disagreed about which environments it covers would be one
  // document saying two things.
  it("reads the html the same way", () => {
    const html = renderMarkdown(record(), () => null, { navDepth: 4, idPrefix: "p-" }).html;
    const { text, dropped } = dropInstanceSections(html, new Set(["prod"]));
    expect(dropped).toEqual(["local"]);
    expect(text).toContain("Unit (prod)");
    expect(text).not.toContain("Unit (local)");
    expect(text).toContain("Out of scope");
  });

  // A marker with no heading under it claims nothing, so it covers itself alone:
  // guessing a span for it would remove prose nobody assigned to an environment.
  it("takes only itself where it governs no heading", () => {
    const md = ["# T", "", instanceMark("local"), "", "prose nobody assigned", ""].join("\n");
    const { text } = dropInstanceSections(md, new Set(["prod"]));
    expect(text).toContain("prose nobody assigned");
    expect(text).not.toContain("rs:env");
  });
});

describe("a document sheet in a narrowed delivery", () => {
  const model = () => {
    const md = record();
    const { html, headings } = renderMarkdown(md, () => null, { navDepth: 4, idPrefix: "p-" });
    return {
      metadata: { title: "t" },
      sheets: [
        { name: "rec", instances: ["local", "prod"], categories: [], document: { html, markdown: md, headings } },
      ],
    } as never;
  };

  it("loses the sections of the environments it does not deliver", () => {
    const { input, report } = restrictInstances(model(), ["prod"]);
    const doc = (input as { sheets: { document: { html: string; markdown: string } }[] }).sheets[0]!.document;
    expect(doc.html).not.toContain("Unit (local)");
    expect(doc.html).toContain("Unit (prod)");
    expect(report.droppedSections).toEqual([{ sheet: "rec", instances: ["local"] }]);
  });

  // BOTH halves, or the page and the folder would say different things about the
  // same delivery.
  it("narrows the markdown with the html", () => {
    const { input } = restrictInstances(model(), ["prod"]);
    const doc = (input as { sheets: { document: { markdown: string } }[] }).sheets[0]!.document;
    expect(doc.markdown).not.toContain("### Unit (local)");
    expect(doc.markdown).toContain("### Unit (prod)");
  });

  // …and the outline goes with them, or the chapter tree offers a heading that
  // is no longer on the page. Filtered by what SURVIVED rather than narrowed in
  // parallel: the ids are in the html, so asking it is exact.
  it("takes the removed headings out of the outline", () => {
    const { input } = restrictInstances(model(), ["prod"]);
    const doc = (input as { sheets: { document: { headings?: { text: string }[] } }[] }).sheets[0]!.document;
    const texts = (doc.headings ?? []).map((h) => h.text);
    expect(texts).toContain("Unit (prod)");
    expect(texts).not.toContain("Unit (local)");
    expect(texts).toContain("Out of scope");
  });

  it("says which sheet lost which environments", () => {
    const { report } = restrictInstances(model(), ["prod"]);
    const said = formatRestrictReport(report);
    expect(said).toContain('sheet "rec"');
    expect(said).toContain("local");
  });

  it("leaves a document that claims no environment alone", () => {
    const plain = () =>
      ({
        metadata: { title: "t" },
        sheets: [{ name: "note", instances: ["local", "prod"], categories: [], document: { html: "<p>x</p>", markdown: "x" } }],
      }) as never;
    const { input, report } = restrictInstances(plain(), ["prod"]);
    expect((input as { sheets: { document: { html: string } }[] }).sheets[0]!.document.html).toBe("<p>x</p>");
    expect(report.droppedSections).toEqual([]);
  });
});
