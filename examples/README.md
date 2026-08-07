# Examples

Each subdirectory is a **self-contained example**: input config file(s), a
`README.md` explaining what it demonstrates and how to run it, plus the
generated `input.json` / `sheet.html` (git-ignored — regenerate from the
README's commands).

| Example | Workflow | Demonstrates |
| --- | --- | --- |
| [`cdk-annotations/`](./cdk-annotations/) | `import` (annotations) | in-source `@rs` annotations on imperative IaC (AWS CDK, TS + Python) |
| [`cdk-snapshot/`](./cdk-snapshot/) | `import --spec` (`snapshot` recipe) | per-environment divergence that lives in **program logic** (`prod ? … : …`), reviewed through one pre-rendered artifact per environment (`cdk synth`): all Pattern B, partial columns for a production-only resource, `include`/`exclude` path globs, read-only (`generated` sources + `capabilities.apply: false`) |
| [`ansible-basic/`](./ansible-basic/) | `import --spec` (`ansible` recipe) | multi-role sheet (nginx + postgresql); the postgresql sheet is **materialized into the full pg_settings inventory** (22 set knobs + 341 `origin: default` rows) so it is an exhaustive ledger, not just what the role touches; two dictionary-sourcing methods side by side — docs-transcribed (bilingual nginx) vs `pg_settings`-extracted (postgresql); Pattern A/B; Molecule |
| [`ansible-httpd/`](./ansible-httpd/) | `import --spec` (`ansible` recipe) | single Apache httpd role, reviewed as **Ansible variables**; hand-authored bilingual dictionary with CamelCase→snake `dict_key` aliases (all 16) |
| [`ansible-keycloak/`](./ansible-keycloak/) | `import --spec` (`ansible` recipe) | single Keycloak role, reviewed as the **product's config keys** (`db-url`…, source-mapped back to the `kc_*` Ansible vars via the template); dictionary **extracted from the product** (the official image's own `PropertyMappers` registry — all 257 config keys, cross-checked against `kc.sh --help-all`); build-time vs runtime scope; per-parameter out_of_scope secret |

## Two workflows

- **annotations** — describe the sheet inline with `@rs` comments in the source
  (best for config-as-code: TS/Python). `import` reads the annotations.
- **import** — extract a draft model with source maps from declarative config
  files (yaml, json, toml, ini, nginx, httpd, haproxy, systemd, xml, dotenv,
  hcl, …). See `skills/review-sheet/formats/` for every supported format.
  `import -f <file>…` handles standalone files; `import --spec build.yml` adds a
  **recipe** that knows how a project lays its files out — `ansible` (base
  defaults + per-environment overlays, optionally through a template) or
  `snapshot` (one pre-rendered artifact per environment, for divergence that
  lives in program logic).

## Adding a new example

1. `mkdir examples/<name>/` and drop the source config file(s) in.
2. `cd examples/<name>` and run `import` → `verify` → `generate` (see any
   existing example's README for the exact commands).
3. Add a `README.md` describing what it demonstrates, and a row to the table
   above.

Run commands from inside the example dir against the repo CLI, e.g.
`bun run ../../src/cli.ts import -f <conf> -o input.json`.
