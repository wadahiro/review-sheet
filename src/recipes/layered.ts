// Layered recipe: the IaC-agnostic core every "one base file + per-instance
// overlay files" project shape reduces to — no Jinja2, no deployed_path, no
// keyMap (every row keeps its extracted identity as its key — see
// assemble.ts's SheetInputs.keyMap; a plain base+overlay layer has no
// template to derive a product key from). Split out of "ansible" (see that file's module
// doc for the thin specialization it keeps on top of this) because a real
// share of PoC use never touched any Ansible concept at all: a plain
// base+overlay `.env` set (a Keycloak realm's non-Ansible config) and a
// Terraform root module's `variables.tf` + per-environment `.tfvars`, both
// pressed into `recipe: ansible` for lack of anything narrower. See CLAUDE.md.
//
// `defaults` is OPTIONAL here (unlike "ansible", where Ansible always has a
// defaults/main.yml): a project with no shared base — every value genuinely
// per-instance, e.g. one merged artifact per environment with nothing to
// call a "default" — omits it and gets the same empty-base convention
// `snapshot` uses (src/recipes/snapshot.ts), so every key still becomes a
// real Pattern B parameter instead of forcing an artificial default.
//
// `defaults`/each overlay accepts one path OR a list of paths (merged in
// declaration order, later paths overriding earlier ones for the same key) —
// needed when a sheet's "base" is genuinely assembled from more than one
// file (e.g. one ECS task definition + one Dockerfile: runtime options and
// build-time options for the very same product, reviewed as one sheet). That
// override is only across DECLARED sources — a collision produced by ONE
// file's own extraction (two entries from the same extractFile() call
// landing on the same key) is never intentional and is a hard error instead
// (see buildMapFromSources's own doc comment below and the PoC's fedlens
// spec, which hit exactly this with TOML's [[oidc]]/[[saml]] both having a
// bare `base_url` leaf).
//
// Each source may also declare a `key` transform (src/keytransform.ts): a
// declarative rename/filter chain applied to every entry that file yields,
// BEFORE it reaches assembleSheets. This is what lets a nested/nonuniform
// format (hcl's `variable.<name>.default`, a JSON array element's
// `environment[name=X].value`) resolve to the project's own flat key space
// without a hand-written recipe — see CLAUDE.md's "declarative key
// transform" note for why AssembleHooks.keyFor is too late in the pipeline to
// do this job.
//
// `include`/`exclude` (src/keyglob.ts) apply to the FINAL (post-transform)
// key, across every source this recipe reads — same semantics "ansible" has
// always had, just shared here so both recipes mean the same thing by it.

import { extractFile, type Format } from "../extract.js";
import type { ExtractOptions } from "../parser.js";
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type { SheetInputs, ExtractedMap, EmbeddedEntry, ValueLayer } from "../assemble.js";
import { makeKeySelector, type KeySelector } from "../keyglob.js";
import { makeKeyTransformer, selectKeySource, keyTransformSchema, type KeyTransform } from "../keytransform.js";

export type SourceSpec = { path: string; format?: Format; key?: KeyTransform };

const sourceSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, format: { type: "string" }, key: keyTransformSchema },
      additionalProperties: false,
    },
  ],
};

const sourceOrListSchema = { oneOf: [sourceSchema, { type: "array", items: sourceSchema, minItems: 1 }] };

const schema = {
  type: "object",
  properties: {
    defaults: sourceOrListSchema,
    overlays: { type: "object", additionalProperties: sourceOrListSchema },
    static_files: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, format: { type: "string" }, key: keyTransformSchema },
        additionalProperties: false,
      },
    },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

function asString(v: JsonValue | undefined, field: string): string {
  if (typeof v !== "string") throw new Error(`layered recipe: "${field}" must be a string`);
  return v;
}

function asObject(v: JsonValue | undefined): Record<string, JsonValue> {
  return v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : {};
}

function asArray(v: JsonValue | undefined): JsonValue[] {
  return Array.isArray(v) ? v : [];
}

function asStringArray(v: JsonValue | undefined, field: string): string[] {
  return asArray(v).map((item, i) => asString(item, `${field}[${i}]`));
}

// Normalizes a `defaults`/overlay field (absent, one source, or a list) to a
// flat SourceSpec[] — [] means "no such source" (the caller decides what that
// means: an empty base layer, or an overlay simply not declared).
export function asSourceSpecs(v: JsonValue | undefined): SourceSpec[] {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : [v];
  return items.map((item) => {
    if (typeof item === "string") return { path: item };
    const o = asObject(item);
    const format = typeof o.format === "string" ? (o.format as Format) : undefined;
    const key = o.key === undefined ? undefined : (o.key as unknown as KeyTransform);
    return { path: asString(o.path, "path"), format, key };
  });
}

function readRequired(io: RecipeIO, path: string, what: string): { file: string; content: string } {
  const file = io.resolve(path);
  const content = io.readFile(file);
  if (content === null) throw new Error(`layered recipe: ${what} not found: ${file}`);
  return { file, content };
}

// A key collision found within ONE file's own extraction pass: two entries
// from the SAME extractFile() call landed on the same key after the (if any)
// key transform. `locations` carries every colliding entry's structural path
// (only entries that HAVE a path are tracked — see buildMapFromSources).
type InFileCollision = { key: string; locations: string[] };

// Regex-escapes a literal string for use inside a `pattern`.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Best-effort `key: { from: path, steps: [...] }` suggestion: for every
// distinct structural prefix among the colliding entries' paths (the part
// before the shared leaf key, e.g. `oidc[name=poc-oidc]` out of
// `oidc[name=poc-oidc].base_url`), propose a step that keeps that whole
// sub-tree's keys apart from its sibling's — the same shape as the fix
// fedlens's own build.yml carries by hand (see SKILL.md's "`defaults`/
// `overlays` vs. `static_files`: they key differently" section). Only fires when every
// colliding path actually ends in `.<key>` (a real nested/repeated
// structure, not a top-level collision) and the resulting prefixes are all
// distinct (otherwise the transform could not tell the entries apart either
// and this is not a helpful suggestion).
function suggestKeyTransformSteps(collisions: InFileCollision[]): string[] {
  const prefixes = new Set<string>();
  for (const { key, locations } of collisions) {
    for (const path of locations) {
      if (path.endsWith(`.${key}`)) prefixes.add(path.slice(0, path.length - key.length - 1));
    }
  }
  if (prefixes.size < 2) return [];
  // An identity predicate can be dropped because what distinguished the paths
  // survives in the segment name itself ("oidc[name=poc-oidc]" -> "oidc" vs
  // "saml[name=poc-saml]" -> "saml"). A POSITIONAL index cannot: the index IS
  // the only thing telling "servers[0]" from "servers[1]", so dropping it
  // hands back a transform that maps both to one key — a "fix" that
  // reproduces the collision it claims to solve. Keep it as a plain segment.
  const labelFor = (prefix: string): string =>
    prefix.replace(/\[([^\]]*)\]/g, (_m, inner: string) => (inner.includes("=") ? "" : `.${inner}`));
  const entries = [...prefixes].sort().map((prefix) => ({ prefix, label: labelFor(prefix) }));
  // Last resort: if the labels still are not all distinct, no suggestion is
  // better than a wrong one — the caller falls back to the generic advice.
  if (new Set(entries.map((e) => e.label)).size !== entries.length) return [];
  const lines: string[] = [];
  for (const { prefix, label } of entries) {
    lines.push(`    - pattern: '^${escapeRegExp(prefix)}\\.(.+)$'`);
    lines.push(`      replace: '${label}.$1'`);
  }
  return lines;
}

function formatKeyCollisionError(what: string, file: string, collisions: InFileCollision[]): string {
  const lines = [
    `layered recipe: ${what}: ${file} maps more than one structural location to the same key — ` +
      `the later one would silently replace the earlier, dropping a row with no error or warning:`,
    "",
  ];
  for (const { key, locations } of collisions) {
    lines.push(`  "${key}":`);
    for (const path of locations) lines.push(`    - ${path}`);
  }
  lines.push("");
  const steps = suggestKeyTransformSteps(collisions);
  if (steps.length > 0) {
    lines.push(`Fix: give this source a "key" transform (from: path) that keeps them apart, e.g. paste as this source's own field:`);
    lines.push(`  key:`);
    lines.push(`    from: path`);
    lines.push(`    steps:`);
    lines.push(...steps);
  } else {
    lines.push(
      `Fix: give this source a "key" transform (from: path, with a pattern/replace per colliding location) ` +
        `so each structural path maps to its own key — see src/keytransform.ts and the fedlens example in the skill.`
    );
  }
  return lines.join("\n");
}

// Reads every source in `specs`, applies each one's own key transform (if
// any) then the shared include/exclude selector, and merges the results into
// one map. Later SOURCES (distinct declared paths in `specs`) win on key
// collision by design — that is the whole point of accepting a list here
// (merging one ECS task definition's runtime options with its Dockerfile's
// build-time options into a single base/overlay layer; see this file's own
// module doc and tests/recipe-layered.test.ts's "later overriding earlier").
//
// A collision WITHIN one file's own extraction is a different thing
// entirely: it means the format's structure (a TOML [[array-of-tables]], a
// JSON array of objects) produced two entries that are genuinely different
// data sharing the same LEAF key, and unless the shared identity field is
// registered via idFields, the "identity" that would have kept the leaf key
// apart never made it into the key at all — silently colliding, not
// intentionally overriding. Detected only when both entries carry a
// structural `source.path` (a flat/leaf-only format like dotenv has none, and
// there "the second line wins" is the format's own semantics, not this
// recipe's to second-guess).
export function buildMapFromSources(
  io: RecipeIO,
  specs: SourceSpec[],
  what: string,
  selector: KeySelector,
  extractOptions: ExtractOptions | undefined,
  warn: (message: string) => void
): ExtractedMap {
  const out: ExtractedMap = new Map();
  for (const spec of specs) {
    const { file, content } = readRequired(io, spec.path, what);
    const transformer = spec.key ? makeKeyTransformer(spec.key) : undefined;
    const seenPathsInFile = new Map<string, string[]>();
    for (const e of extractFile(content, file, spec.format, extractOptions)) {
      let key: string | undefined;
      if (transformer) {
        key = transformer.apply(selectKeySource(spec.key!.from, e.key, e.source.path));
      } else {
        key = e.key;
      }
      if (key === undefined) continue;
      if (!selector.select(key)) continue;
      if (e.source.path !== undefined) {
        const paths = seenPathsInFile.get(key);
        if (paths) paths.push(e.source.path);
        else seenPathsInFile.set(key, [e.source.path]);
      }
      out.set(key, { value: e.value, source: { ...e.source, file } });
    }
    const collisions: InFileCollision[] = [...seenPathsInFile]
      .filter(([, paths]) => new Set(paths).size > 1)
      .map(([key, paths]) => ({ key, locations: [...new Set(paths)] }));
    if (collisions.length > 0) {
      throw new Error(formatKeyCollisionError(what, file, collisions));
    }
    if (transformer) {
      const unmatched = transformer.unmatchedDropPatterns();
      if (unmatched.length > 0) {
        warn(`${what}: key transform pattern matched nothing in ${file}: ${unmatched.join(", ")}`);
      }
    }
  }
  return out;
}

type StaticFileSpec = { path: string; format?: Format; key?: KeyTransform };

function staticFileSpecs(v: JsonValue | undefined): StaticFileSpec[] {
  return asArray(v).map((item) => {
    const o = asObject(item);
    const format = typeof o.format === "string" ? (o.format as Format) : undefined;
    const key = o.key === undefined ? undefined : (o.key as unknown as KeyTransform);
    return { path: asString(o.path, "static_files[].path"), format, key };
  });
}

// A static file's default key is the structural path (falling back to the
// leaf key) — unlike defaults/overlays, whose entries are historically flat
// Ansible-style variables keyed by their leaf name. Preserves the "ansible"
// recipe's own long-standing static_files behaviour when no `key` is given.
function buildEmbeddedFromStaticFiles(
  io: RecipeIO,
  specs: StaticFileSpec[],
  selector: KeySelector,
  extractOptions: ExtractOptions | undefined,
  warn: (message: string) => void
): EmbeddedEntry[] {
  const out: EmbeddedEntry[] = [];
  for (const sf of specs) {
    const { file, content } = readRequired(io, sf.path, "static file");
    const transformer = sf.key ? makeKeyTransformer(sf.key) : undefined;
    for (const e of extractFile(content, file, sf.format, extractOptions)) {
      const key = transformer ? transformer.apply(selectKeySource(sf.key!.from, e.key, e.source.path)) : (e.source.path ?? e.key);
      if (key === undefined) continue;
      if (!selector.select(key)) continue;
      out.push({ key, value: e.value, source: { file, line: e.source.line, path: e.source.path } });
    }
    if (transformer) {
      const unmatched = transformer.unmatchedDropPatterns();
      if (unmatched.length > 0) {
        warn(`static file: key transform pattern matched nothing in ${file}: ${unmatched.join(", ")}`);
      }
    }
  }
  return out;
}

export const layeredRecipe: SheetRecipe = {
  name: "layered",
  schema,
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const name = asString(sheetSpec.name, "name");
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);

    // See the "ansible" recipe's own comment on this: a shared overlay file
    // commonly carries more than one sheet's variables, so selection is
    // opt-in rather than "drop whatever the base does not declare".
    const selector = makeKeySelector(asStringArray(sheetSpec.include, "include"), asStringArray(sheetSpec.exclude, "exclude"));

    const defaultsSpecs = asSourceSpecs(sheetSpec.defaults);
    const baseMap =
      defaultsSpecs.length > 0
        ? buildMapFromSources(io, defaultsSpecs, `sheet "${name}": defaults`, selector, io.extractOptions, warn)
        : new Map();
    // Display fallback: the first defaults source, when there is one — mirrors
    // what a hand-written recipe (e.g. the PoC's former "terraform" recipe)
    // would set by hand. No defaults (snapshot-style sheets) leaves it unset.
    const filePath = defaultsSpecs.length > 0 ? io.resolve(defaultsSpecs[0].path) : undefined;

    const overlayLayers: Extract<ValueLayer, { kind: "overlay" }>[] = Object.entries(asObject(sheetSpec.overlays)).map(
      ([instance, spec]) => ({
        kind: "overlay" as const,
        instance,
        entries: buildMapFromSources(
          io,
          asSourceSpecs(spec as JsonValue),
          `sheet "${name}": overlay "${instance}"`,
          selector,
          io.extractOptions,
          warn
        ),
      })
    );

    const embedded = buildEmbeddedFromStaticFiles(io, staticFileSpecs(sheetSpec.static_files), selector, io.extractOptions, warn);

    // A pattern that matched nothing means the filter is not doing what its
    // author thinks — most likely rows are missing from the sheet.
    const unmatchedSelector = selector.unmatchedPatterns();
    if (unmatchedSelector.length > 0) {
      warn(`sheet "${name}": include/exclude pattern matched nothing: ${unmatchedSelector.join(", ")}`);
    }
    for (const w of warnings) console.warn(`layered recipe: ${w}`);

    return {
      name,
      ...(filePath ? { filePath } : {}),
      instances: io.instances,
      layers: [{ kind: "base", entries: baseMap }, ...overlayLayers],
      embedded,
    };
  },
};

registerRecipe(layeredRecipe);
