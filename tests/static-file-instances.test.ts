// A STATIC FILE THAT IS ONE ENVIRONMENT'S SLICE OF A COMPONENT.
//
// A migration sheet puts two releases side by side, and each release has its
// own environments — an on-premises `dev`/`prod` against a cloud `local`/`poc`,
// sharing no name, which is what a migration usually looks like. The new side
// is rendered per environment from overlays; the old side is whatever was
// recorded, and that can be a plain file per environment rather than a
// template.
//
// So a `static_files` entry may say WHICH environments it is the configuration
// for. Its rows then carry a value per environment and join the same rows from
// its siblings, which is what stacks them in the component's own cell.
//
// An entry that says nothing changes nothing: several unscoped files of one
// component stay several sections, one per file, which is what a legacy sheet
// built from a handful of recorded files wants. The two shapes are not
// unified — an entry opts in.

import { describe, it, expect } from "bun:test";
import "../src/recipes/index.js";
import { getRecipe } from "../src/recipe";
import type { RecipeIO } from "../src/recipe";

const FILES: Record<string, string> = {
  "defaults.yml": "{}\n",
  "dev.properties": "port=9090\nloglevel=debug\n",
  "prod.properties": "port=80\n",
  "other.properties": "port=8080\n",
};

const io = (instances: string[]): RecipeIO =>
  ({
    readFile: (p: string) => FILES[p.split("/").pop() ?? p] ?? null,
    specDir: "/spec",
    resolve: (p: string) => p,
    instances,
  }) as never;

const load = (staticFiles: unknown[], instances = ["dev", "prod"]) =>
  getRecipe("ansible")!.load(
    { name: "legacy", recipe: "ansible", rows: "artifact", defaults: "defaults.yml", static_files: staticFiles } as never,
    io(instances)
  );

const rows = (staticFiles: unknown[], instances?: string[]) =>
  (load(staticFiles, instances).embedded ?? []).map((e) => ({
    key: e.key,
    file: e.source?.file,
    instances: (e.instances ?? []).map((i) => [i.name, i.value] as const),
  }));

describe("a scoped static file", () => {
  it("gives its rows a value per environment it names", () => {
    const got = rows([{ path: "dev.properties", component: "v1", instances: ["dev"] }]);
    expect(got.find((r) => r.key === "port")?.instances).toEqual([["dev", "9090"]]);
  });

  // The join. Two files, one row, one value each — which is what stacks them
  // in the component's cell rather than opening two sections.
  it("joins the same row from another environment's file", () => {
    const got = rows([
      { path: "dev.properties", component: "v1", instances: ["dev"] },
      { path: "prod.properties", component: "v1", instances: ["prod"] },
    ]);
    expect(got.filter((r) => r.key === "port")).toHaveLength(1);
    expect(got.find((r) => r.key === "port")?.instances).toEqual([
      ["dev", "9090"],
      ["prod", "80"],
    ]);
  });

  // A key one environment's file has and another's does not is absent there,
  // and the instance list says so by leaving it out.
  it("leaves out an environment whose file does not have the row", () => {
    const got = rows([
      { path: "dev.properties", component: "v1", instances: ["dev"] },
      { path: "prod.properties", component: "v1", instances: ["prod"] },
    ]);
    expect(got.find((r) => r.key === "loglevel")?.instances).toEqual([["dev", "debug"]]);
  });

  // The list IS the presence list, the same statement a scoped template makes:
  // an environment it leaves out does not have this line. Without it one side
  // of a comparison said "not in this environment's file" and the other said
  // nothing, which reads as two findings rather than one shape.
  it("says the environments it leaves out do not have the row", () => {
    const got = load([
      { path: "dev.properties", component: "v1", instances: ["dev"] },
      { path: "prod.properties", component: "v1", instances: ["prod"] },
    ]).embedded!;
    expect(got.every((e) => e.absent_where_unlisted === true)).toBe(true);
  });

  // THE REGRESSION GUARD. An entry that declares nothing is a FILE of the
  // sheet, and several of them stay several sections — which is what a legacy
  // sheet built from recorded files wants, and what this must not take away.
  it("leaves unscoped files as the separate files they are", () => {
    const got = rows([
      { path: "dev.properties", component: "v1" },
      { path: "prod.properties", component: "v1" },
    ]);
    expect(got.filter((r) => r.key === "port")).toHaveLength(2);
    expect(got.map((r) => r.file).sort()).toContain("prod.properties");
    expect(got.every((r) => r.instances.length === 0)).toBe(true);
    // …and claims nothing about environments either: an unscoped file is not a
    // statement about any of them.
    expect(load([{ path: "dev.properties", component: "v1" }]).embedded!.every((e) => e.absent_where_unlisted === undefined)).toBe(true);
  });

  // Two files both claiming to be one environment's configuration is the spec
  // contradicting itself, and quietly picking one is the failure that hides.
  it("refuses two files that both claim one environment", () => {
    expect(() =>
      rows([
        { path: "dev.properties", component: "v1", instances: ["dev"] },
        { path: "other.properties", component: "v1", instances: ["dev"] },
      ])
    ).toThrow(/both give dev a value for "port"/);
  });

  // The same check `templates[].instances` gets: a name this sheet does not
  // have would otherwise scope the file to nothing and empty it in silence.
  it("refuses an environment this sheet does not have", () => {
    expect(() => rows([{ path: "dev.properties", component: "v1", instances: ["nope"] }])).toThrow(
      /declares instances nope, which this sheet does not have/
    );
  });

  // Nothing scoped, nothing touched.
  it("changes nothing on a sheet that scopes none of them", () => {
    const before = rows([{ path: "dev.properties", component: "v1" }]);
    expect(before.every((r) => r.instances.length === 0)).toBe(true);
  });
});
