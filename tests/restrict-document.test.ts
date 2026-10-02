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
import { dropInstanceSections, dropInstanceColumns, instanceMark, renderMarkdown } from "../src/markdown";

const record = (): string =>
  [
    "# Record",
    "",
    // The summary a record opens with: one column per environment, each marked.
    // It belongs to no section, so dropping sections alone leaves its numbers
    // reading as the delivered environment's own.
    `| Item | ${instanceMark("local")}local | ${instanceMark("prod")}prod |`,
    "| --- | --- | --- |",
    "| Items | 376 | 357 |",
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

  // A BLOCK THAT RENDERS TO NOTHING STILL CLOSES ITS LINE.
  //
  // Two html blocks separated by a blank line arrive as two tokens whose blank
  // line has been moved into a `space` between them — and a space renders to
  // nothing, so the blocks ran together. Invisible for a block a reader sees,
  // and not invisible at all for a COMMENT: three markers written as three
  // blocks came out as one line, and a marker read back by matching a line of
  // its own matched nothing. The sections it governs stayed in a narrowed
  // delivery, which is the quietest way this could fail.
  it("keeps adjacent comment blocks on their own lines", () => {
    const md = ["# T", "", "<!-- other:one -->", "", "<!-- other:two -->", "", instanceMark("local"), "### U (local)", "", "body", ""].join("\n");
    const html = renderMarkdown(md, () => null, { navDepth: 4, idPrefix: "p-" }).html;
    expect(html.split("\n")).toContain(instanceMark("local"));
    expect(dropInstanceSections(html, new Set(["prod"])).dropped).toEqual(["local"]);
  });

  // …and the marker is read even where something DID join them, because a
  // marker that fails to match is a section left in a delivery.
  it("is read when other comments share its line", () => {
    const joined = `<!-- other:one --><!-- other:two -->${instanceMark("local")}\n<h3 id="x">U</h3>\n<p>body</p>\n`;
    const { text, dropped } = dropInstanceSections(joined, new Set(["prod"]));
    expect(dropped).toEqual(["local"]);
    expect(text).not.toContain("body");
  });

  // Prose before it is a different matter: an inline mention is not a block
  // claiming the heading below it.
  it("is not read when prose shares its line", () => {
    const inline = `the marker ${instanceMark("local")}\n<h3 id="x">U</h3>\n<p>body</p>\n`;
    expect(dropInstanceSections(inline, new Set(["prod"])).dropped).toEqual([]);
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

// THE SUMMARY'S COLUMNS, narrowed with the delivery.
//
// A record opens with a table counting what was checked. It used to be one
// column of totals with the breakdown written into a cell as prose — and prose
// is exactly what a narrowing cannot touch, so every number stayed as it was in
// a delivery for one environment, reading as that environment's own. The
// environments are columns now, which is the axis the rest of this tool already
// puts them on, and the column goes.
describe("the columns an environment owns", () => {
  const summary = (): string =>
    [
      "## Summary",
      "",
      `| Item | ${instanceMark("local")}local | ${instanceMark("prod")}prod |`,
      "| --- | --- | --- |",
      "| Items | 376 | 357 |",
      "| Verdict | OK 376 / NG 0 | OK 357 / NG 0 |",
      "",
      "## Another table",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
    ].join("\n");

  it("takes the column, not the row", () => {
    const { text, dropped } = dropInstanceColumns(summary(), new Set(["prod"]));
    expect(dropped).toEqual(["local"]);
    expect(text).toContain("| Items | 357 |");
    expect(text).toContain("| Verdict | OK 357 / NG 0 |");
    expect(text).not.toContain("376");
  });

  // A table with no marked header is nobody's environment and is left alone —
  // the summary is the only one of its kind in a document.
  it("leaves an unmarked table alone", () => {
    const { text } = dropInstanceColumns(summary(), new Set(["prod"]));
    expect(text).toContain("| a | b |");
    expect(text).toContain("| 1 | 2 |");
  });

  // The same in the html, where every cell already says which column it is — so
  // the drop is exact rather than a second count of the same pipes.
  it("reads the html the same way", () => {
    const html = renderMarkdown(summary(), () => null, { navDepth: 4, idPrefix: "p-" }).html;
    const { text, dropped } = dropInstanceColumns(html, new Set(["prod"]));
    expect(dropped).toEqual(["local"]);
    expect(text).toContain("357");
    expect(text).not.toContain("376");
    // …and the table after it keeps both of its own columns.
    expect(text).toContain(">a<");
    expect(text).toContain(">b<");
  });

  it("changes nothing when every environment is delivered", () => {
    const whole = summary();
    expect(dropInstanceColumns(whole, new Set(["local", "prod"])).text).toBe(whole);
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

  // THE WIRING, end to end: a narrowed delivery's summary counts only what it
  // delivers. Without this nothing checked that restrict asks for the column
  // drop at all — the sections would go and the numbers would stay.
  it("narrows the summary's columns as well as the sections", () => {
    const { input } = restrictInstances(model(), ["prod"]);
    const doc = (input as { sheets: { document: { html: string; markdown: string } }[] }).sheets[0]!.document;
    for (const text of [doc.markdown, doc.html]) {
      expect(text).toContain("357");
      expect(text, "the undelivered environment's count is still there").not.toContain("376");
    }
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
