// Framework-free model + AI-prompt builder, shared by the browser app and the
// CLI. No DOM or Node dependencies so it can run in either environment.

import { pickLang, type LangText, type Origin, type SheetDocument } from "./types.js";

// ============================================================
// Shared data model (the embedded sheet-data / review shape)
// ============================================================

export type SourceLocation = {
  file?: string;
  line?: number;
  column?: number;
  end_line?: number;
  anchor?: string;
  path?: string;
  // The base format this location must be READ with, when the file name cannot
  // say it (types.ts carries the same field and the same reason). Load-bearing
  // for verify/apply: parserForSource picks the parser from it.
  baseFormat?: string;
  templateVar?: string;
  conditional?: boolean;
  // True when this source location was produced by a code-generation step
  // (rather than authored/extracted from the real config) — informational for
  // most consumers, but load-bearing for apply.ts/verify.ts (see HELD_REASON_
  // GENERATED and the missing-file warning below).
  generated?: boolean;
  // This site holds a *reference* to the parameter's value, not the value
  // itself (e.g. `$(env:SSO_HOST)`) — load-bearing for both cores: verify.ts
  // checks the located value by containment instead of equality, and
  // apply.ts never treats the site as a write target. Meaningful only on an
  // `additional_sources` entry (see types.ts's `ParameterBase`).
  ref?: string;
  // The text at this site whose PRESENCE is the row's value — see
  // `SourceLocation.member` in types.ts.
  member?: string;
  // The mirror of `ref`: this site holds a PART of the row's value, not a
  // reference to it — the variable's value substituted into a template's line
  // (see types.ts's SourceLocation.substituted and the ansible recipe's
  // `rows: artifact`). verify checks containment the other way round; apply
  // holds, because deciding which part of the line a reviewer meant to change
  // is how a config edit turns into a template edit.
  substituted?: boolean;
};

export type ParamData = {
  key: string;
  // This row IS a block rather than a setting inside one, and the chain of
  // blocks enclosing it — see `ParameterBase.container`/`container_path`, which
  // these mirror. Carried here because both the viewer and the CLI read this
  // shape, and a container is not a fact either of them may guess at.
  container?: { name?: string; nameFromDocs?: boolean };
  container_path?: { path: string; name?: string; subject?: string }[];
  // This row's value is PRESENCE — see `ParameterBase.presence` in types.ts.
  presence?: true;
  // The product own word for presence — see ParameterBase.presence_label.
  presence_label?: LangText | string;
  // The grouping a file heading displaced, for the viewer to sub-head with —
  // see `ParameterBase.sub_category`. Display only; the row's identity is its
  // category and key, and neither moves when the layout does.
  sub_category?: string[];
  // The file this row is a line of — see `ParameterBase.deployed_file`.
  deployed_file?: string;
  // The product's own display name — LangText in a built model, resolved to a
  // string by the viewer's localizeParam. Display only; `key` is identity.
  label?: LangText | string;
  description?: LangText;
  default?: string;
  // The values this setting may take, with the product's own name for each —
  // labels are LangText in a built model and resolved to strings by the
  // viewer's localizeParam, so the language toggle switches them live.
  options?: { value: string; label?: LangText | string }[];
  // The vendor's shipped value — see types.ts's `ParameterBase.baseline`.
  baseline?: string;
  remarks?: LangText;
  value?: string;
  source?: SourceLocation;
  additional_sources?: SourceLocation[];
  instances?: { name: string; value: string; source?: SourceLocation }[];
  out_of_scope?: { reason: LangText; owner?: string };
  origin?: Origin;
  // Written by the recipient in a delivered document, not extracted from any
  // config file. Viewer-side only: no built model ever carries it, and the row
  // has no `source`, which is exactly what it is announcing.
  added?: boolean;
  // Struck through: whoever maintains the document says this is no longer set.
  // Viewer-side only, like `added`.
  deleted?: boolean;
  extra?: Record<string, string>;
};

export type CategoryData = {
  // Identity — see types.ts's Category. `label`/`display` are the display text.
  name: string;
  label?: LangText;
  // Filled by the viewer's localizeCategory, never present in a built model.
  display?: string;
  tag?: string;
  file_path?: string;
  source_file?: string;
  out_of_scope?: { reason: LangText; owner?: string };
  params?: ParamData[];
  categories?: CategoryData[];
};

// Resolve a parameter's effective origin (decision c): an explicit `origin`
// always wins; otherwise `instances` present means a per-environment overlay
// value, and its absence means a single shared ("common") value. `embedded`
// and `default` are never derived — both must be set explicitly ("we set
// nothing here" is not something the shape of a row can prove).
export function effectiveOrigin(param: { origin?: Origin; instances?: { name: string; value: string }[] }): Origin {
  if (param.origin) return param.origin;
  return param.instances !== undefined ? "overlay" : "common";
}

export type SheetData = {
  metadata?: {
    title?: string;
    project?: string;
    version?: string;
    generated_at?: string;
    changelog?: { version: string; date: string; author: string; description: string }[];
    extra?: Record<string, string>;
  };
  columns?: { field: string; header: string; header_lang?: LangText; width?: string; align?: string; className?: string; render?: string; place?: "trailing" | "under_key" }[];
  groups?: { name: string; label?: LangText; display?: string }[];
  sheets: {
    // Identity — see types.ts's Sheet. `label`/`display` are the display text.
    name: string;
    label?: LangText;
    group?: string;
    // See types.ts: `"always"` opens side by side with no way back, for a sheet
    // whose whole purpose is the comparison.
    compare_components?: boolean | "always";
    // Filled by the viewer's localizeSheets, never present in a built model.
    display?: string;
    role?: string;
    instances?: string[];
    file_path?: string;
    source_file?: string;
    categories: CategoryData[];
    // See types.ts's Sheet.document — prose instead of rows. Carried into the
    // viewer's own shape so a document sheet is a sheet everywhere (tab, group,
    // outline) and a special case only where it has to be: it has no rows, so
    // nothing that walks rows finds any.
    document?: SheetDocument;
  }[];
};

// Held reason `computeApply` (apply.ts) uses when a value's source is a
// generated build artifact: it is never edited directly because the file gets
// regenerated. Shared (not just apply-internal) so the browser app can
// recognize it and show the translated `applySkippedGenerated` i18n message
// instead of this raw English text.
export const HELD_REASON_GENERATED = "Cannot apply directly: source file is generated";
// A row whose value is the artifact's rendered LINE, of which the mapped source
// holds only the variable's part (SourceLocation.substituted). Held rather than
// written: the suggested value is a whole line, and deciding which part of it
// the reviewer meant to change is exactly where a config edit turns into a
// template edit — `CustomLog "…" proxied` can be changed in the variable or in
// the template, and only a human can say which was meant.
// A membership row: its value is presence and the site holds the member's own
// text (SourceLocation.member). Held rather than written, because changing it
// is not a scalar edit — "no longer permit ssh" removes an element from a list,
// and writing `true` over `ssh` would corrupt the file. The structural change
// belongs to the same machinery a deleted row already goes through.
export const HELD_REASON_MEMBERSHIP =
  "Cannot apply directly: this row's value is membership of a list — removing or adding a member is a structural edit, not a value one";

export const HELD_REASON_SUBSTITUTED =
  "Cannot apply directly: the row is a rendered line and this source holds only the variable inside it";

// Held reason for a change against an `origin: "default"` row: the parameter is
// at the product's default because our deliverable sets it NOWHERE, so there is
// no line to edit — applying the change means *adding* the setting, which the
// deterministic core deliberately does not do (where a new setting belongs is a
// judgement call). Step 3 of the prompt protocol below covers it.
export const HELD_REASON_DEFAULT = "Cannot apply directly: parameter is at the product default (nothing is set) — the setting has to be added";

// Held reason for a change against an `origin: "baseline"` row: the vendor
// shipped this key and this deliverable does not have it anywhere, so — like
// `HELD_REASON_DEFAULT` — there is no line to rewrite. Kept as its own
// constant rather than reusing HELD_REASON_DEFAULT because the two are
// different facts for a reader of the held prompt: one says "the product's
// own default applies", the other says "the vendor's directive is not in
// effect at all, and re-adding it is what the change means".
export const HELD_REASON_BASELINE =
  "Cannot apply directly: the vendor shipped this parameter and this deliverable does not have it — there is no line to edit";

// Held reason for a change aimed at ONE environment on a row that stores a
// single shared value. Editing that value would move every environment, and
// splitting it into a per-environment override is a structural change to the
// project's layout — a judgement, not an edit. So the deterministic core refuses
// and the AI prompt gets it with the right instruction instead.
// A row somebody wrote into the sheet itself. There is no line to edit, so
// where it belongs — which file, which section, what syntax — is a judgement
// about the project's layout, not an edit.
export const HELD_REASON_ADDED_ROW =
  "Cannot apply directly: this row was written into the sheet and no config file has a line for it — decide where it belongs and add it";

// A row marked as no longer set. Removing a line is not the inverse of editing
// one: it may be commented out, deleted, or moved to a default, and which of
// those is right depends on the file.
export const HELD_REASON_STRUCK_ROW =
  "Cannot apply directly: this setting was marked as no longer used — decide whether its line is removed, commented out, or left to the product default";

// The target names no row in this document at all — the setting was removed, or
// renamed, since the finding was written. Deliberately NOT folded into "no file
// mapped": that says a row exists and nothing points at a file, which is a fact
// about the row's source map, while this says there is no row to have one. The
// two used to read identically, so a finding against a deleted setting looked
// like an ordinary unmapped one and the reader had no way to tell that what
// they were being asked about is gone.
export const HELD_REASON_NO_ROW =
  "Cannot apply directly: no row in the current document matches this finding — the setting was removed or renamed, so decide whether the finding still applies";

// A container row: the block's own identity, not a setting inside it.
//
// Held for a reason no other row has. The block's subject is part of the
// ADDRESS of everything inside it — `Directory["/var/www"].AllowOverride` — so
// rewriting it mechanically would leave every child row of that block pointing
// at a block that no longer exists, and every sibling edit in the same batch
// applied against stale addresses. Which of those follow the rename and which
// were meant as they stand is a judgement about the file, and the batch's
// outcome would otherwise depend on the order the edits happened to be applied
// in.
//
// The mirror of `EXPR_CONTAINERS` in the parsers: an expression container
// trades label identity for editability (it is addressed positionally, so its
// condition is a value apply may rewrite), and a subject container trades the
// reverse. Same invariant, both halves.
export const HELD_REASON_CONTAINER_SUBJECT =
  "Cannot apply directly: this is a block's own identity, and every setting inside it is addressed through it — renaming it moves those rows, so decide the block and its contents together";

// A document sheet's page, rewritten. It goes back to the markdown file the
// page was rendered from — a whole file, not a line, which no source map
// addresses and no parser edits.
export const HELD_REASON_DOCUMENT =
  "Cannot apply directly: this is a whole markdown document, rewritten — replace the contents of the sheet's source_file with the text below";

export const HELD_REASON_SHARED_INSTANCE =
  "Cannot apply directly: the value is a single shared definition — changing it for one environment means adding an environment-level override, which is a structural decision";

export type SaveRecord = { id?: string; at: string; by?: string; comment?: string; changes: number };

export type ReviewTarget = { sheet: string; category?: string; param?: string; instance?: string; field?: string };
// Mirrors types.ts's ReviewChange/ReviewItem. See there for what `at`/`by`/
// `lang` mean; they are set by edits made in a delivered HTML.
export type ReviewChange = { field: string; current?: string; suggested: string; lang?: "ja" | "en" };

export type ReviewItem = {
  id: string;
  target: ReviewTarget;
  changes?: ReviewChange[];
  comment?: string;
  status: "pending" | "applied" | "rejected";
  at?: string;
  by?: string;
  creates?: boolean;
  deletes?: boolean;
  assets?: Record<string, string>;
};

// ============================================================
// Source-map resolution
// ============================================================

export type ParamEntry = {
  param: ParamData;
  fileFallback?: string;
  outOfScope?: boolean;
  outOfScopeReason?: string;
  // Where this row is NOW, so a target naming where it used to be can be
  // re-pointed at it (see retargetReviews).
  sheet: string;
  path: string;
};

// Resolve the default source file for a node: the nearest `source_file` up the
// tree wins, falling back to the nearest display `file_path` (backward
// compatible). A value's own `source.file` still overrides this fallback.
function effectiveFile(sourceFallback?: string, fileFallback?: string): string | undefined {
  return sourceFallback ?? fileFallback;
}

// Index the data tree once, keyed by sheet::category::param. The category key
// mirrors how categoryPath is built at render time (nested names joined by "/").
export function buildSourceIndex(data: SheetData): Map<string, ParamEntry> {
  const index = new Map<string, ParamEntry>();
  const walk = (
    cats: CategoryData[] | undefined,
    sheetName: string,
    parentPath: string,
    fileFallback?: string,
    sourceFallback?: string,
    inheritedOOS?: { reason?: string }
  ): void => {
    for (const cat of cats ?? []) {
      const path = parentPath ? `${parentPath}/${cat.name}` : cat.name;
      const file = cat.file_path ?? fileFallback;
      const src = cat.source_file ?? sourceFallback;
      // This text ends up in an English AI prompt / CLI output, so a bilingual
      // reason is resolved to English here.
      const oos = inheritedOOS ?? (cat.out_of_scope ? { reason: pickLang(cat.out_of_scope.reason, "en") } : undefined);
      for (const p of cat.params ?? []) {
        const pOOS = oos ?? (p.out_of_scope ? { reason: pickLang(p.out_of_scope.reason, "en") } : undefined);
        index.set(`${sheetName}::${path}::${p.key}`, {
          param: p,
          fileFallback: effectiveFile(src, file),
          outOfScope: pOOS !== undefined,
          outOfScopeReason: pOOS?.reason,
          sheet: sheetName,
          path,
        });
      }
      walk(cat.categories, sheetName, path, file, src, oos);
    }
  };
  for (const sheet of data.sheets) walk(sheet.categories, sheet.name, "", sheet.file_path, sheet.source_file);
  return index;
}

// Every category a review target could legitimately name, as `sheet::path`
// (plus `sheet::` for a sheet-level target). Built by the same walk
// `buildSourceIndex` uses, because a category-grained target is resolved
// against the same tree a param-grained one is — it just stops one level short.
export function buildCategoryIndex(data: SheetData): Set<string> {
  const out = new Set<string>();
  const walk = (cats: CategoryData[] | undefined, sheetName: string, parentPath: string): void => {
    for (const cat of cats ?? []) {
      const path = parentPath ? `${parentPath}/${cat.name}` : cat.name;
      out.add(`${sheetName}::${path}`);
      walk(cat.categories, sheetName, path);
    }
  };
  for (const sheet of data.sheets) {
    out.add(`${sheet.name}::`);
    walk(sheet.categories, sheet.name, "");
  }
  return out;
}

export type ResolvedSource = {
  source?: SourceLocation;
  file?: string;
  // The target names an environment, but the row stores ONE value for all of
  // them: what `source`/`file` point at is the SHARED definition, which must
  // never be edited to satisfy one environment. Callers use this to hold the
  // change and to describe it correctly instead of pointing an agent at the
  // shared file (or, worse, at the template the sheet displays).
  sharedForInstance?: boolean;
};

// A target's row, tolerating a category that has MOVED.
//
// A review names sheet + category path + param, and the category is the one
// part of that which is display structure: it comes from a product dictionary's
// own grouping as often as from this project, so upgrading a dictionary — the
// product moved a setting to another screen — silently re-pointed every finding
// filed against it at nothing. Renaming a category in sheet.yml did the same.
//
// Identity is (sheet, param) within a component, so that is what the fallback
// matches on. Where several components of one sheet share the param name — two
// realms both having `sslRequired`, which is exactly what components exist for
// — the FIRST path segment (the component) still tells them apart, and it is
// the segment a dictionary upgrade does not touch. Anything still ambiguous
// resolves to nothing rather than to a guess: attaching a finding to the wrong
// row is worse than reporting that it no longer resolves.
export function findEntry(
  index: Map<string, ParamEntry>,
  target: ReviewTarget
): { entry: ParamEntry; movedFrom?: string } | undefined {
  if (!target.param) return undefined;
  if (target.category !== undefined) {
    const exact = index.get(`${target.sheet}::${target.category}::${target.param}`);
    if (exact) return { entry: exact };
  }
  const candidates = [...index.values()].filter((e) => e.sheet === target.sheet && e.param.key === target.param);
  if (candidates.length === 1) return { entry: candidates[0], movedFrom: target.category };
  if (candidates.length > 1 && target.category !== undefined) {
    const component = target.category.split("/")[0];
    const sameComponent = candidates.filter((e) => e.path.split("/")[0] === component);
    if (sameComponent.length === 1) return { entry: sameComponent[0], movedFrom: target.category };
  }
  return undefined;
}

// Re-point saved reviews at where their rows are NOW, once, before anything
// compares targets. Everything downstream — the viewer's targetKey equality,
// apply's index lookups, the AI prompt's source resolution — then works on
// targets that match the current document, with no tolerance of its own.
//
// Returns the rewritten list plus what moved, because a finding silently
// changing category is exactly the kind of thing this project reports: the
// caller decides whether that is a line in a CLI summary or a note in the
// viewer, but it is never nothing.
export function retargetReviews<T extends { target: ReviewTarget }>(
  reviews: T[],
  data: SheetData
): { reviews: T[]; moved: { target: ReviewTarget; from: string; to: string }[]; unresolved: ReviewTarget[] } {
  const index = buildSourceIndex(data);
  const categories = buildCategoryIndex(data);
  const moved: { target: ReviewTarget; from: string; to: string }[] = [];
  const unresolved: ReviewTarget[] = [];
  const out = reviews.map((r) => {
    // A sheet- or category-level target names no param, so there is no row to
    // follow and it is left exactly as it is — but "nothing to follow" is not
    // "nothing to check". A comment filed against a category that no longer
    // exists is as orphaned as a finding against a deleted row, and it used to
    // be the one kind this function waved through in silence.
    if (!r.target.param) {
      if (!categories.has(`${r.target.sheet}::${r.target.category ?? ""}`)) unresolved.push(r.target);
      return r;
    }
    const hit = findEntry(index, r.target);
    if (!hit) {
      unresolved.push(r.target);
      return r;
    }
    if (hit.movedFrom === undefined || hit.movedFrom === hit.entry.path) return r;
    moved.push({ target: r.target, from: hit.movedFrom, to: hit.entry.path });
    return { ...r, target: { ...r.target, category: hit.entry.path } };
  });
  return { reviews: out, moved, unresolved };
}

// The source pointer + resolved file for a review target. An instance carries
// its own pointer; a simple value uses the parameter's. When neither names a
// file, fall back to the nearest category/sheet file_path.
export function resolveSource(target: ReviewTarget, index: Map<string, ParamEntry>): ResolvedSource {
  if (!target.param) return {};
  const entry = findEntry(index, target)?.entry;
  if (!entry) return {};
  if (target.instance) {
    const inst = entry.param.instances?.find((i) => i.name === target.instance);
    if (inst) return { source: inst.source, file: inst.source?.file ?? entry.fileFallback };
    // No per-environment value: this row is shared (or set nowhere at all).
    // Return the shared definition as CONTEXT, flagged — never as an edit site.
    return {
      source: entry.param.source,
      file: entry.param.source?.file ?? entry.fileFallback,
      sharedForInstance: true,
    };
  }
  return { source: entry.param.source, file: entry.param.source?.file ?? entry.fileFallback };
}

// A compact, machine-and-human readable location hint, e.g.
// "line 42, anchor: `net.ipv4.tcp_fin_timeout =`".
export function locationHint(res: ResolvedSource): string {
  const s = res.source;
  if (!s) return "";
  const parts: string[] = [];
  if (s.line !== undefined) parts.push(`line ${s.line}${s.column !== undefined ? `:${s.column}` : ""}${s.end_line !== undefined ? `-${s.end_line}` : ""}`);
  if (s.path) parts.push(`path: ${s.path}`);
  if (s.anchor) parts.push(`anchor: \`${s.anchor}\``);
  return parts.join(", ");
}

// "Sheet > Category > key (instance)" for the doc/notes sections.
export function targetLabel(target: ReviewTarget): string {
  const parts: string[] = [target.sheet];
  if (target.category) parts.push(target.category.replace(/\//g, " > "));
  if (target.param) parts.push(target.param);
  let s = parts.join(" > ");
  if (target.instance) s += ` (${target.instance})`;
  return s;
}

// ============================================================
// AI prompt builder
// ============================================================

// The prompt is always English (and terse) regardless of the UI language: it is
// consumed by an AI coding agent, where English maximises model accuracy and
// minimises token usage. Reviewer-authored content (comments, values) is kept
// verbatim, so a Japanese reason still passes through unchanged.

const NO_SOURCE = "(no source mapping)";

const PROMPT_PREAMBLE = `# Configuration change requests

Apply each change below to the referenced configuration source. Resolve every
location with this protocol, stopping at the first step that succeeds:
  1. Open the file, go to the given line, and confirm the anchor text is
     present; update the value there.
  2. If the line has shifted, search the whole file for the anchor (or path)
     and update the single match.
  3. If no match exists, add the setting in the appropriate place and note that
     you added it rather than edited it.
  4. If the file is missing, skip the item and report it.
Change only the targeted value and leave surrounding lines untouched. When
finished, list any item you could not apply.

`;

export function buildPromptText(reviews: ReviewItem[], data: SheetData): string {
  const pending = reviews.filter((r) => r.status === "pending");
  if (pending.length === 0) return "";
  const index = buildSourceIndex(data);

  // Three buckets: value changes (config edits, grouped by file), other-field
  // changes (parameter-sheet/documentation edits), and comment-only notes.
  const configByFile = new Map<string, string[]>();
  const docLines: string[] = [];
  const noteLines: string[] = [];
  // Changes that mean "add an override for ONE environment" — the row is shared
  // or set nowhere. These must not be filed under a file to edit: doing that is
  // how an agent ends up hardcoding a per-environment value into a shared
  // template.
  const overrideLines: string[] = [];

  for (const r of pending) {
    // Out-of-scope targets are intentionally excluded from the prompt: they are
    // skipped by apply, not deferred to the AI.
    if (r.target.param && r.target.category) {
      const entry = index.get(`${r.target.sheet}::${r.target.category}::${r.target.param}`);
      if (entry?.outOfScope) continue;
    }
    const changes = r.changes ?? [];
    const valueChanges = changes.filter((c) => c.field === "value");
    const otherChanges = changes.filter((c) => c.field !== "value");

    for (const c of valueChanges) {
      const res = resolveSource(r.target, index);
      const entryForRow = r.target.param && r.target.category
        ? index.get(`${r.target.sheet}::${r.target.category}::${r.target.param}`)
        : undefined;
      if (res.sharedForInstance) {
        const isUnset = entryForRow?.param.origin === "default";
        let body = `- ${r.target.param ?? ""} [environment: ${r.target.instance}]`;
        body += `\n  value: "${c.current ?? ""}" -> "${c.suggested}"`;
        if (r.comment) body += `\n  reason: ${r.comment}`;
        body += isUnset
          ? `\n  currently: not set anywhere — the product default applies.`
          : `\n  currently: one shared value for every environment${res.file ? `, defined in ${res.file}` : ""}.`;
        body += `\n  action: add an override for "${r.target.instance}" in that environment's own configuration layer.`;
        overrideLines.push(body);
        continue;
      }
      const file = res.file ?? NO_SOURCE;
      const hint = locationHint(res);
      let body = `- ${r.target.param ?? ""}${r.target.instance ? ` [instance: ${r.target.instance}]` : ""}${hint ? ` — ${hint}` : ""}`;
      body += `\n  value: "${c.current ?? ""}" -> "${c.suggested}"`;
      if (r.comment) body += `\n  reason: ${r.comment}`;
      // No precise locator (line/anchor/path): tell the agent to find it by key.
      if (!hint) body += `\n  fallback: locate \`${r.target.param}\` in the file and update its value.`;
      // The same value may be defined in several files: list every extra site so
      // the agent keeps them in sync. A `ref` entry is a different claim (a site
      // that holds a reference EXPRESSION to this value, not the value itself —
      // see types.ts's `ParameterBase.additional_sources`), so it is rendered
      // separately as context, not as another site to edit: editing it would
      // mean rewiring, not updating a value.
      const entry = r.target.param && r.target.category && !r.target.instance
        ? index.get(`${r.target.sheet}::${r.target.category}::${r.target.param}`)
        : undefined;
      const adds = entry?.param.additional_sources ?? [];
      const valueAdds = adds.filter((a) => a.ref === undefined);
      const refAdds = adds.filter((a) => a.ref !== undefined);
      if (valueAdds.length > 0) {
        body += `\n  Also update the same value in:`;
        for (const a of valueAdds) {
          const aFile = a.file ?? res.file ?? NO_SOURCE;
          const aHint = locationHint({ source: a });
          body += `\n  - ${aFile}${aHint ? ` — ${aHint}` : ""}`;
        }
      }
      if (refAdds.length > 0) {
        body += `\n  Referenced from (context only — edit the variable, not these):`;
        for (const a of refAdds) {
          const aFile = a.file ?? res.file ?? NO_SOURCE;
          const aHint = locationHint({ source: a });
          body += `\n  - ${aFile}${aHint ? ` — ${aHint}` : ""} (\`${a.ref}\`) — edit only the variable definition unless the wiring itself is being changed.`;
        }
      }
      const arr = configByFile.get(file) ?? [];
      arr.push(body);
      configByFile.set(file, arr);
    }

    for (const c of otherChanges) {
      // A document sheet's page is a whole FILE, rewritten — the markdown the
      // sheet was rendered from. It has a destination, unlike the other edits
      // in this bucket, so it names it: an instruction to "replace the
      // contents" is useless without saying of what.
      if (c.field === "document" && r.target.param === undefined) {
        const file = data.sheets.find((sh) => sh.name === r.target.sheet)?.source_file;
        let doc = `- ${r.target.sheet}${file ? ` — ${file}` : ""}`;
        if (r.comment) doc += `\n  reason: ${r.comment}`;
        doc += `\n  Replace the whole file with:\n\n${c.suggested}`;
        // A picture pasted into the document is referenced by PATH, and that
        // path is a file that does not exist yet. Saying "replace the text"
        // without saying "and write these" leaves a document whose images are
        // broken — the failure would show up in the rendered page, long after.
        const assets = Object.entries(r.assets ?? {});
        if (assets.length > 0) {
          doc +=
            `\n\n  Also write ${assets.length} image file(s), relative to the markdown above. ` +
            `Each is base64 — decode it to bytes, do not save the text:\n` +
            assets.map(([path, uri]) => `  - ${path}\n    ${uri}`).join("\n");
        }
        docLines.push(doc);
        continue;
      }
      let body = `- ${targetLabel(r.target)}\n  ${c.field}: "${c.current ?? ""}" -> "${c.suggested}"`;
      if (r.comment) body += `\n  reason: ${r.comment}`;
      docLines.push(body);
    }

    if (changes.length === 0 && r.comment) {
      noteLines.push(`- ${targetLabel(r.target)}: ${r.comment}`);
    }
  }

  // Everything was filtered out (e.g. all targets out of scope): no prompt.
  if (configByFile.size === 0 && docLines.length === 0 && noteLines.length === 0 && overrideLines.length === 0) return "";

  let text = PROMPT_PREAMBLE;
  // Real source files first; the unmapped bucket (if any) last.
  const files = [...configByFile.keys()].filter((f) => f !== NO_SOURCE);
  if (configByFile.has(NO_SOURCE)) files.push(NO_SOURCE);
  for (const file of files) {
    text += `## File: ${file}\n${configByFile.get(file)!.join("\n")}\n\n`;
  }
  if (overrideLines.length > 0) {
    text += `# Per-environment overrides (ADD a setting — do not edit the shared definition)\n` +
      `Each of these asks for one environment to differ from the others. The value is currently\n` +
      `shared across environments (or not set at all), so satisfying the request means adding an\n` +
      `override in that environment's own layer — e.g. its group_vars/overlay file for Ansible.\n` +
      `Do NOT change the shared definition or a template to do it: that would move every\n` +
      `environment.\n\n${overrideLines.join("\n")}\n\n`;
  }
  if (docLines.length > 0) {
    text += `# Documentation / parameter-sheet edits (not deployed configuration)\n` +
      `These update the parameter sheet itself, not live config files.\n\n${docLines.join("\n")}\n\n`;
  }
  if (noteLines.length > 0) {
    text += `# Notes & open questions\n${noteLines.join("\n")}\n`;
  }
  return text.trimEnd() + "\n";
}
