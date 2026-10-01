// WHO CITES THIS LINE — the inverse of the link a record carries.
//
// An observed document is reached from a verdict and from nowhere else, which
// read from the other end leaves a real question unanswered: a reader partway
// down a 5,000-line plan wants to know whether the line in front of them is one
// some item was judged on, and which.
//
// NOT by giving lines keys. A key asserts "this line IS that row's value", and
// the no-keys invariant exists so a row can never route to an observed copy of a
// file. A citation is a different fact, and it is naturally many-to-many where a
// key is one-to-one — so the many-citers case needs no special handling.

import { describe, it, expect } from "bun:test";
import { buildCitationIndex, citationKey } from "../src/html/citations";
import { paramAnchorId } from "../src/html/anchors";

const ref = (id: string, line?: number): string => `rs-evidence:${encodeURIComponent(line === undefined ? id : `${id}#L${line}`)}`;
const ID = "observed poc terraform show -json";

const record = (rows: { line: number; no: string; what: string; cite: string }[]) =>
  `<table><tbody>${rows
    .map((r) => `<tr data-rs-line="${r.line}"><td>${r.no}</td><td>${r.what}</td><td><a href="${r.cite}">x</a></td></tr>`)
    .join("")}</tbody></table>`;

describe("the citation index", () => {
  it("finds a record's citation, keyed by document AND line", () => {
    const idx = buildCitationIndex([
      { name: "rec", document: { html: record([{ line: 84, no: "5", what: "keycloak.service", cite: ref(ID, 3) }]) } },
    ]);
    expect([...idx.keys()]).toEqual([citationKey(ID, 3)]);
    expect(idx.get(citationKey(ID, 3))).toEqual([
      { sheet: "rec", sheetIndex: 0, address: "rs-doc-line:0:84", label: "5 keycloak.service" },
    ]);
  });

  // A LINE, not a file: the whole point is to answer for the line in front of
  // the reader, so two lines of one document are two different answers.
  it("keeps two lines of one document apart", () => {
    const idx = buildCitationIndex([
      {
        name: "rec",
        document: {
          html: record([
            { line: 10, no: "1", what: "a", cite: ref(ID, 3) },
            { line: 11, no: "2", what: "b", cite: ref(ID, 9) },
          ]),
        },
      },
    ]);
    expect(idx.get(citationKey(ID, 3))?.[0]!.label).toBe("1 a");
    expect(idx.get(citationKey(ID, 9))?.[0]!.label).toBe("2 b");
  });

  // MANY-TO-MANY IS THE SHAPE. Ten lines of one real delivery are cited twice.
  it("carries every verdict decided on one line", () => {
    const idx = buildCitationIndex([
      {
        name: "rec",
        document: {
          html: record([
            { line: 103, no: "24", what: "secrets.sh", cite: ref(ID, 23) },
            { line: 104, no: "25", what: "secrets.sh", cite: ref(ID, 23) },
          ]),
        },
      },
    ]);
    expect(idx.get(citationKey(ID, 23))?.map((c) => c.label)).toEqual(["24 secrets.sh", "25 secrets.sh"]);
  });

  // …and the SAME row citing one line twice is one answer: a record prints every
  // host that answered in a single cell, and a reader choosing where to go must
  // not be offered the same place twice.
  it("says one place once", () => {
    const html = `<table><tbody><tr data-rs-line="7"><td>1</td><td>a</td><td><a href="${ref(ID, 3)}">x</a><a href="${ref(ID, 3)}">y</a></td></tr></tbody></table>`;
    const idx = buildCitationIndex([{ name: "rec", document: { html } }]);
    expect(idx.get(citationKey(ID, 3))).toHaveLength(1);
  });

  // AN ORDINARY VALUE SHEET'S CELLS cite evidence too, and its rows are
  // addressed by id rather than by line — the one difference between the two.
  it("finds a citation in a table cell, addressed by the row's id", () => {
    const idx = buildCitationIndex([
      {
        name: "aws",
        categories: [{ name: "alb", params: [{ key: "idle_timeout", remarks: `[plan](${ref(ID, 5134)})` }] }],
      },
    ]);
    expect(idx.get(citationKey(ID, 5134))).toEqual([
      { sheet: "aws", sheetIndex: 0, address: paramAnchorId(0, "alb", "idle_timeout"), label: "idle_timeout" },
    ]);
  });

  it("reaches a param nested under a subcategory", () => {
    const idx = buildCitationIndex([
      {
        name: "aws",
        categories: [{ name: "alb", categories: [{ name: "listener", params: [{ key: "port", remarks: `[p](${ref(ID, 2)})` }] }] }],
      },
    ]);
    expect(idx.get(citationKey(ID, 2))?.[0]!.address).toBe(paramAnchorId(0, "alb / listener", "port"));
  });

  // A document cited from a sheet the reader does not have open is why this is
  // built over the MODEL and not over the rendered page.
  it("spans sheets", () => {
    const idx = buildCitationIndex([
      { name: "rec", document: { html: record([{ line: 3, no: "1", what: "a", cite: ref(ID, 7) }]) } },
      { name: "aws", categories: [{ name: "alb", params: [{ key: "k", remarks: `[p](${ref(ID, 7)})` }] }] },
    ]);
    expect(idx.get(citationKey(ID, 7))?.map((c) => c.sheet)).toEqual(["rec", "aws"]);
  });

  it("says nothing about a delivery that cites nothing", () => {
    expect(buildCitationIndex([{ name: "s", categories: [{ name: "c", params: [{ key: "k", value: "1" }] }] }]).size).toBe(0);
  });

  // A citation with no line names the document itself, which is still an answer.
  it("keys a line-less citation by the document alone", () => {
    const idx = buildCitationIndex([{ name: "rec", document: { html: record([{ line: 2, no: "1", what: "a", cite: ref(ID) }]) } }]);
    expect([...idx.keys()]).toEqual([ID]);
  });
});
