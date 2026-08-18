// ============================================================
// Input data model
// ============================================================

// A documentation string, or a { en, ja } language map. Fields that carry
// human-readable prose (description, remarks) accept either form: a plain
// string when it is language-neutral or authored in one language, or a map so
// the viewer can switch languages at display time (pickLang resolves it).
export type LangText = string | { en?: string; ja?: string };

// One value a setting may take, and what the PRODUCT'S OWN UI calls it.
//
// This exists because a stored value and a displayed value are not always the
// same string: Keycloak's LDAP search scope is written `1` or `2` through the
// API and shown as "One Level" / "Subtree" in the admin console, so a reviewer
// who only ever configured it through the console meets a bare `1` in the
// sheet and cannot judge it. The label is the console's, so it is localized by
// the product and carried as LangText — and often only in English, because a
// product translates its field labels long before it translates its option
// lists (measured on one release: the option strings existed in `en` and not
// in `ja`). pickLang's cross-language fallback is exactly right for that.
//
// `value` is the STORED form, verbatim — it is what a config file holds and
// what a row is compared against, never a display form. A label is display
// only: it is never concatenated into a value, because the value a cell shows
// is the same string a review's "current value" and `apply`'s write both use,
// and "1 (One Level)" written back into a config file would be a defect.
//
// `label` is optional so the same field can carry the other half of what an
// enumerated setting knows — its LEGAL VALUES, for a product that lists them
// without naming them (PostgreSQL's pg_settings.enumvals). Those are worth
// having for the same reason: a reviewer cannot tell a typo from a valid
// value without them.
export type ParamOption = { value: string; label?: LangText };

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
  // The sheet groups this document uses, in the order they should be read.
  // Declared rather than derived from the order sheets happen to appear in:
  // the reading order of a system's layers is a decision, and one that must not
  // change because a sheet was added in the middle.
  //
  // A group is display structure and nothing else. It does not appear in a
  // review target, a diff key or a source path — a sheet belongs to exactly one
  // and can be moved between them without invalidating anything filed against
  // it, which is the whole reason grouping is safe to add to an existing
  // document.
  groups?: SheetGroup[];
  sheets: Sheet[];
  // Optional capabilities the embedded viewer can rely on (e.g. whether a
  // `review-sheet serve` backend is reachable for direct apply). Carried
  // through generation as a pass-through; consumed by a later viewer task.
  capabilities?: Capabilities;
  // The deployed files this document's rows describe, whole, so a reviewer can
  // read a value IN ITS PLACE. See ArtifactPreview.
  artifacts?: ArtifactPreview[];
};

// What a line of a previewed artifact IS, and how much trust it deserves.
//
//   verbatim     - the template line carries no Jinja at all, so the template
//                  text IS the deployed text, by identity. Every comment and
//                  every blank line is here, which is most of a real config
//                  file and the part that explains the rest of it.
//   substituted  - `{{ var }}` resolved for this instance, by the same engine
//                  whose output `verify` already checks against the real files.
//   absent       - a conditional line this instance does not render. Kept and
//                  greyed rather than removed: "this line exists only in local"
//                  is review information, and dropping it would be this project
//                  losing a line in silence.
//   unrendered   - a `{% for %}`, an unsupported condition, an unresolved
//                  variable. The RAW template text, marked. Never guessed at:
//                  a line that looks rendered and is wrong is worse than one
//                  that says it could not be computed.
export type ArtifactLineKind = "verbatim" | "substituted" | "absent" | "unrendered";

export type ArtifactLine = {
  text: string;
  kind: ArtifactLineKind;
  // The row this line IS, when it is one. Gives the viewer both directions —
  // row to its place in the file, and a line back to the row that reviews it.
  key?: string;
  // Why `unrendered`/`absent`, in the tool's own words (the unresolved
  // variables, or the condition that did not hold).
  reason?: string;
  // For an `unrendered` line, WHICH of the two very different reasons it is.
  // One visual class either way — for the reader of the line the visible fact
  // is the same, "the deployed text is not shown here, and here is why" — but
  // only one of them is the sheet admitting incompleteness:
  //
  //   engine      - review-sheet declines to compute something that WILL be in
  //                 the deployed file and could in principle be computed (a
  //                 loop, an expression, an unresolved project variable). This
  //                 is a gap, and it is what the panel warns about.
  //   deploy-time - a variable the TOOLCHAIN injects when it writes the file
  //                 (Ansible's `ansible_managed` and the template module's
  //                 `template_*` set). No file the sheet could be pointed at
  //                 holds it; nothing is missing and nothing is wrong.
  //
  // Deliberately narrow: an unresolved variable is benign only when the recipe
  // has DECLARED it toolchain-injected. A typo'd name, or a vars file the sheet
  // was never pointed at, is exactly the mis-wired-sheet case that must not go
  // quiet.
  cause?: "engine" | "deploy-time";
};

// A whole deployed file, as this document says it will be, for one or more
// instances.
//
// It is a PREVIEW and is labelled as one — never "the deployed file". review-
// sheet runs no toolchain: it renders the template with its own substitution
// engine, the same one that produces every artifact row's value. That engine
// covers a plain `{{ var }}`, the pure filters and a plain `{% if variable %}`,
// and REPORTS everything else, which is what `unrendered` lines are.
//
// It exists because a value cannot be judged alone. `StartServers 2` is right
// or wrong depending on the `<IfModule mpm_event_module>` around it, and a
// container is not a row — it has no value, no definition site and nothing to
// review. Putting the file beside the sheet answers that without pretending a
// structural line is a parameter.
export type ArtifactPreview = {
  // Stable identity of ONE PREVIEWED FILE: `<sheet>::<component>`, or
  // `<sheet>` when the sheet has no components, optionally followed by
  // `::<file>` (see `previewId` in preview.ts) when a sheet/component has more
  // than one file to preview.
  //
  // Instance variants of the SAME file share an id — the viewer renders those
  // as tabs (`ArtifactPanel`'s `mine`/`mine.length > 1`). Two DIFFERENT files
  // must never share an id, even when they belong to the same sheet and
  // component: a Terraform module's rows span `main.tf`, `variables.tf`, …,
  // and giving them one id would render unrelated files as bogus "instance"
  // tabs of each other. The viewer's row->preview index
  // (`artifactIndex`/`artifactFor` in app.ts) already maps `(sheet, component,
  // key) -> id` per LINE, not per preview, so a row routes to whichever file
  // actually holds its line — no viewer logic had to change for this contract,
  // only the producers had to stop assuming one file per sheet/component.
  id: string;
  sheet: string;
  component?: string;
  // Where the file LANDS on the host, and where it is written HERE. The same
  // pair `Sheet.file_path`/`Sheet.source_file` makes, per component. A
  // `nature: "source"` preview has no deployed counterpart, so this is absent.
  deployed_path?: string;
  source_file: string;
  // Which instances share this exact rendering. Identical renderings are
  // emitted once and listed together, since most files do not differ at all
  // between environments and three copies of one file is three times the
  // reading for no information.
  instances?: string[];
  // What kind of file this is, for the header's claim ONLY — default
  // "artifact" (this doc's title comment: "a whole deployed file, as this
  // document says it will be"). "source" is the AUTHORED file the deployed
  // artifact was derived from (a Terraform module's `.tf`, not the plan/state
  // it produces) — never rendered/deployed itself, so the panel must not say
  // "Rendered from" over it (`t.artifactSourceFile` instead of
  // `t.artifactRenderedFrom`; see app.ts's `ArtifactPanel`).
  //
  // Changes nothing else: not indexing (`artifactIndex` is line-keyed
  // regardless), not gap counting (`unrendered`/`absent` mean the same thing
  // either way), not review scope. A source preview is simply all-`verbatim`
  // in practice, since there is no substitution engine standing between the
  // authored text and what is shown.
  nature?: "artifact" | "source";
  lines: ArtifactLine[];
};

export type SheetGroup = {
  // Identity, referenced by each sheet's `group`. Same split as everywhere
  // else: this never moves, `label` is what a reader sees.
  name: string;
  label?: LangText;
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
  // Carried per version, like `columns`: a snapshot's grouping describes THAT
  // snapshot's sheets, and a regrouping between two revisions is a real change
  // the older document must not be redrawn with.
  groups?: SheetGroup[];
  sheets: Sheet[];
  // Carried per version for the same reason `columns` and `groups` are: a
  // snapshot's artifacts are THAT snapshot's files, and a template that changed
  // between two revisions must not be redrawn under the older document.
  artifacts?: ArtifactPreview[];
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
  // Identity. Every reference to a sheet is this string: build.yml's `name`,
  // sheet.yml's `sheets:` key, a review target, a diff's sheet key, the CLI's
  // messages. It must not move, and it must not be a language.
  name: string;
  // Display text, when the identity is not what a reader should see. Falls back
  // to `name`, resolved per language by the viewer like every other LangText —
  // the same split `Category.label` makes, and for the same reason: a sheet can
  // be called "OS 設定" in Japanese and "OS baseline" in English while both
  // builds produce the SAME review targets, and a wording can be fixed without
  // invalidating a review already in progress.
  label?: LangText;
  // Which group this sheet is read under (ParameterSheetInput.groups). Absent
  // = ungrouped, which is every document that declares no groups at all and is
  // what keeps a flat sheet set flat.
  group?: string;
  // This sheet's components are several of the SAME kind of thing, so reading
  // them side by side answers a question — where do they differ?
  //
  // Declared, never inferred. Having several components does not mean they are
  // comparable: four AWS resource types, ten httpd modules and three rendered
  // artifacts of one product are all components, and none of them line up. A
  // count of shared rows can only guess at where the line is, and the person
  // who wrote the sheet already knows.
  // `true` opens stacked with a toggle to the side-by-side reading; `"always"`
  // opens side by side and offers no toggle, for a sheet that exists only to
  // compare — there is nothing to go back TO. Declared either way, for the
  // reason above: the sheet is written by someone who already knows.
  compare_components?: boolean | "always";
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
  // This sheet is a DOCUMENT, not a table: prose that belongs beside the
  // parameters — a migration policy, an acceptance procedure, the diagram the
  // rows are read against. `categories` is empty for one, and only for one.
  //
  // Already HTML, and already carrying its images as data URIs, because the
  // model is the point at which this tool stops depending on the files around
  // it (see cli.ts's `findBakedSecrets` comment). A path here would mean
  // `generate` had to read the filesystem and that a model was only as good as
  // the checkout it came from.
  document?: SheetDocument;
};

export type SheetDocument = {
  html: string;
  // The headings the outline lists — already filtered by the build's declared
  // depth, so the model states what the navigation IS rather than restating a
  // rule the viewer would apply again and could apply differently.
  headings?: DocumentHeading[];
};

export type DocumentHeading = {
  level: number;
  text: string;
  // Baked into the HTML above; resolved with getElementById, like a category
  // anchor.
  id: string;
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
// per-environment; `default` = the PRODUCT's own default, i.e. our authored
// sources set nothing at all.
//
// This is a WHO-DECIDED taxonomy, not an evidence-channel one, and `default`
// covers two evidence channels that both mean "not us": the documented
// default (no `source` at all — the row exists so the sheet can be the
// exhaustive ledger of the product's parameters), and a value OBSERVED in a
// generated artifact (`source.generated: true` — e.g. a Terraform plan's
// `change.after`, which reports a value the author wrote and one the provider
// defaulted identically; nothing in the project's own source states it, so
// the provider decided, which is `default` by the same rule). There is no
// separate origin for the second case: `SourceLocation.generated` already
// says "observed, not authored", and a fifth Origin value would only restate
// what that field says. What must NOT happen either way is what makes the two
// one value instead of two: **a `default` row never carries a location in a
// file we author** — no `source` at all, or a `source` whose `generated` is
// true, checked in validate.ts (findDefaultOriginErrors).
//
// `baseline` IS a fifth value, where the generated-artifact case above
// deliberately was not, and the difference is what earns it the slot: a
// generated-artifact `default` row has the SAME decider as every other
// `default` (the product) and differs from the documented case only in which
// evidence channel observed it — restating that in a second Origin would say
// nothing `source.generated` does not already say. `baseline` has a DIFFERENT
// decider (the distribution's packager, not the product) and a different
// meaning for the row: the value is not merely undeclared by us, it is not in
// effect ANYWHERE — no line of the deployed artifact holds it. See the
// ansible recipe's `baseline:` (rows: artifact only) and `ParameterBase.
// baseline` below. Like `default`, a `baseline` row never carries a `source`
// — nothing in our files holds it, checked in validate.ts
// (findBaselineOriginErrors) — but unlike `default` it has no evidence-channel
// exception: a baseline row's absence from our files is the whole fact, not
// one of two ways of expressing it.
//
// Optional in the model — when absent it is derived (see `effectiveOrigin` in
// prompt.ts): `instances` present -> "overlay", else "common". `embedded`,
// `default` and `baseline` must always be set explicitly; none of the three is
// ever inferred.
//
// Origin says where a value comes from, never whether it is in review scope:
// a `default` row is in scope like any other (that is the point of writing it
// down), until `out_of_scope` says otherwise.
export type Origin = "overlay" | "common" | "embedded" | "default" | "baseline";

export type Category = {
  // IDENTITY, not display text. It is what `sheet::category::param` is keyed by
  // (prompt.ts's source index, every ReviewTarget, every apply target, the
  // viewer's anchors), so it must not move: renaming a category re-points every
  // pending review at nothing.
  //
  // For almost every category this is also what a reader sees, because the name
  // is a language-independent constant either way — a literal the project wrote
  // in sheet.yml, or a product's own group ("Write-Ahead Log"). `label` exists
  // for the one case where it cannot be: a component, whose name a project
  // writes in both languages.
  name: string;
  // Display text, when it differs from the identity. Falls back to `name`.
  //
  // A LangText, and switched live by the viewer like `description`/`remarks` —
  // which is precisely what `name` must never be. Splitting them is what lets a
  // component be called "Keycloak DB" in Japanese and "Keycloak database" in
  // English while both builds produce the SAME review targets, and what lets
  // someone fix a wording without invalidating a review already in progress.
  label?: LangText;
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
  // IDENTITY. verify/apply resolve a row by it, every review target names it,
  // and it is what the configuration file actually calls this setting.
  key: string;
  // What the PRODUCT calls it where a human meets it — a Keycloak admin-console
  // label. Display only, filled by enrich from the bound dictionary, and never
  // a substitute for the key: a reviewer needs both, one to recognise the
  // setting and one to find it in the file.
  label?: LangText;
  description?: LangText;
  default?: string;
  // The values this setting may take, with the product's own name for each —
  // see ParamOption. Filled by enrich from the bound dictionary, and a
  // FIRST-CLASS field rather than an `extra` entry precisely because the label
  // is LangText: `extra` is a Record<string, string> baked at generate time,
  // so a label routed through it could never follow the viewer's language
  // toggle the way description and remarks do.
  options?: ParamOption[];
  // This value is a credential. Set by whoever knows: a product that declares
  // it (a Keycloak component's ProviderConfigProperty says `secret`), or the
  // project, for the far more common case where the product says nothing —
  // measured, Keycloak's SERVER option registry has no such notion at all, so
  // `https-key-store-password` is indistinguishable from `http-port` to it.
  //
  // NOT a display flag. The viewer does not mask it, deliberately: the value
  // is in the generated HTML either way, and hiding it on screen would sell a
  // safety the file does not have. What it drives is a check at generate time
  // — see `findBakedSecrets` (secrets.ts) — that a sheet about to be handed
  // around does not carry a literal where it should carry a reference.
  secret?: boolean;
  // What the vendor's SHIPPED file gives this key — not `default` (what the
  // PRODUCT documents) and genuinely not the same value: measured, a
  // dictionary built from httpd's own branch documentation says `ServerRoot`
  // defaults to `/usr/local/apache`, while the RHEL package compiles in
  // `/etc/httpd`. `default` answers "what does the product say"; `baseline`
  // answers "what did THIS DISTRIBUTION actually ship" — see the ansible
  // recipe's `baseline:` (rows: artifact only, module doc) for how this gets
  // filled in, and `Origin`'s comment for the `"baseline"` origin value a row
  // gets when the vendor shipped the key and this deliverable does not have it
  // at all (as opposed to a row we DO have, where `baseline` sits beside a
  // real `value` for comparison).
  baseline?: string;
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
  // The base format this location must be READ with, when the file name cannot
  // say it. Extraction is told the format by the spec; verify/apply resolve
  // their parser from the file, so a force-only format like `space` — never
  // detected, by design — would be written by one parser and read by another.
  // Set only where a format was DECLARED; detection covers everything else.
  baseFormat?: string;
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
  // This row's value is the ARTIFACT's line, composed by substituting the
  // value at this site into a template's text — `CustomLog "{{ x }}" proxied`
  // becomes `CustomLog "/var/log/httpd/access_log" proxied`, of which this site
  // holds only the path. See the ansible recipe's `rows: artifact`.
  //
  // The relation is therefore containment in the OTHER direction from `ref`:
  // there the site holds a reference to the value, here the site holds a PART
  // of it. verify checks that what the site says still appears in the row;
  // apply holds, because writing back means deciding which part of the line the
  // reviewer meant to change, and getting that wrong edits a template.
  substituted?: boolean;
};

export type ColumnDefinition = {
  field: string;
  header: string;
  // The same heading as a LangText, when the declaration had one. `header` is
  // the English string every existing consumer reads; this is what lets the
  // viewer print the heading in the reader's own language — an under_key
  // sub-line is unreadable without it, since the value alone ("Env var" vs the
  // row's own key) is two identifiers with no way to tell which is which.
  header_lang?: LangText;
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
  // Who made this entry and when. Only meaningful for edits made in the
  // generated HTML (`status: "applied"`), where the list of items IS the
  // history: an edit never rewrites an earlier one, it appends. Both are
  // self-declared by whoever had the file open -- there is no identity in a
  // standalone HTML -- so they are a record of intent, not an audit trail.
  at?: string;          // ISO 8601, from the editor's own clock
  by?: string;          // free text; empty when nobody typed a name
  // This edit BRINGS A ROW INTO EXISTENCE: `target.param` names a key the
  // generated document does not have. Declared rather than inferred from "the
  // target does not resolve" — that reading would silently resurrect a row a
  // later regeneration deliberately removed.
  creates?: boolean;
  // This entry marks the row as no longer set (`true`) or puts it back
  // (`false`). BOTH directions are recorded — deleting a row and restoring it
  // months later are two decisions, and the second does not erase the first.
  // The newest entry that states either one decides. The row is never removed
  // from the sheet: it is struck through, because a parameter that silently
  // disappears is the failure this whole tool exists to prevent.
  deletes?: boolean;
};

// One save of the document, by whoever was maintaining it.
//
// The per-cell history answers "why is this value what it is" — but only for
// someone who already suspects that cell. This answers "what has happened to
// this system", which is the question asked months later, and it is the only
// place a REASON can live: a timestamp cannot carry one.
export type SaveRecord = {
  at: string;            // ISO 8601, from the editor's own clock
  by?: string;           // self-declared; blank is allowed
  comment?: string;      // why, in the author's words
  changes: number;       // how many entries this save added
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
  // Which language this text was written in, for prose fields (`remarks`)
  // edited in the generated HTML. Shown in the other language the edit does not
  // apply, so a note written in one language never stands in for a translation
  // that was never made. Absent on value changes, which have no language.
  lang?: "ja" | "en";
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
  // Let whoever maintains the sheet edit values and remarks in the generated
  // HTML. Edits are appended as `applied` review items over the baseline, never
  // written into the rows themselves, so the original value always survives.
  edit?: boolean;
  // Offer the AI prompt (the change requests, ready to hand to an assistant).
  // Separate from the mode because it is a judgement about the AUDIENCE:
  // whoever maintains a sheet may have no use for it, or no wish to be
  // offered one. Defaults to true, which is how it behaved before it could be
  // turned off.
  prompt?: boolean;
};
