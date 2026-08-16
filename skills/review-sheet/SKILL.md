---
name: review-sheet
description: >-
  Build a review-sheet input.json from existing configuration files with
  accurate source maps, verify those maps against the real files, generate the
  reviewable HTML, and apply a review.json back to configuration with the
  review-sheet CLI. Use when turning config files into a parameter sheet, or when
  applying reviewer-approved value changes.
---

# review-sheet

`review-sheet` turns a JSON description of configuration parameters into a
single self-contained HTML sheet that reviewers annotate in the browser. Their
feedback is exported as `review.json`, which is then applied back to the real
configuration files.

The key idea is the **source map**: each value can record exactly where it lives
in the real config (`file` + `line` + `anchor`). Accurate source maps let the
`apply` command change the right line deterministically, with no AI guesswork.

## CLI

```sh
review-sheet import   -f conf1 -f conf2 -o input.json  # draft a model (with source maps) from config files
review-sheet import   --spec review-sheet/build.yml   # build it from a declarative spec (recipes + enrichment)
review-sheet generate -i input.json -o sheet.html   # build the HTML sheet
review-sheet generate -i input.json --no-review -o sheet.html  # delivery copy
review-sheet validate -i input.json                 # validate input (schema)
review-sheet validate -i review.json -s review      # validate a review export
review-sheet verify   -i input.json                 # check source maps against the real files
review-sheet apply    -i input.json -r review.json  # preview config edits (dry-run)
review-sheet apply    -i input.json -r review.json --write        # write them
review-sheet apply    -i input.json -r review.json --emit-prompt  # prompt for the rest
review-sheet diff     -i reviewed.json -i input.json # what changed since the reviewed revision
review-sheet serve    -i input.json                 # localhost UI that applies edits directly to local files
```

## Generating input.json from existing files

This is the main job: turn real configuration into `input.json` with accurate
source maps. Most real config is just text with one assignment per line, so
treat it generically: scan the files, extract assignments, and record where each
one is.

**Start with `review-sheet import` when the files are a recognised format.** It
extracts a draft model deterministically — exact line numbers and anchors — for
line-oriented formats (`key = value`, `key: value`, space-delimited),
`.properties`/`.env`/`.ini` (sections become categories), and YAML/JSON (nested
leaves get a `path`). One sheet per file:

```sh
review-sheet import -f /etc/sysctl.conf -f /etc/app/config.yaml -o input.json
review-sheet import -f sshd_config --format space -o input.json   # force a format
review-sheet verify -i input.json                                 # confirm (should be all ok)
```

Then **refine the draft by hand / with judgement**: add `description`/`default`/
`remarks` (no `source` on those), merge the same key across environment files
into one Pattern B parameter (`instances[]`), drop noise, and improve grouping.
Re-run `verify` after edits.

Use the manual procedure below when `import` does not fit — bespoke or templated
formats (Jinja2, HCL `.tf`), or when you need a structure `import` cannot infer.

**The source map is separator-agnostic.** Apply and verify locate a value by its
`anchor` (a literal substring on the line) plus `line`, and edit by replacing the
value text — they assume nothing about the delimiter. So the same mechanism
covers `=`, `:`, space, or tab. Choose the anchor as "the key plus its
delimiter" so it pins the right line:

| Format style | example line | good anchor |
| --- | --- | --- |
| `key = value` (sysctl, ini, tfvars) | `net.core.somaxconn = 128` | `net.core.somaxconn =` |
| `key=value` (dotenv, properties) | `MAX_CONN=128` | `MAX_CONN=` |
| `key: value` (YAML, flat) | `port: 8080` | `port:` |
| space / tab (sshd_config, httpd) | `MaxClients 256` | `MaxClients ` |
| `"key": value` (JSON) | `"port": 8080,` | `"port":` |

Procedure:

1. **Discover the files.** Ask the user, or scan the repo, for the configuration
   files in scope (e.g. `*.conf`, `*.ini`, `*.env`, `*.properties`, `*.yaml`,
   `*.json`, `*.toml`, templates).
2. **Extract assignments.** For each assignment line, capture: the key, the
   current value, the **1-based line number**, and an **anchor** (the key plus
   its delimiter, per the table above). Read line numbers exactly; do not
   estimate.
3. **Build the structure.** Group into sheets/categories (one sheet per file or
   per logical component is a good default; use the file as `sheet.file_path`
   or `category.file_path`). Each assignment becomes a parameter with `value` and
   `source` ({ line, anchor }).
4. **Detect instances (Pattern B).** When the *same key* appears across several
   files (per host / per environment — e.g. `config.prod.yaml`,
   `config.dev.yaml`, or `host_vars/<host>.yml`), model it as one parameter with
   an `instances[]` entry per file, each carrying its own `source.file`.
5. **Fill documentation fields** (`description`, `default`, `remarks`) from
   comments or your knowledge — but give them **no `source`** (they are not in
   the deployed config).
   - **Multilingual prose.** `description` and `remarks` accept either a plain
     string or a `{ en, ja }` language map; the viewer resolves the language at
     display time, so the in-page language toggle switches the text live. Write
     the map in **block style (one language per line)**, never flow style, so a
     single-language edit is a one-line diff and adding a language is a one-line
     append:

     ```yaml
     # good — line-oriented, git-friendly
     description:
       en: Seconds the server waits before failing a request.
       ja: リクエスト失敗と判断するまでの待機秒数。
     # avoid — flow style rewrites the whole line on any change
     description: { en: "Seconds the server waits…", ja: "リクエスト失敗…" }
     ```

     The same rule applies wherever this prose is authored: an inline
     `description`/`remarks` on a parameter, the **project metadata file**
     (`review-sheet/sheet.yml`), or a product **dictionary**
     (`metadata/<product>@<version>.yml`). Providers carry the full map through
     enrichment unchanged; a missing language falls back en → ja.
6. **Verify and self-correct.** Run `review-sheet validate -i input.json` then
   `review-sheet verify -i input.json`. Fix every `FAIL` (wrong line/anchor or a
   stale value) and review each `WARN` (ambiguous anchor → make it more
   specific). Re-run until clean. This loop is what makes a generated source map
   trustworthy.

### Nested formats (YAML / JSON) — use `path`

For YAML and JSON, set `source.path` (`$.services.web.port`, dotted, or
`hosts[0]`). When line + anchor cannot isolate the value, `apply` and `verify`
fall back to a **structural edit**: they parse the file and replace exactly the
scalar at that path, preserving all surrounding formatting and comments. This
covers the cases a line + anchor cannot:

- A leaf key that repeats under different parents (several `port:` lines) —
  `path` selects the right one. (`line` + value also disambiguates when the
  values differ; `path` is the robust choice when they do not.)
- **Minified / single-line JSON** — the whole document is one line, so a
  line + anchor cannot isolate a value, but `path` can.

So for nested YAML/JSON, prefer giving `path` (a `line` + `anchor` is still fine
when the leaf is unambiguous). `verify` reports `ok` via either route.

### What to leave unmapped

A few values still cannot be edited deterministically. Give these **no
`source`** (or only a `file`) so `apply` defers them to the AI prompt:

- YAML block scalars (`|`, `>`) and values whose text spans multiple lines
  (an array/object taken as a whole rather than a scalar leaf inside it).

`verify` marks these `unmapped` (not an error) — the signal that they are
intentionally handed to the prompt rather than applied deterministically.

### Display path vs. source file (`source_file`)

When the file you **display** differs from the file you **edit** — the classic
templated-IaC case, where the sheet should show the deployed path
(`/opt/keycloak/conf/keycloak.conf`) but `verify`/`apply` must act on a local
source (`roles/keycloak/defaults/main.yml` or a `group_vars` file) — set
`source_file` on the sheet or category. It is the default source for `verify`/
`apply`, kept separate from the display `file_path`:

```jsonc
{
  "name": "/opt/keycloak/conf/keycloak.conf",
  "file_path": "/opt/keycloak/conf/keycloak.conf",   // shown in the HTML (deployed path)
  "source_file": "roles/keycloak/defaults/main.yml",  // verify/apply target (local)
  "params": [
    { "key": "hostname", "value": "sso.example.co.jp",
      "source": { "line": 64, "anchor": "keycloak_hostname:", "path": "keycloak_hostname" } },
    { "key": "db-url", "value": "jdbc:postgresql://…",
      "source": { "file": "inventories/production/group_vars/app_servers.yml",  // overrides source_file
                  "line": 8, "anchor": "keycloak_db_url:", "path": "keycloak_db_url" } }
  ]
}
```

Resolution order for the file a value is verified/applied against:

1. the value's own `source.file`, else
2. the nearest `source_file` (category, then sheet), else
3. the nearest `file_path` (category, then sheet) — **backward compatible**: with
   no `source_file`, `file_path` is still used as the source, exactly as before.

**MUST**: whenever `file_path` is a **deployed** path — one that exists on the
managed host, not in your repository — set `source_file` on the same node. The
resolution chain falls back to `file_path` for any value with no `source.file`
of its own, so without `source_file` a machine that happens to have the real
file would have `verify` read `/etc/nginx/nginx.conf` from the reviewer's own
system, and `serve --write` could edit it. The built-in `ansible` recipe
enforces this by construction: declaring `deployed_path` sets both fields
together.

So `source_file` only changes behaviour when you set it; existing models are
unaffected.

### One value defined in several files (`additional_sources`)

When the **same value** is duplicated across files and every copy must change
together — the Ansible case where a variable is set in `defaults/main.yml` and
overridden in several `group_vars` files — list the extra sites in
`additional_sources` (an array of the same `source` shape) on a simple
parameter:

```jsonc
{
  "key": "db-url",
  "value": "jdbc:postgresql://db:5432/keycloak?socketTimeout=50",
  "source": { "file": "roles/keycloak/defaults/main.yml", "line": 104, "anchor": "keycloak_db_url:", "path": "keycloak_db_url" },
  "additional_sources": [
    { "file": "inventories/production/group_vars/app_servers.yml",  "anchor": "keycloak_db_url:", "path": "keycloak_db_url" },
    { "file": "inventories/development/group_vars/app_servers.yml", "anchor": "keycloak_db_url:", "path": "keycloak_db_url" }
  ]
}
```

`apply` edits the primary `source` **and** each additional site (the change is
held for the AI prompt if any one site cannot be applied); `verify` checks every
site independently; the AI prompt lists the extra sites under the change. A
site's `file` may be omitted to inherit the same fallback as the primary.

Use this **only when the value is identical** across the files. The single
`current → suggested` applies to every site, so if one file actually holds a
different value, that site is reported as a `FAIL`/held (never silently
mis-edited) — fix it by hand or drop it from the list. For genuinely different
per-environment values, use `instances[]` (Pattern B), not `additional_sources`.
This rule — and the "on a simple parameter" restriction above — is about entries
with no `ref`; see below for the other kind.

#### The other kind of site: a *reference*, not a duplicate (`source.ref`)

An `additional_sources` entry can instead mark a **reference site**: a place
that holds a *reference expression* pointing at this parameter's value (e.g.
`$(env:SSO_SESSION_IDLE_TIMEOUT)`), not the value itself. Set `source.ref` to
that literal expression. This is what `layered`'s
["Reference substitution in `static_files`"](#reference-substitution-in-static_files-substitution)
declaration produces automatically — you'd rarely hand-author one — but the
model shape is worth knowing either way:

```jsonc
{
  "key": "ssoSessionIdleTimeout",
  "value": "1800",
  "source": { "file": "envs/production.env", "line": 12, "anchor": "SSO_SESSION_IDLE_TIMEOUT=" },
  "additional_sources": [
    { "file": "config/keycloak/poc.yml", "path": "ssoSessionIdleTimeout",
      "anchor": "$(env:SSO_SESSION_IDLE_TIMEOUT)", "ref": "$(env:SSO_SESSION_IDLE_TIMEOUT)" }
  ]
}
```

`ref` changes what both checks mean:

- **`verify`** requires the resolved value to **contain** `ref`, not equal it
  — equality is just the whole-value special case of containment (a composed
  site like `https://$(env:SSO_SAML_HOST)/saml/acs` never equals the bare
  reference text, only contains it). A mismatch is reported as `reference
  "$(env:X)" no longer present — value hardcoded or wiring changed?` rather
  than "stale value" — someone hardcoded the value into the reference site,
  renamed the variable, or deleted the line, and the sheet's "this field is
  fed by this variable" claim is now false.
- **`apply` never writes a `ref` site.** It's filtered out of the edit
  targets entirely — not held, not reported as skipped: writing the
  suggested value there would corrupt the file, so it was never an edit
  target to begin with.
- **The AI prompt** renders `ref` entries separately from ordinary
  additional sources, as context rather than something to edit: "Referenced
  from `<file>:<line>` (`` `<ref text>` ``) — edit only the variable
  definition unless the wiring itself is being changed."

`ref` entries are valid on **both** parameter shapes — `additional_sources`
lives on `ParameterBase`, not just `SimpleParameter`, precisely so a Pattern B
(`instances`) row can carry one too (a merged `substitution:` row usually is
Pattern B). A **non**-`ref` entry stays valid only on a `SimpleParameter`,
since "the same value, defined again elsewhere" is meaningless without a
single `value` to compare it against — schema-enforced, not just convention.

### Out-of-scope parameters (`out_of_scope`)

`out_of_scope` is a **review-remit boundary** — "this is deliberately not part
of *this* review, here's why (and who owns it instead)" — not a statement about
*how* the value is set. Use it for parts of the sheet another team owns, an
OS baseline, a secret managed elsewhere, … **Never** set it just because a
value happens to be a literal baked into source rather than a variable — those
are `origin: embedded` (below) and stay in scope.

Set `out_of_scope` to an **object** with a mandatory `reason` (why it's
excluded — reason-less exclusion fails validation) and an optional `owner` (who
owns it instead), on a **category** (covers it and all descendants) or a single
**parameter**:

```jsonc
{ "name": "/etc/resolv.conf",
  "out_of_scope": { "reason": "Owned by the networking team — not in this review's scope", "owner": "Networking team" },
  "params": [ { "key": "nameserver", "value": "172.24.254.101" } ] }
```

Effect: the HTML greys these out (with the reason/owner) and offers a hide/show
toggle; `verify` reports them as `out_of_scope` (a distinct status, not
`unmapped`); `apply` skips them outright — not held, and never emitted to the AI
prompt. Use this instead of an `extra` flag for "documented but not in scope".

**Breaking change:** `out_of_scope` used to be a plain boolean flag, paired with
a separate `_reason` string field alongside it; both forms are retired and no
longer validate. Migrate the old boolean-plus-separate-reason-field pair to the
single object form shown above (`{ reason, owner? }`).

### Where a value comes from (`origin`)

`origin` records *how* a parameter's value is set — display/grouping metadata,
not a scope gate (see `out_of_scope` above for that). All three values are
**in review scope**:

- `overlay` — set per-environment via a variable (Pattern B: the parameter has
  `instances`).
- `common` — set via a variable, with one value shared across every
  environment (Pattern A: a plain `value`, no `instances`).
- `embedded` — a literal written directly into the deployable source itself
  (a template literal, a hardcoded module argument, …). Changing it is a code
  change/PR rather than a config edit — but it is still an ordinary,
  reviewable parameter: file it in its normal functional category and give it
  a `description` like any other parameter, not a separate "fixed"/mechanism
  category.

`origin` is optional. When omitted it is **derived** (`effectiveOrigin()` in
`src/prompt.ts`): a parameter with `instances` is `overlay`, otherwise
`common`. `embedded` is **never** inferred — set it explicitly whenever a value
lives in source code rather than in a variable/config file:

```jsonc
{ "key": "connection-timeout-ms", "value": "30000", "origin": "embedded",
  "description": "Hard-coded in DbClient.java:42 — changing it is a code PR, not a config edit." }
```

This replaces the retired two-layer "tunable vs fixed" model, where embedded
literals were filed under a separate out-of-scope "Fixed configuration"
category. There is no such category anymore: embedded values are ordinary
in-scope parameters, distinguished only by `origin`.

### Apply-ability (`source.generated`, sheet `capabilities.apply`)

Whether a value can be applied automatically is **derived**, not authored: a
parameter is apply-able iff it has a `source` and that source's `generated`
field is not `true`. Set `source.generated: true` when the value lives in a
generated artifact (a CDK synth template, a rendered Terraform plan, an
imperative-IaC "Option 2" import — see below) that should never be edited
directly; `verify`/`apply` still resolve it, but `apply` treats it like a held
item (deferred to the AI prompt instead of writing the generated file). A whole
sheet (or version) can disable direct apply entirely with
`capabilities: { apply: false }` — e.g. a read-only synth-import sheet. This
distinction only affects the apply UI/CLI; the reading table shows every value
the same way regardless of apply-ability.

Tool-specific notes (still just the generic approach underneath):

- **Ansible**: `group_vars/<group>.yml` and `host_vars/<host>.yml` are
  `key: value` YAML → Pattern B with instance = group/host, `source.file` = that
  file. The editable source of a templated value is the **variable file**, not
  the `.j2` — point `source` (or the category `source_file`) at the
  `group_vars`/`defaults` YAML, and let the category's `file_path` show the
  deployed path (see `source_file` above). A `defaults/main.yml` value you may
  actually change is a live value (give it a `source`), not just the `default`
  doc field.
  - To map a config key to its Ansible variable mechanically, use
    `resolveTemplateVars(templateFile, [group_vars…, defaults], readFile)` (above):
    it parses the `.j2` (the `jinja2` parser records `templateVar` / `conditional`)
    and returns each entry with a `resolvedSource` pointing at the variable file
    that defines it (or the template, for a literal). Pass the variable files in
    precedence order (group_vars before defaults). The template itself is
    structure, not the apply target.
- **Terraform**: per-environment `*.tfvars` are simple `key = value` → Pattern B
  by environment. Resource arguments live in `*.tf` (HCL); record their line and
  an anchor (the argument name) as usual.
- **Imperative IaC (AWS CDK, Pulumi, CDKTF)**: the program (TypeScript/Python/…)
  is *not* a config file. There are **two ways** to review it — pick by whether you
  can edit the source and whether the reviewable values exist as literals.

  **Option 1 — in-source `@rs` annotations** (editable; writes back to the program).
  Add `@rs` comments to the values you want reviewed in the real `.ts`/`.tsx`/`.py`
  source (the `ts` / `py` parsers); `import` curates to just those, the key is the
  code property name, the value is the verbatim RHS expression, and `apply` / `serve`
  edit the **source program** in place (re-parsed to reject broken syntax). Carries
  `description`/`default`/`remarks` inline (no separate authoring) and supports
  per-environment Pattern B via `@rs:config instance:`. See `formats/ts.md`,
  `formats/py.md`, and `spec/annotation.md`.
  - **Good when**: you own the source; the knobs are literals or live in a config
    module / per-env files; you want a true edit loop on the real code.
  - **Limits**: requires editing the program (not for third-party code); only values
    that exist as literals/expressions can be mapped — computed values (loops, props
    passed in, context lookups, intrinsic refs) have no single editable scalar;
    reviewers see source expressions (`Duration.seconds(30)`), not the resolved value.

  **Option 2 — review the synthesized declarative artifact** (read-only record of the
  deployed values). Synthesize to plain YAML/JSON the existing parsers handle, then
  `review-sheet import -f <artifact> -o input.json`:
  - **AWS CDK** → `cdk synth > template.yaml` (or `cdk.out/<Stack>.template.json`).
  - **CDKTF** → `cdktf synth` → `cdktf.out/stacks/<name>/cdk.tf.json`.
  - **Pulumi** → `pulumi stack export` / `pulumi preview --json`.
  - **Good when**: values are computed/dynamic with no source literal; you can't edit
    the program; you need the **actual resolved/deployed** values (after the
    framework's defaults and transforms).
  - **Limits**: read/review only — the artifact is regenerated, so `apply` edits to it
    are lost on the next `synth` (change the source by hand); noisy (logical IDs,
    `Ref`/`Fn::` intrinsics, tokens, no curation); needs a working synth toolchain.
  - **For more than one environment, use the `snapshot` recipe** (`import --spec`)
    instead of one `import -f` per artifact: `snapshots: { <instance>: <artifact> }`
    turns one artifact per environment into a single sheet where every parameter is
    Pattern B (keyed by structural path), an artifact missing a key gives that
    environment a blank cell, and `include`/`exclude` path globs (`*` within a
    segment, `**` across) cut the artifact down to the reviewable subset. Every
    value is marked `source.generated`, so `apply` holds it instead of editing a
    file the next `synth` overwrites — pair it with `capabilities: { apply: false }`.
    Recipes never execute a toolchain: render the artifacts yourself and commit
    them (or render in CI right before `import`). See `examples/cdk-snapshot/`.

  They are **complementary**: annotate the curated, editable knobs **and** keep a synth
  import as a record of what actually deploys, if you want both.

### When `import` is not enough: the ladder

Reach for the **least amount of code that fits**, and stop at the first rung
that does. Each rung reuses the one above it, so moving down costs a few lines,
not a rewrite — the mistake to avoid is jumping straight to Level 3.

**Level 0 — `import -f <file>...`** (no code, no config). One or more standalone
files, one sheet per file. Good for a handful of config files with no project
structure and no per-environment layering.

**Level 1 — `import --spec build.yml`** (declarative, no code). A **recipe**
turns YAML into a sheet. Check the built-ins before writing anything:
- `ansible` — **base + per-instance overlays**, which is all it requires: one
  file of shared values and one per instance that overrides them. Nothing in
  that shape is Ansible-specific, so use it for any layered file set — Terraform
  `.tfvars` per workspace, an `envs/*.env` per environment — and ignore the
  Ansible-flavoured extras. Those extras are what the name is about and are all
  optional: a Jinja2 `template` to render through, and `static_files`. A
  `template`'s row NAMING is derived per row, not declared — see "How a
  template row gets its name" below. Add
  `deployed_path: /etc/nginx/nginx.conf` (the task's `dest:`) so the sheet shows
  where the configuration LANDS — what an operator reviewing middleware
  parameters looks for — while keeping the template as the sheet's
  `source_file`. Declared, never inferred: a task's `dest` is often a variable
  expression, and a wrongly inferred path displayed as fact is worse than none.
  See `examples/ansible-*/review-sheet/build.yml`.
- `snapshot` — the per-environment divergence lives in program logic (CDK
  `if (stage)`, Terraform conditionals), so the only per-environment values are
  the artifacts the tool renders, one per environment. See
  `examples/cdk-snapshot/review-sheet/build.yml`.
- `layered` — the same base+overlay engine `ansible` wraps, minus the
  Ansible-only extras (no `template`, no `deployed_path` — so every row keeps
  its extracted identity as its key by default; there is nothing in the
  layering itself to derive a product key FROM). The one exception is a
  `static_files` entry's own opt-in `substitution:` declaration, which CAN
  produce a `keyMap` entry — see "Reference substitution in `static_files`"
  below. Use `layered` directly whenever the layering has nothing Ansible
  about it at all — a plain `.env` base + per-environment overrides, a
  Terraform root module's `variables.tf` + per-environment `.tfvars`, a
  container image's Dockerfile + task definition. `recipe: ansible` on such a
  sheet still works, it just reads oddly. Accepts `defaults` / `overlays` /
  `static_files` / `include` / `exclude` / a per-source `key` transform, same
  as `ansible`'s own base+overlay half.

#### How a template row gets its name

There is no `keying:` setting to write — a row's name is derived, per row, not
declared per sheet:

| template content | row name |
|---|---|
| bare literal (no `{{ var }}`) | the directive's own key (`origin: "embedded"`, as always) |
| `{{ var }}` backing **exactly one** directive | the directive's key (the product's own name for it); the variable is still recorded, surfaced via the sheet's `under_key` column |
| `{{ var }}` backing **more than one** directive | the variable's own name — no single directive can legitimately claim the row (e.g. httpd's `ProxyPass`/`ProxyPassReverse` pair sharing one backend variable). Reported, never decided silently. |
| a `defaults` variable the template never references at all (including one used only inside a Jinja `{% if %}` test, never interpolated), AND no overlay sets it either | the variable's own name — nothing else names it (this project's "never lose a row" rule: it would otherwise be completely invisible) |
| a `defaults` variable the template never references, but SOME overlay does set | the variable's own name, as a Pattern B row covering only the instances that set it — the ordinary "key seen only in overlays" case, unaffected by the template at all |
| no `template` at all | every row keeps its extracted identity — the same as every non-templated sheet |

The template, when there is one, is also the sheet's **column order** — not
`defaults`'s declaration order — since the template is the more legible map of
"what this config key means" for a reader reviewing the deployed file. A
`defaults` variable rescued because it would otherwise be invisible has no
natural position to take, so it is appended after every template-derived row,
in `defaults`'s own order.

`under_key` (sheet.yml) is required the moment ANY row in the sheet resolves
to a product key this way — nothing to declare if no row does.

This `{{ var }}` → `keyMap` binding is `ansible`'s own reference mechanism —
a template value that is a reference into `defaults`/overlays, recognized
from the template's parse tree. A `static_files` entry can carry the same
kind of reference (a value that is a reference into the sheet's OTHER
layers, e.g. keycloak-config-cli's `$(env:X)`), but recognized from the
value's *text* instead — that is `substitution:`, and it is **`layered`-only**
(not available on `ansible` sheets): see "Reference substitution in
`static_files`" below for why and what to do if you hit its "unknown field"
error under an `ansible` sheet.

#### `defaults`/`overlays` vs. `static_files`: they key differently

Both `ansible` and `layered` read `defaults`/`overlays` and `static_files`,
but not into the same kind of key space, and picking the wrong one for a
given file is a silent-data-loss trap:

- `defaults`/`overlays` key each entry by its **extracted leaf name**
  (`Entry.key`) — a flat, variable-name-style key space. A format whose
  structure repeats a leaf name — a TOML `[[array-of-tables]]`, a JSON array
  of objects — collides: two entries land on the same key. `import --spec`
  refuses to build when that happens (a `key collision` error naming the
  colliding key and both entries' full structural paths — see below), rather
  than silently keeping only the later one.
- `static_files` keys each entry by its full **structural path**
  (`Entry.source.path`, falling back to the leaf name only for a format that
  has none) — reorder-robust and collision-free by construction. The
  resulting parameter is `origin: "embedded"` — "a literal written
  directly into the deployable source itself... changing it is a code
  change/PR rather than a config edit" (see "Where a value comes from"
  above) — unless the entry declares `origin: default` (below).

**Which one to reach for is a statement about the file, not a workaround for
a collision.** If the file *is* the deployed configuration — a rendered
`config.toml`, a `group_vars` YAML, anything a reviewer would edit to change
runtime behaviour — use `defaults`/`overlays`, even when its structure needs
a `key` transform to avoid a collision (below): `static_files` only *looks*
like the easy fix because it never collides, but it also relabels the value
as `embedded`, which is wrong for a file that IS live config. Reach for
`static_files` only when the value genuinely is baked into source — a
Dockerfile `ARG`, a literal the build compiles in. Mislabeling an ordinary
config edit as `embedded` misleads a reviewer about the actual review-remit
boundary and changes how `apply` treats it (an embedded value has no
`defaults`/`overlays`-style source map for `apply` to write through).

**Fixing a `defaults`/`overlays` collision**: give that source a per-file
`key` transform (`from: path`) that folds enough of the structural path into
the key to keep the colliding entries apart. A real example — the `fedlens`
spec, where TOML's `[[oidc]]` and `[[saml]]` both have a bare `base_url`
leaf:

```yaml
defaults:
  path: ../../local/fedlens/config.toml
  key:
    from: path
    steps:
      - pattern: '^oidc\[name=poc-oidc\]\.(.+)$'
        replace: 'oidc.$1'
      - pattern: '^saml\[name=poc-saml\]\.(.+)$'
        replace: 'saml.$1'
```

The collision error itself proposes a block shaped exactly like this
whenever the colliding entries' structural paths share a distinguishable
prefix — paste it in as the source's own `key:` field.

#### `component: { map: ... }` — assigning a row that no transform can reach

```yaml
component:
  map:
    SSO_LDAP_CORP_PASSWORD: corp-ldap
```

An environment variable feeding one member's field is not addressed as part of
the list, so nothing about its NAME derives the member. The fact is an
assignment, and writing an assignment as a regex (`^SSO_LDAP_CORP_PASSWORD$` ->
`corp-ldap`) only hides what it is.

The map is consulted on the row's own key and on its structural path, before any
`steps`, so it composes with a `split:` — the split files the members, the map
files the rows that feed them. An assignment naming a key no row produced is
reported, like every other declaration here that matches nothing.

#### `rows: artifact` — a row is a LINE of the deployed file

```yaml
- name: httpd reverse proxy
  recipe: ansible
  rows: artifact
  template: ../../roles/httpd/templates/httpd.conf.j2
  deployed_path: /etc/httpd/conf/httpd.conf
```

By default a template-driven sheet keys a row by the Ansible VARIABLE behind it.
That axis cannot represent two things the file plainly contains, and both were
measured on a real project by rendering its templates with real variables and
diffing the result against the sheet:

| the template says | the variable axis showed | why |
| --- | --- | --- |
| `CustomLog "{{ x }}" proxied` | the path only | the row is the variable, so the literal text around it has nowhere to go — the sheet could not answer "which access-log format" |
| `ProxyPass … {{ b }}…` and `ProxyPassReverse … {{ b }}…`, twice over | two rows named after the variables | one variable cannot honestly claim any single directive, so all four lines were dropped (it warns) |

`rows: artifact` puts the row on the file's own axis: keyed by the line's
structural path (`IfModule.StartServers`, `ProxyPass[1]` — the way the FILE
addresses it, which is also the only spelling that keeps two `<IfModule>` blocks
apart), valued at the line's text with each `{{ var }}` resolved, and with the
variable moved to the `under_key` column that already exists for it.

**`format:` when no name can say what the artifact is.** A template's format is
its DEPLOYED artifact's format, read from the template's own name and, failing
that, from `deployed_path`. Some formats no name can reach: `space`
(sshd_config's `Key value` grammar) is force-only by design, because nothing
about a file's name or content separates it from prose. Declare it — the same
field, spelled the same way, as `static_files[].format`:

```yaml
templates:
  - path: ../../roles/sso/templates/sshd_config.j2
    component: sshd_config
    deployed_path: /etc/ssh/sshd_config
    format: space
```

Without it the artifact falls to the `generic` parser, which looks for `=`/`:`,
finds none, and yields NO ROWS — the variable behind a line is rescued as a
plain variable row and a line with no variable in it disappears with nothing
said. A sheet of nothing but such lines builds clean and empty:
`verify: 0 ok, 0 warn, 0 error`. On the singular `template:`, declare `format:`
beside `deployed_path:` at the sheet level; declaring it there alongside
`templates:` is an error, since each entry deploys a different artifact. A
format naming no parser fails the build, listing the ones that exist.

**A line may interpolate several variables.** `db-url=jdbc:postgresql://{{ host
}}:5432/{{ name }}` is one row whose value is the rendered line. It points at
one of those variables' definition sites, marked `substituted` — which claims
only that the site's value is PART of the line, and that is true of every
variable in it. verify checks exactly that; apply holds, because which part of
a composed line a reviewer meant to change is not knowable. The `under_key`
column stays empty for such a row: naming it after one of several variables
would misrepresent the others.

**Only a plain `{{ var }}` and the pure filters (`lower`/`upper`/`trim`) are
substituted.** This is deliberately not a Jinja2 implementation: an expression,
an unknown filter or a name nothing defines is left exactly as written and
REPORTED. A partial engine that guessed would print a value that looks rendered
and is wrong, which is worse than admitting the line cannot be resolved — and
the report earns its keep: it is what caught a sheet reading the wrong variables
file, where the silent version would have shown `{{ keycloak_user }}` as a value.

Such a row's source is the VARIABLE's definition site, marked
`substituted: true`, which changes what the two cores do with it:

- **verify** checks CONTAINMENT — the site's value must still appear in the
  row's rendered line. (The mirror of a `ref` site, where the row's value must
  appear in the site.) A rename or a template change around the variable is
  reported as exactly that.
- **apply** HOLDS. The suggested value is a whole line, and deciding which part
  of it the reviewer meant is where a config edit turns into a template edit:
  `CustomLog "…" proxied` can be changed in the variable or in the template, and
  only a human can say which was meant.

Opt in per sheet. Existing sheets keep the variable axis, and switching one
re-keys the rows a variable used to stand for — a real change to that sheet's
review targets, which is why it is never automatic.

##### A directive with no argument is still a row

In a whitespace-delimited file (`format: space`) a lone directive — chrony's
`rtcsync`, sshd's bare keywords — IS a setting: the file says the thing by
naming it and says nothing by leaving it out. Such a line becomes a row valued
`true`.

```
rtcsync          ->  rtcsync = true
port 0           ->  port    = 0
```

Only for whitespace formats. In `key=value` (properties/dotenv/sysctl/ini/
generic) a line with no delimiter is prose or a typo, not a flag — and `generic`
is the fallback that matches every file there is, so inventing rows from it
would turn a README into a sheet.

Two consequences follow from the value being nowhere in the file:

- **verify** confirms the line IS that directive, exactly — `rtcsync` never
  resolves against `rtcsyncfoo` or a line that merely mentions it.
- **apply** HOLDS. Turning a flag off means DELETING its line and turning one on
  means inventing a position for a line the file does not have; neither is the
  literal replacement apply performs, so the change goes to the prompt for a
  human, exactly as a `substituted` row does.

**Declare the format.** `space` is force-only and never detected — a
`chrony.conf.j2` is read as `sysctl` and produces nothing (the build says so).
The declared format is recorded on each row's `source.baseFormat` so that
verify and apply read the value back with the same parser that wrote it; without
that a presence flag would be written by one parser and looked for by another.

#### `group_by: file` — one page per file, as a paper sheet has it

```yaml
"httpd reverse proxy":
  group_by: file
  categories: [httpd.conf, Reverse proxy, Host access]
```

Groups a row the project does not categorise by hand by the FILE it belongs to.
That is how an incumbent parameter sheet is organised — one page per
configuration file, its settings listed as the file states them, walked down
beside the real thing — and it is the answer for a product whose own grouping is
unusable as a review split. Apache is the case that forced it: httpd's
dictionary `group` is the MODULE a directive belongs to (`core`, `mpm_common`),
so grouping by it collapses General, KeepAlive and Logging into one "core" tab,
and the only way out was a category line per row.

**Which file a row belongs to is decided from the model, not assumed.** The
distinction that matters is between a row that IS a line of the deployed
artifact and a row that merely lives in the same role:

| the row | belongs to |
| --- | --- |
| sourced from the template itself | the artifact |
| carries an `under_key` variable | the artifact — its value is written elsewhere, which is what the under_key column is for |
| has no source at all | the artifact — a product default nobody set, and the artifact is where it would be set |
| anything else | its own file |

That last line is load-bearing. `keycloak_dist_src` tells the role where to
download the distribution from; it is not a line of keycloak.conf, and filing it
there makes the sheet claim something false about the file. Such rows keep a
category of their own, which is why the example above declares three.

Note what the reader sees: rows the project does not set are hidden behind "show
unset rows", so the default view of a `group_by: file` sheet IS the file — in
the reference project, 22 rows of keycloak.conf's own settings rather than the
149-row ledger behind them.

**On a sheet whose COMPONENTS are already files, most of this has nothing left
to do.** `templates:` naming each component after the artifact it deploys is
the ordinary shape, so every artifact row already carries the file as its
component and `group_by: file` only re-derives it. A derived name equal to the
component is folded away rather than opening a level with one child of its own
name (`httpd.conf > httpd.conf > ServerTokens`), for the same reason the
component level itself disappears on a single-component sheet: a level that
names what its parent already named is not structure. A hand-written
`category:` is never folded — the project said what it meant.

What the option still does there is the last row of the table above: a variable
that is a line of NO artifact keeps its own file's name, instead of being filed
under whichever component it happens to sit beside. If a sheet has no such rows,
`group_by: file` changes nothing on it and can be dropped.

#### `data_maps:` — a path whose children are data

```yaml
data_maps: [attributes]     # spec level, beside id_fields
```

A free-form map's keys are DATA, not fields of a schema, and they routinely
contain dots (`saml.client.signature`). Without this the key reads as three
levels of structure; with it the row is spelled
`attributes["saml.client.signature"]` and the dotted name stays one name.

It sits beside `id_fields` because it is the same kind of statement: a fact
about the config file's SHAPE that the format itself cannot express, needed
while the KEY is formed. It deliberately cannot come from a bound dictionary —
that would make a row's identity a function of which dictionary VERSION is
bound (document one more attribute and its key flips, orphaning every review
filed under the old one), and a free-form map's coverage is partial by nature,
so known keys would come out bracketed and unknown ones dotted.

Only the spelling changes: `attributes["x"]` and `attributes.x` parse to the
same steps, so `source.path` is untouched and verify/apply resolve either way.

#### `recipe: terraform-plan`

A sheet whose subject is a rendered plan (`terraform show -json`). This is
`snapshot` with the plan's shape written down, so a project does not re-derive
Terraform's address grammar in three hand-written patterns:

```yaml
- name: aws infrastructure
  recipe: terraform-plan
  instances: [staging, production]
  snapshots:
    staging: ../../infra/terraform/plan.staging.json
    production: ../../infra/terraform/plan.production.json
  empty_means_unset: true
  exclude: ["**.tags_all.**", "**.tags.**", "**.timeouts"]
```

What the recipe supplies, and a project therefore does not:

| | |
|---|---|
| key | `ec2.aws_instance.node[0].ami` — module, resource type, name, argument. The module STAYS: `aws_lb.this` is unique only within one, so two ALB modules would otherwise collide on every row. A resource in no module gets `root`, Terraform's own name for it, so every key has one shape |
| component | the module. `names:` — what each module IS to a reader — stays the project's |
| dictionary key | `aws_lb.idle_timeout`: a provider documents an argument of a resource TYPE, not of one instance in one module. Applied to a binding that declares no `key_steps` of its own |
| `id_fields` | `address`, which is how a plan addresses its `resource_changes` |
| what is dropped | everything that is not a resource argument — `format_version`, `relevant_attributes`, `errored`, output changes — by failing to match one pattern, rather than by a list of section names someone keeps up with |

A project's own `key: { steps: [...] }` composes after the plan's, and
`empty_means_unset` matters here: HCL's attrs-as-blocks fills every unset
optional string inside a block with `""`, so one route's `gateway_id` holds a
value while its mutually exclusive siblings come back empty.

The recipe never runs Terraform. A plan is an ordinary committed artifact, which
is what keeps `import --spec` hermetic — a stale plan is a stale sheet, and
re-rendering is part of changing the HCL.

#### `split:` — a source holding an identity-keyed list

A configuration file often holds a LIST of things of one kind, each addressed
by an identity field: several clients, several providers, several units. Each
one is a component (they share a key space — that is what a component is for),
and a row's key is what follows the identity in its address.

```yaml
- name: keycloak clients
  recipe: layered
  split:
    at: clients          # the field holding the list
    by: clientId         # the field each element is addressed by
    only: [poc-oidc, poc-oidc-batch]   # optional: the members THIS sheet reviews
```

That one declaration does four things, and doing them separately is how they
drift apart:

- **the component** is the identity (`poc-oidc`)
- **the key** is the rest of the address (`protocol`, `attributes.pkce`)
- **`only:`** drops the members this sheet does not review — and a name in it
  that no element has is a build error, like every other declaration here that
  matches nothing
- **`by:` is the identity field**, so `id_fields` does not have to say it again
  somewhere else in the spec

Rows that are not members of the list at all pass through untouched, which is
what lets a sheet read the list and a flat env file side by side.

**Write this instead of the equivalent regexes.** The pair it replaces —
`^clients\[clientId=("?)(.+?)\1\]\.(.+)$` once for the key and once for the
component — is a project reverse-engineering the tool's own address grammar:
`structural.ts` quotes an identity only when it has to, so the optional-quote
alternation is load-bearing, and getting it wrong fails by matching nothing.
The tool decided how an address is spelled, so the tool should write the
pattern.

A source's own `key: { steps: [...] }` still composes AFTER the split, which is
where the genuine judgement goes — which sub-objects of a member are review
material and which are the product's bookkeeping.

A `component:` transform composes after it too, rather than being refused: a
sheet can hold rows that are not members of the list and still belong to one —
the environment variable feeding a member's field is the case. The split's own
step runs first, and when further steps follow, a non-member survives it to
reach them instead of being filed under no component.

#### A static file that records the PRODUCT's defaults (`origin: default`)

Not every file a spec reads is part of what the project ships. A snapshot
extracted from the product itself — the built-in objects a server creates on
its own, dumped to JSON and committed — is a *record* of the product, read so
the sheet can be the exhaustive ledger of it. Declare that per file:

```yaml
static_files:
  - path: ../../config/<product>/builtin-objects-<version>.json
    origin: default
```

Every row from that file is filed `origin: "default"` instead of
`"embedded"`, which is the difference between "we bake this in" and "the
product does, we set nothing". Three things follow, and they are the reason
to declare it rather than leave the rows embedded:

- **No source.** The row gets no definition site, because it has none in our
  files — the snapshot is not where the value is decided. This is also what
  stops the viewer from labelling the row with the snapshot's file name as if
  it were a config of ours.
- **`verify` skips it** ("nothing set, no source expected") instead of
  counting a source map that failed to resolve.
- **`apply` holds a change against it.** Changing a product default means
  *adding* the setting somewhere it isn't written yet — a judgement call,
  left to the AI prompt, never a line rewrite.

The extracted value is recorded as the row's `default` as well as its
`value`: for these rows they are the same fact.

Rejected in combination with `substitution:` — that merges the file's rows
into base-layer variables the project DOES set, so "set nowhere by us" cannot
also be true of them.

Note the viewer consequence: unset rows are hidden behind "show unset rows",
so a sheet built ENTIRELY from an `origin: default` file looks empty until
that toggle is on. That is consistent (they are unset), but it makes for a
poor landing — prefer such a sheet alongside rows the project does set, or
tell the reader what the toggle is for.

#### Reference substitution in `static_files` (`substitution:`)

A `static_files` entry sometimes doesn't hold a literal — it holds a
**reference** into the sheet's own base/overlay layers. keycloak-config-cli's
realm export is the motivating case: the static realm YAML has
`ssoSessionIdleTimeout: $(env:SSO_SESSION_IDLE_TIMEOUT)`, and the real
per-environment values live in `default.env`/`local.env`/... — separate
files this same sheet already reads as `defaults`/`overlays`. Read the way
`static_files` always has been, that produces TWO rows for one piece of
wiring: an `origin: embedded` row holding a reference string nobody can
review (`$(env:SSO_SESSION_IDLE_TIMEOUT)`), and a separate `origin: overlay`
row named after the env var holding the real values — nothing in the model
says the two are the same field. Declaring `substitution:` on that static
file merges them into one row (see `src/substitution.ts`'s module doc for
the implementation-level walkthrough this section summarizes):

```yaml
static_files:
  - path: ../../config/keycloak/poc.yml
    format: yaml
    substitution:
      pattern: '\$\(env:([A-Za-z_][A-Za-z0-9_]*)\)'
```

`pattern` is an ordinary regex with **exactly one capturing group** — the
captured text IS the layer key (a `defaults`/overlay entry) the reference
points at. Zero or more than one capturing group is a hard load-time error
naming the count found (a non-capturing `(?:...)` group is fine and doesn't
count). Nothing here is `$(env:X)`-specific — `${X}`, `%{X}`, `@X@` are just
a different pattern, no code change needed. Declared per static file, not
per sheet: which file carries references is a fact about that file.

Every entry the file yields — after that file's own `key` transform and the
sheet's `include`/`exclude` selector, i.e. exactly the entries that would
otherwise become plain `origin: embedded` rows — is classified against the
pattern:

| Value shape | Result |
|---|---|
| No match | Untouched — an ordinary embedded row, exactly as without `substitution:`. |
| Whole value is one reference, the captured key resolves in the base layer or any overlay, and it's the only whole-value site backing that key | **Merged.** The embedded row is removed; a `keyMap` entry renames the layer key's row to the static file's product key (surfaced via `under_key`); the static file's line becomes a `ref` additional source on the merged row. |
| Whole value is one reference, key resolves, but **several** whole-value sites reference the same key | **Merged, without a keyMap entry** — no single product key can honestly claim the row (the same one-backer rule `ansible` already applies to `{{ var }}`, above). The row keeps the variable's own name; every site is recorded as a `ref` additional source; a warning names the variable and every site. |
| Reference is a substring of the value (composed — e.g. a URL built from the var) | **Not merged** — the embedded row stays exactly as today; it's a genuinely distinct reviewable thing. The site is still recorded as a `ref` additional source on the *variable's own row*, so the wiring is checked even though the row's shape didn't change. One summary warning per file lists every composed entry. |
| Whole-value reference, but the captured key resolves in **no** layer | **Not merged, warned per site** — the row stays embedded (never drop a row); the variable may legitimately be pipeline-supplied rather than defined in any file this sheet reads. |

A declared pattern that matches nothing anywhere in the file is a warning
too — the same stance `keyglob.ts`'s `unmatchedPatterns` and
`keytransform.ts`'s unmatched drop patterns take: a rule that matched
nothing is reported, never silent. `import --spec` also prints one summary
tally line per sheet (`substitution: N merged, M composed left embedded, K
dangling`).

A merged row: keyed by the **product field path** (the static file entry's
own key — `ssoSessionIdleTimeout`, `smtpServer.host`), with the backing
variable surfaced through the sheet's `under_key` column exactly like
`ansible`'s own `{{ var }}` binding above; `origin` stays derived from the
base/overlay layers (`overlay`/`common`) — the value genuinely still comes
from there, nothing embedded remains about it; the static file's own line is
recorded as a `ref`-marked entry in `additional_sources` (see "One value
defined in several files" above for the general shape, including what `ref`
changes about how `verify`/`apply`/the AI prompt treat that site).

**The payoff:** the "this env var feeds this field" wiring, which a project
today can only write as prose in `sheet.yml`, becomes a machine-checked
claim. `verify` fails the build if someone later hardcodes a value into the
static file or renames the env var — the same way any other stale source map
fails, instead of staying silently true only in a comment.

**Not available on `ansible`.** `ansible.ts` delegates its `static_files`
reading to `layered.ts`, but validates a sheet's fields against its *own*
schema (spec.ts validates each sheet against its recipe's own schema, never a
delegate's), and that schema was deliberately not extended with
`substitution:` — `ansible` already has its own reference mechanism for this
same problem (`{{ var }}` → `keyMap`, see "How a template row gets its name"
above), and how the two would interact on one sheet (a `{{ var }}` resolving
to a static-file entry that ALSO matches a `substitution:` pattern) is
undesigned, so it's rejected outright rather than guessed at. Today, writing
`substitution:` under an `ansible` sheet's `static_files` entry fails with a
generic ajv `additionalProperties` rejection (`must NOT have additional
property "substitution"`) at spec-load time — nothing in that error mentions
this section, so if you hit it: `substitution:` is `layered`-only; switch the
sheet's `recipe:` to `layered` (dropping `template`/`deployed_path`) if the
shape is genuinely a plain base+overlay one, or resolve the reference by hand
if both mechanisms are genuinely needed on the same sheet.

**Migration is opt-in.** Nothing changes until a static file declares
`substitution:` — output is byte-identical without it. The moment it merges
even one row, three existing machine checks fire, no prose needed:

1. The sheet now has a `keyMap` entry — `sheet.yml` must declare `under_key`
   for that sheet, or the build hard-fails naming the sheet (the exact same
   gate `ansible`'s `{{ var }}` binding already trips).
2. `unusedProjectParams` (`import --spec`'s report) names every `sheet.yml`
   entry keyed by the now-removed env-var row — delete them or fold their
   `description`/`out_of_scope`/`remarks` into the merged row's own entry.
3. The merged row goes through the ordinary strict-metadata gate like any
   other row — an undescribed row still fails the build with a paste-able
   scaffold.

`instances:` at the top of `build.yml` is the project's ordered environment
list, and every sheet's default. A sheet whose own environment set genuinely
differs — Terraform run only in `[staging, production]`, next to an
Ansible-rendered config in `[local, staging, production]` — overrides it with
its own `instances:` (must be a subset of the top-level list, so a typo still
gets caught):

```yaml
instances: [local, staging, production]   # the spec's default
sheets:
  - name: keycloak configuration
    recipe: ansible                        # inherits [local, staging, production]
  - name: aws infrastructure
    recipe: ansible
    instances: [staging, production]       # this sheet only — no separate spec needed
```

Both accept `include` / `exclude` key patterns to select what the sheet reviews
(`*` within a segment, `**` across; everything else literal, so `kc_db_url` and
`Tags[0].Value` are written as-is). This matters for `ansible` as soon as an
inventory keeps **one group_vars file per host group** rather than per role —
the ordinary layout. That file holds every role's variables, so a sheet built
from one role's `defaults` picks up the others' as parameters of its own:

```yaml
  - name: httpd reverse proxy
    recipe: ansible
    defaults: ../roles/httpd/defaults/main.yml
    overlays:
      staging: ../inventories/staging/group_vars/web.yml   # httpd_* AND kc_* AND kcr_*
    exclude: ["kc_*", "kcr_*"]
```

Opt-in, and deliberately not "drop whatever the defaults do not declare": a
variable set only per environment, with no default, is a legitimate Pattern B
row, and dropping those by default would trade one invisible failure for
another. The filter applies to every file the sheet reads, and a pattern that
matches nothing is reported — a filter selecting nothing is how rows disappear
quietly.

A sheet's own dictionary binding (`sheets[].dictionaries`, see "Binding
project keys to a dictionary" below) can additionally **materialize** into the
exhaustive ledger a parameter-sheet review traditionally expects — every
parameter of the product written down, not only the ones this project sets:

```yaml
sheets:
  - name: postgresql configuration
    recipe: ansible
    ...
    dictionaries:
      - product: postgresql
        version: "16"
        key_prefix: pg_
        materialize: true           # expand every uncovered key
```

`materialize` lives ON the binding, not beside it — the dictionary a sheet
expands is exactly the one it is already bound to, so there is nothing to name
a second time (an earlier version of this had a spec-wide `materialize:`
restating `product`/`version` next to a spec-wide `dictionaries:`; the two
inevitably drifted). Every key of that dictionary the sheet does not already
cover (checked through the same binding resolution described in "Binding
project keys to a dictionary" below, so nothing is duplicated),
**and whose `kind` is not `"container"`** (see `DictionaryParam` fields below —
a syntax element like Apache's `<IfModule>` has no default to assert),
becomes an `origin: "default"` row: value = the product's documented default,
description from the dictionary. Such a row has no `source` — `verify`
counts it as `product-default` rather than `unmapped`, and `apply` holds a change
on it (acting on it means *adding* a setting, which is a judgement call). Only
materialize a dictionary that is a genuine full extraction of the product
(`pg_settings` dump, values read out of the product image); materializing a
hand-transcribed dozen entries produces a fake inventory. This is enforced, not
just advised: a dictionary must declare `coverage: full` to be materialized —
`coverage: partial` (or omitting it, which defaults to `partial`) makes
`materialize` fail with an error. `import --spec` reports how many of the
dictionary's keys were skipped as containers (never silently) alongside how
many rows were actually materialized. See `examples/ansible-basic/` and
"Authoring a product dictionary" below.

A dictionary entry with **no documented `default`** is also excluded by
default, for the same reason a container is: `origin: "default"` is a claim
that "the product default applies here", and that claim is simply false for a
directive the dictionary never recorded a default for — this is not
redundancy, it is a false statement in the ledger. Measured on a real project:
122 of 282 candidate rows (43%) across a Keycloak and an httpd dictionary
carried no `default`. Set `includeNoDefault: true` on the binding's
`materialize:` object to opt back in, once you've specifically checked what
the real (undocumented) behavior is:

```yaml
        materialize:
          includeNoDefault: true   # also materialize entries with no dictionary default
```

**This exclusion is only as good as the dictionary's own extraction quality.**
A dictionary's `default` column being empty does not always mean the product
has no default — it can mean the extraction script that generated the
dictionary failed to record one. httpd's own `httpd@2.4.yml` (a mechanical
scrape of the Apache quickreference) is missing a documented default for
several directives that clearly have real behavior: `AcceptFilter` (an
OS-dependent default), `ErrorDocument` (the built-in error page when unset),
`Protocol` (the listener's own protocol). Treat this gate as "skip until
proven otherwise", not "skip because it doesn't matter" — never silently:
`import --spec`'s stderr summary always prints the skipped count
(`materializeReports[].noDefault`), and `--materialize-report <file>` (same
shape as `--bind-report`) writes the full per-sheet report, including
`noDefaultKeys` — the exact keys skipped — so a project can check them against
the product's real documentation and either fix the dictionary (add the
missing `default`) or set `includeNoDefault: true` deliberately.

Materialized rows are filed two levels deep, never as flat top-level tabs:
one parent category (named "Product defaults (not set)" by default, in
`enrich.lang`; override with `defaultsCategory`) holding one subcategory per
dictionary `group`. A sheet's own hand-declared categories are unaffected —
they stay flat, single-level tabs exactly as before. This matters once a
dictionary is genuinely large: httpd@2.4's 729 directives span 100+ Apache
modules, and 100+ flat top-level tabs is not something a reviewer can
navigate — nested under one nameable parent, they read as "the settings this
project states nothing about", out of the way of the rows that need a
decision. The label says "not set" rather than "unused" deliberately: the
product's default IS in effect on these rows, and calling that unused inverts
what the reader should take away.

```yaml
sheets:
  - name: httpd reverse proxy
    recipe: ansible
    ...
    dictionaries:
      - product: httpd
        version: "2.4"
        key_prefix: httpd_
        materialize:
          # Include only these dictionary groups (Apache module names) —
          # everything else in the dictionary is left out entirely, not just
          # hidden. Omitted `groups` (i.e. `materialize: true`) = every group
          # — the only sane choice for a dictionary small enough that
          # "everything" IS the point, like postgresql@16.
          groups: [core, mpm_event, mod_proxy, mod_proxy_http, mod_headers]
          # defaultsCategory: "Unreviewed defaults"   # optional override
```

`groups` exists because a module a deployment never `LoadModule`s isn't an
"unused setting" — it doesn't exist in that configuration at all, and rows
for it are worse than noise, they're false: materializing every module the
product COULD load asserts settings for code that was never even loaded.
Decide the list from what the real config actually loads (grep its
`LoadModule` lines, or infer from which directives it already uses), not from
the dictionary's own table of contents. A named group that matches nothing in
the dictionary — a typo — is reported as a warning
(`materializeReports[].unknownGroups`), never silently ignored; the number of
entries the filter left out is `materializeReports[].groupExcluded`, printed
by `import --spec` alongside the container-skip count. There is no automatic
`LoadModule` cross-reference (yet) — this is a declarative include-list only;
a project can always tighten a stale list by hand as the real config changes.

Recording the review itself needs nothing from the model. An exclusion from
review scope is `out_of_scope` (with its mandatory reason, and `owner` naming
who owns it instead) in the project's own `sheet.yml`, hand-authored and
reviewed in the same pull request as the code — a reviewer asks for one with a
review comment; a maintainer commits it. Rationale for keeping a product default
is a `remarks` on the row. That a review happened, and by whom, is what the
commit says: the reviewed baseline is simply the `input.json` of that revision,
and "what needs looking at again" is

```sh
git show <reviewed-rev>:input.json > /tmp/base.json
review-sheet diff -i /tmp/base.json -i input.json
```

Do not add per-row "reviewed" flags: for a fully reviewed sheet they are a value
snapshot in a worse format than the committed input.json, and the delta they
exist to express is a diff.

#### Value, default, prose: three kinds of "changed"

A row can differ in three ways, and `diff` names which:

```
~ sheet > cat > config.authType[0] (description/remarks only)
~ sheet > cat > config.useTruststoreSpi[0]

diff: 6 changed (4 description/remarks only), 26 added, 26 removed, 984 unchanged
```

`--format json` carries the same thing per row as `changed: ["value"]`,
`["effective"]`, `["default"]`, `["doc"]`, or a combination.

This exists because **comparing one configuration across two product versions is
dominated by prose churn**. Measured on a real Keycloak 19.0.2 → 26.7.0
comparison: 67–74% of shared dictionary keys have different description text,
and most of it is not the product changing — of 115 differing realm entries, 32
are a Japanese translation the newer dictionary has and the older lacks, and 20
are a description the newer one LOST. Counted together, an upgrade review reads
"115 changed" when nothing it configured has moved.

`default` is kept with the findings, not with the prose: the product's own
documented default moving is a statement about the deployment even when every
value held still. In that same comparison it was one row —
`useTruststoreSpi`, whose default went from `ldapsOnly` to `always` under an
untouched value — which is exactly the row an upgrade review exists to find, and
exactly the row that four translation diffs would have buried.

##### A sheet that exists only to compare

```yaml
"realm upgrade":
  compare_components: always
```

`true` opens the sheet stacked and offers a toggle to the side-by-side
reading. `always` opens side by side and offers no toggle: a sheet built to
compare has no stacked reading to go back to.

Both are DECLARED, never inferred, for the reason `compare_components` was
declared in the first place — several components do not make a sheet
comparable, and the person who wrote it already knows which it is.

Comparing two RELEASES needs neither: that axis is the versioned document
(`generate -i old.json new.json`), whose Compare offers its own side-by-side
switch. Use `compare_components` when the things being compared coexist in one
build — two realms, two clients, two LDAP providers.

##### `effective` — the default moved and nothing was holding it back

A moved default means two different things, and only one of them changes what
the system does:

```
~ … > config.useTruststoreSpi[0]
      the project sets this row, so its own value still wins — recorded

~ … > AcceptPathInfo  (effective: the product default moved under an unset value)
      nobody sets this row, so the default IS the value in force — it moved
```

A materialized row carries **no value at all** (measured: all 668 `origin:
default` rows in one project have `value: undefined`, the product's default
beside them), so when its default moves nothing else about the row changes.
Without the split it reads exactly like the harmless case above it — which is
the wrong way round, because this is the one line in a version comparison that
can mean *the system behaves differently and no one edited anything*.

`origin: baseline` counts as unset too: such a row says the vendor's shipped
file had this directive and yours does not, so what governs is the product's
built-in default — those rows are **more** exposed to it moving, not less.

#### When the generated files are not committed

That `git show` assumes `input.json` is in the repository. Plenty of projects
commit no build output at all, and the workflow still works — **rebuild the
baseline from the reviewed revision instead of reading it back**:

```sh
git worktree add /tmp/base "$(git rev-parse origin/main)"     # the reviewed revision
review-sheet import --spec /tmp/base/review-sheet/build.yml -o /tmp/base.json
review-sheet import --spec review-sheet/build.yml -o /tmp/current.json
review-sheet diff -i /tmp/base.json -i /tmp/current.json --format json
git worktree remove /tmp/base
```

Three things make this work rather than half-work:

- **Run the same review-sheet on both sides.** A worktree is a checkout of your
  project, not of the tool, so drive both imports with the one binary you are
  running now. Letting each side use the tool version its own revision pinned
  mixes tool changes (a parser fix, new identity fields) into what is supposed to
  be a configuration diff.
- The spec's paths resolve against the **spec file's own directory**, so pointing
  `--spec` into the worktree reads that revision's configuration throughout. The
  two models then record different source paths, which does not matter: `diff`
  compares keys and values, never `source`.
- Use `--format json` and branch on `.summary`, not on whether stdout was empty
  (see "Versions & diff").

The cost is one extra `import` per run — the same work the build already does,
and the reason the whole pipeline is deterministic. If your project installs
review-sheet as a dependency, the worktree needs its own `bun install` before it
can run anything from inside itself; driving both imports from the main checkout,
as above, avoids that entirely.

**Level 2 — `build.yml` + hooks** (~20 lines). The recipe fits *except* for one
detail — keys spelled differently from your metadata, a handful of parameters to
drop, a field to stamp on the whole model. Keep the spec and pass `hooks`:

```ts
import { buildFromSpecFile } from "review-sheet";
import { readFileSync, writeFileSync } from "node:fs";

const readFile = (p: string) => { try { return readFileSync(p, "utf-8"); } catch { return null; } };

const { input, report } = buildFromSpecFile("review-sheet/build.yml", {
  readFile,
  hooks: {
    // Identity: what the project metadata and enrich() look up.
    keyFor: ({ key }) => key.replace(/^myapp_/, ""),
    // Per parameter, before it is filed; return null to drop it.
    mapParam: (param, { key }) => (key.startsWith("internal_") ? null : param),
    // Whole model, before enrich() runs.
    finalize: (model) => model,
  },
});
writeFileSync("input.json", JSON.stringify(input, null, 2));
```

`buildFromSpecFile` (or `assembleFromSpec`, if you loaded the spec yourself) is
the exact composition `import --spec` runs — same recipes, same assembly, same
strict-metadata gate. Hooks run **before** `enrich()`: what a hook sets is kept
(enrich is fill-only), and what a hook produces still faces the strictness gate,
so a hook can *fix* a missing description, never *hide* one. Run `verify` after
writing, as always.

**Level 3 — your own converter** (last resort). Only for genuinely
project-specific structure no recipe expresses. Call `assembleSheets()` with
your own `SheetInputs` (base/overlay layers, embedded literals) so you still get
Pattern A/B classification, category filing and enrichment for free — and if the
shape repeats across projects, package it as a **custom recipe** instead
(see "Custom recipes" below), which puts you back on Level 1 for the next
project.

A hand-written conversion script must NOT re-implement source-map extraction
by hand (counting line numbers and guessing anchors is exactly what goes
wrong). Delegate that to review-sheet's **extraction adapters**, add only the
project-specific structure, then `verify`.

#### Extraction adapter API

Exported from the `review-sheet` package:

```ts
type Format = "yaml" | "json" | "properties" | "dotenv" | "sysctl" | "ini" | "space" | "generic";

type Entry = {
  categoryPath: string[];   // category nesting this entry belongs under
  key: string;              // the LEAF name only — see the warning below
  value: string;            // current value, as text
  source: SourceLocation;   // { line, anchor, and path for nested formats } — exact location
};

// Pick a Format from the file extension (see the table below).
function inferFormat(file: string): Format;

// Parse one file's text into entries with source maps. `format` defaults to
// inferFormat(file). `file` is used only for format inference (not read).
function extractFile(content: string, file: string, format?: Format): Entry[];

// Convenience: parse many files into a full ParameterSheetInput, one sheet per
// file (sheet.name = basename, sheet.file_path = file). Files that yield no
// entries are skipped. Use this when one-sheet-per-file is acceptable; otherwise
// call extractFile per file and arrange the entries yourself.
function buildInput(files: { file: string; content: string; format?: Format }[]): ParameterSheetInput;

// Template + variable files (Ansible .j2 + group_vars/defaults, Helm .tpl +
// values, Chef .erb, Puppet .epp …): parse the template (the jinja2 parser
// records `templateVar`) and resolve each value against the variable files.
// `resolvedSource` points at where the value actually lives — the variable file
// for a `{{ var }}` value (the apply/verify target), or the template itself for
// a literal. `variableFiles` are tried in order, first definition wins, so the
// caller controls precedence. resolvedSource is undefined when no file defines
// the variable. Tool-specific parts (which file is primary, turning per-env
// files into Pattern B instances) stay in the caller.
type ResolvedEntry = Entry & { resolvedSource?: SourceLocation };
function resolveTemplateVars(
  templateFile: string,
  variableFiles: string[],
  readFile: (path: string) => string | null
): ResolvedEntry[];
```

`source` produced by the adapters: line formats emit `{ line, anchor }`; YAML/JSON
emit `{ line, anchor, path }`. The file itself is taken from the sheet/category
`file_path`, so `source.file` is normally left unset by these adapters.

**`Entry.key` is the last path segment, never the full address.** This holds for
every nested format, not just YAML/JSON: HCL's
`variable "region" { default = "us-east-1" }` yields key `default`, and an ECS
task definition's `environment[name=KC_DB_URL].value` yields key `value`. The
full address is always `entry.source.path`. Matching or normalizing on `key`
alone therefore fails in two directions and neither is loud: a filter looking for
`variable.region.default` matches nothing and the parameters simply disappear
from the sheet, while one looking for `value` matches every array element at
once. Use `entry.source.path ?? entry.key`. If a parameter does vanish this way,
the project metadata still describes it — `import --spec` warns about every
described key that no sheet produced, which is the symptom you will actually see.

For YAML/JSON/XML, `apply`/`verify` resolve by the structural `path` first (line +
anchor is the fallback). Because `path` addresses by map key / element name and
list **identity** (`services[name=web].port` / XML `service[name=web]`, not
`[0]`), it stays correct when map keys, list items, element order, or XML
attribute order change — only a list/element with no identity field
(`name`/`id`/`key`) falls back to a positional `[i]`, which is not reorder-safe.
(XML supports element text and attribute values; mixed content / CDATA are
skipped.)

When a product names its identity something else, say so rather than accept the
positional fallback — Keycloak's realm export identifies a client by `clientId`
and carries none of the built-in names, so every client's values would be pinned
to `clients[0]` and start pointing at a different client the moment the list is
reordered:

```yaml
id_fields: [clientId]        # build.yml, top level
```

or `--id-fields clientId` for `import -f`. Configured names are tried **before**
the built-ins (naming a field is a statement about your data; a Keycloak client's
display `name` is not its identity), and one that is missing or non-unique is
ignored. Extraction only: a path carries its own field name, so `verify`/`apply`
resolve `[clientId=…]` with nothing configured.

Adding this to an existing sheet **renames its parameters**
(`clients[0].enabled` → `clients[clientId=poc-oidc].enabled`), so the project
metadata's keys have to move with them. The build says so — every renamed row
fails the "no category" check by name — but do it as one deliberate change, not
alongside others.

#### Supported formats & extension mapping

`inferFormat` chooses by extension; pass `format` explicitly to override (always
required for `space`, which has no dedicated extension).

<!-- parsers:start -->
| Format | Summary | Details |
| --- | --- | --- |
| `jinja2` | Templates (.j2): base-format structure + the {{ variable }} behind each value (extraction aid). | [details](formats/jinja2.md) |
| `logrotate` | `/path/*.log { … }` blocks: flags, `name args`, and script bodies. | [details](formats/logrotate.md) |
| `haproxy` | Sections and directives; named sections + repeated directive by 1st arg. | [details](formats/haproxy.md) |
| `httpd` | Apache directives and <Tag> containers by label; repeats indexed. | [details](formats/httpd.md) |
| `nginx` | Directives and {} blocks; labeled blocks by label; repeats indexed. | [details](formats/nginx.md) |
| `hcl` | Blocks by label (resource type+name); scalar attributes only; expressions/lists/maps/heredocs skipped. | [details](formats/hcl.md) |
| `json` | Same as YAML including minified JSON; no comments. | [details](formats/json.md) |
| `py` | In-source `@rs` annotations on Python config-as-code (CDK for Python, Pulumi, settings); value = the RHS expression. | [details](formats/py.md) |
| `shell` | Variable assignments and long options with values; a CLI wrapper's arguments become parameters. | [details](formats/shell.md) |
| `systemd` | [Section]+Key=Value unit files; repeated keys indexed. | [details](formats/systemd.md) |
| `toml` | Tables and array-of-tables; reorder-robust paths; scalar values only. | [details](formats/toml.md) |
| `ts` | In-source `@rs` annotations on TS/TSX config-as-code (CDK, Pulumi); value = the RHS expression. | [details](formats/ts.md) |
| `xml` | Element text and attributes; reorder-robust paths via identity attributes. | [details](formats/xml.md) |
| `yaml` | Nested leaves get a structural path; list-of-maps addressed by identity. | [details](formats/yaml.md) |
| `dotenv` | .env KEY=value files; export prefix stripped; quotes KEPT; # comments. | [details](formats/dotenv.md) |
| `ini` | INI/CFG [section] files; sections become categories. | [details](formats/ini.md) |
| `properties` | Java .properties key=value files; # and ! comments; category is Parameters. | [details](formats/properties.md) |
| `sysctl` | sysctl-style key = value .conf files; # and ; comments. | [details](formats/sysctl.md) |
| `space` | Whitespace-delimited files (e.g. sshd_config); force-only, not auto-detected. | [details](formats/space.md) |
| `generic` | Last-resort fallback; tries = then : as delimiter; always matches. | [details](formats/generic.md) |
<!-- parsers:end -->

Line-format rules: blank lines and comment lines are skipped; the **first**
delimiter splits key/value (so a value may contain `:`); the anchor is the key
plus its delimiter (e.g. `MaxClients ` or `net.ipv4.tcp_fin_timeout =`); line
numbers are 1-based.

#### Example

```ts
import { extractFile, validateInput, type Entry } from "review-sheet";
import { readFileSync } from "node:fs";

// 1) Adapter does the hard part: exact line + anchor (+ path for YAML/JSON).
const prod: Entry[] = extractFile(readFileSync("config.prod.yaml", "utf-8"), "config.prod.yaml");
const dev:  Entry[] = extractFile(readFileSync("config.dev.yaml",  "utf-8"), "config.dev.yaml");

// 2) Add YOUR structure: sheets/categories, merge per-env files into Pattern B
//    instances (each instance keeps its own entry.source), attach descriptions
//    (no source on doc fields).
const input = { sheets: [ /* arrange `prod`/`dev` entries */ ] };

// 3) Validate, write input.json, then: review-sheet verify -i input.json
validateInput(input);
```

Keep the script as the deterministic source of the model so it can be re-run when
the config changes, and finish every run with `review-sheet verify`.

### Custom parsers (a format we don't ship)

Formats are pluggable. A `ConfigParser` handles detect / extract / locate / edit
for one format and self-registers; `extract`/`verify`/`apply` pick it
automatically. Drop a module in `./.review-sheet/parsers/` (auto-loaded by the
CLI) or pass `--parsers-dir <dir>`:

```ts
import { registerParser, lineLocate, lineEdit, type ConfigParser } from "review-sheet";

const parser: ConfigParser = {
  name: "myformat",
  priority: 70,                                   // higher = tried before generic
  detect: (file, content) => file.endsWith(".myf"),
  extract: (content, file) => [/* Entry[] with source maps: { line, anchor } at minimum */],
  locate: lineLocate,
  edit: lineEdit,
};
registerParser(parser);
```

**Do not hand-write `locate`/`edit`.** If your format extracts one value per
line — `extract` records `{ line, anchor }` (a literal substring on that
line) per entry, the same as every shipped line-oriented parser
(properties/dotenv/sysctl/ini/space/generic) — `lineLocate`/`lineEdit` from
`"review-sheet"` already implement the correct resolution protocol: trust the
recorded line if it still carries the anchor and the current value,
otherwise re-locate by a unique anchor match across the whole file, and treat
a line that already holds the suggested value as an idempotent no-op rather
than an error. Assign them directly, as above — there is no wrapping to do.
Reimplementing this (as opposed to using the shipped export) is a maintenance
trap: your copy silently drifts from the original the next time it's fixed or
hardened, and nothing will tell you it happened.

Only write a custom `locate`/`edit` when the format needs addressing
`lineLocate`/`lineEdit` cannot express — nested/structural paths, for
example. Even then, you can fall back to line+anchor for values that only
carry `{ line, anchor }`: import the lower-level `locateLine(lines, source,
expected)` (also exported from `"review-sheet"`) and see
`src/parsers/yamljson.ts` in the review-sheet source for the pattern (try the
structural path first, fall back to `locateLine` on a plain line array).

Then: `review-sheet import -f x.myf --parsers-dir ./parsers` (or just place it in
`.review-sheet/parsers/`). In code, `import` the module (or call `registerParser`)
before using `generateHtml`/`verifySources`/`computeApply`.

### Custom recipes (a project shape that repeats)

Recipes are pluggable the same way. Write one when the *layout* — which files
hold the base values, which hold the per-environment overrides, how a key is
spelled in each — is a shape you will meet again, and the built-in `ansible` /
`snapshot` recipes do not express it. A recipe is what puts a project back on
**Level 1**: one `build.yml`, no per-project script.

A `SheetRecipe` has three fields:

- `name` — what a sheet's `recipe:` names in `build.yml`. Resolution is by name
  only; unlike a parser there is no content detection.
- `schema` — an ajv JSON Schema for that sheet's own fields in the spec.
  `loadBuildSpec` validates each sheet against it, so a typo in `build.yml`
  fails at load with a message instead of surfacing later as a missing value.
  Set `additionalProperties: false` at the schema's top level — without it, a
  misspelled field (`overlayz:` for `overlays:`) is silently dropped instead
  of rejected: the sheet builds, but a whole overlay layer (an entire
  environment's worth of values) just vanishes with no error. `loadBuildSpec`
  validates only this recipe's OWN fields against `schema` (the common
  `name`/`recipe`/`instances`/`dictionaries` fields are spec-level, stripped
  before your schema ever sees them), and reports an unknown field with a
  "did you mean" hint when a declared field name is close.
- `load(sheetSpec, io)` — build one sheet's `SheetInputs` (sync). `io` gives you
  `readFile`, `specDir`, `resolve` (spec-relative path → the form recorded in
  the source map) and `instances` (this SHEET's ordered instance list — a
  sheet's own `instances:` in `build.yml`, if given, else the spec's default;
  already resolved before your recipe runs, so just read `io.instances` — a
  recipe only sees its own sheet's fields, so this is the only way to see them).

```ts
import { registerRecipe, extractFile, type SheetRecipe, type RecipeIO } from "review-sheet";
import type { ExtractedMap, SheetInputs } from "review-sheet";

// One shared defaults file, plus one override file per instance.
const recipe: SheetRecipe = {
  name: "myshape",
  schema: {
    type: "object",
    required: ["defaults", "overlays"],
    properties: {
      defaults: { type: "string" },
      overlays: { type: "object", additionalProperties: { type: "string" } },
    },
    additionalProperties: false, // reject an unknown/typo'd field instead of silently ignoring it
  },
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const read = (p: string): ExtractedMap => {
      const file = io.resolve(p);
      const content = io.readFile(file);
      if (content === null) throw new Error(`myshape recipe: not found: ${file}`);
      // Delegate the source map to the adapters — never count lines yourself.
      return new Map(extractFile(content, file).map((e) => [e.key, { value: e.value, source: { ...e.source, file } }]));
    };

    return {
      name: String(sheetSpec.name),
      instances: io.instances,
      layers: [
        { kind: "base", entries: read(String(sheetSpec.defaults)) },
        ...Object.entries(sheetSpec.overlays as Record<string, string>).map(
          ([instance, path]) => ({ kind: "overlay" as const, instance, entries: read(path) })
        ),
      ],
      embedded: [],
      // No keyMap: every row keeps its extracted key (the variable name)
      // verbatim as the parameter key — see below for when to supply one.
    };
  },
};
registerRecipe(recipe);
```

`assembleSheets` takes it from there: exactly one `base` layer is required, a key
only the base sets becomes Pattern A (`origin: "common"`), a key any overlay sets
becomes Pattern B (`origin: "overlay"`) with one value cell per instance.

There is no sheet-wide "keying" setting — naming is decided per ROW, by whether
that row's extracted key has an entry in `SheetInputs.keyMap`
(`{ boundKey, variable }[]`). Supply one when the key a reviewer should see is the
product's own config key rather than the variable name (also declare `under_key`
in the project's sheet.yml, so the sheet gets a column showing which variable
backs each mapped key). Only put a variable into `keyMap` when it backs exactly
one entry: a variable used by two or more directives (httpd's `ProxyPass` and
`ProxyPassReverse` sharing one backend variable, say) has no single product key to
legitimately claim, and mapping it anyway means the LAST directive processed wins
the row's name while the earlier one silently vanishes — no error, just a row that
lies about which directive it drives. Leave such a variable out of `keyMap`
entirely: `resolveKey` (assemble.ts) then falls back to the variable name itself
as the key, and report every such variable (which entry keys it backs) the same
way `ansible.ts` does — a warning naming the variable and every entry it drove,
never a silent choice.

Two rules a recipe must not break:

- **Never execute a toolchain.** If the values only exist after `cdk synth` /
  `terraform plan` / `helm template`, the rendered artifact is an ordinary
  committed file and the recipe reads it (that is what `snapshot` does). A recipe
  that shells out makes the sheet unreproducible and the review untrustworthy.
- **Never hand-roll source maps.** Call `extractFile` (or `resolveTemplateVars`),
  including for a format you had to write a custom parser for. If a value in the
  artifact is machine-generated, set `source.generated: true` so `apply` holds it.

Normalizing extracted keys is most of what a recipe does, and it is where the
`Entry.key` trap above bites: key on `entry.source.path ?? entry.key`, not on
`entry.key`. A filter that matches nothing removes rows silently, so check the
`Warning: N parameter(s) described in the project metadata never appeared in any
sheet` line — that is the build telling you a normalization step dropped
something.

If the shape is *almost* a built-in recipe, do not write one — pass `hooks`
(Level 2) instead.

### Where plugins live, and one trap

All three plugin kinds — parsers, recipes, metadata providers — are plain modules
that self-register at import. The CLI loads them from an explicit flag and from a
convention directory:

| Kind | Register with | Flag | Auto-loaded from | Loaded by |
| --- | --- | --- | --- | --- |
| Parser | `registerParser` | `--parsers-dir` | `./.review-sheet/parsers/` | `import`, `verify`, `apply`, `serve` |
| Recipe | `registerRecipe` | `--recipes-dir` | `./.review-sheet/recipes/` | `import --spec` |
| Metadata provider | `registerMetadataProvider` | `--providers-dir` | `./.review-sheet/providers/` | `import` |

Each command loads the kinds it can act on: `verify` / `apply` / `serve` resolve
source maps, so they need parsers but never recipes or providers.

The auto directory is resolved against the **current working directory**, not
against `build.yml` — run the CLI from the project root.

The trap: your plugin's `import { registerRecipe } from "review-sheet"` is
resolved from **the plugin's own location**, i.e. through your project's
`node_modules`. If the CLI you are running came from somewhere else — a sibling
checkout, `bun run ../review-sheet/src/cli.ts`, a linked workspace — the plugin
loads a *second copy* of the package, and ES module identity is by resolved file
path. review-sheet keeps its registries process-wide (`Symbol.for`) so both
copies share one, but that only helps when **both** copies have that; a project
pinned to an older release still registers into that copy's private array, and
the only symptom is `Unknown recipe "x"` (or a custom parser that is simply never
picked), which reads as "my file was not loaded". If you hit it, move the pin
first.

## Metadata: where descriptions come from

`enrich()` (run by `import --spec`, and by `import -f` when a source is
configured) fills `description` / `default` / `remarks` / `docs_url` / `type` /
`scope` from a registry of providers. It is **fill-only**: a value the project
already set is never overwritten. It never touches `value` / `source` /
`instances`.

Four providers ship, consulted in priority order, **first wins per field** — so
a project can override one field of a dictionary entry without restating the rest:

| Priority | Provider | Reads | Provenance |
| --- | --- | --- | --- |
| 100 | `project` | the project's own `sheet.yml` (`--project` / spec `enrich.project`) | `project` |
| 50 | `argument-specs` | Ansible `meta/argument_specs.yml` (`--argument-specs` / spec `enrich.argument_specs`) | `community` |
| 50 | `terraform-variables` | a Terraform `variables.tf`'s `description = "..."` (`--terraform-variables` / spec `enrich.terraform_variables`) | `community` |
| 30 | `dictionary` | `<product>@<version>.yml` on the metadata dirs | the file's own |

The two priority-50 providers are the **native metadata channels**: the place
each ecosystem already gives you to describe a variable, next to the variable.
Prefer them to writing the same prose again in `sheet.yml` — a description in
both places is one that will drift, and in practice does.

`description` and `remarks` merge **per language key**, not per field, which is
what makes those channels usable at all: they carry no language of their own, so
they are tagged with `enrich.native_lang` (CLI `--native-lang`, default `en`) and
the other language still comes from `sheet.yml`. Write English in `variables.tf`,
Japanese in `sheet.yml`, and the row ends up with both.

> A note on `argument_specs.yml` and a `keyMap`-renamed row: for a row a
> template's `keyMap` resolved to a product key (`hostname`, not the Ansible
> variable `kc_hostname`), `argument-specs` tries that product key first, then
> falls back to the row's original Ansible variable name — so an entry written
> under `kc_hostname` still reaches the row even though it is now displayed as
> `hostname`. No relocation needed: keep a role's own variables documented by
> their variable name, the ecosystem's normal convention, and the fallback
> finds them regardless of what the sheet ends up calling the row.

How a project's own parameter key finds its way to the right entry in a bound
dictionary — before the `dictionary` provider above ever runs a lookup — is
its own resolution phase, and worth understanding before you write anything in
`sheet.yml`: see "Binding project keys to a dictionary" below.

Enrichment is **strict by default**: an in-scope parameter left with no
description fails the build, naming every offender. Silencing it is a decision
you write down — `out_of_scope: { reason, owner? }` in `sheet.yml` — not a flag
you pass. `origin: embedded` parameters (literals baked into a template) are in
scope like any other.

### The project's `sheet.yml`

The build spec's `enrich.project` points at it. One entry per parameter,
keyed by the parameter's own key exactly as the recipe emits it, plus that
sheet's own display config. Everything here is a display fact about how a
sheet is READ, not about where its data comes from, which is what decides the
file it goes in: dictionary bindings (`sheets[].dictionaries`), the recipe,
and the input paths are data-SOURCE facts and stay in `build.yml`.

The whole schema — `loadProjectMeta` rejects a field not on this list, so
this is the complete set, not a selection (providers/project.ts's
`ProjectMetaDoc` / `ProjectMetaSheetDoc` / `ProjectMetaParam`; tests/docs.test.ts
fails when one of them is missing from this section):

| where | field | what it decides |
|---|---|---|
| document | `groups:` | the sheet groups this document has, IN READING ORDER — the header's first row |
| document | `sheets:` | per-sheet namespace (below); mutually exclusive with a top-level `params:` |
| sheet | `group:` | which of `groups:` this sheet is read under |
| sheet | `label:` | the sheet's display name, `{ ja, en }` — the name stays its identity |
| sheet | `categories:` | top-level tab order, and the ghost-tab guard |
| sheet | `group_by: file` | file a row the project does not categorise by the artifact it is written in |
| sheet | `under_key:` | the provenance sub-line column — `id` + bilingual label |
| sheet | `compare_components:` | this sheet's components are comparable side by side — `true` for a toggle, `always` to open that way with no toggle |
| sheet | `components:` | per-COMPONENT `params:`, for a sheet whose rows are named by the product's own field |
| sheet | `params:` | the rows themselves |
| param | `category:` | this row's category — a string, a LIST (a path), or `null` for none |
| param | `dict_key:` | bind this row to a differently-named dictionary entry (rare — see the next section) |
| param | `description:` | the row's description, when no dictionary supplies one |
| param | `remarks:` | a project note shown beside the row — not the description |
| param | `out_of_scope:` | excluded from THIS review, with a reason and an owner |

For a **single-sheet** spec (and for `import -f --project`, which has no
concept of a spec at all), it is flat — `categories:`/`under_key:` at the top
level, alongside `params:`:

```yaml
categories: [General, Database]      # omit entirely to leave tab order unconstrained
params:
  httpd_listen:      { category: General }
  db-url:            { category: Database }
  db-password:
    category: Database
    out_of_scope:                    # excluded from THIS review, with a reason
      reason:
        en: Held in the secrets pipeline — not reviewed as plaintext.
        ja: シークレットパイプラインで管理。平文でのレビュー対象外。
      owner: DBA/Secrets
```

For a **multi-sheet** spec, use `sheets:` instead — `params:`/`categories:`/
`under_key:` namespaced per sheet, keyed by the exact sheet name (`build.yml`'s
`sheets[].name`):

```yaml
# Sheet groups — the header's first row, in reading order. Omit entirely and
# the header stays a flat tab strip.
groups:
  - name: platform
    label: { ja: "基盤", en: "Platform" }
  - name: sso-server
    label: { ja: "SSO サーバ", en: "SSO server" }

sheets:
  "keycloak configuration":          # the key IS build.yml's sheets[].name
    group: sso-server                # which group it is read under
    label: { ja: "Keycloak (設定ファイル)", en: "Keycloak (configuration files)" }
    categories: [Hostname, Database]
    under_key:
      id: ansible_var
      label: { ja: "Ansible 変数", en: "Ansible variable" }
    params:
      kc_hostname: { category: Hostname }
  "httpd reverse proxy":
    group: sso-server
    label: { ja: "Apache HTTPD", en: "Apache HTTPD" }
    categories: [General]
    params:
      httpd_listen: { category: General }
```

**Sheet groups are the outer level of what a reader navigates** — "SSO server
> Apache HTTPD". `groups:` declares them once, in reading order, and each
sheet names one with `group:`. Declaring the order is the point: deriving it
from first appearance would silently reshuffle the whole header the day a
sheet is added in the middle. Checked both ways, like every other list here —
a sheet naming an undeclared group, a declared group no sheet uses, and an
ungrouped sheet in a grouped document are all build errors, not a tab that
quietly appears or quietly does not. A group is display structure only: it
appears in no review target, so grouping an existing document orphans no
finding.

**`label:` is what a reader sees; the sheet's NAME is its identity.** The
name keys every review target, diff and CLI message, so a tab can be renamed
in either language without orphaning a finding filed against it. Nothing sets
the in-sheet heading levels (`h3`/`h4`/`h5`) — those follow the category tree's
depth, so shaping the tree with `category:` / `group_by:` / a dictionary's own
`group:` is how you shape the headings.

**Ghost tabs.** Once a sheet declares `categories:`, any category actually
used that isn't on the list — almost always a typo in some param's
`category:` — fails the build (naming the sheet/key/category, plus a "did you
mean" hint), instead of silently opening a new tab. This is a real,
previously-unguarded bug: `category: Generl` (a typo of `General`) used to
produce a third, silent tab with `verify: 2 ok, 0 warn, 0 error` — no error,
no warning, nothing. A sheet that never declares `categories:` is unconstrained,
exactly as before: categories appear in first-appearance order. Rows a
dictionary `materialize:` adds (see "Materializing" below) are exempt — a
dictionary's own `group`s were never something the declared list was meant to
enumerate.

**Use `sheets:` whenever more than one sheet in the spec reads from a shared
source** (a group_vars file two Ansible roles both read, a static file two
sheets both draw from) — that is exactly the situation a flat `params:`
cannot tell apart. A flat table is ONE namespace for the whole spec: if two
sheets happen to draft the same key (typically because an `include`/`exclude`
filter on one sheet missed something), the flat table answers "does this key
have a category/description" with no notion of WHICH sheet is asking, so the
leaked key can pick up the OTHER sheet's category/description and file in
looking legitimate — no error, nothing to notice. This actually happened: a
`httpd_server_name` variable leaked from an httpd role's overlay into a
Keycloak sheet's drafts (both read the same `group_vars` file) and picked up
the httpd section's `category: General` from a flat `params:`. With
`sheets:`, the leaked key finds nothing under the *Keycloak* sheet's own
table and trips the ordinary "no category"/"no description" build failure
instead, naming the offending sheet.

**The one rule: no mixing.** A file that has `sheets:` must not also have a
top-level `params:` — `loadProjectMeta` rejects it. There is no flat fallback
under `sheets:`; every param must be under its own sheet's `params:`, or the
cross-sheet leakage `sheets:` exists to close comes right back for whatever
slipped into the top level.

Do not mirror the assembled output's `sheets[] > categories[] > params[]` tree
here — that is the shape review-sheet *produces*, not the shape you author (a
`sheets:` doc still has only one level under each sheet name, `params:`, not
the output's nested `categories[]`). A key that never shows up in any sheet is
reported after `import` — scoped to the sheet it was declared under when the
doc uses `sheets:` — so a typo or a renamed key surfaces instead of silently
doing nothing. A `sheets:` doc naming a sheet the build has no sheet for (a
stale name, a typo) is also a build error.

`--project` only applies to `import -f`. Under `--spec`, declare it in the
spec's `enrich:` block (passing the flag anyway is an error, not a no-op).

Notice `httpd_listen` above names only `category` — no `dict_key`. Most
parameters never need one; see the next section for why, and for the rare
case where you do write one.

### Binding project keys to a dictionary

Declaring `dictionaries:` on a SHEET in `build.yml` (see "Authoring a product
dictionary" below for the document itself) does not, by itself, connect any
particular parameter key to any particular dictionary entry. That connection
is resolved once per build, **per sheet** — a key is only ever matched
against the dictionaries ITS OWN sheet declares, never a sibling sheet's, so
two sheets bound to different products can never cross-match by accident —
for every parameter, by `bindKey()` (`src/bind.ts`): the single place a
project key is ever matched against a dictionary key. It tries five tiers, in
this order, and stops at the first one that produces exactly one match:

| Tier | What it tries | Example |
| --- | --- | --- |
| `alias` | the project's own `dict_key`, verbatim | `dict_key: smtpServer.host` |
| `exact` | the raw key IS a dictionary key | `ServerName` → `ServerName` |
| `prefix` | the binding's `key_prefix` stripped | `httpd_server_name` (with `key_prefix: httpd_`) → `server_name` |
| `leaf` | the last identity segment of a structural path | `attributes["saml.client.signature"]` → `saml.client.signature` |
| `normalized` | any candidate above, with `_`/`-`/`.` stripped and casefolded | `httpd_timeout` (prefix-stripped: `timeout`) normalizes to `timeout`, matching dictionary key `TimeOut` |

**Write `sheet.yml` in that order too — start with nothing declared, build,
and only add what the build tells you is missing:**

1. **Build first, with no `dict_key` anywhere.** `exact`, `prefix`, and
   especially `normalized` resolve most of a real project's keys with zero
   declarations — `normalized` is what lets `httpd_timeout` find `TimeOut`
   on its own, and an Ansible role's `httpd_server_name` find `ServerName`,
   with nothing written down.
2. **Declare `key_prefix` before you declare any `dict_key`.** A prefix is a
   statement about *this project's naming convention* (`httpd_`, `SSO_`), not
   about the product, and one line covers every key that shares it — cheaper
   and more legible than repeating the same relationship as N separate
   aliases.
3. **Only write `dict_key` for a true rename** — one that survives
   normalization and still doesn't match. `SSO_SMTP_HOST` vs. the dictionary's
   `smtpServer.host` is real: the env var elides "Server", so no amount of
   stripping delimiters and casefolding makes the two strings equal. That is
   genuine information a human has to assert:
   ```yaml
   params:
     SSO_SMTP_HOST: { category: SMTP, dict_key: smtpServer.host }
   ```
4. **Use `dict_key: null`** — not omitting the field, an explicit `null` — to
   sever a key from a dictionary match it would otherwise get, when a key
   coincidentally collides with an unrelated entry. It short-circuits binding
   entirely: no tier is even tried, unlike an omitted `dict_key`, which just
   skips the `alias` tier and proceeds through `exact`/`prefix`/`leaf`/`normalized`
   as usual.

The `normalized` tier exists because a delimiter or casing difference between
two spellings is wiring, not information — and wiring should not need a line
of YAML to state. The flip side is the organizing principle: **normalization
that makes two spellings equal erases wiring; normalization that does NOT
make them equal, so a human wrote an explicit alias instead, is preserving
real information.** `SSO_SMTP_HOST` / `smtpServer.host` sits on the
information side; `httpd_timeout` / `TimeOut` sits on the wiring side.

That second case is not hypothetical. Apache's own directive is spelled
`TimeOut`; a real project's hand-written dictionary and its `dict_key` alias
had both spelled it `Timeout` (lower-case `o`) instead — an exact-match alias
doesn't care which side is "correct", so the two wrong spellings quietly
agreed with each other for years. Normalized matching closes that hole
structurally: `httpd_timeout` and `TimeOut`/`Timeout` all collide under
stripped/casefolded comparison regardless of which spelling a human actually
used, so there is no longer a way to write an alias that silently agrees with
a typo. (The corresponding fix, if you find one of these in the wild: correct
the dictionary entry's own key, not the alias — the alias is usually the
symptom, not the cause.)

An **ambiguous** match — the same tier hitting more than one distinct
dictionary entry — is always a build error, never a silent first-source-wins
pick: an unnoticed wrong pick here is exactly the failure mode (a wrong
description quietly attached to the wrong parameter) all of this exists to
prevent.

#### Reading the binding report

`import --spec` reports every binding decision, so you can verify — rather
than guess — which tier resolved which key:

- A per-method tally always prints to stderr: `bindings: 0 alias, 3 exact, 0
  prefix, 0 leaf, 16 normalized, 0 none`.
- Every `normalized` row — the one tier where a guess, not a literal or a
  declared alias, decided the binding — prints to **stdout**, one per line,
  unconditionally: `normalized: httpd configuration > httpd_timeout ->
  httpd@2.4:TimeOut`. These are the rows worth a glance on every build; a CI
  job that wants "did any new inference appear" greps stdout, never stderr.
- `--bind-report <file>` additionally writes every row (not just
  `normalized`) plus the method tally as JSON, for diffing build-to-build.

#### When a build fails: scaffold instead of guessing

A strict failure (no category, no description, or a project metadata key that
never appeared in any sheet) already names every offending key. `import
--spec` goes one step further and prints a **paste-able fragment** for
`sheet.yml` on that same failure, with a comment naming any dictionary entry
the key already binds to (so you know a description will show up for free,
and don't duplicate it) — placeholders are the literal string `TODO`, never
an empty string, so pasting it in and rebuilding surfaces exactly what still
needs a human's attention rather than failing strict again with no new
information.

The fragment's shape matches the **target `sheet.yml`'s own shape** — never
how many sheets the current failure happens to span. A project metadata file
already using `sheets:` always gets a `sheets: <name>: params:` fragment back,
even when this one failure only ever names a single sheet (with a leading
comment pointing out that it merges into that sheet's existing block, not a
second top-level `sheets:` key); a flat `params:` file always gets a flat
fragment back. Pasting a flat fragment into a `sheets:` file would trip
`loadProjectMeta`'s own "`sheets:` and top-level `params:` cannot both be
set" check — so the earlier rule (shape follows the failure's own span) could
hand back a fragment that fails the moment you paste it in, the moment a
multi-sheet project's failure happened to be scoped to just one sheet. When
`sheet.yml` doesn't exist yet (the very first `import --spec` run on a new
project), there is nothing on disk to match: a single-sheet spec gets flat, a
multi-sheet spec gets `sheets:` right away, on the reasoning that any two
sheets sharing a source file will need it eventually anyway (see "Use
`sheets:` whenever more than one sheet reads from a shared source" above).
`--scaffold <file>` additionally saves a copy; the fragment always prints to
stdout regardless. For example, a single-sheet project with three
undocumented keys and no dictionary bound at all fails like this:

```
$ review-sheet import --spec build.yml
Error: assemble: 3 parameter(s) have no category:
  app > ghost_one
  app > ghost_two
  app > ghost_three
params:
  # no dictionary match — write a category and description here
  "ghost_one":
    category: TODO
    description:
      en: TODO
      ja: TODO
  ...
```

An unused project metadata key (declared in `sheet.yml`'s `params:` — or, under
`sheets:`, in one sheet's own `params:`, in which case the message names that
sheet — but no sheet ever produced it) prints as a comment checklist instead —
the fix there is deletion or a spelling correction, not a new `params:` entry,
so the scaffold deliberately does not offer an addable block for it.

#### `--interactive`: resolve a scaffoldable failure at the terminal instead

**Off by default** — plain `import` (with or without `--spec`) behaves exactly
as described above, whether or not `--interactive` exists. Pass `--interactive`
to resolve a "no category" / "no description" failure right there instead of
pasting the scaffold in by hand:

```
$ review-sheet import --spec build.yml --interactive

httpd reverse proxy > httpd_health_check_path   (no dictionary match)
  Category:
    1) Reverse proxy
    2) General
    3) KeepAlive
    4) MPM
    n) create a new category
    s) skip
  >
```

Pick a number, or `n` to create a new category (appended to that sheet's own
`categories:` — the tab order — so it is chosen once and offered to every
later question in the same run). `s` skips the parameter entirely and moves
on. A description prompt (English, then Japanese) follows when one is
missing; leave it blank to keep the placeholder `TODO` rather than being
forced to write it now. Answers are written straight back into the project
metadata file (`--project`, or `--spec`'s `enrich.project`), preserving every
comment, and the build is retried once automatically. Whatever you skipped
(or ran out of terminal for) reappears as the ordinary scaffold on that retry,
with a non-zero exit — nothing is left half-silent.

**Incremental search** at the category prompt: type text instead of a number
and it narrows the list shown next (case-insensitive, prefix matches first),
re-numbered from 1. A blank Enter while narrowed clears back to the full
list; a query matching nothing is treated the same as any other unparseable
input (re-asks, flagged). Picking by number still works exactly as before —
search only kicks in for input that isn't a valid number, so a short list is
a completely unchanged experience.

**Bulk apply**: once a category is picked for one entry, and its key carries
a structural identity predicate (`clients[clientId=poc-oidc].publicClient`,
the `[field=value]` syntax `structural.ts` paths use), every OTHER
still-open entry sharing that same predicate is offered the same category in
one shot:

```
  clients[clientId=poc-oidc].publicClient → "Client: poc-oidc" に割り当てました

  同じパターンの未解決キーが 6 件あります:
    clients[clientId=poc-oidc].*
      clients[clientId=poc-oidc].standardFlowEnabled
      clients[clientId=poc-oidc].directAccessGrantsEnabled
      clients[clientId=poc-oidc].rootUrl
      … 他 3 件
  すべて "Client: poc-oidc" にしますか？ [y/N/l=一覧を全部見る]
```

The pattern, match count, and a sample of the actual matching keys are
always shown before anything is applied (`l` lists every match); the default
is "no" (bare Enter declines). Accepting fills the CATEGORY only for every
match — description is never bulk-applied (it asks per entry, same as
always), since a real description differs row to row. Declining leaves every
match to its own individual question, same as before this existed. The
pattern is deliberately conservative: it is derived ONLY from a structural
`[field=value]` predicate, cut at the FIRST one in the key, so everything
under that entity (however deeply nested) groups together — a bare key with
no such predicate (`httpd_keep_alive` vs `httpd_keep_alive_timeout`) is never
turned into a pattern at all, because there is no unambiguous place to split
it and a wrong guess would silently miscategorize real rows.

**Requires a real interactive terminal**: `--interactive` needs stdin AND
stdout to both be a TTY. Without one, it fails immediately with an explicit
error rather than hanging or silently behaving as if the flag were absent —
this is what keeps a CI job or an agent's shell safe: omitting `--interactive`
(the default) is unaffected either way. An unused project-metadata key is
never something `--interactive` offers to fix (deleting an entry, or
correcting a typo, is a `sheet.yml` edit no menu can guess) — it still only
ever prints as the advisory comment checklist above.

### Authoring a product dictionary

A dictionary is `metadata/<product>@<version>.yml`, optionally joined by a
hand-authored `<product>@<version>.overlay.yml` next to it (see "Translations:
the overlay file" below) — bound to a SHEET's key namespace from that sheet's
own `build.yml` declaration:

```yaml
sheets:
  - name: httpd configuration
    recipe: ansible
    ...
    dictionaries:
      - product: httpd
        version: "2.4"
        key_prefix: httpd_        # optional: strip before looking the key up
```

Treat it as a **shared asset**, versioned per product release and reusable by
every project that deploys that product. That drives the split:

- **About the product** → the dictionary: descriptions, documented defaults,
  types, `docs_url`, translations, the product's own grouping.
- **About this project** → `sheet.yml`: which category a parameter is filed
  under, `out_of_scope` exclusions, project-specific remarks, and — only for a
  true rename normalization can't bridge — a `dict_key` alias (see "Binding
  project keys to a dictionary" above).

Wording you wrote yourself, with no product statement behind it, still belongs in
the dictionary — but mark it (see provenance below) so the document's own claim
never vouches for it.

The document, and one entry:

```yaml
product: httpd            # required
version: "2.4"            # required — quote it, YAML reads 2.4 as a number
provenance: official      # default for entries that do not set their own
coverage: partial         # full | partial (default) — see "materialize" above
generated_by: "manual transcription of httpd.apache.org/docs/2.4"
docs_url: https://httpd.apache.org/docs/2.4/
parameters:               # required
  TimeOut:               # the product's OWN spelling, verbatim
    label:                # what the product CALLS it where a human meets it
      en: Timeout
    description:          # string, or a { en, ja } block map
      en: Seconds the server waits before failing a request.
      ja: リクエスト失敗と判断するまでの待機秒数。
    default: "60"         # the PRODUCT's documented default, not this project's
    type: string
    scope: server config, virtual host   # WHERE/WHEN the setting applies
    group: General                       # the PRODUCT's own grouping
    ui: editable                         # how the product's own admin UI exposes it
    options:                             # the values it may take, if enumerated
      - { value: "60", label: { en: One minute } }
    docs_url: https://httpd.apache.org/docs/2.4/mod/core.html#timeout
    provenance: community                # per-entry override — see below
```

Everything except `product`, `version` and `parameters` is optional, and a
parameter whose description is all you have is a perfectly good entry.

**The file is schema-validated** (`src/schema/dictionary.schema.json`) when it
is loaded, so the fields above are the whole vocabulary: an unknown one is a
hard error naming it, with a "did you mean" hint. That is deliberate — the
check used to be three `typeof`s and a cast, which made a misspelled field a
silent no-op: the value never arrived, the row rendered without its default or
its group, and the strict-metadata gate blamed the project for a description
the dictionary was in fact supplying under a typo. `description`/`label` and
every per-language `provenance` accept only `en`/`ja`, for the same reason.
`kind: container` may not carry a `default` — a container has no value of its
own, so what looks like its default is the empty shape of what it holds, and
that is an object where only a scalar belongs.

#### `DictionaryParam` fields

- `label` — what the PRODUCT calls this setting where a human meets it: an
  admin console's field label, a directive's own display name (`LangText`, so
  a console that ships translations carries both). Display only, and never
  identity — the key is what verify/apply resolve by, two settings may
  legitimately share a label, and a product's UI wording changes while its
  key does not. Useful exactly where the key is not something a reviewer has
  ever seen: `attributes["saml.signature.algorithm"]` versus 「署名アルゴリズム」.
- `description` — the product's own words for what the setting does (`LangText`:
  a string, or a `{ en, ja }` block map — see "Multilingual prose" above).
  Enriched onto the parameter and displayed as-is.
- `default` — the **product's** documented default, not this project's
  configured value. Write it in the same units a human reads on the sheet
  (`128MB`, not a raw byte count) so it is comparable to the value column at a
  glance. Omitted means "no documented default" — `materialize` excludes such
  an entry by default (see the no-default gate discussed above, with
  `materialize:`), so a documented default here is what actually gets that
  directive into the ledger, not just a description.
- `type` — a free-text hint of the value's shape (`string`, `int`, `boolean`
  are what the shipped dictionaries use). There is no fixed enum; pick
  whatever the source data gives you and stay consistent within one
  dictionary rather than inventing a taxonomy.
- `scope` — **where/when** the setting applies, in the product's own terms
  (Keycloak's build-time vs runtime, an httpd directive's valid contexts, a
  PostgreSQL parameter's `context` — superuser/sighup/postmaster). Documentation:
  enriched onto the parameter and shown in the sheet.
- `group` — the **product's own grouping** of its parameters (PostgreSQL's
  `pg_settings.category`, Keycloak's `Options` class). Structure, not
  documentation: `resolve()` never returns it, so it can never overwrite a
  category the project set explicitly; the assembler reads it directly as the
  category fallback for any row that binds to a dictionary entry and has no
  project `category:` of its own (see "Binding project keys to a dictionary"
  above) — flat, as a single top-level tab named after `group` (or
  "Uncategorized" if the entry has none), same as a project-declared category.
  A **materialized** (`origin: "default"`) row is the one exception: it nests
  two levels deep instead (see "materialize" above), because there can be
  hundreds of them and a flat tab per `group` does not scale the way it does
  for the handful of rows a project actually sets values for. Either way,
  `sheet.yml`'s `category:` is a **presentational** override, not a
  requirement — write it to file a bound parameter somewhere other than the
  product's own grouping, or to categorize a parameter with no dictionary
  binding at all (a hard error without one). This is the field easiest to
  confuse with `scope` — the test is "does this describe the setting, or
  does it file the setting": the former is `scope`.
- `options` — the values the setting may take, as a list of
  `{ value, label? }`. `value` is the **stored** form, verbatim — what a config
  file holds — and `label` (`LangText`) is what the product's own UI calls it.
  This exists because the two are not always the same string: Keycloak's LDAP
  search scope is written `1` or `2` through the API and shown as "One Level" /
  "Subtree" in the admin console, so a reviewer who only ever configured it
  through that console meets a bare `1` on the sheet and cannot judge it. The
  viewer shows the label BESIDE the value (and beside the default, since an
  unset row is judged by what applies to it) and never folds it in: that same
  string is what a review opens with, what the copy button yields and what
  `apply` writes back, so `1 (One Level)` reaching it would put that text into
  a deployed file. A value no option lists gets no annotation rather than a
  guess — a dictionary is pinned to one product version and a deployment may
  run another.

  `label` is optional, which is how the same field carries the other half of
  what an enumerated setting knows: its **legal values**, for a product that
  lists them without naming them (PostgreSQL's `pg_settings.enumvals`, a
  Keycloak provider's `ProviderConfigProperty.options`). Two dictionaries had
  been folding those into the end of the product's own description as prose —
  an edit to the product's words that this field exists to stop.

  Extraction-owned like every other product fact: an overlay is refused it,
  because a community guess at which values are legal is indistinguishable
  from the product's own list.
- `docs_url` — a deep link to that **specific** setting's own doc anchor, not
  just the product's docs root; that is what makes "read more" useful from the
  sheet.
- `provenance` — per-entry override of the document-level claim, and — like
  `description` — per LANGUAGE: a plain `Provenance` scalar, or a `{ en?,
  ja? }` map when the two languages' wording genuinely comes from different
  places. See "Provenance" below for the exact resolution order, and why it
  deliberately does not fall back across languages the way `description`
  does.
- `kind` — `"value"` (default, omitted is fine) or `"container"`. Most of a
  product's option space has a value; a few entries are pure syntax (Apache's
  `<IfModule>`/`<VirtualHost>`, a block that only groups other directives) —
  "what is `<IfModule>`'s default?" has no answer. `materialize` (see above)
  skips `kind: "container"` entries instead of asserting a value they do not
  have, and reports the skip count so a full dictionary's composition (N
  value / M container) is never silently smaller than it looks. A container
  entry still documents anything KEYED by that name — e.g. httpd.ts's parser
  extracts an `<IfModule ...>` block's own test expression as a synthetic
  `IfModule` row, which resolves its description from this same entry.
- `ui` — `"editable"` / `"readonly"` / `"absent"`: how the PRODUCT'S OWN
  administrative UI exposes this parameter. Omitted means no claim, which is
  every dictionary predating the field and every product with no UI to speak
  of. **Only an extraction that can see the UI may set it** — it is exactly the
  kind of fact a person guesses wrong from a field name, so it belongs to a
  generator, and an overlay is refused it like every other product fact.

  It is a fact about the UI and deliberately NOT about writability: almost
  everything marked `absent` is still settable through the product's API,
  which is how a provisioning tool sets it. Saying "not configurable" would be
  a claim the dictionary cannot support.

  What review-sheet does with it applies to a row **nobody set**
  (`origin: "default"`) and to nothing else:

  | claim | a row the project sets | a row nobody set |
  |---|---|---|
  | `editable` | untouched | untouched |
  | `readonly` | untouched | kept, marked `out_of_scope` with review-sheet's own bilingual reason (a project's own `out_of_scope` still wins) |
  | `absent` | untouched | dropped, with the keys printed |

  The restriction is the whole point. A row the project writes is a real
  decision with a real source map, whatever the UI offers; what gets removed is
  only the assertion "the product default is in force here" for a parameter no
  reader could have chosen and none will find in the UI. `readonly` is the
  in-between case worth keeping: the reader DOES meet the value in the UI, so a
  missing row could not tell them why it is not reviewable — Keycloak's realm
  `notBefore` sits in a read-only box beside Set-to-now / Clear / Push, so it
  records an operation, not a decision.

**Provenance** records how much the wording is worth, and rides onto the
parameter as `extra.provenance` — but only when enrichment actually supplied the
description, so a hand-written description is never mislabelled as the product's.
Set it on the document, and **downgrade per entry** wherever that claim stops
being true:

- `official` — the product's own documentation or vendor statement.
- `extracted` — read out of the product itself (a `pg_settings` dump, reflection
  over an image's option classes). Prefer this over `machine`, which the type
  accepts but no shipped dictionary uses.
- `community` — a team or third-party wording with no product statement behind
  it.
- `project` — set automatically for anything the project's own `sheet.yml` says.

**It is per language** — `Provenance | { en?: Provenance; ja?: Provenance }`,
the same shape `description` already has — settable at both levels exactly
like `description` is: once on the document (the default every entry falls
back to), and overridden per entry wherever that default stops being true:

```yaml
# the real examples/ansible-basic/review-sheet/metadata/nginx@1.26.yml
provenance:
  en: official     # transcribed from nginx.org/en/docs
  ja: community     # this repo's own translation — nginx publishes no Japanese docs
```

One document-level line like this covers all 19 of that file's entries — the
natural extension of the existing "document-level default, per-entry
override" contract, not 19 identical per-entry overrides.

**Why this exists.** A description's two languages routinely trace to two
different sources, and a single scalar cannot say so — it has to pick one
answer for both. Before this shape existed, that was a real, measured
misreport, not a hypothetical one: `nginx@1.26` and `httpd@2.4` each declared
`provenance: official` for the WHOLE document while carrying a hand-written
Japanese translation on all 19 of their entries — neither vendor publishes
Japanese documentation, so `official` was true of the English and false of
the Japanese sitting right next to it. `keycloak@26.7.0` declared
`provenance: extracted` (a mechanical reflection over the server's own
option registry) over 28 entries whose Japanese text — and, for 10 of them,
the English too — a reviewer had hand-written, because Keycloak itself ships
no Japanese and does not document those 10 keys in any language; `extracted`
was never true of a single one of those 28 strings. Neither dictionary was
lying on purpose — the model simply had no way to say "English from the
vendor, Japanese from us" — so **check your own dictionaries for this same
shape**: any file where `ja` was added by hand onto an `official`/`extracted`
document is currently over-claiming for every language it didn't actually
get from the product.

**Resolution, per language, four tiers, each checked in full before falling
through to the next** (`provenanceFor`, `src/providers/dictionary.ts`):

1. the entry's own provenance MAP's key for this language
2. the entry's own provenance SCALAR (claims every language)
3. the document's provenance MAP's key for this language
4. the document's provenance SCALAR (claims every language)
5. `"community"` — the safe default when nothing above says otherwise

This is deliberately **not** the fallback `description` gets from `pickLang`
(types.ts). `pickLang` shows the OTHER language's text when the target
language has no prose of its own — right for prose, because showing
something beats showing nothing. Provenance is a trust claim, not prose: the
origin of a Japanese translation is never answered by the origin of the
English text sitting next to it in the same entry. An entry's
`provenance: { en: official }` (silent on `ja`) falls through to the
DOCUMENT's own default for `ja` — never sideways to read the entry's own
`en` value — because reading it sideways would let a document that is
honest about its English silently vouch for a Japanese translation it never
made a claim about (exactly the keycloak `db` case: `en` has no entry
override, so it reads the document's `extracted`; `ja` is a hand-written
`community` override that must never borrow `en`'s claim).

This is also the one to set per entry when it disagrees with the document:
an `extracted` dictionary whose Japanese, or whose gap-filling English, you
wrote yourself needs `provenance: community` (or, when only one language
needs it, `{ ja: community }`) on those entries specifically, so the
document's `extracted` claim keeps covering only what was genuinely
extracted. On the sheet, a uniform result still renders as today's bare
token (`extracted`); a genuine split renders both in a fixed order:
`en: extracted / ja: community`.

`provenance` and `coverage` are independent axes, and it is easy to conflate
them: `provenance` is about how much the **wording** is worth, `coverage` is
about how much of the **product** is in the file. A dictionary can be
`official` wording at `partial` coverage (a person transcribed a dozen
directives correctly from the docs) or `official` wording at `full` coverage
(a mechanical parse of the docs' own generated index — see below) — the same
document-level `provenance` says nothing about which.

#### Coverage: `full` or `partial`?

`coverage: full` is a claim that `parameters` **enumerates the product's own
option space** — every directive, every GUC, every config key the product
ships — not a claim about how well each entry is written up. It exists because
`materialize` (see "Level 1" above) turns every key the dictionary has that the
project does not set — and that carries a documented `default` (see the
no-default gate above) — into an `origin: "default"` row, i.e. a claim to the
reviewer that "this is everything the product defaults to." That claim is only
true if the dictionary really is exhaustive; a dictionary of a dozen hand-picked
settings materialized
the same way produces a sheet that *looks* like a full inventory while quietly
omitting everything nobody happened to transcribe. `dictionaryCoverage()`
(`src/providers/dictionary.ts`) and `materializeDrafts()` (`src/assemble.ts`)
enforce this mechanically: `coverage` other than the literal string `"full"` —
including the field simply being absent — fails `materialize` with an error
naming the sheet and the dictionary.

The bar for `full` is **mechanical enumeration**, not manual completeness. Ask:
did a person choose which settings to include, or did a machine walk the
product's own list of them? The two generation scripts under `examples/`
answer this differently for the same reason:

- `examples/ansible-keycloak/review-sheet/metadata/extract/` reads Keycloak's
  own `PropertyMappers` registry inside the official container image — the
  registry the server itself consults to decide whether a `kc.*` key exists,
  so nothing is selected and nothing the server accepts is left out.
- `examples/ansible-basic/review-sheet/metadata/normalize-pg.ts` normalizes a
  `SELECT * FROM pg_settings` dump — PostgreSQL's own enumeration of every GUC
  the running server knows about.

Both are `coverage: full`. `examples/ansible-httpd/review-sheet/metadata/httpd@2.4.yml`
is `coverage: partial` even though it was written from the same official docs
Apache publishes, because a person picked which 18 of httpd's ~700 directives
to transcribe — a hand-picked subset stays partial no matter how faithfully
each entry is written.

**When in doubt, `coverage: partial` (the default when the field is omitted).**
Nothing breaks by staying partial — `enrich()` still fills descriptions for
every key the dictionary happens to have — you only lose the ability to
`materialize`. Declaring `full` incorrectly is the failure mode that matters:
it ships a sheet that asserts completeness it does not have, and nothing
downstream can tell a fake full inventory from a real one once it is rendered.

#### Building a `full` dictionary

The shape is the same across products even though the source differs:

1. **Pull the option list out of the product itself, mechanically.** Something
   that *enumerates* the product's real option space, not a curated read of the
   docs:
   - the product's own key registry inside its container image
     (`extract/Extract.java` — Keycloak's `PropertyMappers`, the lookup the
     server resolves every `kc.*` key against);
   - a dump of the product's own settings/catalog table (`normalize-pg.ts` —
     `pg_settings`, which every running PostgreSQL server exposes);
   - an exhaustive `--help`, or a machine-readable schema the product ships
     (an OpenAPI/JSON-schema doc, a generated CLI reference);
   - a documentation build's own **generated index**, when the product's docs
     are themselves built from structured source rather than hand-written
     prose. Apache httpd's `mod/quickreference.html` is generated by the docs
     build from the same XML source as every module page (the page says so:
     "This file is generated from xml source: DO NOT EDIT") and lists all
     ~700 directives as one HTML table — name, syntax, default, valid
     contexts, and module — so a mechanical parse of that one page is a
     genuine full extraction (confirmed while writing this section: parsing
     it yields 729 directives with `coverage: full` accepted by
     `materializeDrafts`, versus the 18 in `httpd@2.4.yml`). This is
     `provenance: official` (the wording is Apache's own) at `coverage: full`
     (the parse is exhaustive) — the two axes really are independent, per
     above. This was **not** wired into `examples/ansible-httpd/` — the
     existing partial `httpd@2.4.yml` there is deliberately left alone; this
     is a feasibility note, not a recommendation to replace it.
2. **Write a normalizer, not a converter you eyeball.** A small per-product
   script reshapes whatever step 1 produced into a typed `DictionaryDoc` and
   calls `renderDictionary()` (below) — so it is re-runnable after every
   product upgrade and a wrong field is a compile error, not a silently
   ignored key.
3. **Commit the raw extraction output**, not just the rendered dictionary
   (`examples/ansible-keycloak/review-sheet/metadata/keycloak-defaults-26.7.0.json`
   is the reflection output `build-dict.ts` reads). This is what lets the
   dictionary be regenerated — and diffed, and audited — without a working
   Docker toolchain on hand; `normalize-pg.ts` instead documents the exact
   `docker run` invocation to reproduce its input, since a live `pg_settings`
   dump is impractical to freeze as a fixture.
4. **Set `provenance: extracted`** on the document, and `generated_by` naming
   the extraction method precisely enough that someone else could reproduce
   it (`"extract/extract.sh — PropertyMappers registry in
   quay.io/keycloak/keycloak:26.7.0"`, not just `"reflection"`).
5. **Cross-check the enumeration against a second channel of the product's,
   and state what is still outside it.** This step is not optional pedantry —
   it is what separates a real `full` claim from one that only feels
   mechanical. This example's dictionary was `coverage: full` at 170 keys for
   months: the extraction reflected over a *hardcoded list* of
   `org.keycloak.config.*Options` classes, so it silently omitted eight whole
   classes (`management-*`, `bootstrap-admin-*`, `config-keystore-*`,
   `telemetry-*`, …) plus every wildcard key (`db-username-<datasource>`,
   `log-level-<category>`), which are built at mapper-registration time and
   exist in no Options class at all. Nothing failed; the sheet just quietly
   stopped being an inventory. Diffing the extraction against
   `kc.sh start --help-all` / `build --help-all` is what surfaced it, and the
   check still runs both ways: help lists nothing the extraction misses, and
   the extraction's extra keys are exactly the ones help hides.
   Then say in the dictionary header what the extraction genuinely cannot
   cover — for Keycloak, `spi-<spi>-<provider>-<property>`, which is
   open-ended because each deployed provider defines its own. A stated gap is
   a gap a reader can reason about; an unstated one makes `full` a lie.

Real extraction output is rarely already dictionary-shaped, and the
non-obvious parts of `build-dict.ts` are worth reading before writing your
own normalizer, because each fixes a real mismatch rather than a hypothetical
one:

- **Category → `group` mapping.** The extraction reports Keycloak's
  raw Java enum names (`DATABASE_DATASOURCES`, `HOSTNAME_V2`); `GROUP_LABEL`
  maps them to headings a reviewer reads on the sheet ("Database / Named
  datasources", "Hostname"), with an automatic title-cased fallback for a
  category a future Keycloak release adds that the map does not yet know
  about — an unmapped category degrades to an ugly-but-present label instead
  of silently vanishing.
- **Unwrapping list-shaped defaults.** Keycloak renders a multi-valued
  option's default in Quarkus list syntax (`log`'s default extracts as
  `"[console]"`), but `keycloak.conf` itself takes the bare, comma-separated
  form. Left as `"[console]"`, the sheet would compare a real config value
  (`console`) against that bracketed default and report it as changed when it
  is not — `normalizeDefault()` strips the brackets so the default is
  comparable to what actually appears in config.
- **No `description` at all for entries the product ships no text for —
  and leave it that way.** The extraction returns an empty string for eight
  keys Keycloak never documents (`db-dialect`, `db-pool-acquisition-timeout`,
  three `log-*-enabled` toggles, three `telemetry-*-headers` keys, plus their
  two `<datasource>` wildcard variants); `build-dict.ts` writes those entries
  with no `description` field at all rather than inventing placeholder
  English of its own. The gap-filling English, and every Japanese
  translation, is the OVERLAY's job now (`keycloak@26.7.0.overlay.yml`, under
  its own doc-level `provenance: community` — see "Translations: the overlay
  file" below), not this script's: that split is what lets a translation be
  added with a YAML edit and no regeneration, and what stops regeneration
  from ever clobbering one.
- **Excluding what is in the registry but is not configuration** — and doing
  it by name. Four Keycloak keys are internal (two build switches, two
  placeholders `kc.sh export`/`import` set to signal their own mode). The
  tempting filter is "drop the hidden ones", which would also drop real
  options like `db-dialect`; `NOT_CONFIGURATION` lists the four instead, with
  a reason each, and `build-dict.ts` throws if any of them no longer exists
  upstream — so a rename after an upgrade fails the build instead of
  silently becoming a no-op exclusion. (The equivalent guard for the
  overlay's translation keys is no longer this script's job — the loader's
  own stale-key check, "Translations: the overlay file" below, runs it for
  every dictionary on every build instead of only at generation time.)

#### Building a `partial` dictionary

For most products a hand-picked subset from the official docs is the right
size — you only need descriptions for the settings your sheet actually
reviews, and a full mechanical extraction may not exist or be worth building.
`httpd@2.4.yml` is this: 18 directives transcribed from
`httpd.apache.org/docs/2.4`, one entry per directive the role's `defaults/main.yml`
and template actually set. Set `provenance: official` (correctly transcribed
from the vendor's own docs) and `generated_by` naming the source page(s);
`coverage` stays unset (defaults to `partial`) or is set explicitly for
clarity.

The one thing a partial dictionary cannot do is `materialize` — attempting it
fails loudly with the error from "Coverage" above, by design: a partial
dictionary genuinely does not know the product's remaining settings, so there
is nothing honest to expand. It still does everything else a dictionary does:
`enrich()` fills descriptions/defaults/`docs_url` for every key it covers, and
growing it over time (more directives transcribed as the project's sheets grow
to cover them) is a normal, incremental edit — it just never becomes the
"materialize this product's full option space" input until a genuine
mechanical extraction replaces it.

#### Translations: the overlay file

A translation — or any other hand-written prose about a product — is a fact
about the PRODUCT, not about this project: the next project that reviews the
same nginx/httpd/keycloak version should inherit it, not re-write it from
scratch. That is the same split this skill already argues for the dictionary
as a whole ("About the product" → the dictionary, "About this project" →
`sheet.yml`, at the top of this section) — it used to leave a translation
with nowhere honest to go. Writing it straight into a GENERATED base file
made that file's own `# GENERATED … do not edit by hand.` header a lie the
moment a human edited underneath it; writing it into `sheet.yml` privatized a
shareable asset and made every project translate the same product's
descriptions over again. The overlay is the third option: hand-authored,
shared like the rest of the dictionary, and safe across regeneration.

**When you need one, and when you don't.** A hand-authored dictionary with no
generator behind it — `nginx@1.26.yml`, `httpd@2.4.yml`, nobody's script
rewrites these — needs no overlay at all: a doc-level `provenance: { en: …,
ja: … }` map (above) is the entire fix, since there is nothing regenerating
the file out from under a hand-added Japanese line. An overlay earns its keep
only for the other case: a dictionary a script writes wholesale
(`build-dict.ts` → `keycloak@26.7.0.yml`), where a hand edit under the base's
own `# GENERATED` header would simply be overwritten the next time someone
re-runs the extraction after a product upgrade.

**File and fields.** `<product>@<version>.overlay.yml`, sitting next to the
base on any of the sheet's `metadata_dirs` — and more than one is legal, on
purpose: a project-local metadata dir can overlay a shared team dictionary
without forking it. An overlay entry may set only `description`, `docs_url`,
and `provenance` — documentation prose. `label`/`default`/`type`/`scope`/
`group`/`kind`/`ui`/`options` are refused outright (an "unknown field" error naming
it, with a "did you mean" hint for a close typo): those are product facts
the extraction owns, and letting an overlay set them would let a community
claim reshape `materialize`'s inventory ledger. A key the base doesn't have
is refused too — the base is the inventory; the overlay only annotates it,
never extends it.

**The merge is fill-only**, and it happens once, inside the loader
(`findDictionary()`, `src/providers/dictionary.ts`) — so `bind.ts`,
`materialize`, and the dictionary provider all see the already-merged result
with no change of their own. Per entry, per language: if the base (or an
earlier overlay) already has text for that language, it is an error, never a
silent overwrite —

```
the dictionary now supplies ja for "db" — drop it from the overlay.
```

— and a key the overlay names that the base no longer has is the same kind
of error, naming the key and suggesting the nearest real one:

```
overlay names a key keycloak@26.7.0 no longer has: "db-charset" — renamed
or removed upstream; fix or drop it.
```

**Why regeneration can't destroy a translation.** The generator writes only
the base and does not know overlays exist — `build-dict.ts` never reads
`keycloak@26.7.0.overlay.yml` — so re-running it after a Keycloak upgrade
cannot silently drop a hand-written translation; the safety comes from the
generator physically not owning that file, not from anyone's discipline
about which file they edit. The reverse hazard is caught the same way, in
the opposite direction: if the product starts shipping a language the
overlay had been filling, the very next build fails loudly, naming every
offending key with the fix spelled out (drop it from the overlay) — never a
stale community translation silently shadowing the product's newer official
text.

**On a version upgrade**, rename the overlay alongside the regenerated base
(`keycloak@26.7.0.overlay.yml` → `keycloak@26.8.0.overlay.yml`); the first
build against the new base re-runs the stale-language guard over every
carried-over translation. That rename IS the review checkpoint — there is no
separate "re-audit the translations" step to remember.

**Worked example**, the real `db` entry
(`examples/ansible-keycloak/review-sheet/metadata/`):

```yaml
# keycloak@26.7.0.yml — GENERATED by build-dict.ts, English only
parameters:
  db:
    description: The database vendor. In production mode the default value of 'dev-file' is deprecated, you should explicitly specify the db instead.
    default: dev-file
    scope: build-time
    group: Database
    docs_url: https://www.keycloak.org/server/all-config
```

```yaml
# keycloak@26.7.0.overlay.yml — hand-authored, never written by build-dict.ts
provenance: community
parameters:
  db:
    description:
      ja: 使用するデータベースベンダー。本番モードでは 'dev-file' 既定は使わず明示指定する（build 時に確定）。
```

After the merge, `db`'s `en` still falls through `provenanceFor`'s tiers to
the base document's own `extracted`; only `ja` carries the overlay's
`community`. The row's `extra.provenance` reads `en: extracted / ja:
community` — not the single `extracted` that, before this file existed,
vouched for a translation Keycloak never wrote.

#### `renderDictionary()`

A dictionary is normally produced by a small per-product script that reshapes
whatever the product yields (see above); those scripts are product-specific,
but the file shape is this package's — build a typed `DictionaryDoc` and hand
it to `renderDictionary()` so a wrong field is a compile error rather than a
silently ignored key:

```ts
import { renderDictionary, type DictionaryDoc, type DictionaryParam } from "review-sheet";

const parameters: Record<string, DictionaryParam> = {/* from the product's own output */};
const doc: DictionaryDoc = {
  product: "postgresql",
  version: "16",
  provenance: "extracted",
  coverage: "full",
  generated_by: "pg_settings dump from postgres:16",
  parameters,
};
process.stdout.write(renderDictionary(doc, { generator: "normalize-pg.ts" }));
```

The output is deterministic (no timestamps, `parameters` keys in the object's
own insertion order) and carries a `# GENERATED … do not edit by hand.` header
naming the generator, so regenerating after a product upgrade is an empty diff
unless the product actually changed. The top-level field order is always
`product`, `version`, `provenance`, `coverage`, `generated_by`, `docs_url`,
`parameters` — fixed by `renderDictionary()` itself, not by the order you set
them on `doc`, so every dictionary in a project reads the same way. Working
examples: `examples/ansible-basic/review-sheet/metadata/normalize-pg.ts` and
`examples/ansible-keycloak/review-sheet/metadata/build-dict.ts`.

### Custom metadata providers

A fourth source — an internal parameter catalogue, a docs API — is a
`MetadataProvider` with a `resolve(query, ctx)` returning the fields it knows
plus a `provenance`. Give it a priority relative to the table above, and register
it with `registerMetadataProvider` (see the plugin section for where the module
goes). Return `description` / `remarks` as the full `{ en, ja }` map, never
collapsed to one language — the viewer resolves the display language at render
time. `provenance` may be the same per-language shape (`Provenance | { en?:
Provenance; ja?: Provenance }` — see "Provenance" above) whenever your own
source's trust level genuinely differs by language; a plain scalar still
works unchanged when it doesn't. `resolveMetadata` credits each language of
`description` to whichever provider actually supplied that language's text
(not just whichever provider ran first), so a per-language `provenance` on
your result is read correctly even when another provider fills the other
language.

## Authoring source maps (the important part)

When you build `input.json` from existing configuration files, populate
`source` so changes can be applied precisely. **Open each real config file and
record the location as you read it** — that is the only moment the line numbers
and anchors are guaranteed correct.

Add `source` to a simple parameter's value, or to each instance (Pattern B):

```jsonc
{
  "key": "net.ipv4.tcp_fin_timeout",
  "value": "60",
  "source": {
    "file": "/etc/sysctl.conf",          // omit to inherit the nearest category/sheet file_path
    "line": 42,                            // 1-based line number
    "anchor": "net.ipv4.tcp_fin_timeout =" // a literal substring present ON that line
  }
}
```

```jsonc
{
  "key": "server.port",
  "instances": [
    { "name": "prod", "value": "8080",
      "source": { "file": "/etc/app/config.prod.yaml", "line": 17, "path": "$.server.port", "anchor": "port:" } },
    { "name": "dev",  "value": "8080",
      "source": { "file": "/etc/app/config.dev.yaml",  "line": 17, "anchor": "port:" } }
  ]
}
```

Rules:

- **`anchor` is what makes apply reliable.** It is a literal substring that
  appears on the value's line — normally the key plus its operator
  (`net.ipv4.tcp_fin_timeout =`, `port:`, `MaxClients `). Apply uses it to (a)
  confirm the line is the right one and (b) re-find the line if it has drifted.
  Without an anchor, the value cannot be auto-applied and is deferred to the AI
  prompt.
- Make the anchor **specific enough to be unique** together with the current
  value. If the same `anchor`+value appears on several lines, apply reports it
  as ambiguous and holds it.
- `line` is **1-based**. Include it whenever you know it; apply trusts it first,
  then falls back to the anchor.
- `file` may be omitted to inherit the nearest `category.file_path` or
  `sheet.file_path`. Set it explicitly when instances live in different files.
- `path` (JSONPath / YAML path / dotted key) is an optional structural hint for
  nested formats (YAML/JSON/TOML); it is informational for the apply step.
- **Only `value` is source-mapped.** `description`, `default`, and `remarks`
  describe the sheet itself, not deployed config — do not give them a `source`.

Then validate: `review-sheet validate -i input.json`.

## Applying a review

1. **Preview** (default dry-run): `review-sheet apply -i input.json -r review.json`.
   It prints a per-file diff of what it would change, plus a "Held" list of
   items it could not verify (no file, no anchor, ambiguous, or a documentation
   field).
2. **Write** the verified edits: add `--write`. Edits are idempotent — re-running
   skips values already at the suggested setting.
3. **Handle the held items** with `--emit-prompt`. This prints an English prompt
   (the same one the HTML "AI" button produces) describing the remaining
   changes and a resolution protocol. Follow it: open each file, locate the
   value by anchor or key, change only that value, and report anything you could
   not apply.

Apply only touches `value` changes that it can verify. Documentation-field edits
and comment-only notes are always left to the prompt so live config files are
never changed by mistake.

### Server mode — apply from the browser, no review.json round-trip

`review-sheet serve -i input.json` serves the sheet on `http://127.0.0.1:<port>`
(default 5173) and applies reviewed changes **directly to the local files**, with
no AI and no review.json export/import. It is the developer's local workflow (the
static HTML + review.json + CLI apply path stays for distributing to reviewers
who don't have the repo). The browser's "Apply to files" button:

1. previews every change as a per-file diff (dry-run — `POST /api/apply`,
   `write:false`), grouped by file, with held/out-of-scope shown separately;
2. on "Write" (`write:true`) writes the verified edits to disk via the same
   `computeApply` core the CLI uses — so `source_file`, `additional_sources`, and
   `out_of_scope` all behave identically;
3. offers the AI prompt for any held remainder.

It binds to `127.0.0.1` only and never writes until you click Write. Works in any
browser (the server holds the filesystem access, so there is no browser-API or
folder-permission requirement).

## Versions & diff

The tool does not store history — the user's VCS does. To let reviewers compare
points in time, **produce one model per revision and pass them all to
`generate`**:

```sh
# one model per point in time (e.g. from each git revision, via import or a script)
review-sheet generate -i model-1.0.json model-1.1.json model-1.2.json -o sheet.html
```

Each file is a normal single-version model. The snapshots are ordered by each
model's `metadata.generated_at` **date, not the argument order** — set it to the
commit date so the timeline is correct regardless of how the files are passed
(the version label comes from `metadata.version`, falling back to the file name).
The sheet then shows a version switcher and a Compare mode that diffs any two
versions cell by cell (including per-instance values).

For programmatic assembly you may instead pass a single document with an explicit
`versions: [{ version, date, tags, sheets, ... }]` array (its order is preserved).
A plain single-`sheets` input still works and is shown as one version.

`review-sheet diff -i base.json -i current.json` answers the same question on the
command line — it prints the differing rows on **stdout** and the
`N changed, …` summary on **stderr**, so a CI job capturing `$(review-sheet
diff …)` gets an empty string when nothing changed, which is indistinguishable
from the command having failed. For anything automated use `--format json`
instead: one document on stdout, summary included, nothing on stderr.

```sh
review-sheet diff -i base.json -i input.json --format json |
  jq -e '.summary.changed == 0'   # exits non-zero when something changed
```

`{ summary, excluded, sheetsOnlyOnOneSide, rows[] }`, where each row is `{ sheet,
category, key, status, cells, fields }`. `excluded`/`sheetsOnlyOnOneSide` are
always present (zero/empty unless the equivalence flags below are set), so a
consumer never branches on whether the field exists. `--all` adds the unchanged
rows; a listed row always carries all of its cells.

Two sheets do not have to have the same shape to be compared. A parameter that is
Pattern A on one side (one shared value) and Pattern B on the other (one value per
instance) is compared by expanding the shared value across the instances, because
that is what Pattern A asserts. So a row saying the same thing in both comes out
`unchanged`, and only the instance that genuinely diverged is reported. This is
what makes the comparison usable beyond successive revisions of one sheet — during
a staged migration you can diff the old platform's sheet against the new one and
read the result as an equivalence check.

### Equivalence checks: two different sheets

Comparing two *different* sheets — e.g. the same system's EC2 form against its
ECS form, mid-migration — has two sources of noise plain `diff` cannot tell
apart from a real difference:

- One side may be materialized (see "Where a value comes from (`origin`)"
  above) into the product's full option space and the other not, so every
  `origin: "default"` row the materialized side carries reads as `removed`.
- A whole sheet may exist on only one side (no reverse-proxy sheet once an ALB
  terminates TLS directly) — that is a structural fact about the platform, not
  N individually removed parameters.

```sh
review-sheet diff -i platform-a.json -i platform-b.json --equivalence --format json
```

`--equivalence` is shorthand for `--exclude-default-origin` (drops materialize
rows from the comparison, counted in `excluded.defaultOrigin` — filtered, not
hidden) and `--sheet-presence` (reports a sheet present on only one side once,
as `sheetsOnlyOnOneSide: [{ name, onlyIn: "from" | "to", paramCount }]`, instead
of exploding its parameters into `removed`/`added`). Both flags work
independently too. On a real staged migration (Keycloak, EC2 vs. ECS) this took
`removed` from 181 to 6, with the exclusion stated rather than assumed:
`excluded: { defaultOrigin: 152 }`, `sheetsOnlyOnOneSide: [{ name: "httpd
reverse proxy", onlyIn: "from", paramCount: 23 }]`.

This only works when both sheets key their parameters against the product's own
configuration keys (a `keyMap`-resolved product key on every row, see "Custom
recipes" above) rather than each platform's delivery mechanism — which may need
a custom `recipe` or `parser` to reach.

Both sides are just files, so where the baseline comes from is your choice:
`git show <rev>:input.json` when the model is committed, or a rebuild from a
`git worktree` of that revision when it is not — see "When the generated files
are not committed".

## Why not just emit a sed script?

`apply` verifies the anchor (and current value) before editing and refuses on
mismatch, so it never silently corrupts an unrelated line — which a raw `sed`
substitution cannot guarantee (escaping, multiple matches, no verification,
`sed` dialect differences). When `apply` is not confident, it hands the work to
the AI prompt rather than guessing.
