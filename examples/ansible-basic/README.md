# ansible-basic — review-sheet for an Ansible project

This example takes a real, idiomatic **Ansible** project (an nginx role with
per-environment inventories, tested with Molecule) and shows how to put
review-sheet on top of it: a reviewable parameter sheet of **every setting the
role provisions**, source-mapped so reviewed values apply straight back into the
variable files.

The Ansible side is designed first, on its own merits; review-sheet just reads it.

## Quick start — adding review-sheet to an Ansible project

The order this example follows to go from an existing Ansible project to a
reviewable, apply-back parameter sheet:

1. **Start from a normal Ansible project** — a role + per-environment
   `inventories/<env>/group_vars` + Jinja2 templates (+ a static drop-in), runnable
   and tested on its own (see [The Ansible project](#the-ansible-project)). Nothing
   here is review-sheet-specific.

2. **Decide each value's `origin`.** The Ansible variables (`defaults` +
   `group_vars`) are `common` (single value, Pattern A) or `overlay`
   (per-environment, Pattern B). Values hard-coded in the template / static
   files are `embedded` — not backed by a variable, so changing one is a
   role/code change rather than a per-environment edit. All are **in
   scope for review**. (See [What the sheet contains](#what-the-sheet-contains-four-origins).)

3. **Write the declarative build spec** `review-sheet/build.yml`. It names the
   built-in `ansible` recipe per role/sheet — no hand-written extraction code:
   - `defaults`/`overlays` → `common`/`overlay` params, each source-mapped to
     its file (Pattern A common / Pattern B per-environment);
   - `template` (jinja2) + `static_files` (`security.conf`) → `embedded`
     params, filed in the same functional categories as the variables;
   - `import --spec` runs `verifySources` before it writes `input.json`.

4. **Build + verify the sheet:**
   ```sh
   mise run setup          # one-time: toolchain + community.docker (see Toolchain)
   mise run sheet          # import --spec (extract + verify) → input.json → sheet.html
   ```
   `import --spec` prints `verify: N ok … M out-of-scope` — every source map is
   checked against the real files before anything is written.

5. **Review the values.** Either hand reviewers the self-contained `sheet.html`
   (they annotate in the browser and export a `review.json`), or run the local UI
   that writes edits straight to your files:
   ```sh
   bun run ../../src/cli.ts serve -i input.json     # http://127.0.0.1:5173
   ```

6. **Apply reviewed changes back** to the real config:
   ```sh
   bun run ../../src/cli.ts apply -i input.json -r review.json           # dry-run
   bun run ../../src/cli.ts apply -i input.json -r review.json --write   # write
   ```
   `common`/`overlay` edits land in the right `group_vars` / `defaults` YAML;
   `embedded` edits land directly in the template/static file — a role/code
   change, not a per-environment value edit, but still a normal `apply` target
   like any other source-mapped value.

> In this repo the CLI is `bun run ../../src/cli.ts`; in your own project you'd
> install the `review-sheet` package and use its `import --spec` the same way.

## What the sheet contains (four origins)

The goal is a sheet of **every nginx setting the role provisions** — not only the
per-environment ones. A good role variableises what should vary per environment
and hard-codes the rest, so the `ansible` recipe reads *both* the variable
files **and** the config artifacts. Every parameter is **in scope for review**; `origin`
records where its value comes from, it is not a scope gate:

- **`common` / `overlay`** — the Ansible variables
  (`roles/nginx/defaults/main.yml` + each `inventories/<env>/group_vars/web.yml`).
  Each value source-mapped to its variable file so `apply` writes back there.
  `common` = a single shared value (Pattern A, e.g. `nginx_listen_port`);
  `overlay` = per-environment columns (Pattern B, e.g. `nginx_server_name`,
  `nginx_worker_connections`).
- **`embedded`** — directives hard-coded in `roles/nginx/templates/nginx.conf.j2`
  (parsed via the jinja2 adapter: `{{ var }}` directives resolve to the
  variables above and are skipped here; literals like `sendfile on` are the
  `embedded` params) and the static `roles/nginx/files/security.conf`. Filed in
  the *same* functional category as the variables and carries a `description`
  like any other parameter — changing one is a role change rather than a
  per-environment value edit, but it is not excluded from review.
- **`default`** — a parameter the role does **not** set at all, whose value in
  effect is PostgreSQL's own default. These rows exist only in the postgresql
  sheet, and only because it is **materialized** (see below).

Each sheet header carries **both paths**, because two different people read it:
`/etc/nginx/nginx.conf` — where the configuration actually lands, which is what
an operator designing middleware parameters looks for — and, muted beside it,
生成元 `roles/nginx/templates/nginx.conf.j2`, the file it is generated from,
which is what someone working on the automation needs. The deployed path is
declared in `build.yml` (`deployed_path:`, copied from the task's `dest:`); it
is never inferred, because a task's `dest` is often a variable expression, and
`verify`/`apply` never resolve against it — that is what the template-side
`source_file` is for.

An `embedded` row's tag names the file the literal lives in
(`nginx.conf.j2` / `security.conf`) rather than saying just "embedded", so the
two populations — template literals and the static drop-in's directives — stay
distinguishable, and the tag tells you where to go to change it.

So the sheet shows *all* parameters, distinguished by `origin` rather than split
into an editable layer and an excluded one; `common`/`overlay` values apply
cleanly back to the variable files, `embedded` values apply back to the
template/static file, and a `default` row has nothing to apply to (see below).
`input.json` and `sheet.html` are generated artifacts (git-ignored); regenerate
with `mise run sheet`.

### The postgresql sheet is the full inventory (`materialize`)

A parameter sheet in the Japanese infrastructure tradition is an **exhaustive
ledger**: every parameter of the product is written down, and each row is marked
in or out of review scope. A sheet that lists only the 22 knobs this role happens
to set cannot say whether the other 341 were *considered and left at their
default* or simply never looked at.

`review-sheet/build.yml` therefore materializes the postgresql sheet, via that
sheet's own dictionary binding:

```yaml
sheets:
  - name: postgresql configuration
    recipe: ansible
    ...
    dictionaries:
      - product: postgresql
        version: "16"
        key_prefix: pg_
        materialize: true
```

Every `postgresql@16` dictionary key the role does not set becomes an
`origin: default` row — value = PostgreSQL's own default, description from the
dictionary, filed under the dictionary's `group` (pg_settings' own taxonomy:
`Write-Ahead Log / Checkpoints`, `Autovacuum`, …). The result is 363 rows: the
22 the role sets, in this project's own categories, plus 341 at their default.
Both taxonomies coexist on purpose — a category name the project declares wins
for the parameters it declares, so `pg_max_connections` stays under this
project's `Connections` while the untouched connection settings land under
pg_settings' `Connections and Authentication / Connection Settings`. Name your
categories after the product's groups if you would rather they merge.

Three consequences worth knowing:

- **`verify` counts them apart.** `341 product-default` in the summary, *not*
  `341 unmapped` — nothing is supposed to resolve for a value nobody sets, and
  burying the real source-map gaps under 341 false ones would defeat the check.
- **`apply` holds a change on such a row.** There is no line to edit; acting on
  it means *adding* the setting, which is a judgement call left to the AI prompt
  rather than a deterministic edit.
- **Only materialize a dictionary that is a genuine full extraction.**
  `postgresql@16.yml` comes from a `pg_settings` dump, so it *is* the product's
  parameter list. `nginx@1.26.yml` is a hand-transcribed dozen directives, so
  materializing the nginx sheet would produce a fake inventory — which is why
  only one of the two sheets here is materialized.

### The first review pass (triage)

An exhaustive sheet is long, so the viewer helps you work through it: every row
carries a checkmark chip (未確認 / 確認済み / 対象外 / 変更依頼), there is an
**未確認のみ表示** filter, a per-category "mark unchecked as checked", and a
`確認済み n / m` counter. These are the digital equivalent of ticking rows on a
printout: **session-local, kept in the browser, never exported**.

What is durable is recorded where it belongs, and none of it is a per-row flag:

| | Where |
| --- | --- |
| Out of review scope | `sheet.yml` — `out_of_scope` with its mandatory reason and `owner` (e.g. `krb_server_keyfile`: Kerberos unused, owner DBA) |
| Reviewed and kept at the default | a `remarks` on the row stating why (e.g. `wal_level`) |
| Change requested | a review item, exported in `review.json` and applied with `apply` |
| That the review happened | the commit — the reviewed baseline is that revision's `input.json` |

So "what needs looking at again" is a diff, not a ledger:

```sh
git show <reviewed-rev>:input.json > /tmp/base.json
bun run ../../src/cli.ts diff -i /tmp/base.json -i input.json
```

### Metadata providers

The `ansible` recipe itself only ever emits `key`/`value`/`source`(`/instances`)/`origin`
for every parameter — `description`/`default`/`remarks`/`docs_url`/`type`/`scope`
are filled in afterwards by `enrich()` (`src/enrich.ts`), from three metadata
providers, project-metadata-first:

- **project** (`review-sheet/sheet.yml`) — this project's own terms: which
  category each parameter belongs to (assembler-only, read via `loadProjectMeta()`),
  a `dict_key` alias where the Ansible variable name and the dictionary's don't
  match (`nginx_listen_port` → `listen`), and per-key remarks. Wins over every
  other source.
- **argument-specs** (`roles/postgresql/meta/argument_specs.yml`) — the
  postgresql role's own documented options (`pg_max_connections`,
  `pg_shared_buffers`); community-grade, since it ships with the role.
- **dictionary** (`review-sheet/metadata/nginx@1.26.yml`,
  `review-sheet/metadata/postgresql@16.yml`) — product-level parameter
  references, matched by the Ansible variable name with `nginx_`/`pg_` stripped.
  `nginx@1.26.yml` is hand-transcribed from the nginx docs (`provenance:
  official`); `postgresql@16.yml` is generated from a `pg_settings` snapshot by
  `review-sheet/metadata/normalize-pg.ts` (`provenance: extracted`).

  **What a directive means always lives here, never in `sheet.yml`** — including
  for the directives hard-coded in the template (`user`, `sendfile`,
  `add_header`…), which reach the dictionary through a `dict_key` because the
  extracted key is the directive's position in the file
  (`http.server.index` → `index`). The dictionary is a shared asset: another
  project reviewing nginx 1.26 points `metadata_dirs` at it and inherits every
  description. What stays in `sheet.yml` is what this project decided —
  category placement, and remarks like "this include pulls in security.conf" or
  "this add_header sets X-Frame-Options", which describe *this* configuration
  rather than the directive.

  Two dictionary fields are easy to confuse: **`scope`** is documentation —
  where/when a setting applies in the product's own terms (an nginx directive's
  valid context, Keycloak's build-time vs runtime) — and enrich writes it onto
  the parameter. **`group`** is the product's own *grouping* of its parameters
  (`postgresql@16.yml` carries pg_settings' category, e.g. `Write-Ahead Log /
  Archive Recovery`); it is structure, never written onto a parameter, and the
  assembler reads it only as a category fallback for parameters the project
  does not set.

Enrichment runs in **strict** mode by default: any in-scope parameter —
`common`/`overlay` variable or `embedded` literal alike — that ends up with no
description after all three providers run fails the build, naming the offender
(`sheet > category > key`); only params/categories carrying an explicit
`out_of_scope` (a review-remit exclusion — none in this example) are exempt.
`import --spec` prints `metadata: N parameter(s) enriched (provider:count, …)` so
you can see where each field came from.

## The Ansible project

An idiomatic role + per-environment inventories, tested with **Molecule** on its
only built-in driver, **`default` (delegated)**, with self-authored
`create.yml`/`destroy.yml` (via `community.docker`). Per
[ansible/molecule#3919](https://github.com/ansible/molecule/issues/3919) the
docker/podman *plugin* drivers are being dropped in favour of Ansible content +
the delegated driver — so this is the forward-looking path. The role targets the
**RHEL family**; Molecule tests it on **Red Hat UBI 10** with systemd
(`registry.access.redhat.com/ubi10/ubi-init`, no subscription needed; `nginx` from
the UBI AppStream repo). `create.yml` installs `sudo` so converge's `become`
behaves like a real RHEL host.

| File | Purpose |
| --- | --- |
| `roles/nginx/` | install nginx; deploy a **static** drop-in (`files/security.conf`) + a **templated** `nginx.conf` (per-env values); enable the service |
| `roles/nginx/defaults/main.yml` | the `common`/`overlay` Ansible variables |
| `inventories/{staging,production}/group_vars/web.yml` | per-environment overrides (Pattern B columns) |
| `site.yml` | `hosts: web` → role `nginx`; staged rollout (`serial` / `max_fail_percentage`) |
| `validate.yml` | shared assertion suite — run by Molecule **and** against real staging/production over SSH |
| `molecule/default/` | ansible-native scenario; `converge.yml` runs `site.yml`, `verify.yml` imports `validate.yml` |
| `mise.toml` / `pyproject.toml` / `uv.lock` | toolchain (mise → uv → molecule + ansible-lint) + task runner |
| `review-sheet/build.yml` | the review-sheet build spec (declarative; read by the `ansible` recipe) |

### Toolchain (mise → uv)

```sh
mise install     # python, uv, bun (per mise.toml)
mise run setup   # uv sync  +  ansible-galaxy collection install -r requirements.yml
```

`mise` pins the tools; `uv` builds the `.venv` from `pyproject.toml` + the committed
`uv.lock`; `uv_venv_auto` puts `molecule`/`ansible` on `PATH`. Requires **Docker**
(Podman works too — swap the `community.docker` modules for `containers.podman`).

### Develop + test (one environment)

```sh
mise run dev     # molecule create — persistent dev container (== test target)
# edit roles/nginx/… then:
mise run loop    # molecule converge + verify — re-apply to the SAME container (fast)
molecule login   # shell in to inspect (e.g. `curl -s localhost`)
mise run down    # molecule destroy
mise run ci      # molecule test — full clean-room run (create→converge→idempotence→verify→destroy)
```

### Verify everywhere — local, staging, production

The assertions live in one shared **`validate.yml`** (native Ansible:
`assert` / `*_facts` / `stat` / `wait_for` / `uri`). Molecule's verifier just runs a
playbook against the live instances, so the *same* file verifies the test container
and real hosts over SSH ("write once, verify everywhere"):

```sh
molecule verify                                                    # the test container
ansible-playbook -i inventories/staging/hosts.yml    validate.yml  # real hosts (post-deploy / scheduled)
ansible-playbook -i inventories/production/hosts.yml validate.yml
```

The full quality story is layered:

| Layer | What / where | How |
| --- | --- | --- |
| Lint / syntax | style + parse | `ansible-lint`; `ansible-playbook --syntax-check site.yml validate.yml` |
| Role logic | install/config/**idempotency** (container) | `molecule test` (converge → idempotence → verify = `validate.yml`) |
| Drift / preview | declared vs actual on real hosts | `ansible-playbook -i inventories/<env> site.yml --check --diff` |
| Staged rollout | risk control on deploy | `site.yml`: `serial: ["1","30%"]` + `max_fail_percentage: 0` |
| Post-deploy | did the servers get it | `validate.yml` over SSH (+ on a schedule, for drift) |
| **Value review** | are these the *right* values | **review-sheet** (human, pre-deploy) |

`validate.yml` checks *the box matches the declared values*; **review-sheet** checks
*the declared values are correct for this environment* — complementary gates (a
wrong-but-valid value passes every machine test).
