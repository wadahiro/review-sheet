// Generic, IaC-agnostic layered-config assembler: turns a base file of values
// plus per-instance overlay files (already extracted elsewhere, e.g. via
// extractFile) into Pattern A/B parameters, resolves each row's display key
// (its extracted identity, or a bound product key via `keyMap` — see
// SheetInputs.keyMap), appends embedded
// literals, files everything under categories (a per-param `category` from
// the project metadata, or that sheet's own declared top-level tab order —
// see providers/project.ts's categoriesForSheet), and finally runs the shared
// `enrich()` pass for documentation. A sheet that declares a tab order is
// held to it: a category actually used that isn't in the list is a "ghost
// tab" (almost always a typo in a param's `category:`) and fails the build —
// see fileDrafts' ghost-tab check below.
//
// This module does NOT reimplement extraction (extract.ts) or enrichment
// (enrich.ts) — it only merges pre-extracted layers into a ParameterSheetInput
// shape and delegates documentation to enrich(). A recipe layer (e.g. an
// Ansible-specific conversion script) is expected to build `SheetInputs` from
// its own extraction and hand it to `assembleSheets`.
//
// All injected I/O in this repo is synchronous (`readFile: (path) => string |
// null`), and so is enrich()/loadProjectMeta() — assembleSheets is therefore
// synchronous too, returning a ParameterSheetInput directly (not a Promise).

import { enrich, type EnrichReport, type ScaffoldEntry, ScaffoldableBuildError, scaffoldShapeFor } from "./enrich.js";
import {
  loadProjectMeta,
  paramsForSheet,
  paramForRow,
  componentParamsForSheet,
  categoriesForSheet,
  underKeyForSheet,
  labelForSheet,
  groupForSheet,
  compareComponentsForSheet,
  declaredComponentsForSheet,
  groupByForSheet,
  sheetGroups,
  checkProjectMetaSheets,
  type ProjectMetaDoc,
  type UnderKeyMeta,
} from "./providers/project.js";
import { findDictionary, dictionaryCoverage } from "./providers/dictionary.js";
import { baseFileName } from "./jinja2.js";
import { bindKey, isBindError, loadBindSources, BIND_METHODS, type Binding, type BindSource, type BindMethod } from "./bind.js";
import type { DictionaryBinding } from "./metadata.js";
import type { KeyTransformStep } from "./keytransform.js";
// Re-exported so importers that reached for it here keep working; the
// implementation moved to a leaf so providers/dictionary.ts can use it too
// without the cycle its own duplicate existed to avoid.
import { suggestNearest } from "./schema-errors.js";
export { suggestNearest };
import type {
  ParameterSheetInput,
  SourceLocation,
  Sheet,
  Category,
  Parameter,
  SimpleParameter,
  InstanceParameter,
  Instance,
  ColumnDefinition,
  SheetMetadata,
  Capabilities,
  LangText,
  ArtifactPreview,
} from "./types.js";

// `origin: "embedded"` marks a base-layer entry whose position relative to its
// sibling base entries matters — e.g. a template's bare literal (no backing
// variable) sitting between two `{{ var }}` passthroughs in the same config
// file. It is filed as a fixed "embedded" SimpleParameter in place
// (skipping keyMap/under_key resolution entirely), instead of through
// `SheetInputs.embedded`, which always appends after every base-derived
// parameter — right for a literal that lives in a genuinely separate file
// (e.g. a static drop-in) but wrong for one interleaved in the base file/
// template itself.
// `component` travels ON the entry rather than being looked up by key. A
// key-indexed map cannot answer the question once two components legitimately
// share a key name: two Keycloak clients both have a `protocol`, and that is
// the whole point of giving each client a component — one map entry keyed
// `protocol` can only hold one of them, and the other row loses its component
// silently.
// `baseline` (the vendor's shipped value for this same key — see types.ts's
// `ParameterBase.baseline`) rides on the entry rather than being looked up
// separately for the same reason `component` does: the ansible recipe's
// `baseline:` matches it onto a row it has already built (the row's own
// `key`), and threading it through here is what lets buildDrafts carry it onto
// the Parameter without a second key-indexed pass of its own.
export type ExtractedEntry = { value: string; source: SourceLocation; origin?: "embedded"; component?: string; baseline?: string };
// Insertion order is significant: it drives Pattern A/B emission order.
export type ExtractedMap = Map<string, ExtractedEntry>;

export type ValueLayer =
  | { kind: "base"; entries: ExtractedMap }
  | { kind: "overlay"; instance: string; entries: ExtractedMap };

// `origin` overrides the default "embedded" filing for a whole static file:
// `default` says the file is not part of our deliverable at all but a RECORD of
// the product's own defaults (an extracted snapshot of what the product ships
// with). Those rows must not claim a definition site in our config — see the
// `Origin` comment in types.ts — so the source is dropped here and the value
// doubles as the documented default.
// `baseline` is the ansible recipe's `baseline:` doing the mirror-image thing:
// a key the vendor's shipped file has and the deployed artifact does not —
// filed as a NEW row rather than matched onto an existing one (see
// ExtractedEntry.baseline for that case), value "" (nothing is in effect),
// with `value` here carrying the VENDOR'S value instead — buildDrafts moves it
// onto `baseline` and drops `source` for the same "no definition site in our
// config" reason `default` drops it, one level stricter: `baseline` has no
// evidence-channel exception at all (see the `Origin` comment in types.ts).
// `categoryPath` is the FILE'S OWN structure as the parser read it (a logrotate
// block's log patterns, a systemd `[Section]`) — the last-resort category, used
// only when the project declared none and the row bound to no dictionary. It is
// the same rank as a materialized row's `fallbackCategoryPath`, and never
// outranks either of those two.
export type EmbeddedEntry = {
  key: string;
  value: string;
  source: SourceLocation;
  component?: string;
  origin?: "embedded" | "default" | "baseline";
  categoryPath?: string[];
  // The categoryPath outranks a bound dictionary's own `group` — see
  // bindingOrFallback. Set by a recipe that knows the row came out of a
  // repetition axis.
  categoryPathWins?: boolean;
  // Per-instance values, when the row differs between environments — or is
  // there for some and not others, which an instance list expresses by simply
  // omitting the ones it is absent from. Set INSTEAD of `value`, which is then
  // only the fallback for a caller that ignores this. A component's rows used
  // to be flatly single-valued: the recipe warned and displayed the base value,
  // which is a sheet stating something about staging that is only true of
  // production.
  instances?: Instance[];
};

// A binding from a bound (product) key to the variable that backs it, e.g.
// { boundKey: "db-url", variable: "kc_db_url" }.
export type KeyMapEntry = { boundKey: string; variable: string };

// Re-exported under its historical name: under_key now lives on the project
// metadata (sheet.yml), not build.yml — see providers/project.ts's
// UnderKeyMeta and this file's header comment for why.
export type UnderKeyColumn = UnderKeyMeta;

export type SheetInputs = {
  name: string;
  // Display fallback (Sheet.file_path) — the sheet's "main" file. Following
  // the convention `Sheet.file_path`/`source_file` were defined for (types.ts),
  // this is where the configuration LANDS (`/etc/nginx/nginx.conf`) when the
  // producer knows it: that is the path an operator reviewing middleware
  // parameters expects to see. Purely informational — every value here carries
  // its own `source.file`, so it never affects verify/apply resolution.
  filePath?: string;
  // Sheet.source_file — the LOCAL file the values are authored in (the template
  // a recipe rendered them from). MUST be set whenever `filePath` is a deployed
  // path: it is the fallback verify/apply use for any value that carries no
  // `source.file` of its own, and without it that fallback would point at a
  // path on the managed host — read (or, under `serve --write`, WRITTEN) on the
  // reviewer's own machine if it happens to exist there.
  sourceFile?: string;
  // What each entry in `instances` represents (e.g. "environment", "region").
  // Documentation only for now: the current ParameterSheetInput/Sheet model has
  // no field to carry it, so it is accepted but not written to the output.
  dimension?: string; // default "environment"
  instances: string[]; // ordered; value-column order
  layers: ValueLayer[]; // exactly one base; error otherwise
  embedded: EmbeddedEntry[]; // already keyed (product-side)
  // Whole deployed files, as this sheet says they will be, for the reviewer to
  // read a value in its place (types.ts's ArtifactPreview). Passed straight
  // through to the model — the assembler neither reads nor merges them; the
  // recipe that owns the template is the only thing that can render one.
  artifacts?: ArtifactPreview[];
  // How a row of THIS sheet relates to a product dictionary's keys, when the
  // recipe knows — a Terraform plan row is `<module>.<type>.<name>.<arg>` and
  // the provider documents `<type>.<arg>`, which follows from the plan's shape
  // rather than from anything a project chose. Applied to a binding that
  // declares no `key_steps` of its own (assemble-spec.ts); a project that
  // declares them still wins.
  dictKeySteps?: KeyTransformStep[];
  // Rows whose display key is a PRODUCT key rather than their extracted
  // identity (an Ansible variable, a structural path, ...) — see
  // resolveKey() below. A base/overlay entry whose extracted key appears here
  // (as `variable`) is filed under `boundKey` instead, with the extracted key
  // itself surfaced via the under_key column; an entry with no keyMap
  // counterpart keeps its extracted key verbatim. There is no longer a
  // sheet-wide "keying" switch (S2): naming is decided per row, by whether
  // THAT row happens to have a keyMap entry — a sheet with no keyMap at all
  // (omitted/empty) behaves exactly like the old "source" keying, and a sheet
  // where every row happens to map behaves like the old "bound" keying, with
  // every shade in between being the normal case (see recipes/ansible.ts's
  // module doc for how it derives this per template entry: a variable backing
  // exactly one directive earns a product key; one backing several, or one
  // the template never references at all, keeps its own name).
  keyMap?: KeyMapEntry[];
  // The COMPONENT each row belongs to, keyed the same way `layers` is (the
  // extracted key, before keyMap renames anything).
  //
  // A component is one purpose-bearing instantiation of a product surface —
  // "the external SSO node", "the ALB for service AAAA", "the Keycloak
  // database". It is what somebody NAMED because a requirement asked for it,
  // and nothing but a human knows it: a Terraform provider hands out resource
  // types, and which Aurora cluster is "the Keycloak database" exists only in
  // the head of whoever wrote the module. A rendered artifact often carries the
  // name (a plan's `module.aurora.*`), which is what makes it derivable rather
  // than hand-listed.
  //
  // It is a SCOPE, not a label: row keys are unique within a component, and
  // materialize's "what does this project already cover" set is per component
  // — without which one ALB setting `idle_timeout` marks that option covered
  // for every other ALB on the sheet, and their unset options vanish from the
  // ledger with no report.
  // Fallback for rows whose entry carries no `component` of its own: the
  // literal, whole-sheet declaration (assemble-spec.ts), where every row
  // belongs to the same one and a map is the cheapest way to say so.
  componentOf?: Map<string, string>;
  // Display text for a component id (see componentOf). The id is identity and
  // must not move; this is what a reader sees, resolved per language by the
  // viewer like every other LangText. Absent = show the id.
  componentLabels?: Map<string, LangText>;
  // Where each component's artifact LANDS, and the local file it is rendered
  // from — the per-component form of Sheet.file_path/source_file, for a sheet
  // whose components are several deployed files. Without it a sheet built from
  // `templates:` says nothing at all about where any of them go: the sheet-wide
  // pair cannot answer for three different files, so it is left unset, and the
  // per-template declaration had nowhere to be recorded.
  componentFiles?: Map<string, { filePath?: string; sourceFile?: string }>;
  // The order the spec declares this sheet's components in. Reading order is a
  // decision, and the order rows arrive in is not one — see fileDrafts.
  componentOrder?: string[];
  // Reference sites a recipe's substitution scan found (src/substitution.ts's
  // `bindReferences`): `variable` is a base/overlay layer key (the SAME
  // extracted identity buildDrafts() below iterates below in passes 1/2,
  // BEFORE keyMap renames it to a product key), `sites` is every location
  // elsewhere that references it. Attached to whatever row that variable
  // produces as `additional_sources` — works whether the row keeps its own
  // name or was renamed via `keyMap` (the merge that PRODUCED these sites in
  // the first place is exactly what decided that keyMap entry, so the two
  // always travel together for a single-backer merge; see substitution.ts's
  // module doc row 2). A variable named here that produces no draft at all
  // (in neither the base nor the overlay-only pass) is a producer bug — a
  // recipe mis-keyed the list against a layer key that doesn't exist — and is
  // a hard error, same "never drop a row's information in silence" rule as
  // everywhere else in this file (here it's not a row that's lost, but the
  // wiring a `ref` site exists to make checkable).
  referenceSites?: { variable: string; sites: SourceLocation[] }[];
  // Of the keys this sheet produced from its `layers` (base + overlay), the
  // ones the project's own authored source actually STATES — as opposed to a
  // key that only appears because a generated artifact resolved it (e.g. a
  // Terraform plan's `change.after`, which reports a provider default
  // identically to an author-set value with no way to tell them apart from
  // the plan alone).
  //
  // A CHANNEL, not a policy: it says "did my source author this", nothing
  // more. When a recipe can answer that question (a Terraform plan checked
  // against the module's own `.tf`), it sets this and every other layer key
  // is demoted to `origin: "default"` below — same class of row as a
  // materialized one (nobody in this project chose the value), just observed
  // rather than documented. When a recipe CANNOT answer it (a CDK/Pulumi
  // synth, where authorship lives in program logic no source map can
  // recover), it leaves this unset and every row keeps today's overlay/common
  // origin — that is a real limit of the channel, not a gap to paper over
  // with a guess.
  //
  // Absent (the default for every existing recipe) changes nothing: this is
  // opt-in, and no recipe in this codebase sets it yet.
  // The repetition axis a recipe built inside each component (layered.ts's
  // `split.nest`): which members it holds and what each of them IS. Read by
  // materialize, so an unset option of a repeated thing lands on every
  // repetition rather than once under its type — the type is not something a
  // reviewer can configure.
  nestedMembers?: Map<string, { under: string; members: { id: string; unit: string }[] }>;
  authoredKeys?: ReadonlySet<string>;
};

// What a hook is told about the parameter it is looking at. `key` is the key as
// assembly resolved it (after keyMap, before `keyFor`); `variable` is the
// backing variable when this row's key came from keyMap, undefined otherwise.
export type ParamContext = { sheet: string; key: string; variable?: string };

// The escape hatch between a declarative build.yml and a hand-written
// conversion script: a project whose shape a recipe covers *except* for one
// detail can keep the recipe and fix that detail here, instead of dropping to
// its own converter (see the ladder in skills/review-sheet/SKILL.md).
//
// Hooks run in assembly order: `keyFor` (identity) -> `mapParam` (per
// parameter) -> `finalize` (whole model). They deliberately run BEFORE enrich():
// a description/category a hook sets is respected (enrich is fill-only), and
// what a hook produces still faces the strict-metadata gate — a hook can fix a
// strict failure, it cannot hide one.
export type AssembleHooks = {
  // Rewrite a parameter's identity. The returned key is what the project
  // metadata (category, out_of_scope) and enrich() look up, so a rename here
  // must match what sheet.yml/the dictionary is keyed by. Applies to every
  // parameter, embedded literals included.
  keyFor?: (ctx: ParamContext) => string;
  // Adjust a built parameter before it is filed into a category — or drop it
  // entirely by returning null (e.g. artifact noise a recipe has no option for).
  // `ctx.key` is post-`keyFor`.
  mapParam?: (param: Parameter, ctx: ParamContext) => Parameter | null;
  // Last look at the whole assembled model before enrich() runs.
  finalize?: (input: ParameterSheetInput) => ParameterSheetInput;
};

// Opt-in instruction, carried on a sheet's OWN dictionary binding (see
// SheetDictionaryBinding below): expand every key of THAT dictionary the
// sheet does not already cover into an `origin: "default"` row, turning the
// sheet into the exhaustive ledger of the product's parameters instead of
// only the subset this project touches (what a Japanese パラメータシート
// review traditionally expects: write everything down, then mark what is out
// of scope). `true` = every group; an object narrows it (see `groups` below).
//
// Only worth doing for a dictionary that is a genuine full extraction of the
// product (postgresql@16 from pg_settings, keycloak from the image) —
// materializing a hand-transcribed dozen directives produces a fake
// inventory, not a real one. This is not left to the author's judgment
// alone: materializeDrafts() below refuses any dictionary whose `coverage`
// (see providers/dictionary.ts) is not `"full"`.
export type DictionaryMaterialize =
  | true
  | {
      // Include only dictionary entries whose `group` is in this list — a large
      // dictionary (httpd@2.4's 729 directives across 100+ modules) otherwise
      // materializes every module the product COULD load, most of which a given
      // deployment never does, drowning the rows that matter in noise that isn't
      // even true (a module that is never `LoadModule`d doesn't have an unused
      // setting — it doesn't exist). Omitted = every group (the historical
      // behavior). A named group that matches nothing in the dictionary is a
      // likely typo, so it is reported (see MaterializeReport.unknownGroups)
      // rather than silently doing nothing — this project's rule against silent
      // loss applies to authoring mistakes too.
      //
      // Declarative only, on purpose: a fancier version could cross-reference the
      // project's own `LoadModule` lines to infer this list automatically, but
      // that parses "what modules are actually active", which is its own,
      // format-specific problem — left for later if a project actually needs it.
      groups?: string[];
      // REMOVED. A materialized row is filed under the SAME category as any
      // other row of its kind (the dictionary's own `group`), not under a
      // parent that segregates it by origin — see materializeDrafts. Kept in
      // the type only so a spec that still declares it fails loudly at schema
      // validation rather than being silently ignored.
      defaultsCategory?: never;
      // Opt-in: also materialize dictionary entries that carry no `default`.
      // Default false — see materializeDrafts' `noDefault` gate for why an
      // entry with no documented default is excluded by default (asserting
      // "the product default applies" for a directive that has none is a
      // false statement, not a redundant one). Set this only for a dictionary
      // binding you have specifically checked: a project can know a
      // directive's real behavior (an OS-level default, a fallback the docs
      // state in prose rather than a Default: field) even when the dictionary
      // entry itself does not record one.
      includeNoDefault?: boolean;
    };

// A sheet's own binding to one product dictionary (build.yml's
// `sheets[].dictionaries[]`). Bindings are per SHEET, not per project — a
// sheet's keys are matched only against the dictionaries IT declares (see
// bindDrafts/assembleSheetsWithReport below), never a sibling sheet's, so two
// sheets bound to different products can never cross-match by accident.
// `key_prefix` is a per-binding project-naming-convention peel (see bind.ts);
// `materialize` is the opt-in ledger expansion above — the two travel
// together because a materialize instruction is meaningless without saying
// which dictionary it expands, and declaring them separately (as build.yml
// used to, with a spec-wide `dictionaries:`/`materialize:` restating the same
// product+version twice) let the two silently drift apart.
export type SheetDictionaryBinding = DictionaryBinding & {
  materialize?: DictionaryMaterialize;
  // Which of the sheet's components this dictionary describes. Absent = the
  // whole sheet, which is what a single-component sheet always means.
  //
  // A sheet whose components are several INSTANCES of one product wants the
  // default: each instance is described by the same dictionary and each needs
  // its own ledger. A sheet whose components are different ARTIFACTS of one
  // product does not — keycloak.conf, the systemd unit that starts it and the
  // shell script that fetches its password are one product, but only the first
  // is what the product's own settings registry is about. Without this,
  // materialize expands once per component and the unit is reviewed against
  // every option of a configuration file it does not contain.
  //
  // Scopes BOTH halves of what a dictionary does — binding and materialize —
  // because "this dictionary describes that artifact" is one claim, and a field
  // that suppressed the ledger while still handing out descriptions would be a
  // different, harder-to-explain one.
  component?: string;
};

// What materializeDrafts() did with one bound dictionary, so a caller can
// print it — "skipped N" must never be silent (see materializeDrafts below).
// `total` and `containerSkipped` describe the DICTIONARY (what fraction of it
// is a syntax container, independent of how much this project already
// covers); `materialized` is how many `origin: "default"` rows this call
// actually added.
export type MaterializeReport = {
  sheet: string;
  product: string;
  version: string;
  total: number;
  containerSkipped: number;
  // Entries belonging to a unit this component does not use (see
  // DictionaryParam.unit) — an option of something that is not here, rather
  // than an option nobody set. 0 for a dictionary that declares no units.
  unitAbsent: number;
  materialized: number;
  // How many otherwise-eligible entries the `groups` filter left out. 0 when
  // no filter was given (never omitted, so a caller can print it unconditionally
  // once the filter becomes non-empty — same "counted, never silent" rule as
  // containerSkipped).
  groupExcluded: number;
  // Names in `binding.materialize.groups` that matched NO entry in the
  // dictionary at all — almost always a typo (see DictionaryMaterialize's
  // `groups`). Empty when no filter was given, or every named group matched
  // something.
  unknownGroups: string[];
  // How many otherwise-eligible entries carry no documented `default` and
  // were therefore excluded (see DictionaryMaterialize.includeNoDefault). 0
  // when `includeNoDefault` is set — never omitted, same "counted, never
  // silent" rule as containerSkipped/groupExcluded.
  noDefault: number;
  // The keys behind `noDefault`, always populated (this report is scoped to
  // one sheet+dictionary binding, not the whole build, so keeping the list is
  // cheap) — this is what makes the exclusion auditable rather than just
  // countable: a number alone cannot tell a caller that "AcceptFilter" is
  // missing because the dictionary itself never recorded a default for it,
  // which is a fact about the DICTIONARY's extraction quality, not about this
  // project. See the `import --spec` CLI: the count always prints, this list
  // is opt-in via --materialize-report (same shape as --bind-report).
  noDefaultKeys: string[];
};

// Rows a dictionary's `ui` claim removed or narrowed on one sheet — the same
// "counted, never silent" rule MaterializeReport follows. Emitted per sheet,
// not per binding, because a row is decided by whichever dictionary bound it.
export type UiReport = {
  sheet: string;
  // Keys dropped: nobody set them and the product's UI does not mention them.
  absentKeys: string[];
  // Keys kept but marked out of scope: the UI shows the value without offering
  // any way to choose one.
  readonlyKeys: string[];
};

// Why a `ui: "readonly"` row is not reviewable, supplied by review-sheet rather
// than by each project: the fact is the dictionary's, so the sentence should be
// too, and a project that disagrees still wins — its own `out_of_scope` is
// applied later and is never overwritten (see fileDrafts).
export const UI_READONLY_REASON: LangText = {
  en: "The product's own admin UI shows this value but offers no way to choose one, so nothing here was decided — it records what the product or an operator action put there. Not set by this project either.",
  ja: "製品の管理 UI はこの値を表示するだけで、選ぶ手段を提供していない。したがってここに合意すべき決定は存在せず、製品または運用操作が入れた結果が写っているだけである。本プロジェクトも設定していない。",
};

// Resolved dictionary bindings for one sheet, nested by COMPONENT and then by
// key — never keyed by the key alone.
//
// Two components of one sheet share a key space on purpose: that is the first
// of the three things a component IS (see SheetDictionaryBinding.component). So
// `port` under one component and `port` under another are two rows, and a
// dictionary scoped to one of them, or a per-component `dict_key` in sheet.yml,
// makes them two DIFFERENT bindings. A flat key->Binding map gave them one
// slot, so whichever bound last handed the other its documentation, its default
// and its group — silently, and only on the sheets whose whole reason for
// existing is that the components differ.
//
// The empty-string component is "no component": rows on a component-less sheet,
// and the rows of a component-bearing sheet that belong to none of them.
export type SheetBindings = Map<string, Map<string, Binding>>;

const NO_COMPONENT = "";

function bindingFor(bindings: SheetBindings, component: string | undefined, key: string): Binding | undefined {
  return bindings.get(component ?? NO_COMPONENT)?.get(key);
}

function setBinding(bindings: SheetBindings, component: string | undefined, key: string, value: Binding): void {
  const scope = component ?? NO_COMPONENT;
  const byKey = bindings.get(scope) ?? new Map<string, Binding>();
  byKey.set(key, value);
  bindings.set(scope, byKey);
}

export type AssembleOpts = {
  projectPath?: string;
  metadataDirs?: string[];
  argumentSpecs?: string[];
  terraformVariables?: string[];
  lang?: "ja" | "en";
  // Passed straight through to enrich()'s same-named option — see
  // EnrichOptions.nativeLang in enrich.ts for the default and rationale.
  nativeLang?: "en" | "ja";
  strictMetadata?: boolean; // default true
  metadata?: { title?: string; project?: string; version?: string };
  capabilities?: Capabilities;
  hooks?: AssembleHooks;
  // Per-sheet dictionary bindings, keyed by SheetInputs.name — see
  // SheetDictionaryBinding. A sheet's drafted keys are matched ONLY against
  // its own entry here (bindDrafts below), never another sheet's: the
  // project-wide `dictionaries:` list build.yml used to have let a key from
  // one sheet accidentally resolve against a dictionary bound for an
  // unrelated sheet. A binding whose own `materialize` is set additionally
  // expands that dictionary's uncovered keys into `origin: "default"` rows
  // on this sheet.
  dictionaries?: Record<string, SheetDictionaryBinding[]>;
  readFile: (path: string) => string | null; // sync
};

const EMPTY_PROJECT_META: ProjectMetaDoc = { params: {} };

// A single not-yet-filed parameter, plus the variable it was bound from (for
// the under_key column) if any. `fallbackCategoryPath` is the LAST-resort
// category, behind the project's own `category:` and behind a bound
// dictionary's `group`: a materialized row's dictionary group (see
// materializeDrafts), or an embedded row's own container in the file it was
// read from (EmbeddedEntry.categoryPath). A project-set parameter with neither
// still has to declare its category in the project metadata or fail the build.
//
// A PATH, not a single name: a materialized row is filed two levels deep —
// under one parent category for "the project sets nothing here", then
// under a subcategory per dictionary `group` (see fileDrafts) — so that
// materializing a large dictionary (httpd@2.4's 100+ modules) doesn't flatten
// into 100+ top-level tabs alongside the project's own, hand-declared,
// actually-reviewable categories.
type Draft = { key: string; param: Parameter; variable?: string; fallbackCategoryPath?: string[]; categoryPathWins?: boolean; component?: string };

// Category of last resort for a materialized row whose dictionary carries no
// `group`. Model-level (like extract.ts's DEFAULT_CATEGORY), not a UI string.
const UNCATEGORIZED = "Uncategorized";

// A dictionary group is a path (providers/dictionary.ts's DictionaryParam.group):
// a list as written, a bare string as its one segment, and UNCATEGORIZED when
// the entry declares none. An empty or all-blank list is treated as none rather
// than producing a category with no name.
function groupPath(group: string | string[] | undefined): string[] {
  if (Array.isArray(group)) {
    const segs = group.filter((g) => typeof g === "string" && g.trim() !== "");
    return segs.length > 0 ? segs : [UNCATEGORIZED];
  }
  return [group || UNCATEGORIZED];
}

// A bound dictionary's own grouping of the entry, when it HAS one. A dictionary
// whose product has no arrangement of its own to state (logrotate's man page
// lists its directives alphabetically) leaves `group` unset, and for those the
// row's own fallback — the container the parser read it out of — says more than
// UNCATEGORIZED does. Binding still outranks the fallback whenever it has an
// answer; this only stops "bound, to an entry that groups nothing" from
// counting as one.
function bindingOrFallback(
  binding: Binding | undefined,
  fallback: string[] | undefined,
  // The fallback OUTRANKS the dictionary's own grouping. True for a row that
  // came out of a repetition axis (layered.ts's `split.nest` — a Keycloak LDAP
  // store's mappers): every member of such an axis has the SAME keys by
  // definition, so grouping them by anything except which member they are
  // merges exactly the rows a reader is there to compare. Six mappers all have
  // an `ldap.attribute`, and the interesting fact is that one reads
  // sAMAccountName and another reads mail.
  //
  // This is not a judgement about the dictionary's group being wrong. It
  // describes ONE mapper, correctly; it simply does not organize a sheet
  // holding six of them side by side, and only the recipe knows it is holding
  // six.
  fallbackWins = false
): string[] | undefined {
  if (fallbackWins && fallback !== undefined) return fallback;
  if (binding && binding.entry.group !== undefined) return groupPath(binding.entry.group);
  return fallback ?? (binding ? [UNCATEGORIZED] : undefined);
}

// Just the tab: the first segment of the path above, or undefined when the
// entry declares no group at all (which `groups:` filters and the ghost-tab
// guard both need to tell apart from "grouped under the empty string").
function groupHead(group: string | string[] | undefined): string | undefined {
  if (Array.isArray(group)) return group.find((g) => typeof g === "string" && g.trim() !== "");
  return group;
}

// Materialized rows used to be filed under a parent category of their own
// ("Product defaults (not set)"), segregating every unset row from every set
// one. That was wrong twice over.
//
// It cut across the product's own taxonomy, which is the taxonomy the
// categories ARE: an ALB's `idle_timeout` and its `client_keep_alive` are two
// timeouts on one load balancer, and reviewing the first while the second sits
// in a different top-level tree hides the relationship a reviewer needs. Rows
// are related to their neighbours, not to other rows that happen to share an
// origin.
//
// And it duplicated categories visibly: a group with both set and unset rows
// appeared twice in the outline under the same name, once in each tree, which
// reads as a bug because it is one.
//
// So a materialized row is filed by its dictionary `group`, exactly like a row
// the project set. What separates them is `origin: "default"`, which the row
// already carries, and the viewer hides them behind one toggle (off by
// default, with a count) — a display concern, handled where display is.

// Per-row naming (S2): no sheet-wide switch — a row whose extracted key has a
// keyMap entry is filed under the product key, with the extracted key
// surfaced as `variable` (the under_key column); every other row keeps its
// extracted key verbatim, with no `variable` at all. This deliberately does
// NOT tag a row that keyMap has no opinion on (an ambiguous variable backing
// more than one directive, or one the template never references) — its
// display key already IS its own identity, so an under_key entry would just
// repeat the same string in both columns. (Contrast the old "bound" keying,
// which tagged every row unconditionally once the sheet opted in — that
// per-SHEET switch no longer exists, so "worth tagging" is decided per row
// instead, by whether it actually resolved to a DIFFERENT key.)
function resolveKey(
  extractedKey: string,
  variableToBound: Map<string, string>,
  boundToVariable: Map<string, string>
): { paramKey: string; variable?: string } {
  const bound = variableToBound.get(extractedKey);
  if (bound !== undefined) return { paramKey: bound, variable: extractedKey };
  // Already keyed by the product key, with a variable behind it. That is what a
  // recipe emitting one row per ARTIFACT LINE produces (ansible's
  // `rows: artifact`): there is nothing to rename — the row was never keyed by
  // the variable — but the variable still belongs in the under_key column, and
  // every rule that asks "is there a variable behind this row" still has to
  // see one.
  const variable = boundToVariable.get(extractedKey);
  return variable !== undefined ? { paramKey: extractedKey, variable } : { paramKey: extractedKey };
}

// A layer-derived row's origin, before authoredKeys sees it, is always
// overlay/common per resolveKey/the two buildDrafts passes below. authoredKeys
// demotes every layer key it does NOT name to "default" — keeping whatever
// instances/value/source the row already resolved to (a row observed
// differently per environment is still worth a row; see SheetInputs.
// authoredKeys). Applied by paramKey (the row's DISPLAY key, post-keyMap),
// since that is what a recipe's authored-key set is stated in terms of.
function demotedOrigin(
  paramKey: string,
  layerOrigin: "overlay" | "common",
  authoredKeys: ReadonlySet<string> | undefined
): "overlay" | "common" | "default" {
  if (authoredKeys === undefined) return layerOrigin;
  return authoredKeys.has(paramKey) ? layerOrigin : "default";
}

function buildOverlayInstances(
  instanceNames: string[],
  extractedKey: string,
  base: ExtractedEntry | undefined,
  overlays: Extract<ValueLayer, { kind: "overlay" }>[]
): Instance[] {
  const out: Instance[] = [];
  for (const name of instanceNames) {
    const ov = overlays.find((o) => o.instance === name);
    const entry = ov?.entries.get(extractedKey) ?? base;
    if (!entry) continue; // no overlay for this instance and no base fallback
    out.push({ name, value: entry.value, source: entry.source });
  }
  return out;
}

function buildDrafts(si: SheetInputs, hooks: AssembleHooks | undefined, underKey: UnderKeyMeta | undefined): Draft[] {
  const baseLayers = si.layers.filter((l): l is Extract<ValueLayer, { kind: "base" }> => l.kind === "base");
  if (baseLayers.length !== 1) {
    throw new Error(`assemble: sheet "${si.name}" must have exactly one base layer (found ${baseLayers.length})`);
  }
  const base = baseLayers[0];
  const overlays = si.layers.filter((l): l is Extract<ValueLayer, { kind: "overlay" }> => l.kind === "overlay");

  for (const ov of overlays) {
    if (!si.instances.includes(ov.instance)) {
      throw new Error(`assemble: sheet "${si.name}" overlay instance "${ov.instance}" is not in instances`);
    }
  }
  const variableToBound = new Map<string, string>();
  const boundToVariable = new Map<string, string>();
  if (si.keyMap)
    for (const m of si.keyMap) {
      variableToBound.set(m.variable, m.boundKey);
      boundToVariable.set(m.boundKey, m.variable);
    }

  // referenceSites is keyed by the LAYER key (extractedKey), not the resolved
  // product key — a variable's own `resolveKey` lookup happens independently,
  // right alongside this one, in both passes below. `matchedReferenceSites`
  // tracks which entries actually found a home, so the hard error after both
  // passes can name exactly the ones that didn't.
  const referenceSitesByVariable = new Map<string, SourceLocation[]>();
  if (si.referenceSites) for (const rs of si.referenceSites) referenceSitesByVariable.set(rs.variable, rs.sites);
  const matchedReferenceSites = new Set<string>();

  function attachReferenceSites(param: Parameter, extractedKey: string): void {
    const sites = referenceSitesByVariable.get(extractedKey);
    if (!sites) return;
    param.additional_sources = sites;
    matchedReferenceSites.add(extractedKey);
  }

  const drafts: Draft[] = [];

  function withUnderKey(param: Parameter, variable: string | undefined): Parameter {
    if (variable !== undefined && underKey) {
      param.extra = { ...(param.extra ?? {}), [underKey.id]: variable };
    }
    return param;
  }

  // Every draft goes through the hooks here, so `keyFor`/`mapParam` see base
  // params, overlay-only params and embedded literals alike.
  function pushDraft(
    key: string,
    param: Parameter,
    variable?: string,
    extractedKey?: string,
    entryComponent?: string,
    fallbackCategoryPath?: string[],
    categoryPathWins?: boolean
  ): void {
    const ctx: ParamContext = { sheet: si.name, key, variable };
    // Looked up by the EXTRACTED key — the one the RECIPE saw and computed
    // `componentOf` against — not by the key after keyMap renamed the row to a
    // product key. Passing only the renamed key silently lost every row a
    // substitution merge had renamed: the Keycloak client whose signature
    // setting arrives as `SSO_SAML_CLIENT_SIGNATURE` and is filed under the
    // field path landed in no component at all, alone at the top of its sheet.
    const component = entryComponent ?? si.componentOf?.get(extractedKey ?? key);
    if (hooks?.keyFor) {
      ctx.key = hooks.keyFor(ctx);
      param.key = ctx.key;
    }
    const mapped = hooks?.mapParam ? hooks.mapParam(param, ctx) : param;
    if (mapped === null) return;
    drafts.push({ key: mapped.key, param: mapped, variable, component, fallbackCategoryPath, categoryPathWins });
  }

  // 1) Base-layer keys, in insertion order.
  const seen = new Set<string>();
  for (const [extractedKey, baseEntry] of base.entries) {
    seen.add(extractedKey);
    if (baseEntry.origin === "embedded") {
      // A fixed embedded entry in place (see ExtractedEntry) — no keying/
      // keyMap/under_key/overlay resolution, filed at its natural position.
      const param = {
        key: extractedKey,
        value: baseEntry.value,
        source: baseEntry.source,
        origin: "embedded",
      } as SimpleParameter;
      pushDraft(extractedKey, param, undefined, undefined, baseEntry.component);
      continue;
    }
    const { paramKey, variable } = resolveKey(extractedKey, variableToBound, boundToVariable);
    const overriddenBy = overlays.filter((ov) => ov.entries.has(extractedKey));

    // The vendor's value for this same key (ansible recipe's `baseline:`,
    // ExtractedEntry.baseline), when this sheet compares against one — carried
    // onto the Parameter alongside whichever shape the row resolves to below,
    // Pattern A or B: it is a property of the KEY, not of one value shape.
    const baselineField = baseEntry.baseline !== undefined ? { baseline: baseEntry.baseline } : {};
    let param: Parameter;
    if (overriddenBy.length > 0) {
      const instances = buildOverlayInstances(si.instances, extractedKey, baseEntry, overlays);
      const origin = demotedOrigin(paramKey, "overlay", si.authoredKeys);
      param = { key: paramKey, instances, origin, ...baselineField } as InstanceParameter;
    } else {
      const origin = demotedOrigin(paramKey, "common", si.authoredKeys);
      param = { key: paramKey, value: baseEntry.value, source: baseEntry.source, origin, ...baselineField } as SimpleParameter;
    }
    attachReferenceSites(param, extractedKey);
    pushDraft(paramKey, withUnderKey(param, variable), variable, extractedKey, baseEntry.component);
  }

  // 2) Keys that appear only in overlays, never in base: Pattern B limited to
  // the overlays that actually carry them (no base fallback).
  for (const ov of overlays) {
    for (const [extractedKey] of ov.entries) {
      if (seen.has(extractedKey)) continue;
      seen.add(extractedKey);
      const { paramKey, variable } = resolveKey(extractedKey, variableToBound, boundToVariable);
      const carriers = overlays.filter((o) => o.entries.has(extractedKey));
      const instances = buildOverlayInstances(si.instances, extractedKey, undefined, carriers);
      const origin = demotedOrigin(paramKey, "overlay", si.authoredKeys);
      const param = { key: paramKey, instances, origin } as InstanceParameter;
      attachReferenceSites(param, extractedKey);
      pushDraft(paramKey, withUnderKey(param, variable), variable, extractedKey, ov.entries.get(extractedKey)?.component);
    }
  }

  // A referenceSites entry naming a variable neither pass ever saw is a
  // producer bug, not a legitimate "nothing to attach to" — the sites it
  // carries would otherwise vanish with no trace (the wiring info this
  // feature exists to make checkable, silently dropped). Checked once here,
  // after both passes, rather than per-pass, since a variable could in
  // principle appear in either.
  if (si.referenceSites) {
    for (const rs of si.referenceSites) {
      if (matchedReferenceSites.has(rs.variable)) continue;
      const files = [...new Set(rs.sites.map((s) => s.file ?? "(no file)"))].join(", ");
      throw new Error(
        `assemble: sheet "${si.name}" referenceSites names variable "${rs.variable}", which produced no draft in ` +
          `the base layer or any overlay (sites: ${files})`
      );
    }
  }

  // 3) Embedded literals, appended after all base-derived params, in order.
  for (const e of si.embedded) {
    // A row a recipe emitted per ARTIFACT LINE arrives here already keyed by
    // the product's own key (ansible's `rows: artifact` on a sheet with
    // components puts its rows in `embedded`, not in a layer), so keyMap has
    // nothing to rename — but it still says WHICH variable backs the line, and
    // that belongs in the under_key column exactly as it does for a layer row.
    // This is resolveKey's second tier, reached the same way. A literal, and
    // any entry keyMap has no opinion on, resolves to undefined and is
    // untouched.
    const variable = boundToVariable.get(e.key);
    const param = (
      e.instances !== undefined
        ? // Pattern B, exactly as a base+overlay row would be: the instances a
          // row is absent from are the ones missing from this list.
          { key: e.key, instances: e.instances, origin: "overlay" }
        : e.origin === "baseline"
          ? // The vendor's key, absent from the deployed artifact: nothing is in
            // effect (`value: ""`), and `e.value` — what extraction actually
            // read off the vendor's file — becomes `baseline` instead of
            // `value`, the same slot-swap `default` does for `default` above.
            // No `source`: see the `Origin` comment in types.ts.
            { key: e.key, value: "", baseline: e.value, origin: "baseline" }
          : e.origin === "default"
            ? { key: e.key, value: e.value, default: e.value, origin: "default" }
            : { key: e.key, value: e.value, source: e.source, origin: "embedded" }
    ) as Parameter;
    pushDraft(e.key, withUnderKey(param, variable), variable, undefined, e.component, e.categoryPath, e.categoryPathWins);
  }

  return drafts;
}

// One row of the build-wide binding report: which dictionary entry a draft's
// key resolved to, and by which tier (see bind.ts's BindMethod) — or "none"
// when the key was evaluated against the project's bound dictionaries and
// matched nothing. "none" is reported, not omitted: this report exists so an
// inference change (a key that used to bind one way and now binds another,
// or stops binding at all) is visible as a row-level diff, and a silent drop
// to "no binding" is exactly the kind of change that must show up. Exposed so
// a caller (the CLI, or a test) can audit the whole build's binding at a
// glance — this is the ONE place a project key gets matched against a bound
// product dictionary, replacing the ad hoc, per-purpose matching that used to
// live separately in materialize's `covered` set and in enrich's dictionary
// provider (the latter still routes its own way — see enrich.ts — until a
// later task moves it onto this same core).
//
// `dictKey`/`product`/`version` are omitted (not `undefined`-valued) on a
// "none" row: there is no dictionary entry to name, and an omitted key
// serializes cleanly to JSON (`--bind-report`) without a stray `null`.
export type BindReportMethod = BindMethod | "none";
export type BindReportRow =
  | { sheet: string; key: string; method: BindMethod; dictKey: string; product: string; version: string }
  | { sheet: string; key: string; method: "none" };
// A `key_steps` rewrite whose "drop" pattern matched no row on the sheet that
// declared it. The author declared wiring that is not there, and every row
// they meant to bind quietly did not — the same class of mistake as an
// include/exclude pattern that selected nothing, and reported the same way
// rather than left to be noticed in the tally.
export type UnmatchedKeySteps = { sheet: string; product: string; version: string; patterns: string[] };

export type BindingReport = {
  rows: BindReportRow[];
  byMethod: Record<BindReportMethod, number>;
  unmatchedKeySteps: UnmatchedKeySteps[];
};

function emptyByMethod(): Record<BindReportMethod, number> {
  const out = {} as Record<BindReportMethod, number>;
  for (const m of BIND_METHODS) out[m] = 0;
  out.none = 0;
  return out;
}

// Resolve every draft's key against the project's bound dictionaries, BEFORE
// materialize and BEFORE filing (see assembleSheetsWithReport) — the single
// phase every downstream consumer of "is this key bound, and to what" now
// reads from, instead of each re-deriving its own candidate matching
// (materialize's old `covered` set, fileDrafts' category fallback). A key
// with no binding at all (`bindKey` returns undefined — most parameters have
// no dictionary counterpart) still gets a "none" row in the report (see
// BindReportRow above), even though it is simply absent from the returned
// bindings map. Ambiguous binds (bindKey returns a BindError) are collected
// into `bindErrors` rather than thrown immediately: the build reports every
// offending key at once, the same discipline missingCategory already uses,
// then fails — see the caller. (An ambiguous key gets neither a bindings
// entry nor a report row: the build never reaches the point of writing a
// report when bindErrors is non-empty.)
// A sheet's bind source plus the component it is scoped to, if any — kept
// together rather than as index-parallel arrays so the scope cannot drift away
// from the source it belongs to.
type ScopedBindSource = { source: BindSource; component?: string };

function bindDrafts(
  sheetName: string,
  drafts: Draft[],
  projectMeta: ProjectMetaDoc,
  bindSources: ScopedBindSource[],
  reportRows: BindReportRow[],
  bindErrors: string[]
): SheetBindings {
  const bindings: SheetBindings = new Map();
  if (bindSources.length === 0) return bindings;
  for (const d of drafts) {
    // A dictionary scoped to another component is not a dictionary this row
    // has (SheetDictionaryBinding.component).
    const inScope = bindSources.filter((s) => s.component === undefined || s.component === d.component).map((s) => s.source);
    if (inScope.length === 0) {
      reportRows.push({ sheet: sheetName, key: d.key, method: "none" });
      continue;
    }
    const dictKey = paramForRow(projectMeta, sheetName, d.component, d.key)?.dict_key;
    const result = bindKey(d.key, dictKey, inScope);
    if (result === undefined) {
      reportRows.push({ sheet: sheetName, key: d.key, method: "none" });
      continue;
    }
    if (isBindError(result)) {
      bindErrors.push(`${sheetName} > ${d.key}: ${result.message}`);
      continue;
    }
    setBinding(bindings, d.component, d.key, result);
    reportRows.push({
      sheet: sheetName,
      key: d.key,
      dictKey: result.dictKey,
      method: result.method,
      product: result.product,
      version: result.version,
    });
  }
  return bindings;
}

// Rows for the parameters the project does NOT set. Runs after buildDrafts and
// after the hooks: these rows are derived from the dictionary's own keys, and
// that identity is exactly what makes them resolvable by enrich — a `keyFor`
// rename would break it. Deciding a default row is not worth reviewing is what
// `out_of_scope` is for, not a hook.
function materializeDrafts(
  sheetName: string,
  // No `drafts` parameter: what this project already covers is read from
  // `draftBindings` (the single bind pass), not re-derived from the drafts here.
  draftBindings: SheetBindings,
  binding: SheetDictionaryBinding,
  opts: AssembleOpts,
  // The component this expansion is FOR, and the draft keys belonging to it.
  // Materialize answers "what does this project not set", and that question has
  // an answer only per component: two ALBs on one sheet each have their own
  // unset options, and a sheet-wide `covered` set let either one's value mark
  // the option covered for both — deleting the other's row from the ledger with
  // no report, which is the exact failure this whole file refuses elsewhere.
  // undefined = the sheet has no components; the whole sheet is the scope.
  component: string | undefined,
  componentKeys: Set<string> | undefined,
  // The repetition axis inside this component, if the recipe made one (see
  // SheetInputs.nestedMembers). An unset option of a REPEATED thing belongs to
  // each repetition, not to the type: six LDAP mappers of one store each have
  // their own `is.binary.attribute`, and that is where a reviewer would set
  // one — a single row filed under the mapper TYPE is a decision nobody can
  // act on, because there is no such object to configure.
  nested?: { under: string; members: { id: string; unit: string }[] }
): { drafts: Draft[]; report: MaterializeReport; bindings: Map<string, Binding> } {
  // binding.materialize is truthy whenever this is called (see the caller in
  // assembleSheetsWithReport) — `true` means "expand everything", an object
  // narrows via groups/defaultsCategory (see DictionaryMaterialize above).
  const opt = binding.materialize === true ? {} : binding.materialize!;

  const dirs = opts.metadataDirs ?? [];
  const dict = findDictionary(binding.product, binding.version, dirs, opts.readFile);
  if (!dict) {
    throw new Error(
      `assemble: materialize: dictionary not found: ${binding.product}@${binding.version} ` +
        `(searched: ${dirs.length > 0 ? dirs.join(", ") : "no metadata dirs configured"})`
    );
  }

  // The gate: materializing turns every UNCOVERED dictionary key into a row
  // that reads as "this product's default, unreviewed" — which only tells the
  // truth if the dictionary itself enumerates the product's real option space.
  // A hand-picked dictionary materialized the same way produces a sheet that
  // LOOKS like a full inventory but silently omits everything nobody happened
  // to write down. `coverage` (omitted -> "partial", the safe default) is the
  // one machine-checkable proxy for that distinction, so this is an error, not
  // a lint: nothing downstream can tell a fake ledger from a real one once it
  // is rendered.
  const coverage = dictionaryCoverage(dict);
  if (coverage !== "full") {
    throw new Error(
      `assemble: materialize: sheet "${sheetName}" names dictionary ${binding.product}@${binding.version}, ` +
        `whose coverage is "${coverage}"${dict.coverage === undefined ? " (not declared — defaults to \"partial\")" : ""}. ` +
        `A "partial" dictionary is a hand-picked set of parameters, not the product's full option space, so ` +
        `materializing it would produce a FAKE inventory: the sheet would look like "every ${binding.product} ` +
        `setting", while really being "every setting someone wrote down". If ${binding.product}@${binding.version}.yml ` +
        `is genuinely a mechanical, exhaustive extraction of ${binding.product}'s options (reflection, a settings ` +
        `dump, a scrape of literally every documented option), declare "coverage: full" on the dictionary document. ` +
        `Otherwise, remove "materialize" from sheet "${sheetName}"'s binding for this dictionary.`
    );
  }

  // Which dictionary keys this sheet already covers: every draft that bound
  // (see bindDrafts) against THIS SAME dictionary (product+version — a sheet
  // can bind more than one, e.g. aws-ec2's keycloak + httpd), by dictKey.
  // Repeats are covered by NAME: `Header[0]`/`Header[1]` both bind to the bare
  // `Header` entry (bind.ts's leaf tier), so any one occurrence of a directive
  // being set is enough to mark the whole directive covered — a materialized
  // row stands for "this project never sets this directive at all", which is
  // false the moment any instance of it appears in the drafts.
  const covered = new Set<string>();
  // Which of the dictionary's units this component actually uses (see
  // DictionaryParam.unit). Its own rows are the evidence: a component with no
  // `aws_lb` row does not have an ALB, so it has no unset ALB arguments — it
  // has no ALB. Empty when the dictionary declares no units at all, which is
  // the single-product case and expands everything.
  const unitsInUse = new Set<string>();
  for (const [, byKey] of draftBindings) {
    for (const [draftKey, b] of byKey) {
      if (componentKeys && !componentKeys.has(draftKey)) continue;
      if (b.product !== binding.product || b.version !== binding.version) continue;
      covered.add(b.dictKey);
      if (b.entry.unit !== undefined) unitsInUse.add(b.entry.unit);
    }
  }

  // The include-list gate (DictionaryMaterialize's `groups`): resolved once,
  // up front, so (a) the "did any named group even exist" check below sees
  // the dictionary's full group set regardless of what got filtered, and (b)
  // the per-entry loop is a single Set lookup.
  const groupFilter = opt.groups ? new Set(opt.groups) : undefined;
  const unknownGroups: string[] = [];
  if (groupFilter) {
    const dictGroups = new Set<string>();
    for (const p of Object.values(dict.parameters)) {
      const g = groupHead(p.group);
      if (g !== undefined) dictGroups.add(g);
    }
    for (const g of opt.groups!) if (!dictGroups.has(g)) unknownGroups.push(g);
  }


  const out: Draft[] = [];
  // Materialized rows are keyed by the dictionary's own key, by construction
  // — enrich() still needs a Binding to resolve their description/default
  // through the SAME single lookup path every other row uses (see
  // metadata.ts's MetadataQuery.binding), not a second, provider-side
  // matching path. Not added to the caller's BindingReport rows: that report
  // is about a PROJECT key resolving against a dictionary (see bindDrafts) —
  // a materialized row's key trivially equals its own dictKey, which is not
  // an interesting binding EVENT the way a project key's match is.
  const bindings = new Map<string, Binding>();
  let containerSkipped = 0;
  let unitAbsent = 0;
  let groupExcluded = 0;
  let noDefault = 0;
  const noDefaultKeys: string[] = [];
  for (const [key, entry] of Object.entries(dict.parameters)) {
    // A container has no value to assert as a default — "what is <IfModule>'s
    // default?" is not a question with an answer — so it is never eligible
    // for materialize, independent of whether this project's own drafts
    // happen to already carry a row of the same key (a parser's synthetic
    // "condition value" row, e.g. httpd.ts's IfModule expression, still
    // resolves its description through this same dictionary entry via
    // enrich() — see the `kind` doc comment). Never dropped silently:
    // counted here and reported by the caller (see MaterializeReport).
    if (entry.kind === "container") {
      containerSkipped++;
      continue;
    }
    if (covered.has(key)) continue;
    // An option of a unit this component does not use is not an unset option;
    // it is an option of something that is not here. Counted so the report says
    // how many, rather than the difference appearing as an unexplained drop.
    if (entry.unit !== undefined && !unitsInUse.has(entry.unit)) {
      unitAbsent++;
      continue;
    }
    // An entry with no group never matches a named filter (there is nothing
    // to opt it in with), so it is excluded right alongside every group that
    // wasn't listed — same as the "which modules does this deployment
    // actually load" question the filter exists to answer.
    // A `groups:` filter names tabs, so it matches the head of a group path —
    // narrowing to "Tokens" keeps "Tokens / Access tokens" with it rather than
    // silently dropping the very rows the reader asked for.
    if (groupFilter && !(groupHead(entry.group) !== undefined && groupFilter.has(groupHead(entry.group)!))) {
      groupExcluded++;
      continue;
    }
    // No documented default: `origin: "default"` asserts "the product
    // default applies here", which is false for a directive the dictionary
    // never recorded a default for (see DictionaryMaterialize.includeNoDefault
    // and the CLAUDE.md caveat this is measured against — some of these DO
    // have a real, undocumented default, e.g. httpd's AcceptFilter/
    // ErrorDocument/Protocol; the exclusion depends on the dictionary's own
    // extraction quality, which is exactly why it must never be silent).
    if (entry.default === undefined && !opt.includeNoDefault) {
      noDefault++;
      noDefaultKeys.push(key);
      continue;
    }
    // The value in effect IS the product default; enrich fills `default` (and
    // the description) from the same dictionary entry right after.
    const makeParam = (rowKey: string) =>
      ({
        key: rowKey,
        value: entry.default !== undefined ? String(entry.default) : "",
        origin: "default",
      }) as SimpleParameter;

    // One row per repetition, keyed the way the repetition's own rows are
    // (`<member>.<dictionary key>`), so a member that DOES set the option and
    // one that does not sit side by side under the same heading.
    const repetitions = entry.unit === undefined ? [] : (nested?.members ?? []).filter((m) => m.unit === entry.unit);
    if (repetitions.length > 0) {
      for (const m of repetitions) {
        const rowKey = `${m.id}.${key}`;
        if (covered.has(rowKey)) continue;
        out.push({
          key: rowKey,
          param: makeParam(rowKey),
          fallbackCategoryPath: [nested!.under, m.id],
          categoryPathWins: true,
          component,
        });
        bindings.set(rowKey, {
          product: binding.product,
          version: binding.version,
          entry,
          dictKey: key,
          method: "exact",
          docProvenance: dict.provenance,
        });
      }
      continue;
    }
    const param = makeParam(key);
    // Two levels: a single parent ("the project sets nothing here") holding a
    // subcategory per dictionary group — see fileDrafts and Draft's comment
    // for why this is a path rather than one name.
    out.push({ key, param, fallbackCategoryPath: groupPath(entry.group), component });
    bindings.set(key, {
      product: binding.product,
      version: binding.version,
      dictKey: key,
      entry,
      method: "exact",
      docProvenance: dict.provenance,
    });
  }
  const report: MaterializeReport = {
    sheet: sheetName,
    product: binding.product,
    version: binding.version,
    total: Object.keys(dict.parameters).length,
    containerSkipped,
    unitAbsent,
    materialized: out.length,
    groupExcluded,
    unknownGroups,
    noDefault,
    noDefaultKeys,
  };
  return { drafts: out, report, bindings };
}

// The file a row is written in, as a one-segment category path. Reads the
// row's own source first and an instance's second: a Pattern B row has no
// single source, but every instance of it is written in a file of the same
// KIND (one per environment), so the first is representative — and that is the
// same assumption `source_file` display fallbacks already make.
// Which file a row belongs to, for `group_by: file`.
//
// The distinction that matters is between a row that IS a line of the deployed
// artifact and a row that merely lives in the same role. `db-url` is a line of
// keycloak.conf whose VALUE happens to come from a variable — the variable is
// provenance, already shown in the under_key column, and grouping by it would
// split one file's settings across two headings for a reason about how the
// file is built. `keycloak_dist_src` is not a line of keycloak.conf at all: it
// tells the role where to download the distribution from, and filing it there
// makes the sheet claim something false about the file.
//
// The evidence is already in the model, so this is decided rather than assumed:
//
//   - sourced from the template itself       -> a literal line of the artifact
//   - carries a keyMap variable (under_key)  -> a line of the artifact whose
//                                               value is written elsewhere
//   - no source at all                       -> a product default of the
//                                               artifact: nobody set it, but
//                                               the artifact is where it would
//                                               be set
//   - anything else                          -> its own file. A variable that
//                                               never reaches the artifact.
function fileCategory(
  param: Parameter,
  artifact: string | undefined,
  templateSource: string | undefined,
  hasVariable: boolean
): string[] | undefined {
  const own =
    ("source" in param ? param.source?.file : undefined) ??
    ("instances" in param ? param.instances?.find((i) => i.source?.file)?.source?.file : undefined);
  const partOfArtifact = own === undefined || hasVariable || (templateSource !== undefined && own === templateSource);
  const file = partOfArtifact ? (artifact ?? own) : own;
  if (file === undefined) return undefined;
  return [baseFileName(file.split("/").pop() ?? file)];
}

function fileDrafts(
  sheetName: string,
  drafts: Draft[],
  draftBindings: SheetBindings,
  projectMeta: ProjectMetaDoc,
  // This SHEET's own declared top-level category order (sheet.yml's
  // categories: — see providers/project.ts's categoriesForSheet). Empty = no
  // order declared, so `declared` below is empty, `order` reduces to plain
  // first-appearance, and the ghost-tab check below is skipped entirely.
  declaredCategories: string[],
  groupByFile: boolean,
  // What this sheet DEPLOYS, when it says so (Sheet.file_path). Used only by
  // `group_by: file` — see fileCategory.
  sheetArtifact: string | undefined,
  // The file the artifact is BUILT from (Sheet.source_file) — a row sourced
  // there is a literal line of it.
  sheetTemplate: string | undefined,
  missingCategory: string[],
  scaffoldEntries: ScaffoldEntry[],
  // Formatted "sheet > key: category "X" is not in..." messages, one per
  // undeclared category actually used — accumulated across every sheet by
  // the caller and thrown once (see assembleSheetsWithReport).
  ghostCategories: string[],
  // Same shape, but for a category reached only through a dictionary's own
  // `group` fallback (no project `category:` written for that key) — see the
  // firstProjectCategoryExample/firstDictFallbackExample split below. Warned,
  // not thrown: accumulated across every sheet and printed once by the CLI.
  categoryWarnings: string[],
  // Display names for component ids, when the recipe supplied them.
  componentLabels: Map<string, LangText> | undefined,
  componentFiles: Map<string, { filePath?: string; sourceFile?: string }> | undefined,
  componentOrder: string[] | undefined
): Category[] {
  // How many distinct components the sheet has. One is the ordinary case (a
  // sheet covers one thing), and the level is collapsed for it — see the path
  // construction below.
  const componentCount = new Set(drafts.map((d) => d.component).filter((c) => c !== undefined)).size;

  // A category tree keyed by path segment at each level. Only materialized
  // rows ever produce a path longer than one segment (see
  // Draft.fallbackCategoryPath) — a project-declared category is always a
  // single name, exactly as before this function grew nesting.
  type Node = { name: string; params: Parameter[]; children: Map<string, Node>; childOrder: string[] };
  const root: Node = { name: "", params: [], children: new Map(), childOrder: [] };

  function childOf(node: Node, name: string): Node {
    let child = node.children.get(name);
    if (!child) {
      child = { name, params: [], children: new Map(), childOrder: [] };
      node.children.set(name, child);
      node.childOrder.push(name);
    }
    return child;
  }

  // Ghost-tab guard (P7): the first NON-materialize draft to land in each
  // top-level category, so a category that turns out undeclared (below) can
  // be reported with a concrete example key. Materialized rows are exempt:
  // their parent ("the project sets nothing here") and the dictionary `group`
  // subcategories under it are expected to range over whatever the
  // dictionary/`groups` filter says, which a sheet's own declared tab list
  // was never meant to enumerate.
  //
  // Split in two (P10 bug 2), because "undeclared" means something different
  // depending on WHERE the category name came from:
  //   - firstProjectCategoryExample: the project itself wrote `category:` in
  //     sheet.yml for this key. An undeclared name here is almost always a
  //     typo (`category: Generl`) — the project's own words disagreeing with
  //     its own declared tab list. Hard error (ghostCategories).
  //   - firstDictFallbackExample: no project `category:` — the row landed
  //     under a bound dictionary entry's own `group` (or "Uncategorized" if
  //     the entry has none) purely as a fallback (see the `path` ternary
  //     below). That name is a fact about the PRODUCT, not something the
  //     project typed, so it can never be a project typo; declaring
  //     `categories:` on a sheet must not force enumerating every dictionary
  //     group a bound param happens to fall into. Warning only
  //     (categoryWarnings) — informational, does not fail the build.
  const firstProjectCategoryExample = new Map<string, string>();
  const firstDictFallbackExample = new Map<string, string>();

  for (const d of drafts) {
    // Component-first, then the sheet-wide table (providers/project.ts's
    // paramForRow): two components of one product share their field NAMES, so
    // a flat table would hand one component's remarks to the other.
    const meta = paramForRow(projectMeta, sheetName, d.component, d.key);
    const binding = bindingFor(draftBindings, d.component, d.key);
    // The project's own category always wins. Failing that, a row that BOUND
    // to a product dictionary entry (see bindDrafts) falls back to the
    // product's own grouping of that entry — the same fallback materialize's
    // own rows already got, now extended to every row instead of only the
    // ones materialize itself manufactured, closing the asymmetry where a
    // project had to hand-write `category:` for a row it only set because it
    // happens to also be bound. A bound entry with no `group` of its own
    // (or a materialized row's own `fallbackCategoryPath`, when neither of
    // the above applies) still needs somewhere to land, hence UNCATEGORIZED.
    // Only a row with NEITHER a project category NOR any binding at all is a
    // hard error — that discipline (keeping the project metadata honest) now
    // applies to a strictly smaller set than before: an unbound param the
    // project sets without dictionaries in play behaves exactly as it always
    // did.
    // The component, when the sheet has one, is the OUTERMOST level: a row
    // belongs first to the thing it was built for, and only then to the
    // product's own taxonomy of settings. Below it the order is unchanged —
    // the project's explicit `category:` for this key, else the bound
    // dictionary's own group, else a materialized row's fallback.
    //
    // `category: null` (DISTINCT from an absent one, exactly as `dict_key:
    // null` is distinct from an absent `dict_key`) is the project stating that
    // this row belongs to no category at all — it is about the COMPONENT as a
    // whole. The admin console this sheet mirrors has that place literally: a
    // Keycloak client's Enabled toggle lives in the page header, above the tab
    // strip, not on any tab. So does a project's own per-environment input
    // that several of the component's fields are derived from.
    //
    // It has to be declared and can never be fallen into — see the empty-path
    // error below, which is what makes an undeclared row an error again.
    const declaredNoCategory = meta?.category === null;
    // The artifact the row is written in, `.j2` stripped: a template is named
    // for the file it produces, and that file is what a reviewer is holding. A
    // row with no file of its own — a product default nobody set — resolves to
    // undefined here and falls through to what it had before.
    //
    // Kept separate from `inner` because only a DERIVED name can be folded
    // below: a project that writes `category:` by hand said what it meant.
    const derivedFile =
      declaredNoCategory || meta?.category || !groupByFile
        ? undefined
        : fileCategory(
            d.param,
            componentFiles?.get(d.component ?? "")?.filePath ?? sheetArtifact,
            componentFiles?.get(d.component ?? "")?.sourceFile ?? sheetTemplate,
            d.variable !== undefined
          );
    const inner = declaredNoCategory
      ? []
      : meta?.category
        ? // A list is a path (project.ts's ProjectMetaParam.category); a bare
          // string is the one-segment case of the same thing. The loop below
          // already walks a path, so nesting needs nothing else.
          typeof meta.category === "string"
          ? [meta.category]
          : meta.category
        : groupByFile
          ? (derivedFile ?? bindingOrFallback(binding, d.fallbackCategoryPath, d.categoryPathWins))
          : bindingOrFallback(binding, d.fallbackCategoryPath, d.categoryPathWins);
    // The component level appears only when the sheet HAS more than one. A
    // sheet covering a single component is that component — naming it again
    // above every category would add a level that says nothing, and would make
    // every row's identity (sheet::category::param) a level deeper for no
    // reader-visible gain. Collapsed here rather than hidden in the viewer, so
    // the model matches what is rendered and apply/review targets stay flat.
    //
    // Going from one component to two therefore re-keys the sheet's rows. That
    // is a real structural change to what the sheet covers, and `diff` shows it
    // as one.
    const showComponent = componentCount > 1 && d.component !== undefined;
    // `inner === undefined` means NOTHING decided a category — no project
    // `category:`, no binding, no materialize fallback. That must stay an
    // error whether or not a component level exists, which is why the
    // component is prepended only to a path that already resolved: prepending
    // it first made every such row come out length 1, so the check below could
    // not fire and the row landed silently under the component heading. The
    // guard held on a single-component sheet (collapsed, so length 0) and was
    // defeated the moment a second component appeared — a build-breaking
    // omission turning into a silent one because a sibling was added
    // elsewhere.
    // A derived file name that repeats the component says nothing, and the
    // level it opens holds exactly one child. `templates:` naming each
    // component after the file it deploys is the ordinary shape — the
    // component IS the file — so `group_by: file` re-derives an identity the
    // row already carries and every tab reads `httpd.conf > httpd.conf`.
    // Folded here for the same reason the component level itself is dropped on
    // a single-component sheet (see `showComponent`): a level that names what
    // its parent already named is not structure.
    //
    // Only the DERIVED name folds. `group_by: file` still earns its keep on
    // the same sheet for a row that is NOT a line of any artifact — an Ansible
    // variable the templates never render — which is exactly the case
    // fileCategory's last branch exists for, and which keeps its own file's
    // name here.
    const folded =
      inner !== undefined && showComponent && derivedFile !== undefined && inner[0] === d.component
        ? inner.slice(1)
        : inner;
    const path = folded === undefined ? undefined : showComponent ? [d.component!, ...folded] : folded;
    if (!path || path.length === 0) {
      // A declared `category: null` that resolved to nothing means the sheet
      // has no component level to file under — either no component at all, or
      // a single one, which is collapsed (above). The model has no place for
      // it: `Sheet.categories` holds every row, and a sheet root carries no
      // params. Say that, rather than reporting it as an undeclared category
      // the scaffold could fix by writing a name.
      if (declaredNoCategory) {
        missingCategory.push(
          `${sheetName} > ${d.key} (declared category: null, but this sheet has no component level to file it under — ` +
            `a sheet with one component IS that component, so the level is collapsed and there is nothing above its categories)`
        );
        continue;
      }
      missingCategory.push(`${sheetName} > ${d.key}`);
      // Never bound here (a bound key always resolves SOME path — its dict
      // group, or Uncategorized — a few lines above), but looked up rather
      // than assumed undefined: if that fallback logic ever grows another
      // case, the scaffold's "binds:" comment should track it, not silently
      // go stale.
      scaffoldEntries.push({
        sheet: sheetName,
        key: d.key,
        needsCategory: true,
        needsDescription: true,
        binding,
        // Only when the sheet actually shows a component level: on a
        // single-component sheet the sheet IS the component, and namespacing
        // the fragment would tell the reader to write a level that does not
        // exist in their sheet.yml.
        ...(showComponent ? { component: d.component } : {}),
      });
      continue;
    }
    let node = root;
    for (const segment of path) node = childOf(node, segment);
    // The ghost-tab guard below is about the PRODUCT's categories, which a
    // sheet declares in `categories:`. A component is a different declaration,
    // made in build.yml, and it sits outside that list — so the name checked is
    // the outermost category WITHIN the component, not the component itself.
    // Requiring components to be repeated in `categories:` would make one fact
    // declarable in two places, which is how the two drift apart.
    const declaredLevel = showComponent ? path?.[1] : path?.[0];
    if (!d.fallbackCategoryPath && declaredLevel !== undefined) {
      if (meta?.category) {
        if (!firstProjectCategoryExample.has(declaredLevel)) firstProjectCategoryExample.set(declaredLevel, d.key);
      } else if (!firstDictFallbackExample.has(declaredLevel)) {
        firstDictFallbackExample.set(declaredLevel, d.key);
      }
    }
    if (meta?.out_of_scope) d.param.out_of_scope = meta.out_of_scope;
    node.params.push(d.param);
  }

  // Ghost-tab guard: once a sheet declares its tab list, every top-level
  // category actually used should be in it — but what to DO about a miss
  // depends on where the name came from (see the split above):
  //   - a project-written `category:` not on the list is almost always a typo
  //     (`category: Generl`) — the build fails.
  //   - a dictionary `group` fallback not on the list is a fact about the
  //     bound product, not something the project typed — it only warns
  //     ("a new tab will appear"; declare it in `categories:` to control its
  //     position, or leave it as an unplanned tab).
  // Declaring nothing (declaredCategories empty) keeps a sheet exactly as
  // free as before this check existed, for both cases.
  if (declaredCategories.length > 0) {
    const declaredSet = new Set(declaredCategories);
    for (const [name, exampleKey] of firstProjectCategoryExample) {
      if (declaredSet.has(name)) continue;
      const hint = suggestNearest(name, declaredCategories);
      ghostCategories.push(
        `${sheetName} > ${exampleKey}: category "${name}" is not in this sheet's declared categories ` +
          `(${declaredCategories.join(", ")})` +
          (hint ? ` — did you mean "${hint}"?` : "")
      );
    }
    for (const [name, exampleKey] of firstDictFallbackExample) {
      if (declaredSet.has(name)) continue;
      if (firstProjectCategoryExample.has(name)) continue; // already reported as an error above
      categoryWarnings.push(
        `${sheetName} > ${exampleKey}: category "${name}" (from a bound dictionary's group) is not in this sheet's ` +
          `declared categories (${declaredCategories.join(", ")}) — it will appear as an extra tab; add it to ` +
          `categories: to control where it lands`
      );
    }
  }

  // Prefer this sheet's own declared display order (its whole reason for
  // existing — see providers/project.ts's categoriesForSheet) over emission
  // order; any TOP-LEVEL category that appears here but isn't declared falls
  // back to first-appearance, appended after the declared ones. Reachable via
  // a materialized row, or now (P10 bug 2) via a warned-but-not-fatal
  // dictionary `group` fallback too — a project-written undeclared category
  // still fails the build above, so only those two non-error sources ever
  // reach here. Only the top level is reordered this way — declared order
  // names sheet-visible tabs, and materialize's own subcategories (a
  // dictionary's `group`s) have no equivalent declaration to honor, so they
  // keep first-appearance order.
  // Order one node's children by the sheet's declared list, keeping anything
  // undeclared in first-appearance order after it.
  // Every declared name that actually ordered something, collected as it goes:
  // a declaration matching nothing is reported below rather than dropped.
  const declaredUsed = new Set<string>();
  const declaredFirst = (node: Node): string[] => {
    const first = declaredCategories.filter((name) => node.children.has(name));
    for (const name of first) declaredUsed.add(name);
    return [...first, ...node.childOrder.filter((name) => !first.includes(name))];
  };
  const declared = declaredCategories.filter((name) => root.children.has(name));
  for (const name of declared) declaredUsed.add(name);
  // A component's place in the reading order is the order the SPEC declares it
  // in — the static files, the templates — not the order its rows happen to
  // reach the assembler. Those differ whenever a component's values arrive
  // through a shared layer: a realm whose per-environment values come from env
  // files is drafted before one written out literally, so the sheet opened on
  // the second file listed. Same rule `instances` has always had: the axis is
  // as DECLARED, never as observed.
  const declaredComponents = (componentOrder ?? []).filter((name) => root.children.has(name) && !declared.includes(name));
  const undeclared = root.childOrder.filter((name) => !declared.includes(name) && !declaredComponents.includes(name));
  const order = [...declared, ...declaredComponents, ...undeclared];

  function toCategory(node: Node, isComponent = false): Category {
    const cat: Category = { name: node.name };
    // A component id gets its display name attached here — the id stays the
    // category's identity, the label is what a reader sees. Only ever set on
    // the component level, because that is the only category whose name is
    // written in two languages (see types.ts's Category).
    const label = componentLabels?.get(node.name);
    if (label) cat.label = label;
    // Same rule as the label: only the component level carries these, because
    // only a component IS a deployed artifact. verify/apply already read the
    // nearest file_path/source_file up the tree, so declaring them here puts
    // every row of that component on the right file with nothing else to do.
    const files = componentFiles?.get(node.name);
    if (files?.filePath) cat.file_path = files.filePath;
    if (files?.sourceFile) cat.source_file = files.sourceFile;
    if (node.params.length > 0) cat.params = node.params;
    // On a component sheet the declared tabs are not the sheet's top level —
    // they sit one level down, inside each component — so the declared order
    // has to be honoured there too, or `categories:` would silently stop
    // ordering anything the moment a sheet grew components. Only that one
    // level: deeper categories are a dictionary's own groups, which have no
    // declaration to honour (same rule as the root level above).
    const childNames = isComponent ? declaredFirst(node) : node.childOrder;
    if (childNames.length > 0) cat.categories = childNames.map((name) => toCategory(node.children.get(name)!));
    return cat;
  }

  const categories = order.map((name) => toCategory(root.children.get(name)!, componentCount > 1));

  // A declared category that ordered nothing is wiring the author wrote and no
  // row ever saw — the same failure keyglob and keytransform already report for
  // a pattern that matched nothing (`unmatchedPatterns`, `unmatchedDropPatterns`),
  // and it was the one place here that stayed silent. It is not harmless: a
  // dictionary's `group` is a PATH, so a name declared in the old flat spelling
  // ("Tokens / Access tokens" for what is now the head "Tokens") quietly orders
  // nothing at all, and the tab sits wherever emission order happens to put it.
  //
  // Reported after the tree is built, not while filtering, because on a sheet
  // with components a name may order nothing at the root and still order
  // something inside every component.
  if (declaredCategories.length > 0) {
    const used = new Set<string>();
    const collect = (cats: Category[]): void => {
      for (const c of cats) {
        used.add(c.name);
        collect(c.categories ?? []);
      }
    };
    collect(categories);
    for (const name of declaredCategories) {
      if (declaredUsed.has(name)) continue;
      // The name IS in use, just not at the level a declaration governs: a
      // dictionary's `group` is a PATH, and only its head is a tab. Saying
      // "did you mean X?" about the very name written would be absurd, and it
      // would hide the actual rule.
      if (used.has(name)) {
        categoryWarnings.push(
          `${sheetName}: declared category "${name}" ordered nothing — it exists, but nested under another. ` +
            `A declaration names a TOP-level tab, so declare the head of its path instead`
        );
        continue;
      }
      const hint = suggestNearest(name, used);
      categoryWarnings.push(
        `${sheetName}: declared category "${name}" ordered nothing — no row is filed under it` +
          (hint ? `; did you mean "${hint}"?` : "")
      );
    }
  }

  return categories;
}


// A short "did you mean" hint for an unused project-metadata key: the closest
// key the build actually assembled, if close enough to plausibly be the same
// parameter under a typo or a rename the metadata was never updated for. The
// distance threshold is deliberately tight (a quarter of the key's own
// length, floor 2) — a wrong suggestion is worse than none, so this only
// fires for genuinely near misses, not any old unrelated key.
//
// Exported so spec.ts's build.yml field-name validation (an unknown
// `overlayz:` should suggest `overlays:`) reuses the identical heuristic
// instead of growing a second one.

// A project metadata key described but never used, paired with the sheet it
// was declared under (`""` for a flat doc — the whole point of a flat doc is
// that it isn't about any one sheet). For a `sheets:` doc this is where the
// accuracy gain over the old build-wide check comes from: a key is "used"
// only if THAT SAME sheet's own drafts produced it, so a key declared for
// sheet A that a DIFFERENT sheet B happens to also draft (the leakage this
// task exists to catch) is correctly still unused under A, not masked by B's
// unrelated draft of the same name.
function unusedProjectMetaEntries(
  projectMeta: ProjectMetaDoc,
  assembledKeysBySheet: Map<string, Set<string>>
): { sheet: string; key: string }[] {
  if (projectMeta.sheets) {
    const out: { sheet: string; key: string }[] = [];
    for (const [sheetName, sheetDoc] of Object.entries(projectMeta.sheets)) {
      const assembled = assembledKeysBySheet.get(sheetName) ?? new Set<string>();
      for (const key of Object.keys(sheetDoc.params)) {
        if (!assembled.has(key)) out.push({ sheet: sheetName, key });
      }
    }
    return out;
  }
  const assembledAll = new Set<string>();
  for (const keys of assembledKeysBySheet.values()) for (const key of keys) assembledAll.add(key);
  return Object.keys(projectMeta.params ?? {})
    .filter((key) => !assembledAll.has(key))
    .map((key) => ({ sheet: "", key }));
}

// Same assembly as assembleSheets(), but also returns the enrich() report
// (byProvider/filled counts) — needed by a caller that prints an enrichment
// summary (e.g. `import --spec`). assembleSheets() itself stays a plain
// ParameterSheetInput return so existing callers are unaffected.
export function assembleSheetsWithReport(
  inputs: SheetInputs[],
  opts: AssembleOpts
): {
  input: ParameterSheetInput;
  report: EnrichReport;
  unusedProjectParams: string[];
  materializeReports: MaterializeReport[];
  // Rows a dictionary's `ui` claim dropped or narrowed — see UiReport.
  uiReports: UiReport[];
  binding: BindingReport;
  // Undeclared top-level categories reached only via a dictionary `group`
  // fallback (P10 bug 2) — informational, the build already succeeded.
  categoryWarnings: string[];
} {
  // A configured project path whose file doesn't exist yet (first-ever run,
  // sheet.yml not authored yet) is treated as "no project metadata" here too
  // — same reasoning as enrich.ts's own projectFileExists check, which this
  // mirrors: it lets the build run far enough to hit missingCategory below
  // and offer a scaffold, instead of dying on loadProjectMeta's "not found"
  // with nothing actionable. `loadedProjectMeta` (as opposed to the
  // operational `projectMeta`, which always falls back to
  // EMPTY_PROJECT_META) keeps the distinction between "loaded and flat" and
  // "nothing to load" that scaffoldShapeFor needs.
  const projectFileExists = opts.projectPath !== undefined && opts.readFile(opts.projectPath) !== null;
  const loadedProjectMeta: ProjectMetaDoc | undefined =
    opts.projectPath !== undefined && projectFileExists ? loadProjectMeta(opts.projectPath, opts.readFile) : undefined;
  const projectMeta = loadedProjectMeta ?? EMPTY_PROJECT_META;
  const scaffoldShape = scaffoldShapeFor(loadedProjectMeta, opts.projectPath !== undefined, inputs.length);
  // Declared but absent: the scaffold has to say so, or a typo in
  // `enrich.project` reads as "these params need a category".
  const missingProjectPath = opts.projectPath !== undefined && !projectFileExists ? opts.projectPath : undefined;

  const missingCategory: string[] = [];
  const missingCategoryEntries: ScaffoldEntry[] = [];
  const bindErrors: string[] = [];
  const bindReportRows: BindReportRow[] = [];
  const unmatchedKeySteps: UnmatchedKeySteps[] = [];
  // Every key that reached assembly, across ALL sheets — kept for the
  // "did you mean" hint on an unused-project-param error (suggestNearest
  // below), which is a plausibility guess and not scoped to one sheet.
  const assembledKeys = new Set<string>();
  // The SAME keys, but kept per sheet too: a `sheets:` project-metadata doc
  // is a namespace per sheet (see providers/project.ts), so "did this
  // sheet's own declared param ever get used" must be answered per sheet,
  // not against the build-wide union — that union is exactly what let a key
  // declared for one sheet silently count as "used" because a DIFFERENT
  // sheet happened to also produce a draft of the same name (see
  // unusedProjectParams below).
  const assembledKeysBySheet = new Map<string, Set<string>>();
  const underKeyColumns = new Map<string, ColumnDefinition>();
  const sheets: Sheet[] = [];
  const artifacts: ArtifactPreview[] = [];
  const materializeReports: MaterializeReport[] = [];
  const uiReports: UiReport[] = [];
  const deadComponents: string[] = [];
  // Every sheet's resolved bindings (bindDrafts' return value), keyed by
  // sheet name then parameter key — handed to enrich() below so its
  // dictionary provider does a plain lookup instead of re-running its own key
  // matching against the SAME dictionaries (see enrich.ts's EnrichOptions.bindings).
  const allBindings = new Map<string, SheetBindings>();
  // Per sheet: does it RENDER a component level, and if it has exactly one
  // component (which collapses that level), which. This is what turns the
  // category path enrich walks back into the component a binding is filed
  // under — see EnrichOptions.bindings.
  const componentLevel = new Map<string, { shows: boolean; only?: string }>();
  // Every keyMap-derived row's backing variable, keyed by sheet name then the
  // row's FINAL (product) key — handed to enrich() below (EnrichOptions.
  // variables) so a native-channel provider (argument-specs.ts) can still
  // reach a row that keyMap renamed. Built independently of whether the
  // sheet declares an `under_key` column: that column is a display choice,
  // this is a lookup fact.
  const allVariables = new Map<string, Map<string, string>>();

  // opts.dictionaries is keyed by sheet name (see its doc comment) — a key
  // naming a sheet this build has no SheetInputs for is always a mistake (a
  // stale name after a sheet was renamed, a typo), same discipline as every
  // other "must not fail silently" check in this file. The project metadata's
  // own `sheets:` doc (below, checkProjectMetaSheets) carries the identical
  // check for sheet.yml's `categories`/`under_key`/`params`.
  const sheetNames = new Set(inputs.map((si) => si.name));
  for (const name of Object.keys(opts.dictionaries ?? {})) {
    if (!sheetNames.has(name)) {
      throw new Error(
        `assemble: dictionaries names sheet "${name}", which this build has no sheet for ` +
          `(sheets: ${[...sheetNames].join(", ")})`
      );
    }
  }
  // Same discipline for the project metadata's own `sheets:` doc, if it has
  // one (a flat doc has none — see checkProjectMetaSheets).
  checkProjectMetaSheets(projectMeta, sheetNames);

  const ghostCategories: string[] = [];
  const categoryWarnings: string[] = [];

  for (const si of inputs) {
    // This sheet's own under_key declaration lives in the project metadata
    // (sheet.yml), not on SheetInputs itself (see providers/project.ts's
    // underKeyForSheet). Required whenever ANY row is named by a product key
    // via keyMap (S2: there is no sheet-wide "bound keying" flag anymore —
    // the moment even ONE row resolves through keyMap, `variable` will be set
    // on it, see resolveKey, and needs somewhere to be surfaced) — a sheet
    // with an empty/absent keyMap (every row keeps its extracted identity)
    // needs no under_key column at all.
    const underKey = underKeyForSheet(projectMeta, si.name);
    const sheetLabel = labelForSheet(projectMeta, si.name);
    const sheetGroup = groupForSheet(projectMeta, si.name);
    const compareComponents = compareComponentsForSheet(projectMeta, si.name);
    if ((si.keyMap?.length ?? 0) > 0 && !underKey) {
      throw new Error(
        `assemble: sheet "${si.name}" has parameter(s) named by a product key (via keyMap) and must declare an ` +
          `"under_key" (id + label) in the project metadata (sheet.yml) to surface the backing variable`
      );
    }
    const drafts = buildDrafts(si, opts.hooks, underKey);
    // Declared, and checked: a sheet claiming its components are comparable
    // when they share no row at all would render a diagonal — every row filled
    // in exactly one column — which is the same class of mistake as a `names:`
    // entry no row produces. Counted over the drafts, since that is the row set
    // the view would be built from.
    if (compareComponents) {
      const byKey = new Map<string, Set<string>>();
      for (const d of drafts) {
        if (d.component === undefined) continue;
        byKey.set(d.key, (byKey.get(d.key) ?? new Set()).add(d.component));
      }
      const shared = [...byKey.values()].filter((c) => c.size > 1).length;
      if (shared === 0) {
        throw new Error(
          `assemble: sheet "${si.name}" declares compare_components, but no parameter appears in more than one of its ` +
            `components — read side by side every row would be filled in exactly one column. Components are not ` +
            `necessarily comparable: several artifacts of one product, or several resource types, share nothing.`
        );
      }
    }
    const components = new Set(drafts.map((d) => d.component).filter((c): c is string => c !== undefined));
    componentLevel.set(si.name, { shows: components.size > 1, only: components.size === 1 ? [...components][0] : undefined });
    // The other half of the same two-way check `component: names:` has: a
    // sheet.yml block for a component this sheet never produced. It needs its
    // own check because the unused-param one cannot see it — a dead block is
    // usually a copy of a SIBLING sheet's, so every key in it (`enabled`,
    // `protocol`) exists on this sheet under a different component and looks
    // used. Measured on a real spec: two sheets each carried the other's
    // component block, 90 lines of documentation applying to nothing, with no
    // complaint from any gate.
    for (const declared of declaredComponentsForSheet(projectMeta, si.name)) {
      if (components.has(declared)) continue;
      const hint = suggestNearest(declared, components);
      deadComponents.push(
        `${si.name}: metadata declares component "${declared}", which this sheet produces no rows for` +
          (hint ? ` — did you mean "${hint}"?` : ` (produced: ${[...components].sort().join(", ") || "none"})`)
      );
    }
    const sheetVariables = new Map<string, string>();
    for (const d of drafts) if (d.variable !== undefined) sheetVariables.set(d.key, d.variable);
    allVariables.set(si.name, sheetVariables);
    // This SHEET's own declared dictionaries only — never another sheet's
    // (see AssembleOpts.dictionaries): binding is resolved per sheet so a key
    // can only ever match what ITS OWN sheet declared.
    const sheetDictionaries = opts.dictionaries?.[si.name] ?? [];
    const bindSources: ScopedBindSource[] = loadBindSources(sheetDictionaries, opts.metadataDirs ?? [], opts.readFile).map(
      (source, i) => ({ source, component: sheetDictionaries[i]!.component })
    );
    // Bind every draft against this sheet's dictionaries BEFORE materialize
    // and BEFORE filing — the single phase both now read from (see bindDrafts,
    // materializeDrafts' `covered` set, and fileDrafts' category fallback)
    // instead of each re-deriving its own key matching.
    const draftBindings = bindDrafts(si.name, drafts, projectMeta, bindSources, bindReportRows, bindErrors);
    // A `key_steps` rewrite that never matched a single row is the same class
    // of mistake as an include/exclude pattern that selected nothing: the
    // author declared wiring that is not there, and every row they meant to
    // bind quietly did not. Reported once per sheet, after every draft has
    // been through the transformer (which is why the transformer lives on the
    // BindSource and not inside bindKey).
    for (const { source: src } of bindSources) {
      const patterns = src.keyTransformer?.unmatchedDropPatterns() ?? [];
      if (patterns.length > 0) {
        unmatchedKeySteps.push({ sheet: si.name, product: src.binding.product, version: src.binding.version, patterns });
      }
    }
    // enrich() gets draftBindings PLUS materialize's own bindings (below) —
    // but fileDrafts (and materializeDrafts' own `covered` set) must keep
    // seeing ONLY draftBindings: a materialized row already carries its
    // category as `fallbackCategoryPath` (nested under the "product
    // defaults" parent — see materializeDrafts), and fileDrafts prefers a
    // present `binding` over that path, so merging materialize's bindings
    // into draftBindings itself would flatten every materialized row back to
    // a top-level dictionary-group tab instead of nesting it.
    // A copy per component too, not just of the outer map: materialize adds its
    // own rows' bindings below, and a shallow copy would push them into the
    // very map fileDrafts must keep seeing unchanged (see the comment above).
    const sheetBindings: SheetBindings = new Map([...draftBindings].map(([c, byKey]) => [c, new Map(byKey)]));
    allBindings.set(si.name, sheetBindings);
    // One expansion PER COMPONENT (see materializeDrafts): each component's
    // ledger is its own. Component order follows first appearance in the
    // drafts, so the sheet reads in the order the artifact presented them.
    const componentKeysByName = new Map<string, Set<string>>();
    for (const d of drafts) {
      if (d.component === undefined) continue;
      const set = componentKeysByName.get(d.component) ?? new Set<string>();
      set.add(d.key);
      componentKeysByName.set(d.component, set);
    }
    // One expansion, unfiltered, when the sheet has a single component: the
    // sheet IS that component, so every draft belongs to it — including any the
    // component map happens not to mention. Filtering by an incomplete key set
    // would leave a row's dictionary key uncovered and materialize it as unset
    // right beside the row that sets it.
    const expansions: [string | undefined, Set<string> | undefined][] =
      componentKeysByName.size > 1
        ? [...componentKeysByName].map(([c, k]) => [c, k])
        : [[[...componentKeysByName.keys()][0], undefined]];
    // A dictionary that names a component the sheet does not have is the same
    // class of mistake as a `names:` entry no row produces, or an include
    // pattern that matched nothing: wiring the author declared and no row ever
    // saw. Checked for every binding, materializing or not, because the scope
    // governs binding too.
    const sheetComponents = new Set(drafts.map((d) => d.component).filter((c): c is string => c !== undefined));
    for (const dictBinding of sheetDictionaries) {
      const scope = dictBinding.component;
      if (scope !== undefined && !sheetComponents.has(scope)) {
        throw new Error(
          `assemble: sheet "${si.name}" binds ${dictBinding.product}@${dictBinding.version} to component "${scope}", ` +
            `which this sheet has no rows for (components: ${[...sheetComponents].join(", ") || "none"})`
        );
      }
    }
    for (const dictBinding of sheetDictionaries) {
      if (!dictBinding.materialize) continue;
      for (const [component, componentKeys] of expansions) {
        if (dictBinding.component !== undefined && dictBinding.component !== component) continue;
        const materialized = materializeDrafts(si.name, draftBindings, dictBinding, opts, component, componentKeys, component === undefined ? undefined : si.nestedMembers?.get(component));
        drafts.push(...materialized.drafts);
        materializeReports.push(materialized.report);
        for (const [k, v] of materialized.bindings) setBinding(sheetBindings, component, k, v);
      }
    }
    // What the product's own UI says about a row NOBODY SET (see
    // DictionaryParam.ui). Runs after materialize so it covers both kinds of
    // `origin: "default"` row — the ones materialize invented from a
    // dictionary, and the ones a recipe filed from a snapshot of the product
    // (static_files' `origin: default`).
    //
    // Restricted to rows the project does not set, and that restriction is the
    // whole point: `ui: "absent"` does not mean unsettable, it means the UI has
    // no field for it. The API still accepts it, which is how a provisioning
    // tool writes one — so a row this project DOES set stays exactly as it is,
    // verified and reviewed like any other. What is removed is only the
    // assertion "the product default is in force here", for a parameter no
    // reader could have chosen and no reader will find in the console.
    const uiAbsentKeys: string[] = [];
    const uiReadonlyKeys: string[] = [];
    const keptDrafts: Draft[] = [];
    for (const d of drafts) {
      const ui = d.param.origin === "default" ? bindingFor(sheetBindings, d.component, d.key)?.entry.ui : undefined;
      if (ui === "absent") {
        uiAbsentKeys.push(d.key);
        continue;
      }
      if (ui === "readonly") {
        uiReadonlyKeys.push(d.key);
        // A project's own out_of_scope is applied later, in fileDrafts, and
        // overwrites this one — the project has the last word on its own
        // review remit, as everywhere else.
        d.param.out_of_scope = { reason: UI_READONLY_REASON };
      }
      keptDrafts.push(d);
    }
    if (uiAbsentKeys.length > 0 || uiReadonlyKeys.length > 0) {
      uiReports.push({ sheet: si.name, absentKeys: uiAbsentKeys, readonlyKeys: uiReadonlyKeys });
    }
    drafts.length = 0;
    drafts.push(...keptDrafts);
    const sheetAssembledKeys = new Set<string>();
    for (const d of drafts) {
      assembledKeys.add(d.key);
      sheetAssembledKeys.add(d.key);
    }
    assembledKeysBySheet.set(si.name, sheetAssembledKeys);
    const declaredCategories = categoriesForSheet(projectMeta, si.name);
    const categories = fileDrafts(
      si.name,
      drafts,
      draftBindings,
      projectMeta,
      declaredCategories,
      groupByForSheet(projectMeta, si.name) === "file",
      si.filePath,
      si.sourceFile,
      missingCategory,
      missingCategoryEntries,
      ghostCategories,
      categoryWarnings,
      si.componentLabels,
      si.componentFiles,
      si.componentOrder
    );
    sheets.push({
      name: si.name,
      // Display text from the project metadata, never from the build spec: the
      // identity above is what every review target, diff key and CLI message
      // uses, and this is only what a reader sees (see Sheet.label).
      ...(sheetLabel ? { label: sheetLabel } : {}),
      ...(sheetGroup ? { group: sheetGroup } : {}),
      // The VALUE, not a boolean: `"always"` is what tells the viewer to open
      // the sheet pivoted and give it no toggle back. Collapsed to `true` here,
      // it never reached the viewer at all — the declaration parsed, the check
      // above ran, and the sheet still opened stacked with a button on it.
      ...(compareComponents ? { compare_components: compareComponents } : {}),
      // The declared axis travels with the sheet: the viewer must not have to
      // guess it from which rows happen to have per-environment values.
      ...(si.instances.length > 0 ? { instances: si.instances } : {}),
      ...(si.filePath ? { file_path: si.filePath } : {}),
      ...(si.sourceFile ? { source_file: si.sourceFile } : {}),
      categories,
    });
    // A preview line names the row it IS. A recipe builds previews before this
    // assembler has finished deciding which rows survive — a dictionary's
    // `ui: "absent"` drops one, a project's filter removes another — so a line
    // can be left naming a row that is not on the sheet. Clicking it does
    // nothing, which is the same "an affordance that opens nothing is worse
    // than none" rule the row side already follows, seen from the other end.
    // Measured: 13 lines across two sheets, every one of them a field the
    // product's own UI does not have.
    if (si.artifacts) {
      const onSheet = new Set<string>();
      const collect = (cats: Category[]): void => {
        for (const c of cats) {
          for (const p of c.params ?? []) onSheet.add(p.key);
          if (c.categories) collect(c.categories);
        }
      };
      collect(categories);
      for (const a of si.artifacts) {
        artifacts.push({
          ...a,
          lines: a.lines.map((l) => (l.key !== undefined && !onSheet.has(l.key) ? { ...l, key: undefined } : l)),
        });
      }
    }

    if (underKey && !underKeyColumns.has(underKey.id)) {
      underKeyColumns.set(underKey.id, {
        field: underKey.id,
        header: underKey.label.en,
        header_lang: underKey.label,
        place: "under_key",
      });
    }
  }

  // Ghost-tab guard (P7): a category actually used but not in a sheet's own
  // declared tab list — collected across every sheet, same "name every
  // offender at once" discipline as missingCategory/bindErrors below, rather
  // than stopping at the first one found.
  if (ghostCategories.length > 0) {
    throw new Error(
      `assemble: ${ghostCategories.length} categor${ghostCategories.length === 1 ? "y" : "ies"} used that ` +
        `${ghostCategories.length === 1 ? "isn't" : "aren't"} in its sheet's declared categories:\n` +
        ghostCategories.map((m) => `  ${m}`).join("\n")
    );
  }

  // An ambiguous bind (two dictionary entries tied at the same tier — see
  // bind.ts) means enrich or the category fallback would otherwise pick one
  // silently; that is exactly the failure mode bind.ts's tier system exists
  // to rule out, so it fails the build unconditionally, not gated by
  // strictMetadata (unlike unusedProjectParams below — an ambiguous bind is
  // not a documentation-hygiene nicety, it is a wrong answer waiting to be
  // rendered).
  if (bindErrors.length > 0) {
    throw new Error(
      `assemble: ${bindErrors.length} parameter(s) bound ambiguously against a product dictionary:\n` +
        bindErrors.map((m) => `  ${m}`).join("\n")
    );
  }

  if (missingCategory.length > 0) {
    // For `import --interactive` (see cli.ts / interactive.ts): a numbered
    // list of candidate categories per offending sheet. A sheet with its own
    // declared `categories:` (categoriesForSheet) offers exactly that list —
    // the whole point of P7 moving it into sheet.yml. A sheet with no
    // declaration falls back to whatever top-level categories THIS build
    // already filed for it (`sheets` is fully populated by this point, one
    // entry per sheet processed in the loop above), so a reader still gets
    // a real, non-empty menu on a first-ever build rather than only "create
    // a new one".
    const categoryChoices: Record<string, string[]> = {};
    for (const e of missingCategoryEntries) {
      if (categoryChoices[e.sheet]) continue;
      const declared = categoriesForSheet(projectMeta, e.sheet);
      if (declared.length > 0) {
        categoryChoices[e.sheet] = declared;
        continue;
      }
      const sheetObj = sheets.find((s) => s.name === e.sheet);
      categoryChoices[e.sheet] = sheetObj ? sheetObj.categories.map((c) => c.name) : [];
    }
    throw new ScaffoldableBuildError(
      `assemble: ${missingCategory.length} parameter(s) have no category:\n` +
        missingCategory.map((m) => `  ${m}`).join("\n"),
      missingCategoryEntries,
      scaffoldShape,
      missingProjectPath,
      categoryChoices
    );
  }

  const metadata: SheetMetadata | undefined = opts.metadata
    ? { ...opts.metadata, generated_at: new Date().toISOString() }
    : undefined;

  // Groups are checked both ways, like `categories:` and a component's `names:`:
  // a sheet naming a group nobody declared would appear under a heading with no
  // name and no order, and a declared group no sheet uses would render an empty
  // tab. Both are the author's list and the build's rows disagreeing, which is
  // the one thing this file never lets pass quietly.
  const declaredGroups = sheetGroups(projectMeta);
  if (declaredGroups.length > 0) {
    const declared = new Set(declaredGroups.map((g) => g.name));
    const used = new Set(sheets.map((sh) => sh.group).filter((g): g is string => g !== undefined));
    const undeclared = [...used].filter((g) => !declared.has(g));
    if (undeclared.length > 0) {
      throw new Error(
        `assemble: sheet group(s) not declared in the project metadata's groups: ${undeclared
          .map((g) => {
            const near = suggestNearest(g, [...declared]);
            return `"${g}"${near ? ` (did you mean "${near}"?)` : ""}`;
          })
          .join(", ")} (declared: ${[...declared].join(", ") || "none"})`
      );
    }
    // Every sheet, once the document groups at all. A grouped header has no
    // place to put an ungrouped sheet: it is neither a group of its own nor
    // inside one, and whichever we picked would be an invention.
    const ungrouped = sheets.filter((sh) => sh.group === undefined).map((sh) => sh.name);
    if (ungrouped.length > 0) {
      throw new Error(
        `assemble: sheet(s) with no "group:" in a document that declares groups: ${ungrouped.join(", ")}. ` +
          `A grouped header has nowhere to show an ungrouped sheet — give each one a group, or remove groups: entirely.`
      );
    }
    const unused = [...declared].filter((g) => !used.has(g));
    if (unused.length > 0) {
      throw new Error(
        `assemble: declared sheet group(s) that no sheet belongs to: ${unused.join(", ")}. ` +
          `Remove the entry, or set "group:" on the sheet it was meant for.`
      );
    }
  } else {
    // No `groups:` and no sheet naming one is the flat, pre-grouping document.
    // A sheet naming one without the list is not: the group would have no
    // label and no place in any order.
    const orphan = sheets.filter((sh) => sh.group !== undefined).map((sh) => sh.name);
    if (orphan.length > 0) {
      throw new Error(
        `assemble: sheet(s) declare a group but the project metadata declares no "groups:" list: ${orphan.join(", ")}. ` +
          `Add groups: [{ name, label }] — the reading order of the header is a decision, not the order sheets happen to appear in.`
      );
    }
  }

  const assembled: ParameterSheetInput = {
    ...(metadata ? { metadata } : {}),
    ...(declaredGroups.length > 0 ? { groups: declaredGroups } : {}),
    ...(underKeyColumns.size > 0 ? { columns: [...underKeyColumns.values()] } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    sheets,
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };

  const input = opts.hooks?.finalize ? opts.hooks.finalize(assembled) : assembled;

  // A key the project metadata describes that no sheet ever produced. Usually
  // it means something upstream silently dropped the parameter — a recipe's
  // normalization filter that matched nothing (the classic cause: filtering on
  // `Entry.key`, which is the LEAF name, when the full address is in
  // `Entry.source.path`), a renamed variable, a hook returning null. That kind
  // of loss has no other symptom: the row simply is not there, and nothing about
  // a shorter sheet says a row was expected.
  //
  // Promoted from a warning to a build failure: a silently shorter sheet is
  // exactly the kind of loss this project's own discipline (see missingCategory
  // above, and CLAUDE.md) refuses to leave unnoticed elsewhere. Gated by
  // strictMetadata (like enrich's own undocumented-in-scope-param check,
  // opts.strictMetadata below) rather than unconditional like missingCategory:
  // this is a documentation-hygiene check (stale metadata, not a broken sheet),
  // so the same escape hatch that lets a project skip "every param needs a
  // description" also lets it skip "every declared param must be used".
  const unusedProjectMetaRaw = unusedProjectMetaEntries(projectMeta, assembledKeysBySheet);
  // A "sheet > key" label whenever the doc actually names sheets (nothing to
  // gain from prefixing a flat doc's keys, which were never about one sheet).
  const unusedProjectParams = unusedProjectMetaRaw.map((e) => (e.sheet ? `${e.sheet} > ${e.key}` : e.key));
  if (unusedProjectMetaRaw.length > 0 && opts.strictMetadata !== false) {
    const unusedEntries: ScaffoldEntry[] = unusedProjectMetaRaw.map((e) => ({
      sheet: e.sheet,
      key: e.key,
      needsCategory: false,
      needsDescription: false,
      unused: true,
      hint: suggestNearest(e.key, assembledKeys),
    }));
    throw new ScaffoldableBuildError(
      `assemble: ${unusedProjectMetaRaw.length} parameter(s) described in the project metadata never appeared in ` +
        `any sheet (a recipe filter that matched nothing? a renamed key? pass strictMetadata: false to downgrade ` +
        `this to a non-fatal report):\n` +
        unusedProjectMetaRaw
          .map((e) => {
            const hint = suggestNearest(e.key, assembledKeys);
            const label = e.sheet ? `${e.sheet} > ${e.key}` : e.key;
            return `  ${label}` + (hint ? ` (did you mean "${hint}"?)` : "");
          })
          .join("\n"),
      unusedEntries,
      scaffoldShape
    );
  }

  if (deadComponents.length > 0 && opts.strictMetadata !== false) {
    throw new Error(
      `assemble: ${deadComponents.length} component block(s) in the project metadata describe a component no sheet ` +
        `produced:\n${deadComponents.map((d) => `  ${d}`).join("\n")}`
    );
  }

  const bindingByMethod = emptyByMethod();
  for (const row of bindReportRows) bindingByMethod[row.method]++;
  const binding: BindingReport = { rows: bindReportRows, byMethod: bindingByMethod, unmatchedKeySteps };

  const enriched = enrich(input, {
    readFile: opts.readFile,
    project: opts.projectPath,
    metadataDirs: opts.metadataDirs,
    argumentSpecs: opts.argumentSpecs,
    terraformVariables: opts.terraformVariables,
    lang: opts.lang,
    nativeLang: opts.nativeLang,
    strict: opts.strictMetadata !== false,
    // The single bind pass already run above (bindDrafts/materializeDrafts) —
    // enrich()'s dictionary provider does a plain lookup off these instead of
    // re-resolving the same keys against the same dictionaries a second way.
    bindings: (sheet, key, categoryPath) => {
      const byComponent = allBindings.get(sheet);
      if (byComponent === undefined) return undefined;
      const level = componentLevel.get(sheet);
      const component = level?.shows ? categoryPath[0] : level?.only;
      // The no-component fall-through is not a guess: a sheet that HAS
      // components can still hold rows belonging to none of them (a variable
      // two components share — see resolveKey), and those bind under "".
      return bindingFor(byComponent, component, key) ?? bindingFor(byComponent, undefined, key);
    },
    variables: allVariables,
  });

  return { ...enriched, unusedProjectParams, materializeReports, uiReports, binding, categoryWarnings };
}

export function assembleSheets(inputs: SheetInputs[], opts: AssembleOpts): ParameterSheetInput {
  return assembleSheetsWithReport(inputs, opts).input;
}
