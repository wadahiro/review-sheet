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
  categoriesForSheet,
  underKeyForSheet,
  checkProjectMetaSheets,
  type ProjectMetaDoc,
  type UnderKeyMeta,
} from "./providers/project.js";
import { findDictionary, dictionaryCoverage } from "./providers/dictionary.js";
import { bindKey, isBindError, loadBindSources, BIND_METHODS, type Binding, type BindSource, type BindMethod } from "./bind.js";
import type { DictionaryBinding } from "./metadata.js";
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
export type ExtractedEntry = { value: string; source: SourceLocation; origin?: "embedded" };
// Insertion order is significant: it drives Pattern A/B emission order.
export type ExtractedMap = Map<string, ExtractedEntry>;

export type ValueLayer =
  | { kind: "base"; entries: ExtractedMap }
  | { kind: "overlay"; instance: string; entries: ExtractedMap };

export type EmbeddedEntry = { key: string; value: string; source: SourceLocation };

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
      // Display name for the parent category materialized rows are filed under
      // (see fileDrafts). Omitted = a built-in default in `opts.lang` (see
      // DEFAULT_MATERIALIZE_CATEGORY below).
      defaultsCategory?: string;
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
// the under_key column) if any. `fallbackCategoryPath` is set only for
// materialized rows (see materializeDrafts): a project-set parameter must
// still declare its category in the project metadata or fail the build.
//
// A PATH, not a single name: a materialized row is filed two levels deep —
// under one parent category for "product defaults nobody reviewed yet", then
// under a subcategory per dictionary `group` (see fileDrafts) — so that
// materializing a large dictionary (httpd@2.4's 100+ modules) doesn't flatten
// into 100+ top-level tabs alongside the project's own, hand-declared,
// actually-reviewable categories.
type Draft = { key: string; param: Parameter; variable?: string; fallbackCategoryPath?: string[] };

// Category of last resort for a materialized row whose dictionary carries no
// `group`. Model-level (like extract.ts's DEFAULT_CATEGORY), not a UI string.
const UNCATEGORIZED = "Uncategorized";

// The parent category every materialized row is filed under, keyed by
// `opts.lang` (categories are plain strings in this model, not LangText — see
// types.ts's Category — so there is no per-viewer language switch for it;
// this only picks which language the BUILD writes). A project that wants
// different wording (or a different lang from the sheet's own strings) sets
// `DictionaryMaterialize.defaultsCategory` explicitly.
const DEFAULT_MATERIALIZE_CATEGORY: Record<"ja" | "en", string> = {
  ja: "既定値（未使用）",
  en: "Product defaults (unused)",
};

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
function resolveKey(extractedKey: string, variableToBound: Map<string, string>): { paramKey: string; variable?: string } {
  const bound = variableToBound.get(extractedKey);
  if (bound !== undefined) return { paramKey: bound, variable: extractedKey };
  return { paramKey: extractedKey };
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
  if (si.keyMap) for (const m of si.keyMap) variableToBound.set(m.variable, m.boundKey);

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
  function pushDraft(key: string, param: Parameter, variable?: string): void {
    const ctx: ParamContext = { sheet: si.name, key, variable };
    if (hooks?.keyFor) {
      ctx.key = hooks.keyFor(ctx);
      param.key = ctx.key;
    }
    const mapped = hooks?.mapParam ? hooks.mapParam(param, ctx) : param;
    if (mapped === null) return;
    drafts.push({ key: mapped.key, param: mapped, variable });
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
      pushDraft(extractedKey, param);
      continue;
    }
    const { paramKey, variable } = resolveKey(extractedKey, variableToBound);
    const overriddenBy = overlays.filter((ov) => ov.entries.has(extractedKey));

    let param: Parameter;
    if (overriddenBy.length > 0) {
      const instances = buildOverlayInstances(si.instances, extractedKey, baseEntry, overlays);
      param = { key: paramKey, instances, origin: "overlay" } as InstanceParameter;
    } else {
      param = { key: paramKey, value: baseEntry.value, source: baseEntry.source, origin: "common" } as SimpleParameter;
    }
    attachReferenceSites(param, extractedKey);
    pushDraft(paramKey, withUnderKey(param, variable), variable);
  }

  // 2) Keys that appear only in overlays, never in base: Pattern B limited to
  // the overlays that actually carry them (no base fallback).
  for (const ov of overlays) {
    for (const [extractedKey] of ov.entries) {
      if (seen.has(extractedKey)) continue;
      seen.add(extractedKey);
      const { paramKey, variable } = resolveKey(extractedKey, variableToBound);
      const carriers = overlays.filter((o) => o.entries.has(extractedKey));
      const instances = buildOverlayInstances(si.instances, extractedKey, undefined, carriers);
      const param = { key: paramKey, instances, origin: "overlay" } as InstanceParameter;
      attachReferenceSites(param, extractedKey);
      pushDraft(paramKey, withUnderKey(param, variable), variable);
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
    const param = { key: e.key, value: e.value, source: e.source, origin: "embedded" } as SimpleParameter;
    pushDraft(e.key, param);
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
export type BindingReport = { rows: BindReportRow[]; byMethod: Record<BindReportMethod, number> };

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
function bindDrafts(
  sheetName: string,
  drafts: Draft[],
  projectMeta: ProjectMetaDoc,
  bindSources: BindSource[],
  reportRows: BindReportRow[],
  bindErrors: string[]
): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  if (bindSources.length === 0) return bindings;
  const sheetParams = paramsForSheet(projectMeta, sheetName);
  for (const d of drafts) {
    const dictKey = sheetParams[d.key]?.dict_key;
    const result = bindKey(d.key, dictKey, bindSources);
    if (result === undefined) {
      reportRows.push({ sheet: sheetName, key: d.key, method: "none" });
      continue;
    }
    if (isBindError(result)) {
      bindErrors.push(`${sheetName} > ${d.key}: ${result.message}`);
      continue;
    }
    bindings.set(d.key, result);
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
  draftBindings: Map<string, Binding>,
  binding: SheetDictionaryBinding,
  opts: AssembleOpts
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
  for (const b of draftBindings.values()) {
    if (b.product === binding.product && b.version === binding.version) covered.add(b.dictKey);
  }

  // The include-list gate (DictionaryMaterialize's `groups`): resolved once,
  // up front, so (a) the "did any named group even exist" check below sees
  // the dictionary's full group set regardless of what got filtered, and (b)
  // the per-entry loop is a single Set lookup.
  const groupFilter = opt.groups ? new Set(opt.groups) : undefined;
  const unknownGroups: string[] = [];
  if (groupFilter) {
    const dictGroups = new Set<string>();
    for (const p of Object.values(dict.parameters)) if (p.group !== undefined) dictGroups.add(p.group);
    for (const g of opt.groups!) if (!dictGroups.has(g)) unknownGroups.push(g);
  }

  const parentCategory = opt.defaultsCategory ?? DEFAULT_MATERIALIZE_CATEGORY[opts.lang ?? "en"];

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
    // An entry with no group never matches a named filter (there is nothing
    // to opt it in with), so it is excluded right alongside every group that
    // wasn't listed — same as the "which modules does this deployment
    // actually load" question the filter exists to answer.
    if (groupFilter && !(entry.group !== undefined && groupFilter.has(entry.group))) {
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
    const param = {
      key,
      value: entry.default !== undefined ? String(entry.default) : "",
      origin: "default",
    } as SimpleParameter;
    // Two levels: a single parent ("product defaults, unreviewed") holding a
    // subcategory per dictionary group — see fileDrafts and Draft's comment
    // for why this is a path rather than one name.
    out.push({ key, param, fallbackCategoryPath: [parentCategory, entry.group || UNCATEGORIZED] });
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
    materialized: out.length,
    groupExcluded,
    unknownGroups,
    noDefault,
    noDefaultKeys,
  };
  return { drafts: out, report, bindings };
}

function fileDrafts(
  sheetName: string,
  drafts: Draft[],
  draftBindings: Map<string, Binding>,
  projectMeta: ProjectMetaDoc,
  // This SHEET's own declared top-level category order (sheet.yml's
  // categories: — see providers/project.ts's categoriesForSheet). Empty = no
  // order declared, so `declared` below is empty, `order` reduces to plain
  // first-appearance, and the ghost-tab check below is skipped entirely.
  declaredCategories: string[],
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
  categoryWarnings: string[]
): Category[] {
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
  // their parent ("product defaults, unreviewed") and the dictionary `group`
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

  const sheetParams = paramsForSheet(projectMeta, sheetName);
  for (const d of drafts) {
    const meta = sheetParams[d.key];
    const binding = draftBindings.get(d.key);
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
    const path = meta?.category
      ? [meta.category]
      : binding
        ? [binding.entry.group ?? UNCATEGORIZED]
        : d.fallbackCategoryPath;
    if (!path || path.length === 0) {
      missingCategory.push(`${sheetName} > ${d.key}`);
      // Never bound here (a bound key always resolves SOME path — its dict
      // group, or Uncategorized — a few lines above), but looked up rather
      // than assumed undefined: if that fallback logic ever grows another
      // case, the scaffold's "binds:" comment should track it, not silently
      // go stale.
      scaffoldEntries.push({ sheet: sheetName, key: d.key, needsCategory: true, needsDescription: true, binding });
      continue;
    }
    let node = root;
    for (const segment of path) node = childOf(node, segment);
    if (!d.fallbackCategoryPath) {
      if (meta?.category) {
        if (!firstProjectCategoryExample.has(path[0])) firstProjectCategoryExample.set(path[0], d.key);
      } else if (!firstDictFallbackExample.has(path[0])) {
        firstDictFallbackExample.set(path[0], d.key);
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
  const declared = declaredCategories.filter((name) => root.children.has(name));
  const undeclared = root.childOrder.filter((name) => !declared.includes(name));
  const order = [...declared, ...undeclared];

  function toCategory(node: Node): Category {
    const cat: Category = { name: node.name };
    if (node.params.length > 0) cat.params = node.params;
    if (node.childOrder.length > 0) cat.categories = node.childOrder.map((name) => toCategory(node.children.get(name)!));
    return cat;
  }

  return order.map((name) => toCategory(root.children.get(name)!));
}

// Iterative Levenshtein distance — used only for the "did you mean" hint on
// an unused-project-param error (see below). No dependency worth pulling in
// for one small edit-distance check.
function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
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
export function suggestNearest(key: string, candidates: Iterable<string>): string | undefined {
  const threshold = Math.max(2, Math.floor(key.length / 4));
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(key, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

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
  const materializeReports: MaterializeReport[] = [];
  // Every sheet's resolved bindings (bindDrafts' return value), keyed by
  // sheet name then parameter key — handed to enrich() below so its
  // dictionary provider does a plain lookup instead of re-running its own key
  // matching against the SAME dictionaries (see enrich.ts's EnrichOptions.bindings).
  const allBindings = new Map<string, Map<string, Binding>>();
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
    if ((si.keyMap?.length ?? 0) > 0 && !underKey) {
      throw new Error(
        `assemble: sheet "${si.name}" has parameter(s) named by a product key (via keyMap) and must declare an ` +
          `"under_key" (id + label) in the project metadata (sheet.yml) to surface the backing variable`
      );
    }
    const drafts = buildDrafts(si, opts.hooks, underKey);
    const sheetVariables = new Map<string, string>();
    for (const d of drafts) if (d.variable !== undefined) sheetVariables.set(d.key, d.variable);
    allVariables.set(si.name, sheetVariables);
    // This SHEET's own declared dictionaries only — never another sheet's
    // (see AssembleOpts.dictionaries): binding is resolved per sheet so a key
    // can only ever match what ITS OWN sheet declared.
    const sheetDictionaries = opts.dictionaries?.[si.name] ?? [];
    const bindSources = loadBindSources(sheetDictionaries, opts.metadataDirs ?? [], opts.readFile);
    // Bind every draft against this sheet's dictionaries BEFORE materialize
    // and BEFORE filing — the single phase both now read from (see bindDrafts,
    // materializeDrafts' `covered` set, and fileDrafts' category fallback)
    // instead of each re-deriving its own key matching.
    const draftBindings = bindDrafts(si.name, drafts, projectMeta, bindSources, bindReportRows, bindErrors);
    // enrich() gets draftBindings PLUS materialize's own bindings (below) —
    // but fileDrafts (and materializeDrafts' own `covered` set) must keep
    // seeing ONLY draftBindings: a materialized row already carries its
    // category as `fallbackCategoryPath` (nested under the "product
    // defaults" parent — see materializeDrafts), and fileDrafts prefers a
    // present `binding` over that path, so merging materialize's bindings
    // into draftBindings itself would flatten every materialized row back to
    // a top-level dictionary-group tab instead of nesting it.
    const sheetBindings = new Map(draftBindings);
    allBindings.set(si.name, sheetBindings);
    for (const dictBinding of sheetDictionaries) {
      if (!dictBinding.materialize) continue;
      const materialized = materializeDrafts(si.name, draftBindings, dictBinding, opts);
      drafts.push(...materialized.drafts);
      materializeReports.push(materialized.report);
      for (const [k, v] of materialized.bindings) sheetBindings.set(k, v);
    }
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
      missingCategory,
      missingCategoryEntries,
      ghostCategories,
      categoryWarnings
    );
    sheets.push({
      name: si.name,
      // The declared axis travels with the sheet: the viewer must not have to
      // guess it from which rows happen to have per-environment values.
      ...(si.instances.length > 0 ? { instances: si.instances } : {}),
      ...(si.filePath ? { file_path: si.filePath } : {}),
      ...(si.sourceFile ? { source_file: si.sourceFile } : {}),
      categories,
    });

    if (underKey && !underKeyColumns.has(underKey.id)) {
      underKeyColumns.set(underKey.id, {
        field: underKey.id,
        header: underKey.label.en,
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

  const assembled: ParameterSheetInput = {
    ...(metadata ? { metadata } : {}),
    ...(underKeyColumns.size > 0 ? { columns: [...underKeyColumns.values()] } : {}),
    ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
    sheets,
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

  const bindingByMethod = emptyByMethod();
  for (const row of bindReportRows) bindingByMethod[row.method]++;
  const binding: BindingReport = { rows: bindReportRows, byMethod: bindingByMethod };

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
    bindings: allBindings,
    variables: allVariables,
  });

  return { ...enriched, unusedProjectParams, materializeReports, binding, categoryWarnings };
}

export function assembleSheets(inputs: SheetInputs[], opts: AssembleOpts): ParameterSheetInput {
  return assembleSheetsWithReport(inputs, opts).input;
}
