# In-source annotation spec (TypeScript / Python) — v1

Status: **implemented (v1)** — TypeScript (`src/parsers/ts.ts`) and Python
(`src/parsers/py.ts`), on the language-agnostic core in `src/annotation.ts`. See
§8 for the exact surface and what is deferred to phase 2.

Goal: load **existing** config-as-code (AWS CDK, Pulumi, plain TS/Python config modules)
into review-sheet by **only adding comments** — no restructuring, no value wrappers, no
extra runtime dependency in the infra code. The annotations carry the sheet metadata
(label, description, default, category, …); the value and its source location are derived
from the code itself, so reviewer-approved value changes can be written straight back to
the real source.

It is a `ConfigParser` (see `src/parser.ts`) built on **ast-grep / tree-sitter** (syntactic
only — no type checking, no semantic/CDK-aware analysis). It runs CLI-side; the project ships
via bunx/npm, so the napi prebuilt binaries are fine (no single-binary need).

---

## 1. Core principle: value = the RHS expression, verbatim

The annotation is attached to a **property / assignment**. The parameter's `value` is the
**verbatim source text of that node's right-hand side**, whatever it is:

| Source | Sheet value |
| --- | --- |
| `bucketName: 'my-app-data'` | `'my-app-data'` |
| `readCapacity: 5` | `5` |
| `timeout: Duration.seconds(30)` | `Duration.seconds(30)` |
| `removalPolicy: RemovalPolicy.RETAIN` | `RemovalPolicy.RETAIN` |

We do **not** dig into the expression to extract a scalar. This dissolves the
"which literal / wrapped value" problem: a CDK value is usually wrapped
(`Duration.seconds(…)`, an enum member, a token) and has no single editable scalar — but
its RHS node always has a clean range.

**Write-back** = replace the RHS node's source range with the reviewer's new text.
**Safety net**: after the edit, re-parse with ast-grep and count `ERROR` nodes; if the edit
**increases** the parse-error count, reject it (prevents injecting broken code).

`value` (from code) and `default` (authored documentation) are **distinct**: a property may
have `value = Duration.seconds(30)` and an annotated `@rs:default Duration.seconds(60)`.

---

## 2. Marker & accepted comment styles

- Marker: **`@rs`**. Configurable via CLI `--annotation-marker` (e.g. `@myorg`). Detection is
  pure substring match inside a comment node, so changing the marker never affects the rules.
- Accepted comment styles: `//`, `/* */` (TS) and `#` (Python).
- **`/** */` is banned** for `@rs` content (collides with TSDoc/typedoc and shows as IDE
  hover noise; formatters auto-convert `/*`→`/**`). `review-sheet annotations --lint` flags
  `@rs` found inside `/** */` (rule `no-jsdoc`).

---

## 3. Association (comment → node)

- **Leading** comment on its own line → the **next** property / assignment. Consecutive
  line-adjacent comment lines are merged into one annotation, so a follow-up
  `// @rs:remarks …` line (or a multi-line `/* … */` block) above the value works:
  ```ts
  // @rs bucket name
  // @rs:remarks naming: <app>-data-<env>
  bucketName: "myapp-data-prod",
  ```
  (A following comment that itself starts with the marker is a separate annotation and
  stops the merge.)
- **Trailing** same-line comment → the property / assignment **on that line**.
- If one property has **both** a leading and a trailing `@rs`, it is flagged with a
  **warning** (`value has multiple @rs annotations`); the first one in document order (the
  leading comment) wins and the other is dropped — it is never silently merged.
- `param` (the key) is **always the identifier / property name** (e.g. `bucketName`,
  `removalPolicy`) so the sheet's key column maps straight to the real code / CDK property.
  The human text goes in the **description**. Use `@rs:param` only to override the key
  explicitly (rare).
- If the comment cannot be attached to a value node (e.g. object shorthand `{ bucketName }`,
  which is not one of the descriptor's `valueKinds`), it is skipped with a warning
  (`@rs comment not associated with a value`) rather than guessing — annotate the real value
  where it lives. Richer shorthand/non-literal handling is phase 2 (§8).

---

## 4. Field vocabulary (`@rs:`-namespaced)

Everything is one namespace: the value marker `@rs`, the directives `@rs:config` /
`@rs:category`, and the value fields `@rs:default` / `@rs:remarks` / … . Namespacing the
fields (rather than bare `@default`) keeps the grammar consistent **and** avoids clashing
with real JSDoc/TSDoc tags (`@param`, `@default`, `@remarks`).

| Annotation | Model field (`src/types.ts`) |
| --- | --- |
| leading text / `@rs:desc` (`@rs:description`) | `description` |
| `@rs:param` (override only) | `key` (default = identifier) |
| `@rs:default` | `default` |
| `@rs:remarks` | `remarks` |
| `@rs:scope out [reason]` | `out_of_scope: { reason }` |
| `@rs:col.<name>` / `@rs:extra.<name>` | `extra` (custom column) |
| (RHS expression) | `value` — auto |
| (identifier / property name) | `key` — auto |
| (AST node position) | `source` — auto |

`@rs` is the opt-in marker ("this property is a review-sheet parameter"); the text after it
is a shorthand for `@rs:desc`. The key stays the code property name unless `@rs:param`
overrides it.

### 4.1 Inline layout — description + short fields, one line

After `@rs`, the text up to the first `@rs:field` is the **description**; `key` stays the
property name. Each `@rs:field` runs to the next `@rs:field` or end of line:

```ts
timeout: Duration.seconds(30),  // @rs request timeout @rs:default 60s  → key=timeout, desc="request timeout"
bucketName: 'my-app-data',      // @rs bucket name                     → key=bucketName, desc="bucket name"
billingMode: 'PAY_PER_REQUEST', // @rs                                 → key=billingMode (no description)
readCapacity: 5,                // @rs @rs:param read_capacity         → key overridden to read_capacity (rare)
```

### 4.2 Block layout — long / multi-line description

The leading text on line 1 and any plain (non-`@rs:`) line are the **description**; lines
beginning with an `@rs:`-field set that field. `key` is still the property name:

```ts
/* @rs request timeout
 * Timeout for the external API call. Too long and Lambda times out first.
 * @rs:default Duration.seconds(60)
 * @rs:remarks SLA is within 3s
 * @rs:col.owner Infra team
 */
timeout: Duration.seconds(30),   // → key=timeout
```

All of `description` / `default` / `remarks` are **optional** — the minimum is bare `// @rs`
(key = the property name, no description). Author them only where they add value. Because the description sits
next to the value in-source, there is **no separate AI-authoring step** (unlike the other
parsers, where only `value` is extractable and the docs are authored elsewhere).

---

## 5. Category — lexical-scope accumulation

`@rs:category X` contributes a segment to a `/`-joined category path. A value's category is
the ordered concatenation of every `@rs:category` **in effect** at the value, outer → inner
(**append, never replace**). Nested annotations build nested categories.

An `@rs:category` is "in effect" for a value when the value is within its scope:

- **(a) on an object/array literal** → its contents and descendants;
- **(b) a standalone comment in a block** → the following siblings in that block and their
  descendants, until the next `@rs:category` in the same block; **bounded by the enclosing
  block** (does not leak to sibling blocks).

It must sit on **its own line** (a wedged `/* … */` between `,` and `{` is fragile under
Prettier — see §7). The class/construct is **not** semantically interpreted; the comment
simply descends lexically.

```ts
/* @rs:category Storage */
export class StorageStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    /* @rs:category Bucket */
    new s3.Bucket(this, 'Data', {
      bucketName: 'my-app-data',  // @rs bucket name   → category = Storage/Bucket
      versioned: true,            // @rs versioning
    });

    /* @rs:category Table */
    new dynamodb.Table(this, 'Sessions', {
      readCapacity: 5,            // @rs read capacity  → category = Storage/Table
    });
  }
}
```

`@rs:category /abs` (leading slash = absolute reset) is **phase 2**.

---

## 6. File-level config & Pattern B

```ts
/* @rs:config sheet: Storage  instance: prod  source_file: ...  lang: ja */
```

- `sheet` — default `Sheet.name` for the file.
- `instance` — tags every value in this file as belonging to the named **Pattern B**
  instance (per-environment value). Same `param` key across files (each with its own
  `instance`) groups into one `InstanceParameter`. **Explicit only** — no filename
  auto-inference (avoids silent env typos).
- `source_file`, `lang` — **parsed but not yet threaded into the model** (the registry
  `Entry` only carries `sheet` / `instance`). Accepted in the grammar so it stays
  forward-compatible; wiring them through `buildInput` is phase 2.

Only `sheet` and `instance` reach the model today. Document-level metadata (title /
project / version) stays in CLI options or a separate file — not in annotations.

---

## 7. Tooling-friction rules (must enforce)

- **`/* */` only; never `/** */`** for `@rs` (§2). Lint it.
- **`@rs:category` on its own line, immediately above a statement.** Prettier/Black treat
  comment position as non-load-bearing and may move comments across commas; keeping the
  annotation on a standalone line above the statement is the safe position. Lint anything
  riskier and recommend running the formatter once and re-checking.
- **`review-sheet annotations -f <file>…`** echoes the resolved `{ sheet, category, param,
  value, path }` per annotated node (printing is the default; `--lint` switches to the
  friction checks), so the lexical "action at a distance" of `@rs:category` is auditable in
  a diff/review. Unassociated `@rs` comments and the double-annotation case surface here as
  `!`-prefixed warnings (non-zero exit).

---

## 8. Implemented & out of scope

**Implemented:** TS (`src/parsers/ts.ts`) and Python (`src/parsers/py.ts`, grammar via
`@ast-grep/lang-python` `registerDynamicLanguage`) parsers; the value fields of §4
(`@rs:desc`/`@rs:default`/`@rs:remarks`/`@rs:scope out`/`@rs:col.*`/`@rs:extra.*`/`@rs:param`),
`@rs:category` lexical-scope accumulation (§5), and `@rs:config` `sheet` override + Pattern B
`instance` grouping (`buildInput`, §6); plain string literals shown unquoted and re-quoted on
write-back; write-back rejected if it raises the parse-error count; CLI `--annotation-marker`
(import/verify/apply/serve) and an `annotations` command (default prints the resolved nodes;
`--lint` runs the `no-jsdoc` / `category-own-line` friction checks).

**Phase 2 (not yet):**
- Non-literal / shorthand values: richer read-only handling and clearer diagnostics.
- `@rs:category /abs` absolute reset.
- `additional_sources` (same value synced across several sites) via a `@sync` marker.
- Python idiomatic path: `Annotated[T, …]` / `Field`-style metadata for Pydantic/dataclass
  in addition to `# @rs` comments.
- `cdk` convenience mode (auto-derive sheet from class, category from construct id) — only
  if the explicit form proves too verbose in practice.

---

## 9. Parser shape (implementation note)

A `ConfigParser` (`src/parser.ts`) named e.g. `ts` / `py`:

- `detect(file, content)` — extension `.ts`/`.tsx` (or `.py`) **and** the marker is present.
- `extract` — ast-grep over comment nodes → for each `@rs`, resolve association (§3), value
  (§1, RHS node text + range → `SourceLocation` line/column/anchor/path), fields (§4),
  category (§5), file config (§6) → `Entry[]`.
- `locate` / `edit` — by the RHS node range, same range-replacement shape as `src/xml.ts`
  (`xmlIndex` / `xmlEdit`), plus the post-edit re-parse safety check (§1).

This is the shape that shipped: `extractAnnotations` / `annotationExtract` /
`annotationLocate` / `annotationEdit` live in `src/annotation.ts`; each per-language parser
(`ts`, `py`) supplies a `LangDescriptor` and self-registers. The §5 CDK example runs
end-to-end (`import → verify → apply`) — see `examples/cdk-annotations/`.

### 9.1 `@ast-grep/napi` API — confirmed (v0.44.0)

Validated by probe against the §5 example:

- `parse(Lang.Tsx, src).root()` → `SgNode`. Match by kind with a rule object:
  `root.findAll({ rule: { kind: "comment" } })` (a **bare string is a pattern, not a kind** —
  `findAll("comment")` matches nothing; this is the main gotcha).
- Comment nodes: both `//` and `/* */` come through as kind `comment`; Japanese text intact;
  `range()` → `{ start/end: { line, column, index } }` with **0-based** line/column + byte
  `index` (model `SourceLocation.line` is 1-based → add 1).
- Object property = kind `pair` with fields `key` / `value` (`pair.field("value")`).
  Config-module RHS = `variable_declarator` (fields `name` / `value`).
- **value = RHS node text verbatim**, confirmed for wrapped values:
  `'my-app-data'`→`string`, `true`→`true`, `5`→`number`,
  `RemovalPolicy.RETAIN`→`member_expression`, `Duration.seconds(30)`→`call_expression`.
- Association: **trailing same-line** = find the `pair`/declarator whose `range().start.line`
  equals the comment's line; **leading** = `comment.next()` (a leading category comment's
  `.next()` is the following statement subtree). Category lexical scope is resolvable via
  `node.ancestors()` + `prevAll()` (preceding-sibling category comments at each level).
- Write-back: `valueNode.replace("new text")` → `Edit { startPos, endPos, insertedText }`
  (byte offsets); `root.commitEdits([edit])` → new source, **format-preserving** (only the
  replaced range changes; surrounding comments/layout untouched).
- **Language coverage of the base napi build: Html / JavaScript / TypeScript / Tsx / Css
  only — Python is NOT included.** TS ships out of the box; Python needs
  `@ast-grep/lang-python` via `registerDynamicLanguage` (a real instance of the §10
  "confirm the grammar is in the build" caveat).

---

## 10. Language generality — one engine, a thin per-language descriptor

The whole design uses only two universal syntactic features that **every** tree-sitter
language exposes:

1. **comment nodes** (the `@rs` marker is a substring match inside them), and
2. **"name = RHS expression" nodes** (property / assignment / keyword-argument).

Everything in §1–§6 (marker scan, value = RHS text + range, association, category
lexical-scope, file config, write-back by range replacement) operates on the **generic
tree** and is therefore language-independent. So the same engine extends to essentially any
tree-sitter language that has comments and assignments — Go, Java, Kotlin, Ruby, C#, … —
not just TS/Python. CDK is merely the first use case; the real capability is
**in-source parameter annotations for any "config expressed in a programming language."**
(This is complementary to the structural parsers in `formats/`, which extract from genuine
*config files*; annotations are for general-purpose code where nothing structural marks
which values are parameters.)

**Architecture rule:** the language-agnostic core is `src/annotation.ts`; each per-language
concern lives in a small **`LangDescriptor`** (the actual fields):

- `lang` — the `@ast-grep/napi` language handle (TS: `Lang.Tsx`; Python: the dynamically
  registered `"python"`).
- `valueKinds` — the node kinds that are "a name with an RHS value", each with its
  `keyField` / `valueField` (TS: `pair`, `variable_declarator`; Python: `assignment`,
  `keyword_argument`, `pair`).
- `pathSegments` / `constructKinds` — ancestor kinds that contribute a stable `path`
  segment (a declarator/class name, or a construct's first string id).
- `stringKinds` — node kinds treated as plain string literals (quotes stripped for display,
  re-added on write-back).

Each language ships as its own `ConfigParser` (`ts`, `py`) that self-registers and wraps the
core with its descriptor. **v1 ships TS + Python only**; this separation makes adding a
language later "add one descriptor," not a rewrite. (The doc-comment friction check is
currently generic — `lintAnnotations` flags `@rs` inside `/** */` wherever that syntax
exists; a per-language doc-channel is not yet part of the descriptor.)

**Caveats:** each language still costs a descriptor + tests + a registered parser (small,
not zero); confirm the target grammar is included in the `@ast-grep/napi` build (custom
grammars need `registerDynamicLanguage`, as Python does); and the syntactic-only limitation
applies uniformly (already accommodated by value = RHS expression).
