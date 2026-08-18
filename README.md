# review-sheet

Generates a self-contained parameter-sheet HTML from a JSON description of your
configuration, collects reviewer feedback on it, and applies the approved changes
back to the real config files.

It is for infrastructure / IaC teams that review settings (sysctl, YAML, `.env`,
Helm values, Ansible vars, …) the same way they review code. Each value carries a
source map recording where it lives in the real files, so an approved change can
be written to that line. Values that cannot be edited deterministically are
collected into an AI prompt instead.

- One HTML file. No server, no runtime dependencies; open it in a browser.
- Reviewers edit values and leave comments, then export their feedback as
  `review.json`.
- `apply` writes the approved value changes back to your config files, verified
  and idempotent. What it cannot apply deterministically becomes an AI prompt.
- One sheet can hold several versions, with a switcher between them and a
  cell-level diff of any two, down to per-instance values (which a line or table
  diff shows poorly).
- `diff` also compares two *different* sheets — when both sheets are keyed by
  the product's own configuration keys, two structurally different platforms
  (EC2 vs. ECS, mid-migration) land on the same product keys, so
  `--equivalence` answers "are these configured the same" instead of just
  "what changed".
- Japanese / English UI (`--lang`). The AI prompt is always English.

---

## Requirements

- [Bun](https://bun.sh). The CLI and library run TypeScript directly, so there is
  no build step.

## Install

```sh
git clone https://github.com/wadahiro/review-sheet
cd review-sheet
bun install
```

Run the CLI from source:

```sh
bun run src/cli.ts <command> [options]
```

The examples below write `review-sheet` for brevity. Substitute
`bun run src/cli.ts`, or expose the binary with `bun link`.

---

## The workflow

You start by drafting a source-mapped model (`import`) and confirming it
(`verify`). From there, there are two ways to collect the review and land the
edits. Pick by whether the reviewers are remote (hand them a file) or local
(edits go straight to disk).

### A. Distribute the HTML (no server, no tooling for reviewers)

```
 config files ──import──▶ input.json ──generate──▶ sheet.html
                          (+ source map)               │ distribute
                                                 reviewers edit in browser
                                                  + Export review.json
                                                        │
 config files ◀──apply── review.json  ────────────────┘
   (verified edits)   └─ whatever can't be applied ─▶ AI prompt
```

1. `import` → `verify`: draft `input.json` (with source maps) and confirm it.
2. Refine: add descriptions and defaults, group settings, merge per-environment files.
3. `generate`: build `sheet.html`, one self-contained file that opens in any browser.
4. Review: send the HTML to reviewers. They change values and add comments, then Export `review.json`.
5. `apply`: write the approved changes back to the config files. The rest goes to the AI prompt.

### B. Serve locally (edits written straight to your files)

```
 config files ──import──▶ input.json ──serve──▶ localhost UI
                          (+ source map)            │ reviewer edits in browser
 config files ◀── written directly ─────────────────┘
   (verified on save — no review.json, no apply step)
```

1. `import` → `verify`, optionally refine: same as above.
2. `serve`: open the sheet on `127.0.0.1`. Each value change is applied to the real
   file on the spot, with the same verification as `apply`. No `review.json`
   round-trip.

---

## Quick start

```sh
# 1. Draft a model from existing config files (exact line + anchor source maps)
review-sheet import -f /etc/sysctl.conf -f /etc/app/config.yaml -o input.json

# 2. Confirm the source maps resolve against the real files
review-sheet verify -i input.json

# 3. Build the reviewable HTML
review-sheet generate -i input.json -o sheet.html

#    ... share sheet.html, reviewers edit values + comment, Export -> review.json ...

# 4. Preview the edits, then write them
review-sheet apply -i input.json -r review.json            # dry-run diff
review-sheet apply -i input.json -r review.json --write     # apply

# --- or, instead of steps 3-4, review locally and write edits straight to disk ---
review-sheet serve -i input.json                            # localhost UI, applies on save
```

---

## Commands

### `import` — config files → draft model

```sh
review-sheet import -f <file>... [--format <fmt>] [-o <out>]
```

Extracts a draft `input.json` with accurate source maps (one sheet per file).
Supported formats (inferred per file extension, or forced with `--format`):

<!-- parsers:start -->
| Format | Files | Notes |
| --- | --- | --- |
| `jinja2` | *.j2 | Templates (.j2): base-format structure + the {{ variable }} behind each value (extraction aid). |
| `logrotate` | /etc/logrotate.conf, /etc/logrotate.d/*, logrotate-*.j2 | `/path/*.log { … }` blocks: flags, `name args`, and script bodies. |
| `haproxy` | haproxy.cfg *.cfg (content-detected) | Sections and directives; named sections + repeated directive by 1st arg. |
| `httpd` | httpd.conf .htaccess conf.d/*.conf *.conf (content-detected) | Apache directives and <Tag> containers by label; repeats indexed. |
| `nginx` | nginx.conf *.conf (content-detected) | Directives and {} blocks; labeled blocks by label; repeats indexed. |
| `hcl` | *.tf *.hcl *.tfvars | Blocks by label (resource type+name); scalar attributes only; expressions/lists/maps/heredocs skipped. |
| `json` | *.json | Same as YAML including minified JSON; no comments. |
| `py` | *.py (with @rs annotations) | In-source `@rs` annotations on Python config-as-code (CDK for Python, Pulumi, settings); value = the RHS expression. |
| `shell` | *.sh *.bash *.ksh *.zsh, or any file with a #! shell shebang | Variable assignments and long options with values; a CLI wrapper's arguments become parameters. |
| `systemd` | *.service *.timer *.socket *.mount *.target *.path *.slice *.scope *.automount *.netdev *.network *.link | [Section]+Key=Value unit files; repeated keys indexed. |
| `toml` | *.toml | Tables and array-of-tables; reorder-robust paths; scalar values only. |
| `ts` | *.ts *.tsx *.mts *.cts (with @rs annotations) | In-source `@rs` annotations on TS/TSX config-as-code (CDK, Pulumi); value = the RHS expression. |
| `xml` | *.xml | Element text and attributes; reorder-robust paths via identity attributes. |
| `yaml` | *.yaml *.yml | Nested leaves get a structural path; list-of-maps addressed by identity. |
| `dotenv` | *.env | .env KEY=value files; export prefix stripped; quotes KEPT; # comments. |
| `ini` | *.ini *.cfg | INI/CFG [section] files; sections become categories. |
| `properties` | *.properties | Java .properties key=value files; # and ! comments; category is Parameters. |
| `sysctl` | *.conf (lower priority than nginx/httpd/haproxy) | sysctl-style key = value .conf files; # and ; comments. |
| `space` | (force only — no dedicated extension) | Whitespace-delimited files (e.g. sshd_config); force-only, not auto-detected. |
| `generic` | anything else (fallback) | Last-resort fallback; tries = then : as delimiter; always matches. |
<!-- parsers:end -->

The output is a draft: review it and add descriptions, defaults, grouping, and
per-environment instances by hand or with the [skill](#agent-skill).

Formats are pluggable. Each one is a `ConfigParser` (detect / extract / locate /
edit) in a registry, so a custom format is another parser. Drop a module that
calls `registerParser(...)` into `./.review-sheet/parsers/` (auto-loaded) or pass
`--parsers-dir <dir>`, and `import` / `verify` / `apply` pick it up.

### Declarative spec: `build.yml` + `sheet.yml`

```sh
review-sheet import --spec review-sheet/build.yml
```

`import -f` above is Level 0: point at files, get a draft, refine by hand.
`import --spec` is Level 1 — it assembles a whole sheet from a declaration,
no code — and covers most of what makes a sheet worth reviewing:
per-environment differences (Pattern B), descriptions filled in automatically
from a product dictionary, and the full-inventory ledger a parameter-sheet
review traditionally wants. Two files divide the work:

- **`build.yml`** — where the data comes from: `version`, `metadata`,
  `instances` (the ordered environment list), `enrich` (which metadata
  sources to read), and `sheets[]`. Each sheet names a `recipe` — `layered`
  (a base file plus per-environment overlays), `ansible` (the same, plus
  Jinja2 template rendering), or `snapshot` (one pre-rendered artifact per
  environment, e.g. `cdk synth` output) — and that recipe's own fields:
  `defaults`/`overlays`, `template`, `static_files`, `include`/`exclude` key
  filters, a per-source `key` transform, and `dictionaries` (which product
  dictionary this sheet's keys bind to, including `materialize`). A sheet may
  declare `parts:` instead of `recipe:` to build ONE sheet from several
  recipes — a host whose sysctl settings come from Ansible variables and whose
  logrotate policy is read as lines of the deployed file is one page of a
  parameter sheet, not two. Each part is scoped to its own component, and a row
  two parts both claim is an error rather than a silent overwrite.
- **`sheet.yml`** — how a human reads it: one entry per parameter key —
  `category`, `description`/`remarks`, `out_of_scope` (excluded from this
  review, with a mandatory reason), `dict_key` (an explicit rename for a key
  that genuinely doesn't match its dictionary entry any other way) — plus,
  per sheet, `categories` (tab order) and `under_key` (the provenance column,
  needed once any row is keyed by a product name derived from a template, or
  from a `static_files` entry's own `substitution:` merge — see the skill). A
  spec with more than one sheet nests all of this under `sheets:`, namespaced
  by sheet name, so a key that leaks from one sheet's extraction into
  another's (two roles reading the same `group_vars` file, say) can't borrow
  the wrong sheet's category and description.

A minimal example, trimmed from `examples/ansible-basic/review-sheet/` (one
Ansible role, base values plus two environment overlays):

```yaml
# build.yml
sheets:
  - name: nginx configuration
    recipe: ansible
    defaults: ../roles/nginx/defaults/main.yml
    template: ../roles/nginx/templates/nginx.conf.j2
    overlays:
      staging: ../inventories/staging/group_vars/web.yml
      production: ../inventories/production/group_vars/web.yml
    dictionaries:
      - product: nginx
        version: "1.26"
        key_prefix: nginx_
```

```yaml
# sheet.yml
sheets:
  "nginx configuration":
    categories: [Network, Performance]
    params:
      listen: { category: Network }
      worker_processes: { category: Performance, remarks: "auto = CPU cores" }
```

What that buys you:

- **Dictionaries fill in descriptions for free.** A `<product>@<version>.yml`
  file (under `enrich.metadata_dirs`) documents a product's parameters once;
  every sheet bound to it (`sheets[].dictionaries`) gets `description` /
  `default` / `type` / `docs_url` without writing them again. Four provider
  sources merge in priority order — the project's own `sheet.yml` (100) beats
  an ecosystem's native metadata (Ansible `argument_specs.yml`, Terraform
  `variables.tf`, both 50) beats the dictionary (30) — so a Terraform
  module's own `description = "..."` is read, not retyped.
- **Keys bind to a dictionary entry on their own.** In order: an explicit
  `dict_key` alias, an exact match, a `key_prefix`-stripped match, a
  structural-path leaf, then a delimiter/case-insensitive normalized match —
  `httpd_timeout` finds dictionary key `TimeOut` with nothing declared. An
  ambiguous match is a build error, never a silent guess.
- **`materialize: true`** on a dictionary binding expands every key the sheet
  does *not* already set into an `origin: "default"` row — the exhaustive
  ledger a parameter-sheet review traditionally expects, not just the handful
  of settings a project happened to touch. An entry with no documented
  default is excluded (asserting "the default applies here" would be false
  for it); the exclusion count is always printed, and `--materialize-report`
  lists them. One ledger per component (below), unless the binding names the
  one component it describes — see `component:` there.
- **`category:` takes a path.** `category: [Tokens, Access tokens]` nests the
  row two levels deep; a bare string is the one-segment case of the same thing.
  A dictionary's own `group:` takes the same path, so a product whose taxonomy
  has levels says so instead of spelling them into one name.
  Only the first segment is a tab, so only it belongs in the sheet's
  `categories:` list. The path is what a review target names, at any depth, so
  nesting is structure rather than decoration.
- **A finding survives its row being reorganised.** A review names a category,
  and a category is display structure — most come from a product dictionary's
  own grouping, so upgrading one can move a setting to another screen. Saved
  findings are re-pointed at wherever the row is now (identity is the parameter
  within its component), and every move is reported rather than followed
  silently. Where the answer would be a guess, it resolves to nothing instead.
- **Sheets can be grouped.** `groups:` in `sheet.yml` declares the reading
  order; each sheet names one with `group:`. The header becomes two rows —
  groups, then the sheets of the one you are in (nothing on the overview, which
  belongs to no group) — and the outline gets the same headings, which is what lets a document hold a workbook's worth of sheets
  instead of a tab strip's. Checked both ways: a sheet naming an undeclared
  group, an unused group, and an ungrouped sheet in a grouped document are all
  build errors. A group is display structure only — it appears in no review
  target, so grouping an existing document orphans nothing.
- **A sheet's name is identity; `label:` is what a reader sees.** Declared in
  `sheet.yml` beside the sheet's other display facts, as a `{ ja, en }` pair,
  and switched live by the viewer's language toggle. The name still keys every
  review target, diff and CLI message, so a tab can be renamed in either
  language without orphaning a finding filed against it.
- **A build that can't proceed says so, and hands you the fix.** A parameter
  with no category or description fails the build, naming every offender
  with a paste-able `sheet.yml` fragment (`--scaffold <file>` writes it out;
  `--interactive` resolves it from a terminal list instead). A key collision,
  an undeclared category, or an unknown `build.yml` field fails the same way,
  named, with a spelling suggestion when one is close.

#### One sheet, several instances of the same product: `component`

A sheet often covers more than one of something — two OIDC clients on one
identity provider, the load balancer in front of one service and the one in
front of another, a primary database and its replica, or several files that make
up one subsystem. Each of those is a **component**: a purpose-bearing
instantiation, named because a requirement asked for it. Nothing but a human
knows which of two identical-looking database clusters is "the session store";
a cloud provider hands out resource types, not purposes.

```yaml
# build.yml — the component is DERIVED from where each row came from, so the
# id already present in every path becomes the heading instead of cluttering
# every key.
sheets:
  - name: oidc clients
    recipe: layered
    static_files:
      - path: clients.yml
        format: yaml
        key:                                   # clients[clientId=X].redirectUris[0]
          from: path                           #   -> redirectUris[0]
          steps:
            - pattern: '^clients\[clientId=(?:.+?)\]\.(.+)$'
              replace: "$1"
              on_no_match: drop
    component:
      from: path                               # matched against the ORIGINAL path,
      steps:                                   # before the key transform above
        - pattern: '^clients\[clientId=(.+?)\]\..*$'
          replace: "$1"
      names:
        web-portal: { name: { en: Web portal, ja: Web ポータル } }
        mobile-app: { name: { en: Mobile app, ja: モバイルアプリ } }
```

Two things worth knowing before copying that: `include`/`exclude` are matched
against the key AFTER the transform, so filtering on the original path silently
drops everything; and a `names:` entry that no row produces is a build error, so
a component that stops appearing is reported rather than quietly vanishing.

The result — the same key under each component, and remarks that stay where they
were written:

```
[Web ポータル]
  [Settings]
    redirectUris[0] = https://portal.example.com/cb   remarks: the portal's callback
[モバイルアプリ]
  [Settings]
    redirectUris[0] = https://app.example.com/cb
```

A component is a **scope**, not a label, and that buys three things:

- **It is the outermost level of a row's path**, so the sheet reads as "this
  client, then its settings" rather than one flat list whose keys all repeat.
- **`materialize` produces one ledger per component.** Without this, a value set
  on one instance marks that option covered for every instance, and the other
  ALB's unset options silently vanish from the ledger.
- **`sheet.yml` gets a namespace per component**, so the remarks written for one
  instance cannot appear on another's row.

```yaml
# sheet.yml — component-first, then the sheet-wide table
sheets:
  "oidc clients":
    params:
      redirectUris[0]: { category: Settings }      # true of every client
    components:
      web-portal:
        params:
          redirectUris[0]: { remarks: "the portal's callback" }   # true of this one
```

**Components do not require the key names to overlap.** Overlapping keys are
what forces the `sheet.yml` namespace above — two clients both have
`redirectUris[0]`, and a flat table would leak one's remarks onto the other —
but that is a consequence, not a precondition. A cloud-infrastructure sheet
whose components are a load balancer, a database, a compute node and a network
shares no keys between them at all; they are components because they are four
separate things a reviewer reads separately.

A sheet with only ONE component collapses the level entirely — naming it above
every category would add a heading that says nothing.

For an `ansible` sheet, `templates:` (plural) makes one component per template,
which is how several rendered artifacts — a config file, a systemd unit, an
environment file — end up on one sheet. A `layered` sheet's `static_files:`
takes the same `component:` per file, for the case a transform cannot reach:
two files holding the same KIND of document produce identical keys and
identical structural paths, so what tells their rows apart is which file they
came from.

That last case is the one where the per-component ledger needs telling
otherwise. `materialize` expands once per component, which is exactly right for
several instances of a product — each needs its own ledger, or one instance's
value marks an option covered for all of them. It is exactly wrong for several
artifacts of one product: a config file, the systemd unit that starts it and a
backup script are all "the product", but only the first is what the product's
settings registry is about, and the other two would each be reviewed against
every option of a file they do not contain. Say which component
the dictionary describes:

```yaml
    dictionaries:
      - product: postgresql
        version: "16"
        materialize: true
        component: postgresql.conf   # not the unit file, not the backup script
```

It scopes binding as well as the ledger, because "this dictionary describes that
artifact" is one claim. Expect the rows in the other components to lose the
category they were getting from the dictionary's own grouping — the build stops
and asks `sheet.yml` for one, which is the point. Naming a component the sheet
has no rows for is a build error, like every other rule here that matched
nothing. It is also the only way they can: two
systemd units both have `Unit.Description`, and without a component to separate
them one row would overwrite the other.

`skills/review-sheet/SKILL.md` and `review-sheet import --spec --help` cover
every field; this is the shape, not the reference.

### `generate` — model → reviewable HTML

```sh
review-sheet generate -i input.json -o sheet.html
review-sheet generate -i v1.json v2.json v3.json -o sheet.html  # version history (ordered by date)
review-sheet generate -i input.json --readonly -o sheet.html    # a copy that can only be read
review-sheet generate -i input.json --allow edit -o sheet.html  # a copy its owner can maintain
review-sheet generate -i input.json --lang en -o sheet.html     # English UI (default: ja)
```

`-i` accepts multiple files; each is a snapshot, ordered by its
`metadata.generated_at` (see [Versions & diff](#versions--diff)). `-o` defaults to
stdout. `--title` overrides the document title.

`--allow` states what the recipient may do — `review` **or** `edit`, never both.
They are different jobs done by different people at different times: proposing
changes before the sheet is handed over, and maintaining values afterwards. A
document offering both would put two primary actions on every cell and mix
proposals with facts in one file.

`prompt` is not a mode; it adds the AI-prompt affordance to whichever one is on.
It is off unless named, because it is a judgement about the AUDIENCE: in the
usual flow the edited document comes back to whoever built it and `apply`
produces the prompt there, against the real files, so the handed-over copy
often has no use for one. Asking for `prompt` alone is an error — it is built from
findings or edits, and a document with neither has nothing to put in it.

| `--allow` | review | edit | prompt |
|---|:--:|:--:|:--:|
| *(omitted)* — same as `review,prompt` | ✅ | | ✅ |
| `--readonly` | | | |
| `review` | ✅ | | |
| `edit` | | ✅ | |
| `edit,prompt` | | ✅ | ✅ |
| `edit,review` | *error* | | |

Without `--allow`, `--readonly` decides: it hands over a document that can only
be read. (`--no-review` is the old spelling of it — it named only the review UI,
but once editing and the prompt existed it meant none of them.) An unknown name
is an error, not an ignored word. See
[Editing a generated sheet](#editing-a-generated-sheet).

### `validate` — schema check

```sh
review-sheet validate -i input.json               # a model
review-sheet validate -i review.json              # a review export
review-sheet validate -i httpd@2.4.62.yml         # a dictionary (YAML), or its .overlay.yml
```

### `verify` — source maps vs. the real files

```sh
review-sheet verify -i input.json [--quiet]
```

Checks every value's source: the file is readable, the value is located by
line/anchor (or by `path` for YAML/JSON), and the recorded value is still there.
Reports `ok` / `warn` (ambiguous anchor) / `error` (stale value or wrong locator)
/ `unmapped` (intentionally left to the AI prompt), and exits non-zero on errors.
Run it after `import` and after any hand edits.

### `apply` — review.json → config edits

```sh
review-sheet apply -i input.json -r review.json                 # dry-run preview (diff)
review-sheet apply -i input.json -r review.json --write          # write the edits
review-sheet apply -i input.json -r review.json --emit-prompt    # print the AI prompt for the rest
review-sheet apply -i input.json -r returned.html                # an edited sheet is its own review file
```

For each approved value change, `apply` confirms the location (by line + anchor,
or structurally by `path` for YAML/JSON), then replaces only that value. It is
idempotent. Anything it cannot verify (no source, an ambiguous anchor, a
multi-line or block value, an edit to a documentation field) is left untouched
and folded into an English AI prompt (`--emit-prompt`) that you can hand to a
coding agent.

### `serve` — local UI that writes edits straight to your files

```sh
review-sheet serve -i input.json                # opens http://127.0.0.1:5173
review-sheet serve -i input.json --port 8080
review-sheet serve -i input.json --no-open      # don't auto-open the browser
```

Serves the sheet on localhost (127.0.0.1 only) and skips the
export-`review.json` round-trip: reviewer edits are applied directly to the local
config files. The embedded app calls a small backend (`POST /api/apply`,
`/api/verify`) built on the same verified apply core, so a value you change in
the browser is written to the real file on the spot, with the same
line/anchor/`path` verification as `apply`. Single-version models only; no AI, no
`review.json`.

### `annotations` — inspect in-source `@rs` annotations

```sh
review-sheet annotations -f stack.ts            # print resolved sheet / category / value / path
review-sheet annotations -f config.py --lint    # tooling-friction checks
```

For TS/TSX/Python files that carry in-source `@rs` annotations (config-as-code
such as AWS CDK / Pulumi; see `spec/annotation.md`), the default `--print` shows
the resolved sheet / category / value / path per annotated property, and
`--lint` flags issues (a marker inside a `/** */` doc comment; an `@rs:category`
not on its own line). The marker defaults to `@rs` and can be changed with
`--annotation-marker` (also accepted by `import` / `verify` / `apply` / `serve`).

### `diff` — compare two snapshots

```sh
review-sheet diff -i base.json -i current.json                  # what changed, since the last reviewed revision
review-sheet diff -i base.json -i current.json --format json    # machine-readable: one document, nothing on stderr
review-sheet diff -i platform-a.json -i platform-b.json --equivalence --format json  # are two DIFFERENT sheets equivalent?
```

Compares two `input.json` snapshots — added / removed / changed parameters,
down to per-instance cells. Differing rows go to **stdout**, the `N changed, …`
summary to **stderr**, so a naive `$(review-sheet diff …)` capture cannot tell
"nothing changed" from "the command failed"; use `--format json` for anything
automated (`{ summary, excluded, sheetsOnlyOnOneSide, rows }`, one document,
nothing on stderr). `--all` includes unchanged rows.

Two different questions, one command:

- **The same sheet, over time** — "what still needs re-review since the last
  approved revision" (see [Versions & diff](#versions--diff));
- **Two different sheets, for equivalence** — "are these two deployment forms
  configured the same" (see [Equivalence checks](#equivalence-checks-are-two-deployment-forms-configured-the-same)).

---

## Input model & source maps

`input.json` is a list of sheets → categories → parameters. A parameter is either
a single value (Pattern A) or one value per instance/environment (Pattern B):

```jsonc
{
  "sheets": [
    {
      "name": "OS Tuning",
      "file_path": "/etc/sysctl.conf",
      "categories": [
        {
          "name": "Network",
          "params": [
            {
              "key": "net.ipv4.tcp_fin_timeout",
              "description": "TIME_WAIT socket timeout (seconds).",
              "default": "60",
              "value": "30",
              "source": { "line": 42, "anchor": "net.ipv4.tcp_fin_timeout =" }
            },
            {
              "key": "server.port",
              "instances": [
                { "name": "prod", "value": "8080",
                  "source": { "file": "/etc/app/config.prod.yaml", "path": "$.server.port" } },
                { "name": "dev",  "value": "8080",
                  "source": { "file": "/etc/app/config.dev.yaml",  "path": "$.server.port" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

The `source` object is what lets `apply` edit the right place:

| field | meaning |
| --- | --- |
| `file` | path to the real config file (defaults to the nearest category/sheet `file_path`) |
| `line` | 1-based line number |
| `anchor` | a literal substring on that line, usually the key and its delimiter; used to verify the line and to re-locate it if it drifts. Works with any delimiter (`=`, `:`, space, tab) |
| `path` | structural path for YAML/JSON (`$.server.port`, `hosts[0]`), which allows an exact edit of nested or minified values |

Only `value` is source-mapped. `description` / `default` / `remarks` are
documentation rather than deployed config, and carry no `source`.

---

## Versions & diff

review-sheet does not store history; your VCS already does. To get a version
history, produce one model per revision and pass them all to `generate`:

```sh
# one model per point in time (your own script, or `review-sheet import`)
git show v1.0:config.yaml | review-sheet import -f /dev/stdin -o model-1.0.json   # (illustrative)
# ... produce model-1.1.json, model-1.2.json ...

# bundle the snapshots into one sheet
review-sheet generate -i model-1.0.json model-1.1.json model-1.2.json -o sheet.html
```

The snapshots are ordered by each model's `metadata.generated_at` date, not by
the order you pass them, so the timeline is correct whatever the argument order.
Set `generated_at` to the commit date; the version label comes from
`metadata.version`, falling back to the file name. If some files have no date,
the given order is kept and a warning is printed.

For programmatic assembly you can also hand-write or generate a single versioned
document and pass it as one file:

```jsonc
{
  "metadata": { "title": "Cluster config" },
  "versions": [
    { "version": "1.0", "date": "2026-01-10", "tags": ["baseline"], "sheets": [ /* ... */ ] },
    { "version": "1.2", "date": "2026-03-01", "tags": ["release"],  "sheets": [ /* ... */ ] }
  ]
}
```

When the result has more than one version, the sheet shows a version switcher and
a Compare mode. Compare is an overlay on the normal sheet view, with the same
tabs, columns, grouping, freeze, outline and search, rather than a separate diff
screen. You pick a *from* (older baseline) and *to* (current) version and the
sheet annotates itself in place:

- changed values inline as `old → new`, in the same strikethrough/suggested
  styling used for review edits; added and removed rows in place with a colored
  bar and a `+`/`−`/`~` badge; a `N changed · N added · N removed` summary in the
  toolbar;
- "Changed only" hides unchanged rows; tabs, outline and search keep working;
- per-instance cells for Pattern B, so you can see which environment's value
  moved: `web 8080 → 8888`, `api 9090` (unchanged), `db 5432` (added column),
  `cache 6379` (removed column). This is the case a plain table diff, such as one
  in a wiki, renders unreadably.

Renames are matched by name/key, so a renamed sheet, category or parameter shows
as a remove plus an add. A plain single-`sheets` input still works and is treated
as one version.

On the command line, `review-sheet diff -i base.json -i current.json` answers
the same "what changed since the reviewed revision" question — see [`diff`](#diff--compare-two-snapshots)
above.

### Equivalence checks: are two deployment forms configured the same?

During a staged migration (EC2 → ECS, VM → container, on-prem → cloud, …) both
forms often run in production side by side, and the question a parameter sheet
exists to answer is whether they are configured *the same way*. `diff` answers
it directly when both sheets bind their parameters to the product's own
configuration keys (see the [skill](skills/review-sheet/SKILL.md))
rather than to each platform's delivery mechanism (an env var, a Terraform
variable, a Dockerfile `RUN` flag) — the same setting then lands under the same
key regardless of how each platform happens to deliver it, so two structurally
different sheets become comparable.

```sh
review-sheet diff -i platform-a.json -i platform-b.json --equivalence --format json
```

`--equivalence` is shorthand for two filters — each also available on its own,
and each visible in the output rather than silently shrinking the numbers:

- `--exclude-default-origin` drops materialize-derived `origin: "default"` rows
  from the comparison. A [materialized](skills/review-sheet/SKILL.md) sheet
  writes down the product's *entire* option space, including everything left
  at its default; comparing that against a sheet that was never materialized
  makes every one of those rows look "removed" when the real story is that one
  side chose to write the full inventory down and the other didn't. The count
  is reported as `excluded.defaultOrigin` — filtered, not hidden.
- `--sheet-presence` reports a sheet that exists on only one side once
  (`sheetsOnlyOnOneSide: [{ name, onlyIn, paramCount }]`) instead of exploding
  every one of its parameters into `removed`/`added`. A layer that genuinely
  doesn't exist on one platform — no reverse-proxy sheet once an ALB
  terminates TLS directly — is a structural fact about that platform, not
  per-parameter drift.

Measured on a real staged migration (Keycloak on EC2 vs. ECS): plain `diff` reported `changed: 6, added: 0, removed: 181,
unchanged: 12` — the 6 rows that actually mattered were buried under 181
`removed` rows, of which 152 were materialize rows the ECS sheet never carried
and 23 belonged to a reverse-proxy sheet the ECS platform doesn't have.
`--equivalence` reduced that to `changed: 6, added: 0, removed: 6, unchanged:
12`, with the exclusion stated rather than assumed:
`excluded: { defaultOrigin: 152 }`, `sheetsOnlyOnOneSide: [{ name: "httpd
reverse proxy", onlyIn: "from", paramCount: 23 }]`. The remaining 6 `removed`
rows are genuine: a mix of real deployment differences (Secrets Manager access
parameters ECS doesn't need) and pre-existing gaps in the project's own
`sheet.yml` — not noise from the comparison mechanism.

This equivalence check rests on both sides actually landing on the same key,
which the same migration measured separately: 18/18 Keycloak
settings normalized to the same product key regardless of source (env var,
Terraform variable, or a Dockerfile build flag), 17/18 of those byte-identical
in value, and 0 false positives once `diff`'s Pattern A/Pattern B cell matching
was fixed. It is not free, but less
code buys it than it first looks: the ECS task definition's
`environment`/`secrets` arrays don't carry the product key as a plain field
name, but the built-in `layered` recipe plus a declarative `key` transform in
`build.yml` (a few lines of regex, no code — see [Declarative spec](#declarative-spec-buildyml--sheetyml))
normalizes them onto the same keys the EC2 side's `ansible` recipe derives
from its template. A **custom parser** is still needed for the other side of
the platform gap: build-time flags baked into a Dockerfile `RUN` line have no
built-in format, so that one plugin remains.

## Reviewing in the browser

Open `sheet.html` (generated without `--readonly`). Reviewers can:

- Edit a value to suggest a change, and leave a comment on any parameter,
  category, or sheet.
- Toggle comments, filter to commented rows, search across everything
  (Cmd/Ctrl+K), and navigate via the outline.
- Export their feedback as `review.json`, import an existing one to merge, or
  copy the AI prompt for all pending changes.

Feedback persists in the browser's local storage, so a reviewer can stop and
resume. The exported `review.json` is what you feed to `apply`.

---

## Editing a generated sheet

Generated with `--allow edit`, the HTML is not only readable but maintainable:
whoever holds it can change a value or a remark and add rows, and save the
document back over itself. It is for the case where the system is maintained by
hand, with no pipeline to re-run — the sheet is where the current value lives.

What makes it more than a spreadsheet is that **an edit never overwrites the
row**. It is appended as an `applied` review item carrying a timestamp and a
name, so:

- the original value survives underneath, still tied to its `source` — the line
  in the real config file it was extracted from;
- the steps between it and the current value are on record, and readable months
  later from the file itself;
- an edited cell is marked, so a value somebody changed afterwards is never
  mistaken for one this tool extracted and checked;
- an added row is marked too, and carries no source map, because no config file
  has a line for it;
- a row that is no longer set is **struck through, not removed** — it stays on
  the sheet with its value and its history readable, and can be restored. Both
  the striking-out and the restoring are recorded: months apart, they are two
  decisions, and the second does not erase the first.

A `recipe: document` sheet is editable too — as **markdown**, which is what it
came from and what an edit has to travel back to. The source and the images
travel with such a document (an image was embedded as a data URI at build time,
so it is in the HTML and not in the markdown; re-rendering without it would
quietly drop every picture). The markdown renderer is ~45 KB and is put in the
file only when a document may actually be edited.

**Paste an image** from the clipboard and it is embedded where the cursor is.
What goes into the markdown is a path — `images/<hash>.png`, the way the
document already refers to the pictures beside it — and the bytes travel next to
the text on the edit. A data URI inline would work equally well and read
terribly: a paragraph interrupted by 40 KB of base64 is unreadable in the editor
and in the `.md` the change goes back to. The name is content-addressed, so the
same picture pasted twice is one file.

An edit to a document reaches `apply` like any other: it names the markdown file
the page was rendered from, carries the whole new text, and lists any pasted
image as a file to write beside it.

A row whose value is shared by every environment asks which you mean before it
changes anything. Editing one environment **splits the row**: the others keep
the shared definition and its `source`, and the one you changed has no config
line behind it yet — which is exactly the work it is now asking for. Editing all
of them keeps the row shared.

Saving asks for a name and, more usefully, a **reason** — both optional. Each
save becomes one line of a change log on the overview page:

| When | By | | Why |
|---|---|---|---|
| 2026-09-02 10:30 +09:00 | 佐藤 | 1 | rolled back, the pool was starving |
| 2026-08-18 18:00 +09:00 | 田中 | 2 | raised after hitting the connection limit |

That log sits beside the generated document's own changelog rather than inside
it: one is the history of the DOCUMENT, the other of the installation it
describes, and they have different authors. The per-cell chain records what
changed and when; nothing but this can record why.

Saving rewrites the file in place on Chrome and Edge (via the File System Access
API) and falls back to a download elsewhere. Closing with unsaved edits warns —
the file is the only place they live.

Each save stamps the file with a revision, and the browser keeps unsaved work
under it. Without that, every copy of one generated document shared a buffer:
edit one copy without saving, open another, and the first one's work is sitting
in it, ready to be saved into the wrong file.

That work is loaded automatically, and the document **says so** — a notice when
it opens, and a count beside the save button for as long as it is unsaved. The
count survives the narrow-window layout that collapses button labels; the word
"Save" does not, and does not need to. Loading it is not a choice and there is no way to throw it away
there — both alternatives are worse. A discard button is an irreversible action
sitting beside the safe one, and "restore later" lets two working states exist
at once: put the work aside, edit, and now there are two sets of unsaved changes
and a question about which one the file gets. One state, always loaded, and the
screen says where it came from.

Only the unsaved work is kept in the browser — the rest is in the file.

### Getting the changes back into the config files

The history travels inside the document, so the edited HTML **is** the review
file:

```sh
review-sheet apply -i input.json -r returned.html --emit-prompt
```

The HTML is never handed to an AI — it is hundreds of KB of app and data.
`apply` reads the edit history out of it and splits the work by what a source
map can prove:

- a value change on a row with a source map is **applied deterministically** —
  the line is located, verified against what the file actually holds, and
  rewritten;
- a row that was added, or struck out, cannot be: where a new setting belongs,
  and whether a removed one is deleted, commented out or left to the product
  default, are judgements about the file. Those go into the AI prompt, with the
  reason and the file attached.

In one measured run that prompt was 2 KB against a 397 KB document.

The document can produce that prompt itself too, if it was built with
`--allow edit,prompt`, for whoever maintains it without a CLI. It is built from the same collapsed plan, so the two cannot
describe the same change differently; the difference is that only `apply` can
verify a location against the file it is about to edit.

There is deliberately **no JSON export in edit mode**. Exporting is what a
REVIEW document is for: it cannot write itself, its findings live only in that
browser's storage, and `review.json` is the single way out. An edit document
saves itself and `apply` reads it, so the same entries as JSON would be a lesser
copy of what the file already carries — and one that looks like an alternative
to saving, which is how work gets lost.

An edit history is **collapsed to its net change** first. A value edited from
500 to 600 to 700 is one change to make, because the file still holds 500 —
replaying the chain would fail at the first step the moment anyone had applied
part of it by hand, and cascade from there.

Both are self-declared: a standalone HTML has no identity and no trusted clock,
so this is a record of intent, not an audit trail. If you need one, that is the
VCS's job.

---

## Agent skill

`skills/review-sheet/SKILL.md` is a [Claude Code](https://claude.com/claude-code)
skill that describes the whole workflow for an AI agent: drafting `input.json`
from existing files with accurate source maps (including when to use `import` and
when to author by hand), and the `validate` → `verify` → `apply` loop.

To use it in your own project, copy the skill into your skills directory:

```sh
mkdir -p .claude/skills
cp -r path/to/review-sheet/skills/review-sheet .claude/skills/
```

Then ask the agent to, e.g., "build a review-sheet model from the config files in
`./deploy` and verify the source maps." The agent generates the model, runs
`verify`, and fixes any mismatches it reports.

---

## Library usage

```ts
import {
  generateHtml,
  validateInput,
  verifySources,
  computeApply,
  buildPromptText,
  // extraction adapters — for project-specific conversion scripts
  extractFile,
  buildInput,
  inferFormat,
} from "review-sheet";
```

`generateHtml(input, options?)` returns the HTML string. `verifySources` and
`computeApply` take an injected file reader, so you can build your own pipelines.
`extractFile(content, file)` turns one config file into entries with accurate
source maps (line + anchor, and a `path` for YAML/JSON); use it in a conversion
script so that you only write the project-specific structure, then run `verify`.

---

## Development

```sh
bun test          # run the test suite
```

See `CLAUDE.md` for the architecture and source layout.

## License

MIT
