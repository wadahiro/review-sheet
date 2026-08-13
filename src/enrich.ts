// Metadata enrichment pass: fills in documentation (description/default/remarks/
// docs_url/type/scope) on a already-assembled ParameterSheetInput from external
// metadata sources (the project's own metadata file, Ansible argument_specs, product
// dictionaries), via the MetadataProvider registry in metadata.ts.
//
// Runs AFTER assembly (not part of extract/buildInput): it never touches
// value/source/additional_sources/instances, only ever fills fields a project's
// build.ts left undefined. verify/apply/serve are untouched — enrichment is
// purely documentation, source maps are unaffected.

import "./providers/index.js";
import { resolveMetadata, type MetadataContext, type MetadataProvider, type DictionaryBinding, type LangProvenance } from "./metadata.js";
import { loadProjectMeta, paramsForSheet, checkProjectMetaSheets, type ProjectMetaDoc } from "./providers/project.js";
import { bindKey, isBindError, loadBindSources, type Binding, type BindSource } from "./bind.js";
import { pickLang, type ParameterSheetInput, type Category, type Parameter } from "./types.js";

export type EnrichOptions = {
  readFile: (path: string) => string | null;
  lang?: "en" | "ja";
  // Language the NATIVE channels (argument_specs.yml / Terraform variables.tf)
  // are actually written in — see MetadataContext.nativeLang in metadata.ts.
  // Defaults to "en": both formats are conventionally authored in English
  // (that's the ecosystem's own writing convention, not this tool's), but a
  // team that writes them in Japanese can override it here rather than
  // having that assumption silently baked in.
  //
  // One setting covers both channels rather than one per channel: they are
  // written by the same repo's authors under the same convention, so a
  // project mixing English argument_specs with Japanese Terraform variables
  // (or vice versa) is not a case worth a second knob for.
  nativeLang?: "en" | "ja";
  strict?: boolean;
  project?: string;
  metadataDirs?: string[];
  argumentSpecs?: string[];
  terraformVariables?: string[];
  dictionaries?: DictionaryBinding[];
  providers?: MetadataProvider[];
  // Already-resolved dictionary bindings — what assembleSheets hands in (its
  // bindDrafts/materializeDrafts already ran the single bind pass; see
  // assemble.ts). enrich()'s dictionary provider then does a plain lookup
  // instead of re-matching.
  //
  // A LOOKUP, not a map, and specifically not a key->Binding map: a binding
  // belongs to a (component, key) pair (see assemble.ts's SheetBindings), and
  // which component a row is in is something only the assembler can say. The
  // emitted model renders a component as the outermost category, and a sheet
  // with a single component collapses that level away entirely — so the
  // category path enrich walks is evidence the assembler can read and enrich
  // cannot. Handing over a flat map instead made two components of one sheet
  // share one slot, and whichever bound last supplied the OTHER's description,
  // default and group.
  //
  // Omitted (the `import -f` + `--project` path, which never goes through
  // assembleSheets) makes enrich() run that SAME bind pass itself — see
  // resolveBindings() below — against the input model's own keys, using
  // bind.ts's bindKey directly. Either way, bindKey() is the only place a
  // project key is matched against a dictionary entry.
  bindings?: (sheet: string, key: string, categoryPath: string[]) => Binding | undefined;
  // Every keyMap-derived row's backing variable (assemble.ts's Draft.variable
  // — see resolveKey), keyed by sheet name then the row's FINAL (product) key
  // — what assembleSheets hands in, mirroring `bindings` above. Independent of
  // whether the project declared an `under_key` column: that column is a
  // display choice (whether the reader SEES the variable), while this is
  // what lets a query reach a native channel — e.g. argument-specs.ts's
  // fallback lookup — that documents the row by its Ansible variable name
  // rather than by the product key the row is now filed under.
  //
  // Omitted (the `import -f` + `--project` path, which never goes through
  // assembleSheets and has no keyMap concept at all) leaves every query's
  // `variable` unset — same as before this fallback existed.
  variables?: Map<string, Map<string, string>>;
};

export type EnrichReport = {
  filled: number;
  missing: { sheet: string; category: string; key: string }[];
  byProvider: Record<string, number>;
};

// ---- Scaffold ----------------------------------------------------------------
//
// A strict failure (assemble.ts's "no category", this module's "no
// description", or assemble.ts's "unused project param") already names every
// offending key — that's what made a PoC clean-room user invent, on their
// own, the workaround this type formalizes: run the build once against an
// empty `params:`, then transcribe the exact key list the error printed
// straight into sheet.yml. `renderScaffold()` below does that transcription
// FOR them, as a paste-able YAML fragment, with whatever this build's single
// bind pass (bind.ts's bindKey, run once — see assemble.ts's bindDrafts) already
// knows about that key, so the author isn't guessing whether a description
// will show up "for free" from a bound dictionary.
export type ScaffoldEntry = {
  sheet: string; // "" for an "unused" entry — it isn't about any one sheet.
  key: string;
  // What this key still needs a sheet.yml entry for. Both false only happens
  // for `unused` entries (see below), which are advisory, not add-able.
  needsCategory: boolean;
  needsDescription: boolean;
  // The dictionary entry (if any) this key already binds to — see bind.ts.
  // Present or absent, it changes what the rendered comment says: a bound key
  // missing a description almost always means the DICTIONARY entry itself has
  // none (fix it there, or override here), not that sheet.yml forgot anything.
  binding?: Binding;
  // True for a key the project metadata DESCRIBES but no sheet ever produced
  // (assemble.ts's unusedProjectParams). The fix there is deletion or a typo
  // fix, not a new params: entry, so renderScaffold prints these as a comment
  // checklist instead of an addable block.
  unused?: boolean;
  // "did you mean ...?" — only ever set on an `unused` entry.
  hint?: string;
  // Which component of the sheet this key belongs to, when the sheet has more
  // than one. Without it a key that several components share renders as a
  // repeated map key, which YAML rejects outright ("Map keys must be unique")
  // — so the fragment a reader is told to paste would not parse. It is also
  // the honest shape: two components sharing a key name are two different
  // parameters, and one description cannot be true of both.
  component?: string;
};

// Which shape a paste-able scaffold fragment should render in. This is a fact
// about the TARGET file the reader will paste into — not about how many
// sheets happen to be named among a single failure's offending keys (a
// single-sheet failure against a multi-sheet `sheets:` doc still needs a
// `sheets:` fragment, or pasting it in fails loadProjectMeta's own
// "sheets: and top-level params: cannot both be set" check). See
// scaffoldShapeFor below for how each throw site decides this.
export type ScaffoldShape = "flat" | "sheets";

// A strict failure that carries enough structure to render a scaffold, not
// just a message. Both assemble.ts (missing category / unused project param)
// and this module (missing description) throw this instead of a plain Error,
// so any caller — today just cli.ts's `import` — can catch ONE type and offer
// the fragment, regardless of which of the three checks tripped.
export class ScaffoldableBuildError extends Error {
  entries: ScaffoldEntry[];
  shape: ScaffoldShape;
  // Set when a project metadata path WAS declared and the file is not there.
  // The build deliberately continues in that case so a first build can be
  // handed a scaffold instead of dying — but the path has to survive to the
  // output, or a typo in `enrich.project` renders as "these params need a
  // category", the reader pastes into the sheet.yml they actually have, and
  // the identical error comes back with nothing pointing at the real cause.
  missingProjectPath?: string;
  // Per-sheet candidate category names for `import --interactive` (see
  // cli.ts / interactive.ts) to offer as a numbered list, for entries whose
  // `needsCategory` is true. Only assemble.ts's "no category" throw site
  // populates this (it alone knows a sheet's declared `categories:`, and
  // what top-level categories the build already used) — enrich.ts's own
  // "no description" throw and the "unused project param" throw never set
  // `needsCategory`, so they have nothing to offer here. Empty/undefined for
  // a sheet with neither a declaration nor any category used yet.
  categoryChoices: Record<string, string[]>;
  constructor(
    message: string,
    entries: ScaffoldEntry[],
    shape: ScaffoldShape,
    missingProjectPath?: string,
    categoryChoices?: Record<string, string[]>
  ) {
    super(message);
    this.name = "ScaffoldableBuildError";
    this.entries = entries;
    this.shape = shape;
    this.missingProjectPath = missingProjectPath;
    this.categoryChoices = categoryChoices ?? {};
  }
}

// Decides `shape` for the constructor above. `doc` is the TARGET project
// metadata file already loaded at the throw site (undefined when there is
// none to look at — either no project path was configured at all, or one was
// configured but the file hasn't been created yet, the "about to author
// sheet.yml for the first time" case).
//
// - A loaded `sheets:` doc always wins: paste-ability requires matching what
//   is already on disk, regardless of how many sheets this particular
//   failure spans.
// - A loaded flat doc: flat, likewise regardless of failure span.
// - No doc, but a path WAS given (the file just doesn't exist yet): guess
//   from the build's own sheet count. A single-sheet build only ever needs
//   flat; a multi-sheet build is one shared source file away from needing
//   `sheets:` (see SKILL.md's "use sheets: whenever more than one sheet
//   reads from a shared source"), so a first-ever scaffold for a multi-sheet
//   spec is written directly in the shape it will need anyway, rather than
//   flat now and a manual migration later.
// - No doc, no path given at all: nothing to guess FROM — flat, the shape a
//   single-sheet project (and `import -f --project`, which has no concept of
//   a spec) is expected to author.
export function scaffoldShapeFor(doc: ProjectMetaDoc | undefined, pathGiven: boolean, sheetCount: number): ScaffoldShape {
  if (doc?.sheets) return "sheets";
  if (doc) return "flat";
  if (pathGiven) return sheetCount > 1 ? "sheets" : "flat";
  return "flat";
}

// A YAML scalar is never ambiguous when double-quoted (JSON string escaping
// is a valid subset of YAML's double-quoted scalar syntax) — the one format
// that stays valid regardless of what the key itself looks like, including a
// full structural path lifted verbatim from an error message
// (`clients[0].attributes.pkce.code.challenge.method`, brackets and all).
function yamlKey(key: string): string {
  return JSON.stringify(key);
}

// One entry's body — the "why" comment plus the placeholder value — indented
// to fit either shape renderScaffold below can produce: a flat `params:` list
// (indent "  ") or a `sheets: <name>: params:` nesting (indent "      ").
function renderScaffoldParam(e: ScaffoldEntry, indent: string): string[] {
  const lines: string[] = [];
  if (e.binding) {
    const b = e.binding;
    const what = e.needsDescription
      ? "the dictionary entry has no description — fill it in here or in the dictionary"
      : "description will come from the dictionary";
    lines.push(`${indent}# binds: ${b.product}@${b.version} ${b.dictKey} (${b.method}) — ${what}`);
  } else {
    const what = e.needsCategory && e.needsDescription ? "category and description" : e.needsCategory ? "category" : "description";
    lines.push(`${indent}# no dictionary match — write a ${what} here`);
  }

  const key = yamlKey(e.key);
  if (e.needsCategory && !e.needsDescription) {
    lines.push(`${indent}${key}: { category: TODO }`);
  } else if (!e.needsCategory && e.needsDescription) {
    lines.push(`${indent}${key}:`);
    lines.push(`${indent}  description:`);
    lines.push(`${indent}    en: TODO`);
    lines.push(`${indent}    ja: TODO`);
  } else if (e.needsCategory && e.needsDescription) {
    lines.push(`${indent}${key}:`);
    lines.push(`${indent}  category: TODO`);
    lines.push(`${indent}  description:`);
    lines.push(`${indent}    en: TODO`);
    lines.push(`${indent}    ja: TODO`);
  } else {
    lines.push(`${indent}${key}: {}`);
  }
  return lines;
}

// Render a paste-able sheet.yml fragment from a strict-failure's entries, in
// the order the build encountered them (sheet order — see each throw site).
// Every value is a placeholder ("TODO"): renderScaffold's job is to save the
// "which exact keys, spelled how" transcription step the PoC workaround did
// by hand, not to guess documentation on the author's behalf.
//
// `shape` is decided by the caller (scaffoldShapeFor, at the throw site,
// where the target file's own doc — or its absence — is in scope) and is NOT
// re-derived here from how many distinct sheets the failing entries happen to
// span: a single-sheet failure against an already-`sheets:`-shaped project
// still needs a `sheets:` fragment, or pasting it in trips loadProjectMeta's
// own "sheets: and top-level params: cannot both be set" check.
export function renderScaffold(entries: ScaffoldEntry[], shape: ScaffoldShape, missingProjectPath?: string): string {
  const toAdd = entries.filter((e) => !e.unused);
  const unused = entries.filter((e) => e.unused);

  const lines: string[] = [];

  // Lead with it: "the file you declared is not there" outranks "these params
  // need a category", because pasting the fragment anywhere else cannot fix it.
  if (missingProjectPath !== undefined) {
    lines.push(`# NOTE: the declared project metadata file does not exist: ${missingProjectPath}`);
    lines.push("# Create it with the fragment below — or, if that path is a typo, fix it first;");
    lines.push("# pasting into a different sheet.yml will leave this error unchanged.");
    lines.push("");
  }

  if (toAdd.length > 0) {
    if (shape === "sheets") {
      // sheet.yml already uses (or, on a brand-new file, is meant to use)
      // sheets: — one params: block per sheet name. If it already has a
      // sheets: key, merge each sheet's params: entries into that sheet's
      // existing block below; don't paste a second top-level "sheets:" key.
      lines.push("# sheet.yml uses \"sheets:\" — merge each sheet's params: entries below into");
      lines.push("# its existing block under sheets:, don't paste a second \"sheets:\" key.");
      lines.push("sheets:");
      // Grouped by sheet, then by component: a component is a namespace inside
      // a sheet (providers/project.ts's paramForRow), so its keys go under
      // `components: <id>: params:` rather than beside the sheet-wide ones.
      // Order of first appearance within each group, like the flat form.
      const bySheet = new Map<string, ScaffoldEntry[]>();
      for (const e of toAdd) bySheet.set(e.sheet, [...(bySheet.get(e.sheet) ?? []), e]);
      for (const [sheet, entries] of bySheet) {
        lines.push(`  ${yamlKey(sheet)}:`);
        const sheetWide = entries.filter((e) => e.component === undefined);
        if (sheetWide.length > 0) {
          lines.push(`    params:`);
          for (const e of sheetWide) lines.push(...renderScaffoldParam(e, "      "));
        }
        const byComponent = new Map<string, ScaffoldEntry[]>();
        for (const e of entries) {
          if (e.component === undefined) continue;
          byComponent.set(e.component, [...(byComponent.get(e.component) ?? []), e]);
        }
        if (byComponent.size === 0) continue;
        lines.push(`    components:`);
        for (const [component, ces] of byComponent) {
          lines.push(`      ${yamlKey(component)}:`);
          lines.push(`        params:`);
          for (const e of ces) lines.push(...renderScaffoldParam(e, "          "));
        }
      }
    } else {
      lines.push("params:");
      for (const e of toAdd) lines.push(...renderScaffoldParam(e, "  "));
    }
  }

  if (unused.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("# unused project metadata keys — declared in sheet.yml's params:, but no");
    lines.push("# sheet produced them. Remove the entry, or fix the key if it's a typo/rename:");
    for (const e of unused) {
      const label = e.sheet ? `${e.sheet} > ${e.key}` : e.key;
      lines.push(`#   ${label}${e.hint ? ` (did you mean "${e.hint}"?)` : ""}`);
    }
  }

  return lines.join("\n") + "\n";
}

function fillExtra(param: Parameter, field: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  if (param.extra?.[field] !== undefined) return false;
  if (!param.extra) param.extra = {};
  param.extra[field] = value;
  return true;
}

// Render a resolved LangProvenance for `extra.provenance`, which is a plain
// string field (input.schema.json's `extra` is `additionalProperties:
// {type: string}` — a map value would not be schema-valid). A scalar, or a
// per-language map with nothing to disagree with (both languages equal, or
// only one language resolved at all), renders as today's bare token — this
// is what keeps every unmigrated dictionary's `extra.provenance` output
// byte-identical. Only a genuine split renders the joined form.
//
// Deliberately NOT i18n'd (see src/html/i18n.ts): `extra` values are static
// strings baked in at generate time, so the in-page language toggle cannot
// re-resolve them the way it re-resolves `description`/`remarks` (LangText,
// resolved live by the viewer's localizeSheets). A project that wants a
// reader-facing provenance column can already declare one (`columns:` with
// `field: extra.provenance`); this string is what it will show.
export function formatProvenance(p: LangProvenance): string {
  if (typeof p === "string") return p;
  const { en, ja } = p;
  if (en !== undefined && ja !== undefined && en !== ja) return `en: ${en} / ja: ${ja}`;
  // Only one language resolved (or both agree, which resolveMetadata/the
  // dictionary provider already collapse to a bare string before this point
  // — this branch mainly covers "only one language has a description at
  // all", not a genuine tie): show whichever side is present.
  return en ?? ja ?? "community";
}

function enrichParam(
  param: Parameter,
  sheet: string,
  categoryPath: string[],
  ctx: MetadataContext,
  providers: MetadataProvider[] | undefined,
  byProvider: Record<string, number>,
  resolveBinding: (sheet: string, key: string, categoryPath: string[]) => Binding | undefined,
  resolveVariable: (sheet: string, key: string) => string | undefined
): boolean {
  const file = "source" in param ? param.source?.file : undefined;
  const binding = resolveBinding(sheet, param.key, categoryPath);
  const variable = resolveVariable(sheet, param.key);
  const query = { key: param.key, sheet, categoryPath, file, binding, variable };
  const resolved = resolveMetadata(query, ctx, providers);

  let wrote = false;
  if (resolved) {
    if (resolved.label !== undefined && param.label === undefined) {
      param.label = resolved.label;
      wrote = true;
    }
    if (resolved.description !== undefined && param.description === undefined) {
      param.description = resolved.description;
      wrote = true;
    }
    if (resolved.default !== undefined && param.default === undefined) {
      param.default = resolved.default;
      wrote = true;
    }
    if (resolved.remarks !== undefined && param.remarks === undefined) {
      param.remarks = resolved.remarks;
      wrote = true;
    }
    if (fillExtra(param, "docs_url", resolved.docs_url)) wrote = true;
    if (fillExtra(param, "type", resolved.type)) wrote = true;
    if (fillExtra(param, "scope", resolved.scope)) wrote = true;

    if (param.out_of_scope === undefined && resolved.out_of_scope !== undefined) {
      param.out_of_scope = resolved.out_of_scope;
      wrote = true;
    }

    // Provenance reflects where `description` came from — only set when this
    // pass actually supplied a description (a preset description keeps no
    // extra.provenance, since enrich contributed nothing to it).
    if (resolved.provenance !== undefined && resolved.description !== undefined && param.description === resolved.description) {
      if (fillExtra(param, "provenance", formatProvenance(resolved.provenance))) wrote = true;
    }

    for (const [name, count] of Object.entries(resolved.contributions)) {
      byProvider[name] = (byProvider[name] ?? 0) + count;
    }
  }

  return wrote;
}

function walkCategories(
  sheetName: string,
  categories: Category[],
  parentPath: string[],
  parentOutOfScope: boolean,
  ctx: MetadataContext,
  providers: MetadataProvider[] | undefined,
  report: EnrichReport,
  resolveBinding: (sheet: string, key: string, categoryPath: string[]) => Binding | undefined,
  resolveVariable: (sheet: string, key: string) => string | undefined
): void {
  for (const category of categories) {
    const categoryPath = [...parentPath, category.name];
    const outOfScope = parentOutOfScope || category.out_of_scope !== undefined;

    for (const param of category.params ?? []) {
      if (outOfScope || param.out_of_scope !== undefined) continue; // exempt from strict, no query

      const wrote = enrichParam(param, sheetName, categoryPath, ctx, providers, report.byProvider, resolveBinding, resolveVariable);
      if (wrote) report.filled++;

      // A description is present if any language resolves to a non-empty string.
      const desc = pickLang(param.description, ctx.lang);
      if (!desc || desc.length === 0) {
        report.missing.push({ sheet: sheetName, category: categoryPath.join(" > "), key: param.key });
      }
    }

    if (category.categories) {
      walkCategories(sheetName, category.categories, categoryPath, outOfScope, ctx, providers, report, resolveBinding, resolveVariable);
    }
  }
}

export function enrich(
  input: ParameterSheetInput,
  opts: EnrichOptions
): { input: ParameterSheetInput; report: EnrichReport } {
  const cloned = structuredClone(input);

  // A configured project path whose file has not been created yet (the
  // "about to author sheet.yml for the first time" bootstrap case — see
  // scaffoldShapeFor) is NOT a hard failure here: treated as "no project
  // metadata", same as opts.project being unset, so the build can still run
  // far enough to hit a strict check and offer a scaffold, instead of dying
  // on "project metadata not found" with nothing actionable. A path whose
  // file DOES exist keeps loadProjectMeta's full strictness (invalid YAML,
  // a sheets:/params: mix, an unknown sheet name below — all still hard
  // errors).
  const projectPath = opts.project;
  const projectFileExists = projectPath !== undefined && opts.readFile(projectPath) !== null;
  const projectMeta: ProjectMetaDoc | undefined =
    projectPath !== undefined && projectFileExists ? loadProjectMeta(projectPath, opts.readFile) : undefined;
  // Same "sheets: names a sheet this build doesn't have" check assemble.ts
  // runs — needed here too since this function is also the whole enrichment
  // path for `import -f --project` (assembleSheets never gets called), which
  // is the only place THAT flow's project metadata gets validated against
  // the model's real sheet names.
  if (projectMeta) checkProjectMetaSheets(projectMeta, cloned.sheets.map((s) => s.name));
  // Dictionary bindings are no longer part of the project metadata file (see
  // providers/project.ts) — a caller that wants dictionary binding here
  // (this standalone path, not assembleSheets — see EnrichOptions.bindings)
  // must pass `dictionaries` explicitly.
  const dictionaries = opts.dictionaries ?? [];

  const ctx: MetadataContext = {
    lang: opts.lang ?? "en",
    nativeLang: opts.nativeLang ?? "en",
    readFile: opts.readFile,
    // undefined (not opts.project) when the file doesn't exist yet, so the
    // project provider's own resolve() short-circuits instead of calling
    // loadProjectMeta a second time and hitting its hard "not found" throw.
    project: projectMeta ? opts.project : undefined,
    argumentSpecs: opts.argumentSpecs ?? [],
    terraformVariables: opts.terraformVariables ?? [],
    metadataDirs: opts.metadataDirs ?? [],
    dictionaries,
    cache: new Map(),
  };

  // Standalone bind pass: only needed when the caller hasn't already run one
  // (see EnrichOptions.bindings — assembleSheets always has). Uses the exact
  // same core, bind.ts's bindKey, directly against the input model's own
  // keys — the `import -f` + `--project` path, which never goes through
  // assembleSheets, still resolves through the ONE place a project key gets
  // matched against a dictionary entry.
  const bindSources: BindSource[] = opts.bindings
    ? []
    : loadBindSources(dictionaries, opts.metadataDirs ?? [], opts.readFile);
  const bindErrors: string[] = [];

  function resolveBinding(sheet: string, key: string, categoryPath: string[]): Binding | undefined {
    if (opts.bindings) return opts.bindings(sheet, key, categoryPath);
    if (bindSources.length === 0) return undefined;
    const dictKey = projectMeta ? paramsForSheet(projectMeta, sheet)[key]?.dict_key : undefined;
    const result = bindKey(key, dictKey, bindSources);
    if (result === undefined) return undefined;
    if (isBindError(result)) {
      bindErrors.push(`${sheet} > ${key}: ${result.message}`);
      return undefined;
    }
    return result;
  }

  function resolveVariable(sheet: string, key: string): string | undefined {
    return opts.variables?.get(sheet)?.get(key);
  }

  const report: EnrichReport = { filled: 0, missing: [], byProvider: {} };

  for (const sheet of cloned.sheets) {
    walkCategories(sheet.name, sheet.categories, [], false, ctx, opts.providers, report, resolveBinding, resolveVariable);
  }

  // Same discipline as assemble.ts's own bindErrors check: an ambiguous bind
  // is a wrong answer waiting to be rendered, not a documentation-hygiene
  // nicety, so it fails unconditionally rather than being gated by `strict`.
  if (bindErrors.length > 0) {
    throw new Error(
      `enrich: ${bindErrors.length} parameter(s) bound ambiguously against a product dictionary:\n` +
        bindErrors.map((m) => `  ${m}`).join("\n")
    );
  }

  const strict = opts.strict !== false;
  if (strict && report.missing.length > 0) {
    const lines = report.missing.map((m) => `  ${m.sheet} > ${m.category} > ${m.key}`);
    // Re-resolving each key's binding here (rather than threading it out of
    // walkCategories) is safe and cheap: bindErrors is guaranteed empty at
    // this point (the check above already returned otherwise), so calling
    // resolveBinding again for the same key/sources is deterministic and
    // pushes nothing new.
    const entries: ScaffoldEntry[] = report.missing.map((m) => ({
      sheet: m.sheet,
      key: m.key,
      needsCategory: false,
      needsDescription: true,
      // `category` is the joined path this row was filed under, which is where
      // the component is (see EnrichOptions.bindings) — split back so the
      // scaffold names the same binding the row itself resolved.
      binding: resolveBinding(m.sheet, m.key, m.category.split(" > ")),
    }));
    throw new ScaffoldableBuildError(
      `metadata: ${report.missing.length} parameter(s) have no description:\n${lines.join("\n")}\n` +
        `Add it to a dictionary / argument_specs / project metadata, mark it out_of_scope, or pass strict:false.`,
      entries,
      scaffoldShapeFor(projectMeta, projectPath !== undefined, cloned.sheets.length),
      projectPath !== undefined && !projectFileExists ? projectPath : undefined
    );
  }

  return { input: cloned, report };
}
