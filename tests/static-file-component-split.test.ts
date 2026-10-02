// A FILE CANNOT BOTH NAME ITS COMPONENT AND BE DIVIDED BY THE SPLIT.
//
// `component:` on a static file means the sheet's own derivation is not
// consulted for it — the file owns its rows, the way a file with its own
// include/exclude owns its selection. A `split` on the same sheet says the
// opposite about those same rows: they belong to the members it finds in them.
//
// Undeclared, the contradiction surfaced far from its cause: nothing registered
// a member, so the split's `only:` list found that NOBODY produced the members
// it named, and the error read as a problem with a sheet-wide selection. The
// reader then goes looking at the list rather than at the one line that caused
// it.
//
// Refused rather than reconciled: no reading honours both, since a file holding
// several components is not one component's file.

import { describe, it, expect } from "bun:test";
import "../src/recipes/index.js";
import { getRecipe } from "../src/recipe";
import type { RecipeIO } from "../src/recipe";
import type { SheetInputs } from "../src/assemble";

const FILES: Record<string, string> = {
  "clients.yml": "clients:\n  - clientId: client-A\n    protocol: openid-connect\n  - clientId: client-B\n    protocol: saml\n",
  "vars.yml": "smtp_host: mail.example.com\n",
  // One key each, so nothing else goes wrong first: the sheet's own two rows
  // would key identically under one component, and that collision is a
  // different report.
  "one-each.yml": "clients:\n  - clientId: client-A\n    protocol: openid-connect\n  - clientId: client-B\n    rootUrl: https://b.example\n",
};

const io: RecipeIO = {
  readFile: (p: string) => FILES[p.split("/").pop() ?? p] ?? null,
  specDir: "/spec",
  resolve: (p: string) => p,
  instances: ["prod"],
} as never;

const load = (files: unknown[], only = ["client-A", "client-B"]): SheetInputs =>
  getRecipe("layered")!.load(
    { name: "clients", recipe: "layered", split: { at: "clients", by: "clientId", only }, static_files: files } as never,
    io
  ) as SheetInputs;

// The other shape of the same split: the members travel in the KEY (`as:
// prefix`) and the component slot is the SOURCE's — a sheet comparing two
// releases of the same list, each release one file.
const loadPrefixed = (files: unknown[]): SheetInputs =>
  getRecipe("layered")!.load(
    {
      name: "clients",
      recipe: "layered",
      split: { at: "clients", by: "clientId", as: "prefix", members: [{ id: "client-A" }, { id: "client-B" }] },
      static_files: files,
    } as never,
    io
  ) as SheetInputs;

describe("a static file the split divides", () => {
  const BOTH = [{ path: "clients.yml", include: ["**"], component: "client-A" }];

  it("is refused", () => {
    expect(() => load(BOTH)).toThrow(/cannot both name its component and be divided by the split/);
  });

  // EVERY member the split finds in the file, not whichever row came first:
  // "it is also client-B's" is the fact that makes the declaration wrong, and a
  // message naming only "client-A" restates the declaration back at its author.
  it("names every component the split assigns it to", () => {
    expect(() => load(BOTH)).toThrow(/"client-A", "client-B"/);
  });

  // WHAT IT REPLACES. With the file's rows claimed by its declaration, nothing
  // registers a member, so the split's `only:` list found that nobody produced
  // the members it names — a report about a sheet-wide selection, pointing
  // nowhere near the one line that caused it.
  it("replaces the report about the selection", () => {
    const one = [{ path: "one-each.yml", include: ["**"], component: "client-A" }];
    expect(() => load(one)).not.toThrow(/selects members no row produced/);
    expect(() => load(one)).toThrow(/cannot both name its component/);
  });

  it("says which recipe refused it", () => {
    expect(() => load(BOTH)).toThrow(/^layered recipe: sheet "clients"/);
  });
});

// Asked of the ROWS and not of the spec: a file that genuinely is one
// component's stays legal on a sheet whose other sources split, which is the
// ordinary shape — the list of components in one file, a component's own
// variables in another.
describe("a static file the split does not divide", () => {
  const MIXED = [
    { path: "clients.yml", include: ["**"] },
    { path: "vars.yml", include: ["**"], component: "client-A" },
  ];

  it("keeps its declared component", () => {
    const out = load(MIXED);
    const row = out.embedded.find((e) => e.key.endsWith("smtp_host"))!;
    expect(row.component).toBe("client-A");
  });

  it("leaves the split's own members alone", () => {
    const out = load(MIXED);
    const owners = new Set(out.embedded.filter((e) => e.source.file === "clients.yml").map((e) => e.component));
    expect([...owners].sort()).toEqual(["client-A", "client-B"]);
  });
});

// THE SHAPE THIS REFUSAL MUST NOT REACH, which is how it was found: a release
// comparison declares `as: prefix` precisely so the component slot is left to
// the source, and every one of its files names its own release. Nothing derives
// a component there — so a check that read the deriver's answer as one saw the
// untouched path and called it a component, refusing a real project's sheet
// with thirty of its own row addresses quoted back at it as component names.
describe("a split that leaves the component slot to the source", () => {
  const RELEASE = [{ path: "clients.yml", include: ["**"], component: "release-1" }];

  it("still takes a file that names its release", () => {
    expect(() => loadPrefixed(RELEASE)).not.toThrow();
  });

  it("files every row under that release", () => {
    const owners = new Set(loadPrefixed(RELEASE).embedded.map((e) => e.component));
    expect([...owners]).toEqual(["release-1"]);
  });

  // …and the members are still told apart, in the key, which is what makes the
  // two readings comparable at all.
  it("keeps the members apart in the key", () => {
    const keys = loadPrefixed(RELEASE).embedded.map((e) => e.key);
    expect(keys).toContain("client-A.protocol");
    expect(keys).toContain("client-B.protocol");
  });
});
