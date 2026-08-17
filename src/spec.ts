// BuildSpec: the declarative `build.yml` that drives `import --spec`. It
// names which recipe (see recipe.ts) builds each sheet, plus the
// assembleSheets-level options (instances, enrich sources, capabilities).
//
// All paths written in the spec are relative to the spec file's own
// directory. This loader resolves the spec-level path fields it knows about
// (enrich.project / enrich.metadata_dirs / enrich.argument_specs) to absolute
// paths; recipe-specific path fields are opaque to this loader — each recipe
// resolves its own via the `RecipeIO.resolve` it is handed.

import Ajv from "ajv";
import { keyTransformSchema } from "./keytransform.js";
import { parse } from "yaml";
import { dirname, resolve as resolvePath } from "node:path";
import { getRecipe, listRecipes, type JsonValue } from "./recipe.js";
import type { SheetDictionaryBinding } from "./assemble.js";
import { formatAjvErrors } from "./schema-errors.js";

export type BuildSpec = {
  version: 1;
  metadata?: { title?: string; project?: string; version?: string };
  // Required, ordered — the project's full, canonical environment set, and
  // every sheet's DEFAULT (see `sheets[].instances` below). Kept required
  // even though a spec whose every sheet declares its own instances would
  // not strictly need it: this is the one place a typo ("stagng") gets
  // caught, and the one place a reader sees the project's whole environment
  // list without scanning every sheet.
  instances: string[];
  enrich?: {
    project?: string;
    metadata_dirs?: string[];
    argument_specs?: string[];
    terraform_variables?: string[];
    lang?: "ja" | "en";
    // Language argument_specs.yml / variables.tf are actually WRITTEN in
    // (as opposed to `lang` above, which is the enrichment/UI language) —
    // see EnrichOptions.nativeLang in enrich.ts. Defaults to "en": both
    // formats are conventionally authored in English, but a team writing
    // them in Japanese can declare that here instead of the tool silently
    // assuming English.
    native_lang?: "ja" | "en";
    strict?: boolean;
  };
  capabilities?: { apply?: boolean };
  // Extra field names that identify an item of a list-of-maps, so its values get
  // a reorder-robust `[field=value]` path instead of a positional `[i]`. Tried
  // before the built-in name/id/key (see extract.ts's resolveIdFields). A
  // property of the project's DATA, so it belongs to the spec rather than to
  // every command line that builds from it.
  id_fields?: string[];
  data_maps?: string[];
  sheets: Array<
    {
      name: string;
      recipe: string;
      // Per-sheet override of the spec-level `instances` — findings #10: a
      // spec used to be forced to split (one build.yml per environment set)
      // whenever two sheets in the same project genuinely covered different
      // environments (Terraform run only in [staging, production], the
      // Ansible-rendered config in [local, staging, production]). Omitted =
      // inherit the spec's list verbatim.
      //
      // Design choices, and why:
      //  - MUST be a subset of `instances` above, not an independent list —
      //    otherwise a sheet-level typo creates a silent, unvalidated new
      //    environment axis instead of an error; `instances` stays the one
      //    place every environment name is spelled out and checked.
      //  - Its OWN order is authoritative when given (not filtered from the
      //    spec's order) — a sheet is free to present its columns in the
      //    order that reads best for it; nothing downstream assumes sheets
      //    within one build share a column order.
      instances?: string[];
      // This sheet's dictionary bindings — see SheetDictionaryBinding in
      // assemble.ts. Per-sheet, not spec-wide: a sheet's keys are matched
      // ONLY against the dictionaries it declares here (bindKey never sees a
      // sibling sheet's dictionary), and a binding's own `materialize` opts
      // that ONE dictionary into the exhaustive-ledger expansion — the two
      // facts ("this sheet binds product X" and "expand product X into this
      // sheet") used to be split across a spec-wide `dictionaries:` (in
      // sheet.yml) and a spec-wide `materialize:` (here), each restating the
      // same product+version, with nothing tying either to a specific sheet
      // beyond a repeated `sheet:` name field.
      dictionaries?: SheetDictionaryBinding[];
      // Display order for this sheet's top-level category tabs, and the
      // ansible recipe's under_key column, used to live here — moved to the
      // project metadata (sheet.yml's `categories:`/`under_key:`, or a
      // `sheets:`-doc's per-sheet fields — see providers/project.ts) in P7:
      // both are display facts about how a sheet is READ, the same kind of
      // fact `category:`/`out_of_scope:` already are, not about where its
      // data comes from. Splitting the assignment (sheet.yml) from the tab
      // order (here) let a second, easy-to-forget write silently produce a
      // "ghost tab" — a category nobody declared showing up with no error;
      // one file removes that failure mode outright.
    } & Record<string, JsonValue>
  >;
};

// `verbose: true` so an `additionalProperties` error carries `parentSchema`;
// `parentSchema` — formatAjvErrors uses it to list the schema's OWN declared
// property names as "did you mean" candidates (suggestNearest), without a
// second, hand-maintained list of "what fields does this object accept" per
// throw site.
const ajv = new Ajv({ allErrors: true, verbose: true });

// Fields common to every sheet entry regardless of recipe (spec-level
// concepts: identity, which recipe builds it, environment/dictionary
// wiring) — as opposed to a recipe's OWN fields (`defaults`/`overlays`/...),
// which are opaque to this loader and validated separately against
// `recipe.schema` (see the per-sheet validation loop below). Kept as one
// schema fragment so both the permissive first pass (`specSchema.sheets`,
// which must still accept whatever fields the sheet's recipe defines) and
// the strict second pass (recipe fields ONLY — see COMMON_SHEET_FIELDS
// below) agree on exactly what "common" means.
const materializeSchema = {
  // `true` (expand everything) or a narrowing object — see
  // DictionaryMaterialize in assemble.ts.
  oneOf: [
    { const: true },
    {
      type: "object",
      properties: {
        groups: { type: "array", items: { type: "string" }, minItems: 1 },
        includeNoDefault: { type: "boolean" },
      },
      additionalProperties: false,
    },
  ],
};

const statedDictionarySchema = {
    type: "object",
    required: ["product", "version"],
    properties: {
      product: { type: "string" },
      version: { type: "string" },
      key_prefix: { type: "string" },
      // Only the `steps` half of a recipe's `key:` — there is no `from:` to
      // choose here, the input is always the row's own key.
      key_steps: keyTransformSchema.properties.steps,
      // Which of the sheet's components this dictionary describes — see
      // SheetDictionaryBinding.component in assemble.ts. Naming a component the
      // sheet has no rows for is an error, not a no-op.
      component: { type: "string" },
      materialize: materializeSchema,
    },
    additionalProperties: false,
};

const dictionariesSchema = {
  type: "array",
  items: {
    // Two shapes, and never a mixture: a STATED pair (product + version,
    // optionally scoped to one component), or `per_component: true` — "every
    // component of this sheet is a version of this product" (see
    // PerComponentDictionaryBinding in assemble.ts). `version`/`component` are
    // forbidden alongside it, because the whole point is that neither is
    // written twice and left unchecked against the other.
    oneOf: [
      {
        type: "object",
        required: ["product", "per_component"],
        properties: {
          product: { type: "string" },
          per_component: { const: true },
          key_prefix: { type: "string" },
          key_steps: keyTransformSchema.properties.steps,
          materialize: materializeSchema,
        },
        additionalProperties: false,
      },
      statedDictionarySchema,
    ],
  },
};


// Every field name of a sheet entry that is NOT a recipe field — used to
// strip a sheet down to its recipe-specific fields before validating those
// against `recipe.schema` (below), and as the exact set a bare object
// literal declares for reuse in the permissive first pass.
const COMMON_SHEET_FIELDS = ["name", "recipe", "instances", "dictionaries", "component"] as const;

// Reviewer-facing text: one language, or both.
const langTextSchema = {
  oneOf: [
    { type: "string" },
    { type: "object", properties: { en: { type: "string" }, ja: { type: "string" } }, additionalProperties: false, minProperties: 1 },
  ],
};

// Every sheet declares what it covers. Two forms, and which one a sheet uses is
// a fact about its SOURCE, not a preference:
//
//   - a literal `{ id, name?, purpose? }` — the sheet covers one component, and
//     nothing in its sources says which; a human names it.
//   - a `{ from, steps, names }` transform — the sheet's artifact holds several
//     components and carries their identity in the source path (a Terraform
//     plan's `module.aurora.*`). Only a recipe that reads a structured artifact
//     accepts this, so its schema is the recipe's own (see recipes/snapshot.ts)
//     and this one only has to admit the shape.
//
// OPTIONAL in the spec, mandatory in the model: a sheet that declares nothing
// still has exactly one component, named after the sheet (assemble-spec.ts), so
// every row carries one and the scoping rules have no special case.
//
// Requiring the declaration was tried and abandoned. It does not prevent the
// failure it looked like it prevented — a sheet that really holds two Keycloak
// instances passes just as happily with one `component:` written on it, because
// no schema can tell how many things a config file describes. So it bought
// uniformity and a place for `purpose`, at the cost of a line in every spec
// anyone ever writes, plus 52 test fixtures. Uniformity belongs in the model,
// where it is free.
const componentSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: langTextSchema,
    purpose: langTextSchema,
    from: { enum: ["key", "path"] },
    steps: { type: "array" },
    map: { type: "object", additionalProperties: { type: "string" } },
    names: { type: "object" },
  },
  additionalProperties: false,
};

const specSchema = {
  type: "object",
  required: ["version", "instances", "sheets"],
  properties: {
    version: { const: 1 },
    metadata: {
      type: "object",
      properties: {
        title: { type: "string" },
        project: { type: "string" },
        version: { type: "string" },
      },
      additionalProperties: false,
    },
    instances: { type: "array", items: { type: "string" }, minItems: 1 },
    enrich: {
      type: "object",
      properties: {
        project: { type: "string" },
        metadata_dirs: { type: "array", items: { type: "string" } },
        argument_specs: { type: "array", items: { type: "string" } },
        terraform_variables: { type: "array", items: { type: "string" } },
        lang: { enum: ["ja", "en"] },
        native_lang: { enum: ["ja", "en"] },
        strict: { type: "boolean" },
      },
      additionalProperties: false,
    },
    capabilities: {
      type: "object",
      properties: { apply: { type: "boolean" } },
      additionalProperties: false,
    },
    id_fields: { type: "array", items: { type: "string" } },
    data_maps: { type: "array", items: { type: "string" } },
    sheets: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["name", "recipe"],
        properties: {
          name: { type: "string" },
          recipe: { type: "string" },
          instances: { type: "array", items: { type: "string" }, minItems: 1 },
          dictionaries: dictionariesSchema,
          component: componentSchema,
        },
        // Deliberately NOT additionalProperties: false — a sheet entry also
        // carries its recipe's own fields (`defaults`/`overlays`/`template`/
        // ...), which this loader does not know the shape of until it has
        // read `recipe`. Those are enforced strictly in the per-sheet pass
        // below instead, against `recipe.schema` — an unknown field either
        // way ends up rejected, just by the pass that actually knows the
        // full field list for this sheet's recipe.
      },
    },
  },
  additionalProperties: false,
};

const validateSpecSchema = ajv.compile(specSchema);


// Directory a spec's own relative paths resolve against (exported so a caller
// building a RecipeIO — e.g. the CLI — computes the identical directory).
export function specDirOf(path: string): string {
  return dirname(resolvePath(path));
}

export function loadBuildSpec(path: string, io: { readFile: (p: string) => string | null }): BuildSpec {
  const content = io.readFile(path);
  if (content === null) throw new Error(`Build spec not found: ${path}`);

  const data = parse(content);
  if (!validateSpecSchema(data)) {
    throw new Error(`Build spec validation error:\n${formatAjvErrors(validateSpecSchema.errors)}`);
  }
  const spec = data as BuildSpec;

  const specDir = specDirOf(path);
  const resolveSpecPath = (p: string): string => resolvePath(specDir, p);

  if (spec.enrich) {
    if (spec.enrich.project) spec.enrich.project = resolveSpecPath(spec.enrich.project);
    if (spec.enrich.metadata_dirs) spec.enrich.metadata_dirs = spec.enrich.metadata_dirs.map(resolveSpecPath);
    if (spec.enrich.argument_specs) spec.enrich.argument_specs = spec.enrich.argument_specs.map(resolveSpecPath);
    if (spec.enrich.terraform_variables) spec.enrich.terraform_variables = spec.enrich.terraform_variables.map(resolveSpecPath);
  }

  // Per-sheet recipe-specific fields: unknown recipe name is an error listing
  // what IS registered; known recipes validate the sheet's own fields via ajv.
  const sheetValidators = new Map<string, ReturnType<typeof ajv.compile>>();
  for (const sheet of spec.sheets) {
    // A sheet's own `instances`, if given, must be a subset of the spec's —
    // see the field's comment above for why it is not allowed to be an
    // independent list.
    if (sheet.instances) {
      const unknown = sheet.instances.filter((i) => !spec.instances.includes(i));
      if (unknown.length > 0) {
        throw new Error(
          `Sheet "${sheet.name}" instances not in the spec's instances (${spec.instances.join(", ")}): ${unknown.join(", ")}`
        );
      }
    }

    const recipe = getRecipe(sheet.recipe);
    if (!recipe) {
      const names = listRecipes().map((r) => r.name);
      throw new Error(
        `Unknown recipe "${sheet.recipe}" for sheet "${sheet.name}". ` +
          (names.length > 0 ? `Registered: ${names.join(", ")}` : "No recipes are registered.")
      );
    }
    let validateSheet = sheetValidators.get(recipe.name);
    if (!validateSheet) {
      validateSheet = ajv.compile(recipe.schema);
      sheetValidators.set(recipe.name, validateSheet);
    }
    // Validate ONLY the recipe-specific fields (recipe.schema's own
    // documented contract — see recipe.ts's SheetRecipe.schema) against
    // recipe.schema's `additionalProperties: false`: the common fields
    // (name/recipe/instances/dictionaries) are spec-level, not part of any
    // recipe's contract, and would themselves be rejected as "additional"
    // if left in — every recipe schema deliberately does not declare them.
    const recipeFields: Record<string, JsonValue> = { ...(sheet as Record<string, JsonValue>) };
    for (const field of COMMON_SHEET_FIELDS) delete recipeFields[field];
    if (!validateSheet(recipeFields)) {
      throw new Error(
        `Sheet "${sheet.name}" (recipe "${sheet.recipe}") validation error:\n${formatAjvErrors(validateSheet.errors)}`
      );
    }
  }

  return spec;
}
