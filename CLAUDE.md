# CLAUDE.md

## Project

review-sheet — CLI tool and library that generates reviewable parameter sheet HTML from JSON input. Targets Japanese IT infrastructure teams but supports English UI via i18n.

## Stack

The choices `package.json` does not explain:

- Bun runs the TypeScript directly — there is no build step for the CLI.
- The browser app is Preact + htm, bundled INLINE into one self-contained HTML
  file (`Bun.build()`); custom CSS, no framework.
- Config edits go through `yaml` and `saxes` because both report source
  positions — that is what makes format-preserving surgical edits possible.
- `tests/viewer.test.ts` renders the real Preact tree against happy-dom, so the
  viewer is covered by `bun test` like any pure core.

## Commands

```sh
bun test                    # run all tests
bun run typecheck           # tsc --noEmit over src/ AND tests/ (tsconfig.json alone excludes tests/)
bun run src/cli.ts import -f <conf>... -o <file>  # draft a model (with source maps) from config files
bun run src/cli.ts generate -i <file>... -o <file>  # generate HTML (multiple inputs = version history, ordered by date)
bun run src/cli.ts validate -i <file>            # validate a model / review / dictionary / overlay (JSON or YAML)
bun run src/cli.ts verify -i <input>             # verify source maps resolve in the real config files
bun run src/cli.ts apply -i <input> -r <review>  # apply reviewed value changes (dry-run; --write to commit). <review> may be an edited sheet.html
bun run src/cli.ts serve -i <input>              # localhost UI (127.0.0.1) that applies edits directly to local files
bun run docs                  # regenerate per-format docs (run after editing parser meta)
```

## Code conventions

- Source code comments and commit messages in English
- UI-facing strings (table headers, alerts, button labels) are i18n'd via `src/html/i18n.ts` — support `ja` and `en`
- No TypeScript `class` unless absolutely necessary
- No `any` or `unknown` types
- Semantic commit messages in English

## Architecture

One pipeline, each stage a pure core with its I/O injected (no `fs` inside a core
— `apply.ts`/`verify.ts` are the reference shape):

```
extract   config file  -> Entry[]           parser per format (src/parsers/)
recipe    file layout  -> layers            src/recipes/, chosen by build.yml
assemble  layers       -> sheets            Pattern A/B, categories, materialize
bind      project key  -> dictionary entry  src/bind.ts, five tiers, run once
enrich    sheets       -> descriptions      metadata providers, priority-merged
generate  model        -> one HTML file
```

Three stances decide most design arguments here:

- **Never drop a row in silence.** Losing a parameter is the failure mode this
  whole area exists to prevent. Report it, or fail the build — never continue
  quietly. The same applies to a rule that matched nothing.
- **Prefer a machine-checked declaration to prose.** Prose about the code rots
  and nothing notices; a check does not.
- **Registries are process-wide** (`src/registry.ts`, keyed off `Symbol.for`) so
  a plugin that resolved its own copy of a module still registers into the array
  the CLI reads.

Per-module rationale lives in `.claude/rules/architecture.md`, which loads
automatically when you touch `src/` or `tests/`. Beside it,
`.claude/rules/verifying.md` records how a claim about this codebase earns the
right to be believed — written from a measured failure record, not from
principle, and the rule that matters most is that nothing is green until it has
been seen red.

## Source map

`source` (`{ file, line, column, end_line, anchor, path }`) records where a value
lives in the real config — on a simple parameter, or per instance for Pattern B.
Only `value` is source-mapped; `description`/`default`/`remarks` are documentation.

Two locators, in this order:

- `path` — a structural address, for nested YAML/JSON. Survives reordering, and
  edits the exact scalar while preserving formatting.
- `line` + `anchor` — the fallback. `anchor` is a literal substring of the
  value's line: it confirms the line and re-locates it if the file drifted. It
  is delimiter-agnostic, so one mechanism covers `=`, `:`, space and tab.

**History is the VCS's job, not this tool's.** A version history is built by
passing one single-version model per revision (`generate -i a.json b.json ...`);
`assembleVersions` orders them by each model's `metadata.generated_at`, NOT by
argument order. See the skill for source-map authoring rules.
