// The one-call `build.yml` -> ParameterSheetInput path: resolve each sheet's
// recipe, let it build its SheetInputs, then assemble + enrich them.
//
// This is the composition the CLI's `import --spec` performs, exported as a
// library function so a project does NOT have to choose between "fully
// declarative" and "hand-written converter". A project whose shape a recipe
// covers except for one detail keeps the recipe and passes `hooks`
// (AssembleHooks — see assemble.ts) for that detail; only genuinely
// recipe-shaped-differently projects need their own converter, and even those
// can call assembleSheets() directly rather than re-implementing extraction.
//
// It stays a pure function of injected I/O (`readFile`), like every other core
// here — the CLI owns fs access, and `resolve` decides what path form ends up
// recorded in the model's source maps.

import { resolve as resolvePath } from "node:path";
import type { DictionaryBinding } from "./metadata.js";
import {
  assembleSheetsWithReport,
  type AssembleHooks,
  type SheetInputs,
  type SheetDictionaryBinding,
  type MaterializeReport,
  type UiReport,
  type BindingReport,
} from "./assemble.js";
import { getRecipe, type RecipeIO } from "./recipe.js";
import type { ExtractOptions } from "./parser.js";
import { loadBuildSpec, specDirOf, type BuildSpec } from "./spec.js";
import type { EnrichReport } from "./enrich.js";
import type { LangText, ParameterSheetInput } from "./types.js";

// A sheet's `component:` (spec.ts). `id` marks the literal form; `from`/`steps`
// the derived one, which only a structured-artifact recipe reads.
type ComponentDecl = { id?: string; name?: LangText | string; purpose?: LangText | string; from?: string; steps?: unknown };

function asLangText(v: LangText | string): LangText {
  return typeof v === "string" ? { en: v, ja: v } : v;
}

export type SpecAssembleOpts = {
  readFile: (path: string) => string | null; // sync, like every other injected I/O here
  // Directory enumeration for a recipe whose subject is a directory rather
  // than a named file (see RecipeIO.listDir) — optional for the same reason
  // `hooks` is: most callers (a project with no such sheet, most tests) never
  // need it, so nothing has to hand-build a no-op just to keep compiling.
  listDir?: (path: string) => string[] | null;
  // See RecipeIO.readBinary — bytes for a recipe that embeds a binary asset.
  readBinary?: (path: string) => Uint8Array | null;
  specDir: string; // directory the spec's relative paths resolve against (specDirOf())
  // How a spec-relative path is recorded in the model. Defaults to an absolute
  // path; the CLI passes a CWD-relative one so a committed input.json does not
  // bake in a local filesystem layout.
  resolve?: (path: string) => string;
  hooks?: AssembleHooks;
  // Overrides for the spec's own `enrich` fields — for a caller (a CLI flag, a
  // conversion script) that needs to override what the file says. Omitted =
  // whatever the spec declares.
  lang?: "ja" | "en";
  // Override for the spec's own `enrich.native_lang` (see spec.ts) — same
  // relationship to the spec as `lang`/`strictMetadata` above.
  nativeLang?: "ja" | "en";
  strictMetadata?: boolean;
  // In-source annotation marker override (CLI `--annotation-marker`), same
  // relationship to the spec as `lang`/`strictMetadata`: build.yml has no
  // field for this (it is a command-line convention, not a project property,
  // unlike `id_fields` below), so the only way in is here.
  marker?: string;
};

export function assembleFromSpecWithReport(
  spec: BuildSpec,
  opts: SpecAssembleOpts
): {
  input: ParameterSheetInput;
  report: EnrichReport;
  unusedProjectParams: string[];
  materializeReports: MaterializeReport[];
  uiReports: UiReport[];
  binding: BindingReport;
  categoryWarnings: string[];
} {
  const resolvePathOpt = opts.resolve ?? ((p: string): string => resolvePath(opts.specDir, p));

  // Built here, once, rather than in the CLI, so a project that drops to
  // Level 2 (buildFromSpecFile + hooks) gets the identical extraction
  // configuration from the identical spec — the same reason this whole
  // composition is one function. Handed to every recipe via `io.extractOptions`
  // as ordinary data — a global setter here would be exactly the mechanism
  // that silently stopped working the moment two copies of extract.ts could
  // exist in one process (see the `resolveIdFields` writeup in extract.ts).
  // Passing it as data instead
  // means there is nothing for a second copy to disagree about — a recipe
  // reads `io.extractOptions` and hands it straight to `extractFile()`.
  const extractOptions: ExtractOptions = { idFields: spec.id_fields, marker: opts.marker };

  const baseIo = {
    readFile: opts.readFile,
    listDir: opts.listDir,
    readBinary: opts.readBinary,
    specDir: opts.specDir,
    resolve: resolvePathOpt,
    extractOptions,
    lang: opts.lang ?? spec.enrich?.lang,
  };

  const inputs: SheetInputs[] = [];
  // Each sheet's own dictionaries (spec.ts's BuildSpec.sheets[].dictionaries),
  // collected keyed by sheet name — this is the one place a sheet's build.yml
  // declaration turns into the per-sheet map assembleSheets() reads
  // (AssembleOpts.dictionaries). Built here, alongside `inputs`, rather than a
  // separate pass, so the key used (`sheetSpec.name`) is trivially the same
  // one `recipe.load()` gave the resulting SheetInputs. `categories`/
  // `under_key` are NOT built here (P7) — they now live in the project
  // metadata (sheet.yml), read directly by assembleSheets via
  // opts.projectPath, not threaded through this composition at all.
  const dictionaries: Record<string, SheetDictionaryBinding[]> = {};

  for (const sheetSpec of spec.sheets) {
    const recipe = getRecipe(sheetSpec.recipe);
    if (!recipe) {
      // loadBuildSpec already validated every sheet's recipe is registered;
      // this can only happen if a recipe unregistered itself in between.
      throw new Error(`Unknown recipe "${sheetSpec.recipe}" for sheet "${sheetSpec.name}".`);
    }
    // A sheet's own `instances` (validated by loadBuildSpec as a subset of
    // spec.instances) overrides the spec-level default here — the one place
    // that resolution happens, so every recipe just reads `io.instances` and
    // stays unaware the override mechanism exists at all (see spec.ts and
    // findings #10).
    const instances = sheetSpec.instances ?? spec.instances;
    const component = sheetSpec.component as ComponentDecl | undefined;
    const io: RecipeIO = { ...baseIo, instances, component, dataMaps: spec.data_maps };
    const si = recipe.load(sheetSpec, io);
    // A recipe that knows the shape of its rows can say how a product
    // dictionary's keys relate to them (SheetInputs.dictKeySteps). Applied only
    // where the binding declares nothing: the project's own `key_steps` is a
    // statement about ITS dictionary and always wins.
    if (si.dictKeySteps) {
      for (const d of (sheetSpec.dictionaries ?? []) as unknown as DictionaryBinding[]) {
        if (d.key_steps === undefined) d.key_steps = si.dictKeySteps;
      }
    }
    // A LITERAL component declaration says the same thing about every row on
    // the sheet, so it is applied here rather than in each recipe: a recipe
    // that reads a flat config file has nothing to contribute to the answer.
    // A DERIVED one (`from`/`steps`) is the recipe's to resolve, because only
    // it knows the artifact — if the recipe already produced componentOf, that
    // is what happened and this leaves it alone.
    // Every sheet has exactly one component unless something says otherwise:
    // a declared literal, or — when the sheet declares nothing — the sheet
    // itself, which is what a single-component sheet has always meant. Giving
    // it an identity here rather than leaving `componentOf` empty is what keeps
    // the scoping rules free of a "no components" case; the level is collapsed
    // for a single one anyway (assemble.ts), so nothing is displayed for it.
    //
    // A DERIVED declaration (`from`/`steps`) is the recipe's to resolve, since
    // only it knows the artifact — if the recipe already produced componentOf,
    // that is what happened, and this leaves it alone.
    if (si.componentOf === undefined) {
      const id = component?.id ?? sheetSpec.name;
      const keys = new Set<string>();
      for (const layer of si.layers) for (const k of layer.entries.keys()) keys.add(k);
      // Embedded literals are rows too. Leaving them out made them belong to no
      // component, so materialize's per-component `covered` set never saw them
      // and re-materialized each one as an unset default beside the row that
      // sets it — 20 phantom rows on one example.
      for (const e of si.embedded) keys.add(e.key);
      si.componentOf = new Map([...keys].map((k) => [k, id]));
      if (component?.name !== undefined) si.componentLabels = new Map([[id, asLangText(component.name)]]);
    }
    inputs.push(si);
    if (sheetSpec.dictionaries) dictionaries[sheetSpec.name] = sheetSpec.dictionaries;
  }

  return assembleSheetsWithReport(inputs, {
    readFile: opts.readFile,
    projectPath: spec.enrich?.project,
    metadataDirs: spec.enrich?.metadata_dirs,
    argumentSpecs: spec.enrich?.argument_specs,
    terraformVariables: spec.enrich?.terraform_variables,
    lang: opts.lang ?? spec.enrich?.lang,
    nativeLang: opts.nativeLang ?? spec.enrich?.native_lang,
    strictMetadata: opts.strictMetadata ?? spec.enrich?.strict,
    metadata: spec.metadata,
    capabilities: spec.capabilities,
    hooks: opts.hooks,
    dictionaries,
  });
}

export function assembleFromSpec(spec: BuildSpec, opts: SpecAssembleOpts): ParameterSheetInput {
  return assembleFromSpecWithReport(spec, opts).input;
}

// Convenience for a conversion script: load the spec file and assemble in one
// call (`specDir` is derived from the spec's own path). Everything else is the
// same as assembleFromSpec.
export function buildFromSpecFile(
  specPath: string,
  opts: Omit<SpecAssembleOpts, "specDir">
): { input: ParameterSheetInput; report: EnrichReport } {
  const spec = loadBuildSpec(specPath, { readFile: opts.readFile });
  return assembleFromSpecWithReport(spec, { ...opts, specDir: specDirOf(specPath) });
}
