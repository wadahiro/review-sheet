// Project metadata provider: a single YAML file (opt-in, ctx.project)
// that documents parameters in project terms and wins over every other source.
// Also carries one assembler-only hint (per-param category) that enrich()
// itself ignores — a project's build.ts reads loadProjectMeta() directly for
// that. Dictionary bindings (which product a sheet's keys match against) stay
// in build.yml (spec.ts's BuildSpec.sheets[].dictionaries) — that is a
// data-SOURCE fact, not a display one. `categories` (a sheet's top-level tab
// display order) and `under_key` (the ansible recipe's provenance column) are
// display facts and live here instead (P7): a CLI feature that lets a reader
// pick or create a category interactively writes exactly one file this way —
// splitting the assignment (sheet.yml) from the tab order (build.yml) made a
// dropped second write a silent "ghost tab" (a category nobody declared
// showing up with no error). See categoriesForSheet/underKeyForSheet below.

import { parse } from "yaml";
import { registerMetadataProvider, type MetadataProvider, type MetadataContext, type MetadataQuery, type MetadataResult, type LangText } from "../metadata.js";

export type ProjectMetaParam = {
  // Assembler-only hint: which category this project key belongs to. NOT
  // returned by resolve() — enrich() never touches sheet/category structure.
  //
  // `null` is not "unset": it is the project declaring that this row belongs
  // to NO category — it is about the component as a whole, and files directly
  // under the component heading, above every category. Same undefined/null
  // distinction `dict_key` below draws, for the same reason: a fact somebody
  // stated must be told apart from one nobody has stated yet. Only meaningful
  // on a sheet with more than one component (a single-component sheet IS that
  // component, so the level is collapsed and there is nothing above its
  // categories) — assemble.ts errors otherwise rather than guessing.
  //
  // A LIST is a path: `[Tokens, Access tokens]` files the row under an "Access
  // tokens" category nested inside "Tokens". Only the first segment is a tab,
  // so only it belongs in the sheet's `categories:` declaration. A one-element
  // list and a bare string mean the same thing.
  category?: string | string[] | null;
  // string: a true alias (see bind.ts). null: an explicit severance — this
  // key is declared to bind to nothing. undefined: not declared.
  dict_key?: string | null;
  description?: LangText;
  remarks?: LangText;
  out_of_scope?: { reason: LangText; owner?: string };
};

// A row named by a product key via `keyMap` (assemble.ts) surfaces its
// backing Ansible variable as a muted sub-line under the parameter key (see
// assemble.ts's ColumnDefinition place: "under_key"); `id` is also the `Parameter.extra`
// field name that variable is stored under, so it doubles as data plumbing,
// not pure display — but which column header a reader sees for it IS a
// display decision, hence sheet.yml, not build.yml.
export type UnderKeyMeta = { id: string; label: { ja: string; en: string } };

// A single sheet's own `params:` namespace, under `sheets:` below, plus that
// sheet's own display config (top-level tab order, under_key column) — see
// this file's header for why both moved here from build.yml.
export type ProjectMetaSheetDoc = {
  categories?: string[];
  under_key?: UnderKeyMeta;
  // Which group this sheet is read under (types.ts's Sheet.group), naming an
  // entry of the doc's top-level `groups:`. A display fact like `label`, and in
  // the same file for the same reason.
  group?: string;
  // This sheet's components are comparable side by side (Sheet.compare_components).
  compare_components?: boolean;
  // The sheet's display text (Sheet.label). Here rather than in build.yml for
  // the same reason `categories`/`under_key` are: it is a fact about how the
  // sheet is READ, not about where its rows come from, and the reviewer-facing
  // prose of this project lives in one file.
  label?: LangText;
  params: Record<string, ProjectMetaParam>;
  // Per-component params, for a sheet holding more than one. The same leak
  // `sheets:` closed one level up: on a sheet whose rows are named by the
  // product's own field, two components SHARE those names — two Keycloak
  // clients both have `redirectUris[0]` — so a single flat table makes one
  // client's remarks ("this is the SAML SP's ACS URL") appear on the other's
  // row, looking authored rather than leaked.
  //
  // Resolved component-first, then the sheet-wide table: a field means the
  // same thing on every component of one product, so its DESCRIPTION belongs
  // in `params:` once, while the reason THIS component was set that way
  // belongs under the component. Neither has to restate the other.
  components?: Record<string, { params: Record<string, ProjectMetaParam> }>;
};

// Flat (`params`) is a single spec-wide namespace: two sheets that happen to
// share a key (e.g. two sheets reading the same group_vars file) share its
// category/description too — which is exactly how a key that leaked from one
// sheet's extraction into another's (a missing `exclude:` filter, say) can
// come out looking legitimately documented under the WRONG sheet's metadata,
// with no error. `sheets` closes that: each sheet's `params:` is its own
// namespace, keyed by sheet name, so a leaked key finds nothing under its
// actual sheet and the existing "no category"/"no description" strict gates
// name it. Only one of the two may be set — see loadProjectMeta — a flat
// fallback under `sheets` would silently reopen the same hole. `categories`/
// `under_key` at this (flat) level are the single-sheet (Level 0) equivalent
// of the per-sheet fields above — a flat doc only ever backs one sheet, so
// there is nothing to namespace.
export type SheetGroupDecl = { name: string; label?: LangText };

export type ProjectMetaDoc = {
  categories?: string[];
  under_key?: UnderKeyMeta;
  label?: LangText;
  params?: Record<string, ProjectMetaParam>;
  sheets?: Record<string, ProjectMetaSheetDoc>;
  // The sheet groups this document uses, IN READING ORDER (types.ts's
  // SheetGroup). Optional: a document that declares none, and sheets that name
  // none, stay a flat tab strip exactly as before.
  //
  // Declaring it is what buys the order — derived-from-first-appearance would
  // silently reshuffle the whole header the day a sheet is added in the middle
  // — and, once declared, it is checked BOTH ways like every other list here:
  // a sheet naming a group nobody declared, and a declared group no sheet uses,
  // are both errors rather than a tab that quietly appears or quietly does not.
  groups?: { name: string; label?: LangText }[];
};

// A `category:` list is a path, and every segment of it has to be a real name.
// Checked once at load, where the file can be named, rather than per row deep
// inside assembly: `category: []` is the interesting case — it looks like
// "no category" but `null` already means that, and the two must not be one
// spelling apart.
function checkCategoryPaths(params: Record<string, ProjectMetaParam> | undefined, where: string, path: string): void {
  for (const [key, param] of Object.entries(params ?? {})) {
    const c = param?.category;
    if (!Array.isArray(c)) continue;
    if (c.length === 0) {
      throw new Error(
        `project metadata ${path}: ${where}"${key}" has an empty category list. ` +
          `Write the path it belongs under, or "category: null" to say it belongs to no category at all.`
      );
    }
    const bad = c.findIndex((seg) => typeof seg !== "string" || seg.trim() === "");
    if (bad !== -1) {
      throw new Error(
        `project metadata ${path}: ${where}"${key}" has an empty or non-string category path segment at position ${bad + 1} ` +
          `(${JSON.stringify(c)}).`
      );
    }
  }
}

export function loadProjectMeta(path: string, readFile: (path: string) => string | null): ProjectMetaDoc {
  const content = readFile(path);
  if (content === null) throw new Error("project metadata not found: " + path);
  const doc = (parse(content) ?? {}) as Partial<ProjectMetaDoc>;
  if (doc.sheets && doc.params) {
    throw new Error(
      `project metadata ${path}: "sheets:" and top-level "params:" cannot both be set. ` +
        `A file using "sheets:" has no flat fallback — namespace every param under its own sheet ` +
        `(a mix would silently let one sheet's params be read as another's).`
    );
  }
  if (doc.sheets) {
    const sheets: Record<string, ProjectMetaSheetDoc> = {};
    for (const [name, s] of Object.entries(doc.sheets)) {
      checkCategoryPaths(s?.params, `sheet "${name}" param `, path);
      for (const [component, c] of Object.entries(s?.components ?? {})) {
        checkCategoryPaths(c?.params, `sheet "${name}" component "${component}" param `, path);
      }
      sheets[name] = {
        params: s?.params ?? {},
        ...(s?.categories ? { categories: s.categories } : {}),
        ...(s?.under_key ? { under_key: s.under_key } : {}),
        ...(s?.label ? { label: s.label } : {}),
        ...(s?.group ? { group: s.group } : {}),
        ...(s?.compare_components ? { compare_components: true } : {}),
        ...(s?.components ? { components: s.components } : {}),
      };
    }
    return { sheets, ...(doc.groups ? { groups: doc.groups } : {}) };
  }
  checkCategoryPaths(doc.params, "param ", path);
  return {
    params: doc.params ?? {},
    ...(doc.groups ? { groups: doc.groups } : {}),
    ...(doc.categories ? { categories: doc.categories } : {}),
    ...(doc.under_key ? { under_key: doc.under_key } : {}),
    ...(doc.label ? { label: doc.label } : {}),
  };
}

// Every check downstream (bindDrafts/fileDrafts/enrich, in assemble.ts) reads
// a project key by first resolving THIS SHEET's own params table — flat docs
// have one table shared by every sheet (`sheet` is ignored), `sheets:` docs
// have one table per sheet (an unknown/undeclared sheet name resolves to an
// empty table, not a fallback to any other sheet's).
export function paramsForSheet(doc: ProjectMetaDoc, sheet: string | undefined): Record<string, ProjectMetaParam> {
  if (doc.sheets) return (sheet !== undefined ? doc.sheets[sheet]?.params : undefined) ?? {};
  return doc.params ?? {};
}

// One row's project metadata: the component's own entry FIELD-MERGED over the
// sheet-wide one, so a component can add a `remarks` without restating the
// `description` that is true of every component, or override a field where it
// genuinely differs. A row with no component, or a sheet with no `components:`,
// reads exactly as before.
export function paramForRow(
  doc: ProjectMetaDoc,
  sheet: string | undefined,
  component: string | undefined,
  key: string
): ProjectMetaParam | undefined {
  const wide = paramsForSheet(doc, sheet)[key];
  if (component === undefined || !doc.sheets || sheet === undefined) return wide;
  const own = doc.sheets[sheet]?.components?.[component]?.params?.[key];
  if (!own) return wide;
  return wide ? { ...wide, ...own } : own;
}

// Every (component, key) pair the project declares for a sheet, for the
// "described but never produced" check — a component-scoped entry that names a
// key no row produced is exactly as wrong as a sheet-wide one, and was
// invisible while only the flat table was walked.
export function componentParamsForSheet(
  doc: ProjectMetaDoc,
  sheet: string | undefined
): { component: string; key: string }[] {
  if (!doc.sheets || sheet === undefined) return [];
  const out: { component: string; key: string }[] = [];
  for (const [component, c] of Object.entries(doc.sheets[sheet]?.components ?? {})) {
    for (const key of Object.keys(c.params ?? {})) out.push({ component, key });
  }
  return out;
}

// The components this sheet's metadata declares a block for. Compared against
// the components the sheet actually PRODUCED (assemble.ts), the same two-way
// check `component: names:` has on the build.yml side: a block for a component
// no row belongs to is documentation applying to nothing, and the ordinary
// "unused param" check cannot see it — those keys (`enabled`, `protocol`) exist
// on the sheet under a DIFFERENT component, so every one of them looks used.
export function declaredComponentsForSheet(doc: ProjectMetaDoc, sheet: string | undefined): string[] {
  if (!doc.sheets || sheet === undefined) return [];
  return Object.keys(doc.sheets[sheet]?.components ?? {});
}

// This sheet's own declared top-level tab display order (see this file's
// header). Empty = nothing declared, so the caller (assemble.ts's fileDrafts)
// falls back to first-appearance order and skips the ghost-tab check
// entirely — a sheet that never declares one stays exactly as free as before.
export function categoriesForSheet(doc: ProjectMetaDoc, sheet: string | undefined): string[] {
  if (doc.sheets) return (sheet !== undefined ? doc.sheets[sheet]?.categories : undefined) ?? [];
  return doc.categories ?? [];
}

// Whether this sheet declares its components comparable (Sheet.compare_components).
export function compareComponentsForSheet(doc: ProjectMetaDoc, sheet: string | undefined): boolean {
  return (doc.sheets && sheet !== undefined ? doc.sheets[sheet]?.compare_components : undefined) ?? false;
}

// This sheet's own group id, if any (Sheet.group). A flat doc describes one
// sheet, and one sheet is not something to group, so only a `sheets:` doc can
// answer this.
export function groupForSheet(doc: ProjectMetaDoc, sheet: string | undefined): string | undefined {
  return doc.sheets && sheet !== undefined ? doc.sheets[sheet]?.group : undefined;
}

// The document's declared groups, in reading order. Empty when it declares none.
export function sheetGroups(doc: ProjectMetaDoc): { name: string; label?: LangText }[] {
  return doc.groups ?? [];
}

// This sheet's own display text, if any (Sheet.label). A flat doc describes one
// sheet, so its top-level `label:` is that sheet's — same shape as
// categoriesForSheet.
export function labelForSheet(doc: ProjectMetaDoc, sheet: string | undefined): LangText | undefined {
  if (doc.sheets) return sheet !== undefined ? doc.sheets[sheet]?.label : undefined;
  return doc.label;
}

// This sheet's own under_key column declaration (id + bilingual label), if
// any — see UnderKeyMeta above.
export function underKeyForSheet(doc: ProjectMetaDoc, sheet: string | undefined): UnderKeyMeta | undefined {
  if (doc.sheets) return sheet !== undefined ? doc.sheets[sheet]?.under_key : undefined;
  return doc.under_key;
}

// A `sheets:` doc naming a sheet this build has no SheetInputs for is always a
// mistake (a stale name after a rename, a typo) — same discipline as
// assemble.ts's own `dictionaries` sheet-name check, which this mirrors.
export function checkProjectMetaSheets(doc: ProjectMetaDoc, knownSheets: Iterable<string>): void {
  if (!doc.sheets) return;
  const known = new Set(knownSheets);
  const unknown = Object.keys(doc.sheets).filter((s) => !known.has(s));
  if (unknown.length > 0) {
    throw new Error(
      `project metadata: sheets: names sheet(s) this build has no sheet for: ${unknown.join(", ")} ` +
        `(sheets: ${[...known].join(", ") || "(none)"})`
    );
  }
}

function cachedProjectMeta(path: string, ctx: MetadataContext): ProjectMetaDoc {
  const cacheKey = "project:" + path;
  const cached = ctx.cache.get(cacheKey);
  if (cached) return cached as ProjectMetaDoc;
  const doc = loadProjectMeta(path, ctx.readFile);
  ctx.cache.set(cacheKey, doc);
  return doc;
}

const projectProvider: MetadataProvider = {
  name: "project",
  priority: 100,
  resolve(query: MetadataQuery, ctx: MetadataContext): MetadataResult | undefined {
    if (!ctx.project) return undefined;
    const doc = cachedProjectMeta(ctx.project, ctx);
    // The component, when the sheet has more than one, is the OUTERMOST level
    // of a row's category path (assemble.ts's fileDrafts) — so the path's head
    // is where to look, with no extra field threaded through the query.
    //
    // Only honoured when it names a component this sheet actually DECLARES:
    // on a single-component sheet the level is collapsed and the head is an
    // ordinary category, and treating that as a component id would read a
    // table nobody wrote. A miss falls back to the sheet-wide params, which is
    // every sheet that predates this.
    const head = query.categoryPath?.[0];
    const declared = query.sheet !== undefined && head !== undefined && doc.sheets?.[query.sheet]?.components?.[head] !== undefined;
    const p = paramForRow(doc, query.sheet, declared ? head : undefined, query.key);
    if (!p) return undefined;
    // `p.dict_key` is NOT returned here: it is read directly off project
    // metadata by the single bind pass (bind.ts's bindKey, driven by
    // assemble.ts's bindDrafts or enrich.ts's standalone pass), never routed
    // through a provider result — see MetadataQuery.binding.
    return {
      // Carry the full LangText through; the viewer resolves the display
      // language at render time (see dictionary provider).
      description: p.description,
      remarks: p.remarks,
      out_of_scope: p.out_of_scope,
      provenance: "project",
    };
  },
};
registerMetadataProvider(projectProvider);
