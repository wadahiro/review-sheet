// Pluggable SheetRecipe registry: mirrors src/parser.ts's shape (register /
// get / list, replace-by-name), but for the `import --spec` conversion path
// instead of config-format extraction.
//
// A recipe turns one sheet's recipe-specific fields from a `build.yml` (see
// spec.ts) into a `SheetInputs` (src/assemble.ts) — the extraction adapters
// (extract.ts) still do the actual per-format parsing; a recipe is the glue
// that knows how a particular IaC tool (e.g. Ansible) lays out its base +
// per-instance override files and hands the result to assembleSheets().
//
// Unlike ConfigParser, there is no content-detection: a sheet always names its
// recipe explicitly in the spec, so resolution is a plain by-name lookup.

import type { SheetInputs } from "./assemble.js";
import { sharedRegistry } from "./registry.js";
import type { ExtractOptions } from "./parser.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export type RecipeIO = {
  readFile: (path: string) => string | null; // sync, like every other injected I/O in this repo
  specDir: string; // absolute directory of the build.yml this sheet came from
  resolve: (p: string) => string; // specDir-relative path -> absolute
  instances: string[]; // this SHEET's instances (ordered) — already resolved from the
  // sheet's own `instances`, falling back to the spec's top-level default (see
  // spec.ts's BuildSpec.sheets[].instances and assemble-spec.ts). A recipe has
  // no other way to see them, since it only receives its own sheet's fields,
  // and needs none of the override logic — it just reads this field.
  // The build.yml/CLI-level extraction configuration (id_fields, an
  // annotation marker override) this sheet's recipe should hand to every
  // `extractFile()` call it makes, as ordinary data — see the
  // `assembleFromSpecWithReport` comment in assemble-spec.ts for where this
  // is built, and extract.ts's `resolveIdFields` writeup for why. A recipe
  // that ignores this (or calls `extractFile(content, file)` with no fourth
  // argument at all) simply extracts with the built-in identity fields and
  // the default "@rs" marker — there is no process-wide fallback.
  extractOptions?: ExtractOptions;
  // The BUILD's language (spec.ts's `enrich.lang`, or the CLI's --lang). A
  // recipe needs it only where it produces a plain string the model has no
  // LangText slot for — a category name, which types.ts's Category holds as a
  // bare string, so the language is chosen once at build time rather than
  // switched per viewer.
  lang?: "ja" | "en";
  // The sheet's `component:` declaration (spec.ts). Every sheet has one; only a
  // recipe that reads a structured artifact can act on the DERIVED form (a
  // transform over the source path — see recipes/snapshot.ts). A recipe that
  // ignores this is not wrong: a literal declaration is applied centrally, in
  // assemble-spec.ts, because it says the same thing about every row and needs
  // nothing from the recipe to do it.
  component?: Record<string, unknown>;
  // The spec's `data_maps:` — paths whose CHILDREN are data rather than fields
  // of a schema (Keycloak's `attributes`, any free-form map). A key under one
  // is spelled `attributes["saml.client.signature"]` instead of dotted, so a
  // dotted data key is not read as structure.
  //
  // A fact about the config file's SHAPE, exactly like `id_fields`, and here
  // for the same reason: YAML cannot say it, and it has to be known while the
  // KEY is formed. It deliberately cannot come from the bound dictionary —
  // spelling driven by a dictionary would make row identity a function of
  // which dictionary version is bound, and a free-form map's coverage is
  // partial by nature, so known keys would come out bracketed and unknown ones
  // dotted.
  dataMaps?: string[];
};

export type SheetRecipe = {
  name: string;
  schema: object; // ajv JSON Schema for the sheet's recipe-specific fields
  load: (sheetSpec: Record<string, JsonValue>, io: RecipeIO) => SheetInputs; // sync
};

// Process-wide, so a plugin that resolved its own copy of this module still
// registers into the array the CLI reads — see registry.ts.
const registry = sharedRegistry<SheetRecipe>("review-sheet.recipes.v1");

export function registerRecipe(r: SheetRecipe): void {
  const i = registry.findIndex((x) => x.name === r.name);
  if (i >= 0) registry[i] = r;
  else registry.push(r);
}

export function listRecipes(): SheetRecipe[] {
  return [...registry];
}

export function getRecipe(name: string): SheetRecipe | undefined {
  return registry.find((r) => r.name === name);
}
