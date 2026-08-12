export { generateHtml } from "./html/generate.js";
export { validateInput, validateReview, validateVersionedInput, isVersionedInput } from "./validate.js";
export { verifySources } from "./verify.js";
export { computeApply } from "./apply.js";
export { buildPromptText } from "./prompt.js";
export { diffSheets } from "./diff.js";
export type { DiffOptions, DiffResult, DiffStatus, SheetDiff, CategoryDiff, ParamDiff, CellDiff, SheetPresence } from "./diff.js";
// Extraction adapters: turn config files into model entries with accurate source
// maps. Use these in a project-specific conversion script so the hard part
// (exact line + anchor, per format) is delegated to the tested adapters.
export { extractFile, buildInput, inferFormat, resolveTemplateVars, type Entry, type ResolvedEntry, type Format } from "./extract.js";
// Pluggable parser registry: register custom parsers for non-standard formats.
export { registerParser, listParsers, getParser, resolveParser } from "./parser.js";
// Ready-to-use locate/edit for a line-oriented custom format ("one value per
// line, found by line number + a literal anchor substring") — the same
// mechanism properties/dotenv/sysctl/ini/space/generic all use. A custom
// ConfigParser for that shape of format should assign these directly
// (`locate: lineLocate, edit: lineEdit`) rather than reimplementing them;
// locateLine is the lower-level line-index finder they're built on, exposed
// for a parser that also needs a structural (path-based) locate/edit and
// wants line+anchor only as a fallback, the way the built-in yaml/json
// parser does.
export { lineLocate, lineEdit, locateLine } from "./line-config.js";
// ExtractOptions carries per-call extraction configuration (id_fields, an
// annotation marker override) as ordinary data (see parser.ts and the
// extract.ts / annotation.ts writeups): a caller assembling its own
// SheetInputs (a hand-written converter, a custom recipe) builds one and
// passes it straight to extractFile() — there is no process-wide state to
// mutate instead.
export type { ConfigParser, EditResult, LocateResult, ExtractOptions } from "./parser.js";
// Metadata enrichment: fill in documentation (description/default/remarks/...)
// from the project's own metadata file, Ansible argument_specs, or a product dictionary.
export { enrich } from "./enrich.js";
export type { EnrichOptions, EnrichReport } from "./enrich.js";
export { registerMetadataProvider, listMetadataProviders, getMetadataProvider, resolveMetadata, pickLang } from "./metadata.js";
export type {
  Provenance,
  LangProvenance,
  LangText,
  DictionaryBinding,
  MetadataQuery,
  MetadataResult,
  MetadataContext,
  MetadataProvider,
  ResolvedMetadata,
} from "./metadata.js";
// Product dictionaries: the typed shape a per-product normalizer emits (a
// pg_settings dump, reflection over a container image, a docs scrape → one
// `<product>@<version>.yml`), plus the renderer that writes it.
export { renderDictionary } from "./providers/dictionary.js";
export type { DictionaryDoc, DictionaryParam } from "./providers/dictionary.js";
export { loadProjectMeta, paramsForSheet, categoriesForSheet, underKeyForSheet, checkProjectMetaSheets } from "./providers/project.js";
export type { ProjectMetaDoc, ProjectMetaSheetDoc, ProjectMetaParam, UnderKeyMeta } from "./providers/project.js";
// Layered-config assembler: merges base+overlay value layers into Pattern A/B
// params, resolves each row's key (extracted identity, or a product key via
// keyMap), appends embedded literals, and enriches.
export { assembleSheets, assembleSheetsWithReport } from "./assemble.js";
export type {
  ExtractedEntry,
  ExtractedMap,
  ValueLayer,
  EmbeddedEntry,
  KeyMapEntry,
  UnderKeyColumn,
  SheetInputs,
  AssembleOpts,
  AssembleHooks,
  ParamContext,
  SheetDictionaryBinding,
  DictionaryMaterialize,
  MaterializeReport,
} from "./assemble.js";
// build.yml -> ParameterSheetInput in one call (what `import --spec` runs).
// Pass `hooks` to adjust keys/params/the whole model without leaving the
// declarative spec — the escape hatch below a hand-written converter.
export { assembleFromSpec, assembleFromSpecWithReport, buildFromSpecFile } from "./assemble-spec.js";
export type { SpecAssembleOpts } from "./assemble-spec.js";
// Recipe registry: register a SheetRecipe to make it available to `build.yml`
// (via the `recipe:` field on a sheet) — see spec.ts.
export { registerRecipe, listRecipes, getRecipe } from "./recipe.js";
export type { JsonValue, RecipeIO, SheetRecipe } from "./recipe.js";
// BuildSpec loader: turns a declarative `build.yml` into a validated BuildSpec
// (recipe-specific sheet fields validated against each named recipe's schema).
export { loadBuildSpec, specDirOf } from "./spec.js";
export type { BuildSpec } from "./spec.js";
export type {
  ParameterSheetInput,
  SheetMetadata,
  ChangeLogEntry,
  Sheet,
  Category,
  Parameter,
  SimpleParameter,
  InstanceParameter,
  Instance,
  SourceLocation,
  VersionedSheetInput,
  SheetVersion,
  ColumnDefinition,
  ReviewDocument,
  ReviewItem,
  ReviewTarget,
  ReviewChange,
  GenerateOptions,
} from "./types.js";
