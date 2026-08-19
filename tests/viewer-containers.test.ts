// What a block looks like on the sheet.
//
// The requirement was stated as a picture: an ordinary table row, with the
// settings inside a block indented under it — the shape the spreadsheets this
// replaces had, where a merged header cell sat above its group. So these assert
// the picture, and one thing behind it: the row's identity does not change when
// its display gets shorter.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root } from "../src/html/app";
import type { ParameterSheetInput } from "../src/types";

const SHEET: ParameterSheetInput = {
  metadata: { title: "t" },
  sheets: [
    {
      name: "web",
      categories: [
        {
          name: "/etc/httpd/conf/httpd.conf",
          params: [
            { key: "ServerName", value: "example.invalid", description: "the host name" },
            {
              key: `Directory["/var/www"]`,
              container: { name: "Directory" },
              container_path: [],
              value: `"/var/www"`,
              description: "the directory this block governs",
            },
            {
              key: `Directory["/var/www"].AllowOverride`,
              container_path: [{ path: `Directory["/var/www"]`, name: "Directory" }],
              value: "None",
              description: "what .htaccess may override",
            },
            {
              key: `Directory["/var/www"].RequireAll.Require`,
              container_path: [{ path: `Directory["/var/www"]`, name: "Directory" }, { path: `Directory["/var/www"].RequireAll`, name: "RequireAll" }],
              value: "ip 10.0.0.0/8",
              description: "an access condition",
            },
          ],
        },
      ],
    },
  ],
};

let host: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  // The viewer opens on the overview tab when the document has metadata.
  location.hash = "#1";
  host = document.createElement("div");
  document.body.appendChild(host);
  const payload = { metadata: SHEET.metadata, versions: [{ version: "current", sheets: SHEET.sheets }] };
  render(h(Root, { payload, reviewEnabled: true, editEnabled: false, initialLang: "ja", server: false }), host);
});
afterEach(() => {
  render(null, host);
  host.remove();
});

const rows = (): HTMLElement[] => [...host.querySelectorAll("tr.rs-param-row")] as HTMLElement[];
const keyOf = (r: HTMLElement): string => (r.querySelector(".rs-col-key code")?.textContent ?? "").trim();

describe("a block on the sheet", () => {
  // The complaint that started this: every setting repeated the block in its
  // own name, so the key column read `Directory["/var/www"].AllowOverride` down
  // the page and the actual setting was the last word of it.
  // A block shows what KIND it is and puts its argument in the value column;
  // a setting shows only what it adds to the block it sits in.
  it("shows only what each row adds to its block", () => {
    expect(rows().map(keyOf)).toEqual(["ServerName", "Directory", "AllowOverride", "RequireAll", "Require"]);
  });

  // `RequireAll` is drawn from the chain, not emitted as a row: there is no
  // decision in it beyond the fact that it groups, so nothing is keyed by it,
  // no dictionary owes it a description and it has no review target. Leaving it
  // out entirely was worse — the condition below it was pushed two levels in
  // with one heading above it, and the missing level explained nothing.
  it("draws a block with no argument without making it a row", () => {
    const requireAll = rows().find((r) => keyOf(r) === "RequireAll")!;
    expect(requireAll.classList.contains("rs-row-structure")).toBe(true);
    expect(requireAll.querySelector("button")).toBeNull();
  });

  // Same grammar for both kinds: an ordinary row, indented by how deep it sits.
  it("indents by how many blocks enclose the row", () => {
    expect(rows().map((r) => r.style.getPropertyValue("--rs-block-depth"))).toEqual(["", "", "1", "1", "2"]);
  });

  // Every indent step has something above it explaining what it is.
  it("leaves no indent step unaccounted for", () => {
    const depths = rows().map((r) => Number(r.style.getPropertyValue("--rs-block-depth") || 0));
    for (let i = 1; i < depths.length; i++) expect(depths[i] - depths[i - 1]).toBeLessThanOrEqual(1);
  });

  it("marks a block so it reads as one, without a tint that means a state", () => {
    expect(rows().map((r) => r.classList.contains("rs-row-container"))).toEqual([false, true, false, true, false]);
  });

  // A block with no argument has nothing to put in the value column, and the
  // paper sheets left it empty too — it is not a gap to fill.
  it("leaves a block with no argument valueless, and shows the argument of one that has it", () => {
    const cells = rows().map((r) => (r.querySelector(".rs-col-value")?.textContent ?? "").trim());
    expect(cells[1]).toContain("/var/www");
    expect(cells[3]).toBe("");
  });

  // The display got shorter; the identity did not. Everything outside this
  // table — the review dialog, the AI prompt, apply's own lookup — still names
  // the row in full, which is the string a source map resolves by.
  // NOT covered here: the copy button and the review dialog hand over the
  // DISPLAYED text rather than the key (see ReviewableCell's effectiveValue).
  // The toolbar is a portal that only exists while a cell is pointed at, and
  // waking it from this harness took more machinery than the one-line rule is
  // worth — so it is verified by looking, and said here rather than pinned by a
  // test that would only assert the harness.
  it("keeps the full key as the row's identity", () => {
    const anchors = rows().map((r) => r.id);
    expect(anchors.some((a) => a.includes("AllowOverride"))).toBe(true);
    expect(keyOf(rows()[2])).toBe("AllowOverride");
  });
});

describe("a filter and the blocks a surviving row hangs under", () => {
  // The unset-rows filter hides the `RequireAll` block, and the condition
  // inside it survives. Dropping the block would leave that condition indented
  // under nothing, and the reader with no way to tell which grouping governs
  // it — the question container rows exist to answer.
  it("keeps a block whose contents survived the filter", () => {
    const keys = rows().map(keyOf);
    expect(keys).toContain("RequireAll");
    expect(keys).toContain("Require");
  });

  // Re-admitted, not re-ordered: a block still sits above what it holds.
  it("puts the re-admitted block back above its contents", () => {
    const keys = rows().map(keyOf);
    expect(keys.indexOf("RequireAll")).toBeLessThan(keys.indexOf("Require"));
  });
});

// `@` marks an ATTRIBUTE in this tool's path grammar, because an attribute and
// a child element of the same name would otherwise share an address. The file
// writes `max-count="10000"`; the marker is the tool's, and the key column shows
// the file's words.
describe("an address marker that is not the file's", () => {
  const XML: ParameterSheetInput = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "cache",
        categories: [
          {
            name: "cache-ispn.xml",
            params: [
              {
                key: "infinispan.local-cache[name=realms]",
                container: { name: "local-cache" },
                value: "realms",
                description: "the cache this block configures",
              },
              {
                key: "infinispan.local-cache[name=realms].memory.@max-count",
                container_path: [
                  { path: "infinispan.local-cache[name=realms]", name: "local-cache" },
                  { path: "infinispan.local-cache[name=realms].memory", name: "memory" },
                ],
                value: "10000",
                description: "entries held",
              },
            ],
          },
        ],
      },
    ],
  };
  let h2: HTMLElement;
  beforeEach(() => {
    render(null, host);
    h2 = document.createElement("div");
    document.body.appendChild(h2);
    render(h(Root, { payload: { metadata: XML.metadata, versions: [{ version: "current", sheets: XML.sheets }] }, reviewEnabled: true, editEnabled: false, initialLang: "ja", server: false }), h2);
  });
  afterEach(() => {
    render(null, h2);
    h2.remove();
  });
  const xmlRows = (): HTMLElement[] => [...h2.querySelectorAll("tr.rs-param-row")] as HTMLElement[];

  it("shows an attribute by the name the file writes", () => {
    const keys = xmlRows().map((r) => (r.querySelector(".rs-col-key code")?.textContent ?? "").trim());
    expect(keys).toContain("max-count");
    expect(keys).not.toContain("@max-count");
  });

  // Display only. Everything that resolves the row — apply, verify, a review
  // target — still uses the key with the marker in it.
  it("keeps the marker in the row's identity", () => {
    const row = xmlRows().find((r) => (r.querySelector(".rs-col-key code")?.textContent ?? "").trim() === "max-count")!;
    // The anchor id percent-escapes the key, so the marker survives as %40.
    expect(row.id).toContain("_40max-count");
  });
});
