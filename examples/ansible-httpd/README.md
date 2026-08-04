# ansible-httpd — review-sheet for an Apache httpd role

This example takes a small, real **Ansible** project (an Apache httpd role,
event MPM, with per-environment inventories) and shows how to put review-sheet
on top of it: a reviewable parameter sheet of **every setting the role
provisions**, source-mapped so reviewed values apply straight back into the
variable files.

It is deliberately **lean and review-sheet-focused** — no Molecule scenario, no
toolchain (`mise`/`uv`/`pyproject.toml`), no `validate.yml`. That whole
testing/toolchain pattern (Molecule on Red Hat UBI, `validate.yml` run
everywhere, staged rollout, lint/idempotence/drift layers) is demonstrated once,
in depth, in [`../ansible-basic`](../ansible-basic) — go there for it. Here,
generating the sheet only needs **bun**:

```sh
bun run ../../src/cli.ts import --spec review-sheet/build.yml -o input.json
```

## Quick start

1. **Start from a normal Ansible project** — a role + per-environment
   `inventories/<env>/group_vars` + a Jinja2 template, runnable on its own (see
   [The Ansible project](#the-ansible-project)). Nothing here is
   review-sheet-specific.

2. **Decide each value's `origin`.** Ansible variables (`defaults` +
   `group_vars`) are `common` (single value, Pattern A) or `overlay`
   (per-environment, Pattern B). Values hard-coded in the template are
   `embedded` — not backed by a variable, so changing one is a role/code
   change rather than a per-environment edit. All three are **in scope for
   review**, filed in the same functional categories. (See
   [What the sheet contains](#what-the-sheet-contains-three-origins).)

3. **Write the declarative build spec** `review-sheet/build.yml`. It names the
   built-in `ansible` recipe — no hand-written extraction code:
   - `defaults`/`overlays` → `common`/`overlay` params, each source-mapped to
     its file (Pattern A common / Pattern B per-environment);
   - `template` (`httpd.conf.j2`, jinja2, delegating to the httpd
     `<Tag>`/directive adapter) → `embedded` params, filed in the same
     functional categories as the variables;
   - `import --spec` runs `verifySources` before it writes `input.json`.

4. **Build + verify the sheet:**
   ```sh
   bun run ../../src/cli.ts import --spec review-sheet/build.yml -o input.json
   ```
   It prints `metadata: N parameter(s) enriched (…)` and `verify: … 0 error, 0
   unmapped, K out-of-scope` — every source map is checked against the real
   files before anything is written.

5. **Generate the HTML sheet:**
   ```sh
   bun run ../../src/cli.ts generate -i input.json -o sheet.html
   ```
   Hand reviewers the self-contained `sheet.html` (they annotate in the browser
   and export a `review.json`), or run the local UI that writes edits straight
   to your files:
   ```sh
   bun run ../../src/cli.ts serve -i input.json     # http://127.0.0.1:5173
   ```

6. **Apply reviewed changes back** to the real config:
   ```sh
   bun run ../../src/cli.ts apply -i input.json -r review.json           # dry-run
   bun run ../../src/cli.ts apply -i input.json -r review.json --write   # write
   ```
   `common`/`overlay` edits land in the right `group_vars` / `defaults` YAML;
   `embedded` edits land directly in `httpd.conf.j2` — a role/code change, not
   a per-environment value edit, but still a normal `apply` target like any
   other source-mapped value.

> In this repo the CLI is `bun run ../../src/cli.ts`; in your own project you'd
> install the `review-sheet` package and use its `import --spec` the same way.

## What the sheet contains (three origins)

Every parameter is **in scope for review** — `origin` records where its value
comes from, it is not a scope gate:

- **`common` / `overlay`** — the Ansible variables
  (`roles/httpd/defaults/main.yml` + each `inventories/<env>/group_vars/web.yml`).
  Each value source-mapped to its variable file so `apply` writes back there.
  `common` = a single shared value (Pattern A, e.g. `httpd_document_root`);
  `overlay` = per-environment columns (Pattern B, e.g. `httpd_server_name`,
  `httpd_max_request_workers`).
- **`embedded`** — directives hard-coded in `roles/httpd/templates/httpd.conf.j2`
  (parsed via the jinja2 adapter: `{{ var }}` directives resolve to the
  variables above and are skipped here; literals like `Include
  conf.modules.d/*.conf` are the `embedded` params). Filed in the *same*
  functional category as the variables (e.g. `Include` sits with the other
  General directives) and carries a `description` like any other parameter —
  changing one is a role/template change rather than a per-environment value
  edit, but it is not excluded from review.

`input.json` and `sheet.html` are generated artifacts (git-ignored); regenerate
with `bun run ../../src/cli.ts import --spec review-sheet/build.yml -o input.json`.

### Metadata providers

The `ansible` recipe itself only ever emits `key`/`value`/`source`(`/instances`)/`origin`
for every parameter — `description`/`default`/`remarks`/`docs_url`/`type`/`scope`
are filled in afterwards by `enrich()` (`src/enrich.ts`), from three metadata
providers, project-metadata-first:

- **project** (`review-sheet/sheet.yml`) — this project's own terms: which
  category each parameter belongs to (assembler-only, read via `loadProjectMeta()`),
  and a `dict_key` alias mapping each Ansible variable to its Apache directive.
  Wins over every other source.
- **argument-specs** (`roles/httpd/meta/argument_specs.yml`) — the role's own
  documented options (`httpd_max_request_workers`, `httpd_server_tokens`);
  community-grade, since it ships with the role.
- **dictionary** (`review-sheet/metadata/httpd@2.4.yml`) — a product-level
  parameter reference, hand-transcribed from the Apache docs (`provenance:
  official`), matched via each key's `dict_key` alias.

Unlike PostgreSQL in `ansible-basic` (`pg_<name>` → `<name>`, a mechanical
strip-the-prefix mapping needing **zero** aliases), Apache directives are
CamelCase (`ServerTokens`, `MaxRequestWorkers`) while Ansible variables are
snake_case (`httpd_server_tokens`, `httpd_max_request_workers`) — so **every
one of the 16 Ansible variables** needs an explicit `dict_key` alias in
`sheet.yml`. That's the honest efficiency trade-off of this naming convention
versus a `pg_`-style one.

Enrichment runs in **strict** mode by default: any in-scope parameter —
`common`/`overlay` variable or `embedded` literal alike — that ends up with no
description after all three providers run fails the build, naming the offender
(`sheet > category > key`); only params/categories carrying an explicit
`out_of_scope` (a review-remit exclusion — none in this example) are exempt.
`import --spec` prints `metadata: N parameter(s) enriched (provider:count, …)` so
you can see where each field came from.

### Bilingual descriptions and the language toggle

Descriptions and remarks may be a `{ en, ja }` language map; the viewer resolves
the language at render time, so the sheet's language toggle switches the prose
live. The `httpd@2.4` dictionary is bilingual, so those rows flip between English
and Japanese. `httpd_server_tokens` and `httpd_max_request_workers` are described
by the role's `argument_specs.yml` instead — and Ansible argument specs are
**English-only** — so, since argument-specs wins over the dictionary
(priority 50 > 30), those two rows stay English in Japanese mode (a missing
language falls back en → ja). This is faithful provider behaviour, not a bug: the
official dictionary is translated, a community source may not be. To localize
them anyway, add a `{ en, ja }` description in `sheet.yml`, which wins at
priority 100.

## The Ansible project

A minimal role targeting the **RHEL family** (`httpd` package,
`/etc/httpd/conf/httpd.conf`, `service httpd`), event MPM.

| File | Purpose |
| --- | --- |
| `roles/httpd/` | install httpd; deploy a **templated** `httpd.conf` (per-env values); enable the service |
| `roles/httpd/defaults/main.yml` | the `common`/`overlay` Ansible variables |
| `roles/httpd/meta/argument_specs.yml` | role-documented options for 2 of the 16 Ansible variables |
| `inventories/{staging,production}/group_vars/web.yml` | per-environment overrides (Pattern B columns) |
| `site.yml` | `hosts: web` → role `httpd` |
| `review-sheet/build.yml` | the review-sheet build spec (declarative; read by the `ansible` recipe) |

No Molecule scenario, no `mise.toml`/`pyproject.toml`/`uv.lock`, no
`validate.yml` — see [`../ansible-basic`](../ansible-basic) for that whole
testing/toolchain layer (it applies unchanged to a role like this one).
