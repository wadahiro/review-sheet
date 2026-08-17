// The document recipe: a sheet that is prose. What it must get right is not the
// markdown (tests/markdown.test.ts covers that) but the two things that make it
// a SHEET — it reaches the model with no rows and breaks nothing on the way,
// and it refuses to produce a document whose images would not travel with it.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { documentRecipe } from "../src/recipes/document";
import { assembleSheets } from "../src/assemble";
import type { RecipeIO } from "../src/recipe";

beforeEach(stubNonBuiltInProviders);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function io(files: Record<string, string>, binaries: Record<string, Uint8Array> = {}): RecipeIO {
  return {
    readFile: (p) => files[p] ?? null,
    readBinary: (p) => binaries[p] ?? null,
    specDir: "/spec",
    resolve: (p) => p,
    instances: ["production"],
  };
}

describe("document recipe", () => {
  it("produces a sheet with a document and no rows", () => {
    const si = documentRecipe.load(
      { name: "移行方針", file: "docs/policy.md" },
      io({ "docs/policy.md": "# 移行方針\n\n本文。\n" })
    );
    expect(si.name).toBe("移行方針");
    expect(si.layers).toEqual([]);
    expect(si.document?.html).toContain("<h1");
    expect(si.document?.headings?.map((h) => h.text)).toEqual(["移行方針"]);
  });

  it("resolves an image against the MARKDOWN's directory, not the spec's", () => {
    // `docs/policy.md` referencing `img/x.png` means `docs/img/x.png`, the way
    // every markdown editor already reads it.
    const si = documentRecipe.load(
      { name: "d", file: "docs/policy.md" },
      io({ "docs/policy.md": "![x](img/x.png)" }, { "docs/img/x.png": PNG })
    );
    expect(si.document?.html).toContain("data:image/png;base64,iVBORw==");
  });

  it("fails the build when an image is missing, naming every one of them", () => {
    // A silently broken diagram is the loss this tool exists to prevent, and
    // one build should not have to be run four times to find four bad paths.
    expect(() =>
      documentRecipe.load(
        { name: "d", file: "docs/policy.md" },
        io({ "docs/policy.md": "![a](gone.png)\n\n![b](also-gone.png)" })
      )
    ).toThrow(/gone\.png, also-gone\.png/);
  });

  it("refuses a remote image rather than making the deliverable fetch when opened", () => {
    expect(() =>
      documentRecipe.load(
        { name: "d", file: "docs/policy.md" },
        io({ "docs/policy.md": "![a](https://example.com/x.png)" })
      )
    ).toThrow(/self-contained/);
  });

  it("says which markdown file is missing", () => {
    expect(() => documentRecipe.load({ name: "d", file: "docs/nope.md" }, io({}))).toThrow(/docs\/nope\.md/);
  });

  it("honours nav_depth", () => {
    const si = documentRecipe.load(
      { name: "d", file: "m.md", nav_depth: 1 },
      io({ "m.md": "# A\n\n## B\n" })
    );
    expect(si.document?.headings?.map((h) => h.text)).toEqual(["A"]);
  });

  it("rejects a field it does not define", () => {
    // The spec loader validates recipe fields against this schema; a typo that
    // parsed would be a setting that silently did nothing.
    const props = (documentRecipe.schema as { properties: Record<string, unknown>; additionalProperties: boolean });
    expect(props.additionalProperties).toBe(false);
    expect(Object.keys(props.properties).sort()).toEqual(["file", "nav_depth"]);
  });
});

describe("a document sheet reaching the model", () => {
  const build = () =>
    assembleSheets(
      [
      documentRecipe.load({ name: "policy", file: "m.md" }, io({ "m.md": "# A\n\n本文\n" })),
      {
        name: "params",
        instances: ["production"],
        layers: [{ kind: "base", entries: new Map([["port", { value: "8080", source: { file: "b.yml", line: 1 } }]]) }],
        embedded: [],
      },
      ],
      {
        projectPath: "project.yml",
        readFile: (p) => (p === "project.yml" ? "params:\n  port:\n    category: Server\n" : null),
        strictMetadata: false,
      }
    );

  it("keeps its place among ordinary sheets, with no categories", () => {
    const input = build();
    expect(input.sheets.map((s) => s.name)).toEqual(["policy", "params"]);
    expect(input.sheets[0].categories).toEqual([]);
    expect(input.sheets[0].document?.html).toContain("<h1");
  });

  it("does not disturb the sheet that does have rows", () => {
    // The point of short-circuiting a document early is that every check the
    // assembler makes still runs for everything else.
    const input = build();
    expect(input.sheets[1].categories.length).toBeGreaterThan(0);
  });
});

// Heading ids have to be unique across the whole document, and a heading text
// is not: three sheets that each write "## ツリー" would otherwise carry one id
// between them. Only the active sheet's body is in the DOM, so it is not the
// body that breaks — the outline lists every sheet's entries at once and marks
// the current one by comparing ids, so one id shared by three lights all three.
describe("document recipe: heading ids across sheets", () => {
  const md = "# A\n\n## ツリー\n";
  const load = (name: string) =>
    documentRecipe.load({ name, file: "m.md" }, io({ "m.md": md }));

  it("namespaces them by sheet, so the same heading text does not collide", () => {
    const a = load("os directory aws").document?.headings?.map((h) => h.id) ?? [];
    const b = load("os directory db").document?.headings?.map((h) => h.id) ?? [];
    expect(a.some((id) => b.includes(id))).toBe(false);
    expect(a).toContain("rs-doc-os-directory-aws-ツリー");
  });

  it("puts the same ids in the HTML as in the headings it reports", () => {
    // An outline entry pointing at an id the page does not carry goes nowhere.
    const si = load("os directory aws");
    for (const h of si.document?.headings ?? []) {
      expect(si.document?.html).toContain(`id="${h.id}"`);
    }
  });

  it("keys on the sheet's name, not its position", () => {
    // A prefix keyed on declaration order would re-point every anchor the
    // moment a sheet is inserted above this one.
    expect(load("os directory db").document?.headings?.[0].id).toBe("rs-doc-os-directory-db-A");
  });
});
