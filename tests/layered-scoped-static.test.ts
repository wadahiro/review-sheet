// A COMPONENT THAT EXISTS IN ONE ENVIRONMENT AND NOT ANOTHER.
//
// `static_files[].instances` was written for the ansible recipe's migration
// sheets and lived there, so a `layered` sheet could not say it — and on a
// layered sheet the static files ARE the configuration, which makes it the only
// place the fact could have been stated. Undeclared, every row of a client
// deployed to one environment reads as a shared value, and the sheet records
// that the client exists in the other one too.
//
// The folding reads nothing either recipe knows: entries in, entries out. It
// belongs to whichever owns `static_files`, which is this one.

import { describe, it, expect } from "bun:test";
import "../src/recipes/index.js";
import { getRecipe } from "../src/recipe";
import type { RecipeIO } from "../src/recipe";
import type { SheetInputs } from "../src/assemble";

const FILES: Record<string, string> = {
  "shared.yml": "clients:\n  - clientId: client-shared\n    name: Shared\n",
  "one.yml": "clients:\n  - clientId: client-one\n    name: Only in envA\n",
  "other.yml": "clients:\n  - clientId: client-one\n    name: Also in envB\n",
};

const io: RecipeIO = {
  readFile: (p: string) => FILES[p.split("/").pop() ?? p] ?? null,
  specDir: "/spec",
  resolve: (p: string) => p,
  instances: ["envA", "envB"],
} as never;

// `only` names the members each case's files actually produce — a split that
// selects a member nothing produced is its own error, and it fires first.
const spec = (files: unknown, only: string[]) => ({
  name: "clients",
  recipe: "layered",
  split: { at: "clients", by: "clientId", only },
  static_files: files,
});

const load = (files: unknown, only: string[] = ["client-shared", "client-one"]): SheetInputs =>
  getRecipe("layered")!.load(spec(files, only) as never, io) as SheetInputs;
const rowFor = (out: SheetInputs, key: string) => out.embedded.filter((e) => e.key.endsWith(key));

const SCOPED = [
  { path: "shared.yml", include: ["**"], members_only: true },
  { path: "one.yml", include: ["**"], members_only: true, instances: ["envA"] },
];

describe("a static file that names the environments it is the configuration for", () => {
  it("is accepted by the layered recipe", () => {
    expect(() => load(SCOPED)).not.toThrow();
  });

  // The row exists in envA and nowhere else, which is what the sheet has to
  // record — not a value that reads as holding in both.
  it("makes its rows per-environment", () => {
    const row = rowFor(load(SCOPED), "name").find((e) => e.source.file === "one.yml")!;
    expect(row.instances).toEqual([{ name: "envA", value: "Only in envA", source: row.source }]);
  });

  // …and says outright that an environment it leaves out does not have the row,
  // rather than leaving a blank a reader has to interpret.
  it("says an unlisted environment does not have the row", () => {
    const row = rowFor(load(SCOPED), "name").find((e) => e.source.file === "one.yml")!;
    expect(row.absent_where_unlisted).toBe(true);
  });

  // An unscoped file is a FILE of the sheet, exactly as before: several of them
  // stay several sections. The two shapes are not unified — an entry opts in.
  it("leaves an unscoped file alone", () => {
    const row = rowFor(load(SCOPED), "name").find((e) => e.source.file === "shared.yml")!;
    expect(row.instances).toBeUndefined();
    expect(row.absent_where_unlisted).toBeUndefined();
  });

  // Two files of the same component, each one environment's: the rows join,
  // each carrying its own value and its own site.
  it("joins two scoped files of the same component", () => {
    const out = load(
      [
        { path: "one.yml", include: ["**"], members_only: true, instances: ["envA"] },
        { path: "other.yml", include: ["**"], members_only: true, instances: ["envB"] },
      ],
      ["client-one"]
    );
    const rows = rowFor(out, "name");
    expect(rows).toHaveLength(1);
    expect(rows[0].instances?.map((i) => `${i.name}=${i.value}`)).toEqual(["envA=Only in envA", "envB=Also in envB"]);
  });

  it("refuses two files both claiming one environment", () => {
    expect(() =>
      load(
        [
          { path: "one.yml", include: ["**"], members_only: true, instances: ["envA"] },
          { path: "other.yml", include: ["**"], members_only: true, instances: ["envA"] },
        ],
        ["client-one"]
      )
    ).toThrow(/two files cannot both be that environment's configuration/);
  });

  // A name this sheet does not have would scope the file to nothing and empty
  // it in silence.
  it("refuses an environment this sheet does not have", () => {
    expect(() => load([{ path: "one.yml", include: ["**"], members_only: true, instances: ["envC"] }], ["client-one"])).toThrow(
      /declares instances envC/
    );
  });

  // The message names the recipe the reader is actually using.
  it("says which recipe refused it", () => {
    expect(() => load([{ path: "one.yml", include: ["**"], members_only: true, instances: ["envC"] }], ["client-one"])).toThrow(
      /^layered recipe:/
    );
  });
});

// …and it has to reach the SPEC, which is where the reporter hit it: a recipe's
// schema is checked when the build spec is loaded, not when `load` is called,
// so every assertion above passes with the field still refused by the schema.
describe("the field the build spec accepts", () => {
  const SPEC = "/p/build.yml";
  const yaml = (instances: string) => `
version: 1
metadata: { title: t, project: p }
instances: [envA, envB]
enrich:
  project: /p/sheet.yml
sheets:
  - name: clients
    recipe: layered
    split: { at: clients, by: clientId, only: ["client-one"] }
    static_files:
      - path: /p/one.yml
        include: ["**"]
        members_only: true
        ${instances}
`;
  const disk: Record<string, string> = {
    "/p/one.yml": "clients:\n  - clientId: client-one\n    name: Only in envA\n",
    "/p/sheet.yml": "sheets:\n  clients:\n    params:\n      name: { description: { en: n, ja: n } }\n",
  };
  const loadSpec = async (instances: string) => {
    const { loadBuildSpec } = await import("../src/spec");
    return loadBuildSpec(SPEC, { readFile: (p: string) => (p === SPEC ? yaml(instances) : (disk[p] ?? null)) });
  };

  it("takes instances on a layered static file", async () => {
    await expect(loadSpec("instances: [envA]")).resolves.toBeDefined();
  });

  // The shape without it is unchanged, so the test above is about `instances:`
  // and not about the entry.
  it("still takes one without", async () => {
    await expect(loadSpec("")).resolves.toBeDefined();
  });
});
