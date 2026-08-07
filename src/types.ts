// ============================================================
// Input data model
// ============================================================

// A documentation string, or a { en, ja } language map. Fields that carry
// human-readable prose (description, remarks) accept either form: a plain
// string when it is language-neutral or authored in one language, or a map so
// the viewer can switch languages at display time (pickLang resolves it).
export type LangText = string | { en?: string; ja?: string };

// Resolve a LangText for a target language: the exact language if present, else
// English, else Japanese, else undefined. A plain string passes through.
export function pickLang(t: LangText | undefined, lang: "en" | "ja"): string | undefined {
  if (t === undefined) return undefined;
  if (typeof t === "string") return t;
  return t[lang] ?? t.en ?? t.ja;
}

export type ParameterSheetInput = {
  metadata?: SheetMetadata;
  columns?: ColumnDefinition[];
  sheets: Sheet[];
  // Optional capabilities the embedded viewer can rely on (e.g. whether a
  // `review-sheet serve` backend is reachable for direct apply). Carried
  // through generation as a pass-through; consumed by a later viewer task.
  capabilities?: Capabilities;
};

export type Capabilities = {
  apply?: boolean;
};

// A collection of full snapshots, each a complete sheet set tagged with a
// version/date/tags. The viewer can switch the displayed version and diff any
// two. A plain ParameterSheetInput is accepted too (treated as a single
// version).
export type VersionedSheetInput = {
  metadata?: SheetMetadata;
  versions: SheetVersion[];
  // Same meaning as `ParameterSheetInput.capabilities`: a document-level
  // pass-through carried unchanged into the embedded payload.
  capabilities?: Capabilities;
};

export type SheetVersion = {
  id?: string;          // stable id (defaults to the version label)
  version: string;      // human label, e.g. "1.2"
  date?: string;        // ISO date/time the snapshot represents
  tags?: string[];      // free-form tags, e.g. ["release", "prod"]
  author?: string;
  note?: string;
  columns?: ColumnDefinition[];
  sheets: Sheet[];
};

export type SheetMetadata = {
  title?: string;
  project?: string;
  version?: string;
  generated_at?: string;
  changelog?: ChangeLogEntry[];
  extra?: Record<string, string>;
};

export type ChangeLogEntry = {
  version: string;
  date: string;
  author: string;
  description: string;
};

export type Sheet = {
  name: string;
  role?: string;
  // The review axis this sheet is organised along (environments, regions …),
  // ordered, as DECLARED by the build (never derived from which rows happen to
  // differ). Without it the viewer can only infer the axis from rows that carry
  // `instances`, so a category where every value is shared would silently lose
  // its environment columns — and with them the ability to say "production
  // should set this one".
  instances?: string[];
  file_path?: string;
  // Default source file for verify/apply, distinct from the display `file_path`
  // (e.g. file_path = deployed path, source_file = local template/vars file).
  // A value's `source.file` still overrides this; when neither is set, apply
  // falls back to `file_path` (backward compatible).
  source_file?: string;
  categories: Category[];
};

// Presence marks the node excluded from review scope; `reason` is mandatory
// (why it's excluded), `owner` optionally names who is responsible instead.
//
// `reason` is prose, so it is a LangText like every other prose field in the
// model — a Japanese team writes the reason in Japanese, and an English reader
// of the same sheet must not be shown it untranslated. `owner` is a team name
// ("DBA", "Platform"), which is an identifier rather than prose, so it stays a
// plain string.
export type OutOfScope = {
  reason: LangText;
  owner?: string;
};

// Where a parameter's value comes from. `overlay` = per-environment variable
// (has `instances`); `common` = a single shared value; `embedded` = a literal
// baked into the deployable source (template literal / hardcoded arg), never
// per-environment; `default` = the PRODUCT's own default, i.e. our deliverable
// sets nothing at all — the row exists so the sheet can be the exhaustive
// ledger of the product's parameters, and its `value` is the documented default
// (never a location in our files, so it carries no `source`).
//
// Optional in the model — when absent it is derived (see `effectiveOrigin` in
// prompt.ts): `instances` present -> "overlay", else "common". `embedded` and
// `default` must always be set explicitly; neither is ever inferred.
//
// Origin says where a value comes from, never whether it is in review scope:
// a `default` row is in scope like any other (that is the point of writing it
// down), until `out_of_scope` says otherwise.
export type Origin = "overlay" | "common" | "embedded" | "default";

export type Category = {
  name: string;
  tag?: string;
  file_path?: string;
  source_file?: string;
  // Mark a whole category (and its descendants) as not in review scope: greyed
  // out in the HTML, and skipped — not held — by verify/apply.
  out_of_scope?: OutOfScope;
  params?: Parameter[];
  categories?: Category[];
};

export type ParameterBase = {
  key: string;
  description?: LangText;
  default?: string;
  remarks?: LangText;
  // Mark a single parameter as not in review scope (same effect as the category
  // flag, at parameter granularity).
  out_of_scope?: OutOfScope;
  origin?: Origin;
  extra?: Record<string, string>;
  // Extra definition sites related to this parameter, beyond its primary
  // `source` (or per-instance `source` on Pattern B). Two kinds, distinguished
  // by `SourceLocation.ref`:
  //   - no `ref`: the SAME value, defined again elsewhere and kept in sync on
  //     a value change (e.g. an Ansible variable defined in defaults/main.yml
  //     and overridden in several group_vars files) — apply edits the primary
  //     `source` and each of these; verify checks them all for equality.
  //     Valid only on a SimpleParameter: "the same value" is undefined
  //     without a single `value` to compare against (schema-enforced — see
  //     input.schema.json's `parameter` def).
  //   - `ref` set: the site holds a *reference expression* to this
  //     parameter's value, not the value itself (e.g. `$(env:SSO_HOST)` in a
  //     static config file) — verify checks it by containment instead of
  //     equality, and apply never writes it.
  // Use `additional_sources` (no `ref`) — not `instances` — when the value is
  // identical but defined in more than one place; `instances` is for
  // genuinely different per-environment values.
  additional_sources?: SourceLocation[];
};

export type SimpleParameter = ParameterBase & {
  value: string;
  instances?: never;
  // Where this value lives in the real configuration source, so the AI prompt
  // can target the edit precisely (source-map style).
  source?: SourceLocation;
};

export type InstanceParameter = ParameterBase & {
  value?: never;
  instances: Instance[];
};

export type Parameter = SimpleParameter | InstanceParameter;

export type Instance = {
  name: string;
  value: string;
  // Per-instance source location: instances of the same parameter usually live
  // in different files/hosts, so each carries its own pointer.
  source?: SourceLocation;
};

// Source-map-style pointer to where a value lives in the real configuration.
// `file` + `line` give the precise spot; `anchor`/`path` let a consumer verify
// the spot and re-locate it if the line has drifted (the fallback path). When
// `file` is omitted, the nearest category/sheet `file_path` is used instead.
export type SourceLocation = {
  file?: string;
  line?: number;
  column?: number;
  end_line?: number;
  anchor?: string;
  path?: string;
  // Adapter hints produced by the jinja2 parser — informational only, not used
  // by verify/apply. `templateVar` is the variable behind a `{{ … }}` value (a
  // conversion script resolves it in the variable file); `conditional` flags a
  // line inside a `{% if %}`/`{% for %}` block (its rendered position may shift).
  templateVar?: string;
  conditional?: boolean;
  // True when this source location was produced by a code-generation step
  // (rather than authored/extracted from the real config) — informational only.
  generated?: boolean;
  // This site holds a *reference* to this parameter's value, not the value
  // itself — the literal reference expression (e.g. `$(env:SSO_HOST)`)
  // expected to appear in the site's own value. verify checks it by
  // containment, not equality; apply never treats it as a write target (see
  // `additional_sources` on `ParameterBase`). Meaningful only on an
  // `additional_sources` entry, never on a parameter's primary `source`.
  ref?: string;
};

export type ColumnDefinition = {
  field: string;
  header: string;
  width?: string;
  align?: "left" | "center" | "right";
  className?: string;
  render?: "text" | "status";
  // Where the column is placed. "trailing" (default) adds a column at the right.
  // "under_key" renders the field as a muted second line inside the key cell
  // (for a provenance identity tied to the key, e.g. a backing variable name) —
  // it is not a separate column, so it costs no width and follows the key's
  // freeze behaviour.
  place?: "trailing" | "under_key";
};

// ============================================================
// review.json schema v2.0
// ============================================================

export type ReviewDocument = {
  schema_version: "2.0";
  created_at: string;
  reviews: ReviewItem[];
};

export type ReviewItem = {
  id: string;
  target: ReviewTarget;
  changes?: ReviewChange[];
  comment?: string;
  status: "pending" | "applied" | "rejected";
};

export type ReviewTarget = {
  sheet: string;
  category?: string;
  param?: string;
  instance?: string;
  field?: string;
};

export type ReviewChange = {
  field: string;
  current?: string;
  suggested: string;
};

// ============================================================
// Generation options
// ============================================================

export type GenerateOptions = {
  title?: string;
  review?: boolean;
  lang?: "ja" | "en";
  // When true, the embedded app runs in server mode: it talks to a local
  // `review-sheet serve` backend (POST /api/apply, /api/verify) to apply
  // reviewed changes directly to local files instead of exporting review.json.
  server?: boolean;
};
