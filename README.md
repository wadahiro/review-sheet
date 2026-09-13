# review-sheet

Generates a self-contained parameter-sheet HTML from a JSON description of your
configuration, collects reviewer feedback on it, and applies the approved changes
back to the real config files.

It is for infrastructure / IaC teams that review settings (sysctl, YAML, `.env`,
Helm values, Ansible vars, …) the same way they review code. Each value carries a
source map recording where it lives in the real files, so an approved change can
be written to that line. Values that cannot be edited deterministically are
collected into an AI prompt instead.

- Two shapes, one model. **HTML** for reading and reviewing: one self-contained
  file, no server, no runtime dependencies. **Markdown** (`--format md`) for
  handing over: one file per sheet, the chapter tree as directories, every row
  linked to the line of the deployed file it is written on — the shape a
  recipient maintains with an assistant, and the one a repository diffs.
- Reviewers propose values and leave comments, then export their feedback as
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
- Japanese or English, decided when the document is generated (`--lang`) — for
  the prose as much as for the chrome, so the markdown and the HTML say the same
  words. Prose the project only has in the other language is shown in it and
  COUNTED, rather than shown silently. The AI prompt is always English.

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
(edits go straight to disk). Whichever you pick, [handing the sheet
over](#handing-a-sheet-over) afterwards is its own question, answered by
`--format md`.

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
4. Review: send the HTML to reviewers. They propose values and add comments, then Export `review.json`.
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

#    ... share sheet.html, reviewers propose values + comment, Export -> review.json ...

# 4. Preview the edits, then write them
review-sheet apply -i input.json -r review.json            # dry-run diff
review-sheet apply -i input.json -r review.json --write     # apply

# --- or, instead of steps 3-4, review locally and write edits straight to disk ---
review-sheet serve -i input.json                            # localhost UI, applies on save

# 5. Hand it over: the same model as a markdown set, with a viewer beside it
review-sheet generate -i input.json --format md -o sheet/
review-sheet verify   -i input.json --md sheet/             # …and in CI, so it cannot go stale
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
| `crontab` | /etc/crontab, /etc/cron.d/*, cron.d/*.j2 | One row per line: a job verbatim, or a `NAME=value` assignment. |
| `jinja2` | *.j2 | Templates (.j2): base-format structure + the {{ variable }} behind each value (extraction aid). |
| `logrotate` | /etc/logrotate.conf, /etc/logrotate.d/*, logrotate-*.j2 | `/path/*.log { … }` blocks: flags, `name args`, and script bodies. |
| `dockerfile` | Dockerfile, Containerfile (any suffix), *.dockerfile | The instructions that decide something a reviewer signs — the base image, the environment, the ports, the user, what it runs. |
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
| `dotenv` | *.env | .env KEY=value files; export prefix stripped; surrounding quotes read as syntax; `KEY=` kept as a row; # comments. |
| `ini` | *.ini *.cfg | INI/CFG [section] files; sections become categories. |
| `properties` | *.properties | Java .properties key=value files; # and ! comments; no sections, so no category of its own. |
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

A minimal example, trimmed from `tests/fixtures/projects/ansible-basic/review-sheet/` (one
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
  order; each sheet names one with `group:`. They are the CHAPTERS: the tree
  beside the text is drawn from them, the sticky bar keeps the path to where the
  reader is, and `--format md` writes them as the directories the set is in.
  That is what lets a document hold a workbook's worth of sheets — a strip of a
  hundred tabs is a menu nobody can see. Checked both ways: a sheet naming an undeclared
  group, an unused group, and an ungrouped sheet in a grouped document are all
  build errors. A group is display structure only — it appears in no review
  target, so grouping an existing document orphans nothing.
- **A sheet's name is identity; `label:` is what a reader sees.** Declared in
  `sheet.yml` beside the sheet's other display facts, as a `{ ja, en }` pair,
  resolved for the language the document is generated in. The name still keys
  every review target, diff and CLI message, so a sheet can be renamed in either
  language without orphaning a finding filed against it — and the markdown set
  names its file by the label while the identity stays underneath.
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

### `generate` — model → a document to read, or a set to hand over

```sh
review-sheet generate -i input.json -o sheet.html
review-sheet generate -i v1.json v2.json v3.json -o sheet.html  # version history (ordered by date)
review-sheet generate -i input.json --readonly -o sheet.html    # a copy that can only be read
review-sheet generate -i input.json --lang en -o sheet.html     # English (default: ja)
review-sheet generate -i input.json --format md -o sheet/       # the same model as a markdown set
```

`-i` accepts multiple files; each is a snapshot, ordered by its
`metadata.generated_at` (see [Versions & diff](#versions--diff)). `-o` defaults to
stdout, and is a DIRECTORY under `--format md`. `--title` overrides the document
title.

`--lang` decides the content's language as well as the chrome's, once, here —
there is no switch in the page. A document that said two different things
depending on a button could not be projected to markdown, which holds one
language, and one model saying two things is what made the markdown a lesser
view of it. Prose the project only has in the other language is shown in it and
counted, rather than shown silently.

`--format md` writes the set described in
[Handing a sheet over](#handing-a-sheet-over): an index, one file per sheet, the
chapter tree as directories, the artifacts and evidence beside the chapter that
describes them, and a `viewer.html` that reads it back.

`--allow` states what the recipient may do: `review`, optionally with `prompt`.
`prompt` is not a mode; it adds the AI-prompt affordance. It is off unless named,
because it is a judgement about the AUDIENCE: in the usual flow the review comes
back to whoever built the sheet and `apply` produces the prompt there, against
the real files, so the handed-over copy often has no use for one. Asking for
`prompt` alone is an error — it is built from findings, and a document with none
has nothing to put in it.

| `--allow` | review | prompt |
|---|:--:|:--:|
| *(omitted)* — same as `review,prompt` | ✅ | ✅ |
| `--readonly` | | |
| `review` | ✅ | |
| `review,prompt` | ✅ | ✅ |
| `prompt` | *error* | |

Without `--allow`, `--readonly` decides: it hands over a document that can only
be read. (`--no-review` is the old spelling of it.) An unknown name is an error,
not an ignored word.

### `validate` — schema check

```sh
review-sheet validate -i input.json               # a model
review-sheet validate -i review.json              # a review export
review-sheet validate -i httpd@2.4.62.yml         # a dictionary (YAML), or its .overlay.yml
review-sheet validate -i results.json             # a unit test's answers
review-sheet validate -i results.json --plan plan.json   # …and whether they answer that plan
```

With `--plan`, the shape check is followed by the one a test record actually
needs: every item of the plan answered, every answer belonging to the plan, and
nothing left `not_run` without a reason. It does NOT gate on pass/fail — a
record with failures in it is doing its job.

### `test-plan` — what the unit test has to check

```sh
review-sheet test-plan -i input.json -o plan.json [--instances staging production] [--sheets ...]
```

Derives the plan from the model, so the coverage such a document always claims —
"every setting the detailed design records is checked" — is what the build
enforces rather than a promise. What each row asks for follows from its origin: a row
this project set is checked against its value in that environment, an unset row
asserts that the product's own default still applies, and a row the vendor
shipped and this project removed asserts that no line carries it.

What no model can derive is declared per UNIT (a group in the project metadata,
or a sheet that belongs to none):

```yaml
groups:
  - name: app-server
    label: { en: Application server }
    test:
      method: |            # how this unit is tested at all — written once
        Read the deployed files on the host and compare them with the design.
      functional:          # items with no row behind them
        - It starts, stops and restarts
      taxonomy:            # how THIS organisation raises its items, per level
        - level: { en: Unit }      # the words are the project's own test
          raised: { en: One per server }   # standard, never the tool's
        - level: { en: Component }
          raised: { en: One per software component }
        - level: { en: Setting }
          raised: { en: Every setting the design records }
  - name: network
    test:
      not_tested: { en: Not tested in this phase — covered by the plan diff }
```

A unit that holds testable rows and declares neither `method` nor `not_tested`
FAILS: untested by accident and untested on purpose look identical in a finished
document, and only the second is allowed to be silent.

Nothing here runs anything. The plan says what to check and what is expected; a
collector and a judge outside answer it, in the shape `validate --plan` reads
back.

### `test-doc` — the tables, into the document a project wrote

```sh
review-sheet test-doc -i input.json -r results.json --unit server-sso -d tests-sso.md
```

A test specification-and-record is mostly prose only a project can write, around
tables only a machine should: they are a thousand rows long and they change with
every run. So this does not generate the document — it fills the parts of one
that are marked for it, in place, the way the parser tables are filled into this
README:

```md
## How items are classified
<!-- test:taxonomy:start --><!-- test:taxonomy:end -->

## Items and results
<!-- test:items:start --><!-- test:items:end -->
```

`test:items`, `test:functional`, `test:summary` (counts, computed — a written
summary is the first thing to rot), `test:taxonomy` and `test:excluded`. A
marker nothing fills is an error; a block that carries ANSWERS and has nowhere
to go is an error; the rest a document may simply decline.

The levels a project's `taxonomy` declares are all POINTABLE on the page, or the
table describing them describes nothing a reader can find: the first (the unit)
is named in each environment heading, the second (the sheet) is a heading of
its own, the third is one row. Each row says WHAT is expected and, beside it, WHO decided
it — this project, the vendor's own configuration kept or changed, the product's
default, or the vendor's line this project removed. Those are two questions, and
a record that answers only the first cannot say whether `Listen 80` is a decision
or an inheritance. Their NAMES and the rule for raising their items are the
project's words — an organisation's test standard states them, and quoting one
organisation's sentences inside this tool would publish them to every other
project it builds; what the tool adds is the other half of each row, where that
level is on the page it just wrote. A taxonomy nobody declared renders no block
at all. What a row is ABOUT — the component, which is addressing detail inside a
sheet — is a column rather than a heading, since a client identified by its URL
makes an unreadable heading and a fine cell.

Run without `-r`, it writes the specification before any run — every item, every
environment, not yet run. With `-r`, the results must answer the plan (the same
check `validate --plan` makes) or no document is written.

The unset-parameter items are counted rather than listed, since two thousand
"still on the product's default" rows are a real check and not what a reviewer
signs; `--include-defaults` prints them as rows for a customer who wants the
exhaustive list.

### Evidence — the raw material a verdict was read from

```sh
review-sheet generate -i input.json --evidence results.json -o sheet.html
```

A verdict names an address — `web01 /etc/httpd/conf/httpd.conf:12` — and
until this flag existed the thing that address named lived only on a machine
nobody reading the record could reach. `--evidence` carries it: each collected
file, and each command's output, becomes a document in the page, and the record's
evidence cell becomes a link that opens it at the line the verdict was read at.
The link is markdown's own (`rs-evidence:` — a scheme nothing outside the page
resolves), because the record is a document a project owns and its renderer
escapes raw HTML in it: an `<a>` written into a cell shows up as visible markup.

It is the same answer the artifact panel gave the sheet's rows, one journey
over, and it reuses the same panel — with two rules that are not decoration:

- The header says the document was **collected**, from which host and at what
  moment (`nature: "observed"`), never "Rendered from". Those are opposite
  claims about who produced the bytes.
- An observed document is NOT in the row->preview index. A row already routes to
  exactly one document, and an observed copy of the same file would make which
  one it opens depend on emission order. It is reached from the verdict that
  cites it, which is the reader who wants it.

What may travel is the JUDGE's decision, not the tool's: the thing that collected
the bytes is the layer that already redacts a credential before it leaves the
host, and it writes `evidence` into the results. And `--instances` narrows
evidence exactly as it narrows values — the environments a delivery does not
cover are not in the file, not hidden in it. A page built without the flag keeps
the address as plain text: an affordance that opens nothing is worse than none.

### `verify` — source maps vs. the real files

```sh
review-sheet verify -i input.json [--quiet]
review-sheet verify -i input.json --md sheet/   # …and that a committed set still describes it
```

Checks every value's source: the file is readable, the value is located by
line/anchor (or by `path` for YAML/JSON), and the recorded value is still there.
Reports `ok` / `warn` (ambiguous anchor) / `error` (stale value or wrong locator)
/ `unmapped` (intentionally left to the AI prompt), and exits non-zero on errors.
Run it after `import` and after any hand edits.

`--md` adds the other staleness question. A committed markdown set is read for
months and nothing about it says it has stopped describing the configuration: a
value moves in a file, the HTML is regenerated, and the markdown goes on looking
exactly as correct as the day it was written. The set's index carries which
model it came from; this holds it to that, and fails when they are not the same
one. A set written before the stamp existed warns rather than fails — not being
able to answer is not the same as being wrong. A delivery narrowed with
`--instances` records what it covers, and this narrows the same way before
comparing: the set says which environments it is, so nobody has to remember
which flags built it.

### `apply` — review.json → config edits

```sh
review-sheet apply -i input.json -r review.json                 # dry-run preview (diff)
review-sheet apply -i input.json -r review.json --write          # write the edits
review-sheet apply -i input.json -r review.json --emit-prompt    # print the AI prompt for the rest
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

- Propose a value and leave a comment on any parameter, category, or sheet.
- Toggle comments, filter to commented rows, search across everything
  (Cmd/Ctrl+K), and navigate via the outline.
- Export their feedback as `review.json`, import an existing one to merge, or
  copy the AI prompt for all pending changes.

Feedback persists in the browser's local storage, so a reviewer can stop and
resume. The exported `review.json` is what you feed to `apply`.

---

## Handing a sheet over

The generated HTML is READ, not edited. A sheet is a view of a model, and the
model is what the sources say — so a value that has moved is changed where it is
written, and the sheet is generated again. What a reviewer produces is findings,
and those leave through `apply -r review.json`, the AI prompt, or `serve`.

Which leaves the question of who does the regenerating, and there are two
answers.

**A project that keeps the repository** regenerates it. The sheet and the
markdown are both projections of the model; the markdown is committed, so
`git diff` over it is a review of what moved, and `verify --md` says when it has
stopped describing the model beside it.

```sh
review-sheet generate -i input.json --format md -o sheet/
review-sheet verify   -i input.json --md sheet/     # …and in CI
```

`-o` takes a `.zip` instead, for a hand-over where the set has to arrive as one
thing and be checked as a unit. The directory stays the primary form: it is what
a repository diffs, and an archive holding a `.html` is what a corporate mail
gateway most often refuses.

**A project that does not** gets the folder. `--format md` writes a `viewer.html`
beside the set: it opens on the sheet as delivered, and a folder dropped onto it
replaces what is shown with what the folder says — which is how a recipient with
no toolchain looks at what they, or the assistant they asked, have since
changed. The page says so while it is showing one, and reviewing is off in that
state: the rows are no longer the model's.

```
sheet/
  README.md                     the index, the model's stamp, and what to do
  viewer.html                   open this; drop the folder on it
  詳細設計/SSO サーバ/Keycloak.md        one file per sheet
  詳細設計/SSO サーバ/artifacts/…        what the deployed file says
  詳細設計/SSO サーバ/evidence/…         what a host was found holding
```

Under its key, every row that has one carries a **プレビュー** link to the file
it is a line of, at that line — the same affordance the HTML puts there, and the
reason the files travel with the sheet. A value is judged by what surrounds it:
the `<IfModule>` it sits in, the `{% if %}` that decides whether it is there at
all. The link opens the deployed file, never the repository line the value is
written on — a recipient has no checkout for that to resolve in, and whoever
does has `review-sheet` itself, whose AI prompt already groups every change by
the file to edit.

A delivery is TWO things with one role each — `viewer.html`, which you open,
and `sheet/`, which you drag onto it once you have edited something. Dragging is
a gesture to repeat after every edit, so the page can write what it is holding
into a copy of itself: press **Save as one file** and you get a `sheet.html`
that carries the whole set. Open that from then on — no folder, no dragging —
and a link into the set opens beside the sheet rather than in the browser.

A button, and nothing to run. A `.bat` that rebuilt the page was written and
removed: every way it could be refused belonged to the act of running a script —
an EDR, an AppLocker rule, the mark-of-the-web on a file out of a downloaded
zip, and ConstrainedLanguage, which is what PowerShell drops into under WDAC and
where the .NET it needed is refused outright. A button in a page the recipient
is already looking at is refused by none of them. Nothing in a delivery is
executable.

The mode that let a recipient maintain the HTML itself was built and removed: a
sheet with no model behind it has no per-cell review target, no origin and no
dictionary, and `apply` could only guess where its text belonged.

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
