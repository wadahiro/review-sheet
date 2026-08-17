// Layered recipe: the IaC-agnostic core every "one base file + per-instance
// overlay files" project shape reduces to — no Jinja2, no deployed_path. Every
// row keeps its extracted identity as its key (see assemble.ts's
// SheetInputs.keyMap; a plain base+overlay layer has no template to derive a
// product key from) UNLESS a static file's own `substitution:` declaration
// (see below) recognizes and merges it — the one, opt-in exception. Split out
// of "ansible" (see that file's module
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
// (see buildMapFromSources's own doc comment below and the `fedlens` spec,
// which hit exactly this with TOML's [[oidc]]/[[saml]] both having a bare
// `base_url` leaf).
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
//
// A static file may also declare `substitution: { pattern }` (src/substitution.ts):
// an opt-in regex that recognizes a value as a reference into the sheet's own
// base/overlay layers (e.g. keycloak-config-cli's `$(env:X)`) and, where it
// safely can, merges the static-file row into the row the reference points
// at — see substitution.ts's module doc for the five-way classification. This
// is the one way `layered` CAN produce a `keyMap` entry (previously never —
// see the historical note that used to sit here): the merge behaves exactly
// like the "ansible" recipe's own `{{ var }}` -> product-key binding
// (deliberate convergence, see the design's Q1), it is just recognized from a
// value's TEXT instead of a template's parse tree.

import { extractFile, type Format } from "../extract.js";
import type { ExtractOptions } from "../parser.js";
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type { SheetInputs, ExtractedMap, EmbeddedEntry, KeyMapEntry, ValueLayer } from "../assemble.js";
import { makeKeySelector, type KeySelector } from "../keyglob.js";
import {
  makeKeyTransformer,
  selectKeySource,
  keyTransformSchema,
  splitKeySteps,
  splitComponentSteps,
  nestedMemberPath,
  nestedMemberId,
  type KeyTransform,
  type KeyTransformStep,
  type StructuralSplit,
} from "../keytransform.js";
import { compileSubstitution, bindReferences, type ReferenceSite } from "../substitution.js";
import { previewFile, previewId, addLineKey, type LineKeys } from "../preview.js";
import type { ArtifactPreview, LangText } from "../types.js";

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

// Exported so `ansible.ts` declares the SAME shape rather than a copy of it:
// `ansibleRecipe.load` delegates defaults/overlays wholesale to
// `layeredRecipe.load`, so a narrower copy next door restricts nothing — it
// only refuses, with a confusing message, a declaration that would have
// worked. (`static_files` is the deliberate exception; see ansible.ts.)
export const sourceOrListSchema = { oneOf: [sourceSchema, { type: "array", items: sourceSchema, minItems: 1 }] };

// `pattern` is the only field: see substitution.ts's compileSubstitution for
// the "exactly one capturing group" check — that is a runtime validation
// (the group count depends on the regex text, ajv can't check it), not a
// schema one. additionalProperties: false, same spec-strictness rule as
// everywhere else — a typo'd field here must not silently do nothing.
const substitutionSchema = {
  type: "object",
  required: ["pattern"],
  properties: { pattern: { type: "string" } },
  additionalProperties: false,
};

const staticFilesSchema = {
  type: "array",
  items: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      format: { type: "string" },
      key: keyTransformSchema,
      include: { type: "array", items: { type: "string" } },
      exclude: { type: "array", items: { type: "string" } },
      substitution: substitutionSchema,
      component: { type: "string" },
      members_only: { type: "boolean" },
      origin: { enum: ["embedded", "default"] },
    },
    additionalProperties: false,
  },
};

export const splitSchema = {
  type: "object",
  required: ["at", "by"],
  properties: {
    at: { type: "string" },
    by: { type: "string" },
    only: { type: "array", items: { type: "string" }, minItems: 1 },
    // A list nested inside each member — see StructuralSplit.nest.
    nest: {
      type: "object",
      required: ["at", "by", "key_from", "under"],
      properties: {
        at: { type: "string" },
        by: { type: "string" },
        key_from: { type: "string" },
        under: { type: "string" },
        only: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

const schema = {
  type: "object",
  properties: {
    split: splitSchema,
    defaults: sourceOrListSchema,
    overlays: { type: "object", additionalProperties: sourceOrListSchema },
    static_files: staticFilesSchema,
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

// The sheet's `component:` transform, applied to every key it produced.
//
// Returns undefined when the sheet declares no derived component (the literal
// form, and the "no declaration at all" default, are handled centrally in
// assemble-spec.ts — a recipe has nothing to add to either).
//
// The id/name split matters here as everywhere: the transform yields an ID,
// which is what rows are filed under and what every review target is keyed by,
// while `names:` supplies the display text. A client id is `poc-oidc` or a
// whole metadata URL; neither is what a reader wants to see as a heading.
// The sheet's `component:` transform, applied to each entry as it is extracted.
//
// Per ENTRY, and against the entry's own PRE-transform identity — not against
// the final key list. Both matter:
//
//   - `from:` only means anything here. Reading the final key ignored it
//     outright, so a layered sheet declaring `component: {from: path}` got
//     silently nothing while looking correct.
//   - a source may rename its keys to the product's own field names, which is
//     the whole point of pairing a component with a `key:` transform. The
//     component lives in the address the row CAME from
//     (`clients[clientId=poc-oidc].protocol`), and after the rename that
//     address is gone. Deriving late meant renaming and grouping could not
//     both be done, and the failure was loud in the wrong place: the `names:`
//     two-way check reporting every declared component as "produced by
//     nothing".
//
// The map is still keyed by the FINAL key, because that is what assemble looks
// rows up by — only the question being asked of each entry moved earlier.
type ComponentDeriver = {
  note: (entryKey: string, entryPath: string | undefined, finalKey: string) => void;
  // The id an entry WOULD get, without recording it — the collision check needs
  // the scope, not another entry in the map.
  idFor: (entryKey: string, entryPath: string | undefined) => string;
  finish: () => { componentOf: Map<string, string>; componentLabels?: Map<string, LangText> } | undefined;
};

type ComponentSpec = KeyTransform & {
  names?: Record<string, { name?: LangText | string }>;
  // Literal "this key belongs to that component", for the rows a transform
  // cannot reach: an environment variable feeding one member's field is not
  // addressed as part of the list, so nothing about its NAME derives the
  // member — the fact is an assignment, and writing an assignment as a regex
  // (`^SSO_LDAP_CORP_PASSWORD$` -> `corp-ldap`) only obscures it.
  map?: Record<string, string>;
};

function makeComponentDeriver(
  spec: ComponentSpec | undefined,
  sheetName: string,
  warn: (message: string) => void,
  // Declared by `split: { only: [...] }`: every id the sheet says it reviews.
  // Checked against what the rows actually produced, the same two-way check
  // `names:` has — a selection naming something no element has is a selection
  // that silently reviews less than it claims.
  requiredIds?: string[]
): ComponentDeriver {
  if (!spec?.steps && !spec?.map) return { note: () => {}, idFor: () => "", finish: () => undefined };

  const transformer = makeKeyTransformer(spec);
  const mapped = new Map(Object.entries(spec.map ?? {}));
  const unusedMapKeys = new Set(mapped.keys());
  // The map is consulted on the row's own key AND on its structural path, so an
  // assignment can name either — whichever the reader would recognise.
  const assign = (entryKey: string, entryPath: string | undefined): string | undefined => {
    for (const candidate of [entryKey, entryPath]) {
      if (candidate !== undefined && mapped.has(candidate)) {
        unusedMapKeys.delete(candidate);
        return mapped.get(candidate);
      }
    }
    return undefined;
  };
  const componentOf = new Map<string, string>();
  const ids = new Set<string>();

  return {
    // With no `steps`, an unassigned row belongs to NO component: the identity
    // the transformer would return is the row's own key, which would make every
    // unassigned row a component of its own.
    idFor(entryKey, entryPath) {
      return assign(entryKey, entryPath) ?? (spec.steps ? transformer.apply(selectKeySource(spec.from, entryKey, entryPath)) ?? "" : "");
    },
    note(entryKey, entryPath, finalKey) {
      const id =
        assign(entryKey, entryPath) ?? (spec.steps ? transformer.apply(selectKeySource(spec.from, entryKey, entryPath)) : undefined);
      if (id === undefined) return; // belongs to no component; falls back downstream
      ids.add(id);
      componentOf.set(finalKey, id);
    },
    finish() {
      const unmatched = transformer.unmatchedDropPatterns();
      if (unmatched.length > 0) {
        warn(`sheet "${sheetName}": component transform pattern matched nothing: ${unmatched.join(", ")}`);
      }
      // An assignment naming a key no row produced is wiring for nothing — the
      // same rule as a pattern, a glob or a `names:` entry that matched nothing.
      if (unusedMapKeys.size > 0) {
        warn(`sheet "${sheetName}": component map names ${unusedMapKeys.size} key(s) no row produced: ${[...unusedMapKeys].sort().join(", ")}`);
      }
      const missing = (requiredIds ?? []).filter((id) => !ids.has(id));
      if (missing.length > 0) {
        throw new Error(
          `layered recipe: sheet "${sheetName}": split selects ${missing.length === 1 ? "a member" : "members"} no row produced: ` +
            `${missing.join(", ")} (produced: ${[...ids].sort().join(", ") || "none"})`
        );
      }

      // Two-way, like the snapshot recipe's: a component the sheet produces
      // but nobody named would appear as a raw id, and a name for a component
      // nothing produces is a name for nothing.
      if (spec.names) {
        const unnamed = [...ids].filter((id) => !spec.names![id]).sort();
        const stale = Object.keys(spec.names).filter((id) => !ids.has(id)).sort();
        if (unnamed.length > 0 || stale.length > 0) {
          throw new Error(
            `layered recipe: sheet "${sheetName}": component names are out of step with the sheet's rows.` +
              (unnamed.length > 0 ? `\n  produced, named nowhere: ${unnamed.join(", ")}` : "") +
              (stale.length > 0 ? `\n  named here, produced by nothing: ${stale.join(", ")}` : "")
          );
        }
      }

      if (componentOf.size === 0) return undefined;
      const componentLabels = new Map<string, LangText>();
      for (const [id, decl] of Object.entries(spec.names ?? {})) {
        if (decl.name !== undefined) {
          componentLabels.set(id, typeof decl.name === "string" ? { en: decl.name, ja: decl.name } : decl.name);
        }
      }
      return componentLabels.size > 0 ? { componentOf, componentLabels } : { componentOf };
    },
  };
}

function componentIdOf(deriver: ComponentDeriver | undefined, entryKey: string, entryPath: string | undefined): string {
  return deriver ? deriver.idFor(entryKey, entryPath) : "";
}

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

// The `key_from` value of every nested member in one file, keyed by the
// member's path. Built in one pass BEFORE keys are derived, because the value
// that prefixes a mapper's keys is its own `providerId` field — another entry
// of the same object, which no string transform can reach.
function nestPrefixes(
  split: StructuralSplit | undefined,
  entries: readonly { value: string; source: { path?: string } }[]
): Map<string, string> | undefined {
  if (!split?.nest) return undefined;
  const field = split.nest.key_from;
  const out = new Map<string, string>();
  for (const e of entries) {
    const member = nestedMemberPath(split, e.source.path);
    if (member === undefined || e.source.path !== `${member}.${field}`) continue;
    out.set(member, e.value);
  }
  return out;
}

// Prefix a nested member's key with what its own `key_from` field says it IS.
// A member the field does not answer for is left alone rather than guessed at:
// the row then fails to bind and the strict gate names it, which is the right
// failure — filing it under a neighbour's type would publish one mapper's
// meaning under another's.
function withNestPrefix(
  key: string | undefined,
  path: string | undefined,
  split: StructuralSplit | undefined,
  prefixes: Map<string, string> | undefined
): string | undefined {
  if (key === undefined || prefixes === undefined || split === undefined) return key;
  const member = nestedMemberPath(split, path);
  const prefix = member === undefined ? undefined : prefixes.get(member);
  if (prefix === undefined) return key;
  // The member's own id leads, because identity is per COMPONENT and every
  // nested member of one member now shares it — six mappers of one store all
  // have a `ldap.attribute`, and without this they would be one row six times
  // over. The type follows, which is what the dictionary is keyed by; a
  // binding strips the leading id to reach it.
  const id = nestedMemberId(split, path);
  return id === undefined ? `${prefix}.${key}` : `${id}.${prefix}.${key}`;
}


// `[under, <nested member>]` for a nested row, nothing for anything else. The
// LAST-resort category (assemble.ts): a project `category:` and a bound
// dictionary's own `group` both still win, which is right — this says where
// the row SITS in the file, not what it is about.
// The MEMBER a nested member sits in — the component its rows are filed under.
function componentOfPath(split: StructuralSplit, path: string): string | undefined {
  const m = new RegExp(`^${escRe(split.at)}\\[${escRe(split.by)}=("?)(.+?)\\1\\]\\.`).exec(path);
  return m?.[2];
}

function escRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nestedCategory(split: StructuralSplit | undefined, path: string | undefined): { categoryPath: string[]; categoryPathWins: true } | undefined {
  if (!split?.nest) return undefined;
  const id = nestedMemberId(split, path);
  // Outranks the dictionary's own group: every member of a nest has the same
  // keys, so grouping by anything but which member they are merges the rows a
  // reader is there to compare.
  return id === undefined ? undefined : { categoryPath: [split.nest.under, id], categoryPathWins: true };
}

export function buildMapFromSources(
  io: RecipeIO,
  specs: SourceSpec[],
  what: string,
  selector: KeySelector,
  extractOptions: ExtractOptions | undefined,
  warn: (message: string) => void,
  component?: ComponentDeriver,
  split?: StructuralSplit
): ExtractedMap {
  const out: ExtractedMap = new Map();
  for (const spec of specs) {
    const { file, content } = readRequired(io, spec.path, what);
    const transformer = spec.key ? makeKeyTransformer(spec.key) : undefined;
    const seenPathsInFile = new Map<string, string[]>();
    // Materialized before the loop: a nested member's key prefix comes from
    // another entry of the same file, so the whole file has to be in hand
    // before any key is decided.
    const fileEntriesRaw = [...extractFile(content, file, spec.format, extractOptions)];
    const prefixes = nestPrefixes(split, fileEntriesRaw);
    for (const e of fileEntriesRaw) {
      let key: string | undefined;
      if (transformer) {
        key = transformer.apply(selectKeySource(spec.key!.from, e.key, e.source.path));
      } else {
        key = e.key;
      }
      key = withNestPrefix(key, e.source.path, split, prefixes);
      if (key === undefined) continue;
      if (!selector.select(key)) continue;
      if (e.source.path !== undefined) {
        const paths = seenPathsInFile.get(key);
        if (paths) paths.push(e.source.path);
        else seenPathsInFile.set(key, [e.source.path]);
      }
      const componentId = componentIdOf(component, e.key, e.source.path);
      component?.note(e.key, e.source.path, key);
      out.set(key, { value: e.value, source: { ...e.source, file }, ...(componentId ? { component: componentId } : {}) });
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

type SubstitutionFieldSpec = { pattern: string };

type StaticFileSpec = {
  path: string;
  format?: Format;
  key?: KeyTransform;
  // This file's OWN selection, SHADOWING the sheet's for this file alone (see
  // buildEmbeddedFromStaticFiles). "Everything this file yields" is `["**"]`.
  include?: string[];
  exclude?: string[];
  substitution?: SubstitutionFieldSpec;
  // Which component every row of THIS file belongs to, stated outright.
  //
  // The sheet-level `component:` transform cannot express this: it derives an
  // id from a row's key or structural path, and two files holding the same kind
  // of document (two realms, two of anything) produce identical paths. What
  // tells them apart is which FILE they came from, which no transform over the
  // row can see. Same shape, and same reason, as the ansible recipe's
  // `templates:`.
  component?: string;
  // How this file's rows are filed. Default `embedded`: a literal our
  // deliverable bakes in, with a real definition site in our config.
  //
  // `default` is for a file that is NOT part of the deliverable — a snapshot of
  // what the product itself ships with, extracted and committed so the sheet
  // can be an exhaustive ledger. Our config sets none of it, so those rows get
  // no source (there is no line of ours to point at, and none for apply to
  // rewrite) and the extracted value is recorded as the documented default.
  // Stated per file because it is a property of where the file came from, which
  // nothing in the rows themselves reveals.
  origin?: "default";
  // Under the sheet's `split:`, this source holds ONLY members of the list —
  // so a row that is not one is noise, and dropped. Off by default, because a
  // sheet's other sources routinely hold rows that are not members and must
  // survive (the environment file feeding a member's field).
  members_only?: boolean;
};

function staticFileSpecs(v: JsonValue | undefined): StaticFileSpec[] {
  return asArray(v).map((item) => {
    const o = asObject(item);
    const format = typeof o.format === "string" ? (o.format as Format) : undefined;
    const key = o.key === undefined ? undefined : (o.key as unknown as KeyTransform);
    const substitution =
      o.substitution === undefined ? undefined : { pattern: asString(asObject(o.substitution).pattern, "static_files[].substitution.pattern") };
    const include = Array.isArray(o.include) ? (o.include as string[]) : undefined;
    const exclude = Array.isArray(o.exclude) ? (o.exclude as string[]) : undefined;
    const component = typeof o.component === "string" ? o.component : undefined;
    const membersOnly = o.members_only === true ? true : undefined;
    const origin = o.origin === "default" ? ("default" as const) : undefined;
    // A substitution merges this file's rows INTO a base-layer variable, whose
    // value our deliverable does set — so "the product's own default, set
    // nowhere by us" cannot also be true of them. Refused rather than silently
    // dropped on one side or the other.
    if (origin === "default" && substitution !== undefined) {
      throw new Error(`layered recipe: static_files[].origin "default" cannot be combined with "substitution" (${asString(o.path, "static_files[].path")})`);
    }
    return { path: asString(o.path, "static_files[].path"), format, key, include, exclude, substitution, component, origin, members_only: membersOnly };
  });
}

// A static file's default key is the structural path (falling back to the
// leaf key) — unlike defaults/overlays, whose entries are historically flat
// Ansible-style variables keyed by their leaf name. Preserves the "ansible"
// recipe's own long-standing static_files behaviour when no `key` is given.
//
// Reference substitution runs PER FILE, right here, rather than as a
// separate pass over the merged embedded list — bindReferences (substitution.ts)
// needs to know exactly which entries came from ONE substitution-declaring
// file, and only that file's entries should ever be classified/merged; a
// file with no `substitution:` field is untouched, exactly as before this
// feature existed (the byte-identical-when-unused guarantee — see
// SKILL.md's "Reference substitution in static_files").
function buildEmbeddedFromStaticFiles(
  io: RecipeIO,
  specs: StaticFileSpec[],
  selector: KeySelector,
  extractOptions: ExtractOptions | undefined,
  baseMap: ExtractedMap,
  overlayLayers: Extract<ValueLayer, { kind: "overlay" }>[],
  warn: (message: string) => void,
  sheetName: string,
  component?: ComponentDeriver,
  split?: StructuralSplit
): {
  nestedMembers: Map<string, { under: string; members: { id: string; unit: string }[] }>;
  embedded: EmbeddedEntry[];
  keyMap: KeyMapEntry[];
  referenceSites: ReferenceSite[];
  componentOf: Map<string, string>;
  artifacts: ArtifactPreview[];
} {
  const embedded: EmbeddedEntry[] = [];
  const nestedMembers = new Map<string, { under: string; members: { id: string; unit: string }[] }>();
  // A static file needs no rendering: it is committed, and what it says IS what
  // the sheet reviews. So its preview is the file, verbatim, with the rows it
  // produced marked on their own lines — the same panel the ansible recipe
  // fills by rendering a template, filled here by reading.
  //
  // Only `static_files`, deliberately. A `defaults`/`overlays` file is SHARED
  // (an Ansible group_vars file holds every role's variables, which is why
  // `include:`/`exclude:` exists at all), so putting one whole into a document
  // that gets circulated would hand on rows the sheet deliberately filtered
  // out. A static file is the sheet's own subject; there is nothing else in it.
  const artifacts: ArtifactPreview[] = [];

  const keyMap: KeyMapEntry[] = [];
  // Variable -> the component of the file whose row it was merged into. A
  // whole-value merge does not keep the static file's entry: the BASE-layer row
  // is renamed to the product key instead (see substitution.ts), so the only
  // record left of which file asked for it is this map. Without it the merged
  // rows land in no component — and on a sheet where every other row has one,
  // "no component" becomes a phantom extra component named after the sheet,
  // carrying a full materialize ledger of its own.
  const componentOf = new Map<string, string>();
  // Merged PER VARIABLE across every substitution-declaring static file in
  // this sheet — two different static files could each reference the same
  // layer key (unlikely, but nothing rules it out), and a variable's
  // referenceSites entry must carry every site regardless of which file
  // found it (assemble.ts's buildDrafts attaches by variable, not by file).
  const referenceSitesByVariable = new Map<string, ReferenceSite["sites"]>();
  let mergedTotal = 0;
  let composedTotal = 0;
  let danglingTotal = 0;
  let sawSubstitution = false;

  for (const sf of specs) {
    const { file, content } = readRequired(io, sf.path, "static file");
    // Selection is a property of a KEYSPACE, not of a sheet. A sheet has one
    // per independent origin of rows: the layer stack (defaults + every
    // overlay, which must share a vocabulary or a Pattern A/B split would be
    // fabricated), and each static file after its own `key:` transform. One
    // selector stretched across all of them works only while nothing renames —
    // the moment a file converges its addresses into the product's own field
    // names, the sheet's globs cannot name them, and the sheet's own list
    // cannot be widened without admitting rows from the other keyspace.
    //
    // So a file that declares its own selection OWNS it: the sheet's list does
    // not apply to that file at all. Not intersection — intersection recreates
    // exactly the bug, since the sheet vocabulary still cannot name renamed
    // keys. Not union — union of includes is arguable, union of excludes is
    // not, and the pair has no one-sentence meaning.
    const ownSelector =
      sf.include !== undefined || sf.exclude !== undefined
        ? makeKeySelector(sf.include ?? ["**"], sf.exclude ?? [])
        : undefined;
    const fileSelector = ownSelector ?? selector;
    const transformer = sf.key ? makeKeyTransformer(sf.key) : undefined;
    const fileEntries: EmbeddedEntry[] = [];
    // component id (or "" for none) -> key -> the paths that produced it.
    const seenInFile = new Map<string, Map<string, string[]>>();
    // See buildMapFromSources: the prefix is another entry of this same file.
    const rawEntries = [...extractFile(content, file, sf.format, extractOptions)];
    const prefixes = nestPrefixes(split, rawEntries);
    // The axis itself, for materialize: which members this component holds and
    // what each of them IS. Collected here because this is where both facts are
    // in hand — the member's id from its address, its unit from `key_from`.
    if (split?.nest) {
      for (const [memberPath, unit] of prefixes ?? []) {
        const id = nestedMemberId(split, `${memberPath}.`);
        const owner = componentOfPath(split, memberPath);
        if (id === undefined || owner === undefined) continue;
        const bucket = nestedMembers.get(owner) ?? { under: split.nest.under, members: [] };
        if (!bucket.members.some((m) => m.id === id)) bucket.members.push({ id, unit });
        nestedMembers.set(owner, bucket);
      }
    }
    for (const e of rawEntries) {
      const derived = transformer ? transformer.apply(selectKeySource(sf.key!.from, e.key, e.source.path)) : (e.source.path ?? e.key);
      const key = withNestPrefix(derived, e.source.path, split, prefixes);
      if (key === undefined) continue;
      if (!fileSelector.select(key)) continue;
      // A file that names its component owns it, the same way a file that
      // declares its own include/exclude owns its selection — the sheet's
      // transform is not consulted for it, and must not count these rows
      // towards its own `names:` two-way check.
      if (sf.component === undefined) component?.note(e.key, e.source.path, key);
      // Two entries of ONE file landing on one key means the key does not
      // identify them. `buildMapFromSources` has always hard-errored on this
      // and the snapshot recipe collects and throws; static files had neither,
      // on the premise that a structural path never collides — true until a
      // `key:` transform could rename them, which it now can. Renaming two
      // clients' `clients[clientId=X].protocol` down to `protocol` would
      // otherwise keep one row and lose the other with no report.
      //
      // Scoped by COMPONENT, because that is what a component is for: one
      // `protocol` per client is two rows; two in the same client is a real
      // collision. Entries outside any component share one scope.
      const scope = sf.component ?? componentIdOf(component, e.key, e.source.path);
      const entryComponent = scope || undefined;
      const seen = seenInFile.get(scope) ?? new Map<string, string[]>();
      const where = seen.get(key);
      if (where) where.push(e.source.path ?? key);
      else seen.set(key, [e.source.path ?? key]);
      seenInFile.set(scope, seen);
      fileEntries.push({
        key,
        value: e.value,
        source: { file, line: e.source.line, path: e.source.path },
        ...(entryComponent ? { component: entryComponent } : {}),
        // A nested member is filed INSIDE its member's component, under a
        // category named for it. The component stays the member — a mapper is
        // part of the store, not a sibling of it.
        ...(nestedCategory(split, e.source.path) ?? {}),
        ...(sf.origin ? { origin: sf.origin } : {}),
      });
    }
    const clashes: InFileCollision[] = [];
    for (const seen of seenInFile.values()) {
      for (const [key, locations] of seen) if (locations.length > 1) clashes.push({ key, locations });
    }
    if (clashes.length > 0) throw new Error(formatKeyCollisionError("static file", file, clashes));
    if (transformer) {
      const unmatched = transformer.unmatchedDropPatterns();
      if (unmatched.length > 0) {
        warn(`static file: key transform pattern matched nothing in ${file}: ${unmatched.join(", ")}`);
      }
    }
    // A selector tracks unmatched patterns across exactly the keyspaces it
    // governs. The sheet's spans several and is reported once by the caller; a
    // file's own spans one, so it is reported here, naming the file. This is
    // sharper than the shared tracking, not merely equal to it: a pattern dead
    // in the file it was written for can no longer be counted "used" by an
    // accidental match in some other source.
    if (ownSelector) {
      const dead = ownSelector.unmatchedPatterns();
      if (dead.length > 0) {
        warn(`static file ${file}: include/exclude pattern matched nothing: ${dead.join(", ")}`);
      }
    }

    // The file itself, for the context panel. `previewFile` (src/preview.ts)
    // owns the size gate and the verbatim-line mechanics; refusal is loud
    // (`warn`) rather than a silent truncation — losing something quietly is
    // the one thing this project does not do.
    //
    // BEFORE the substitution branch below, and from `fileEntries` rather than
    // whatever that branch produces. Sitting after it, this ran only for a file
    // that declared `substitution:` — every other static file was silently
    // previewless, which is three of a real project's six such sheets. And
    // `fileEntries` is the right source either way: a substitution merge
    // RENAMES a row onto the variable that composes it, and the line the reader
    // wants is still the one this file writes.
    const keys: LineKeys = new Map();
    for (const e of fileEntries) addLineKey(keys, e.source.line, e.key);
    const preview = previewFile(
      { id: previewId(sheetName, sf.component), sheet: sheetName, ...(sf.component !== undefined ? { component: sf.component } : {}), source_file: file },
      content,
      keys,
      warn
    );
    if (preview) artifacts.push(preview);

    if (!sf.substitution) {
      embedded.push(...fileEntries);
      continue;
    }

    // compileSubstitution throws (naming the capture-group count found) on a
    // malformed pattern — a build.yml authoring mistake, propagated straight
    // up as a load()-time error like every other spec validation in this file.
    sawSubstitution = true;
    const compiled = compileSubstitution(sf.substitution.pattern);
    const result = bindReferences({ embedded: fileEntries, baseMap, overlayLayers, compiled });
    embedded.push(...result.embedded);
    keyMap.push(...result.keyMap);
    if (sf.component !== undefined) {
      for (const km of result.keyMap) {
        const claimed = componentOf.get(km.variable);
        if (claimed !== undefined && claimed !== sf.component) {
          // One base row cannot belong to two components. Reported rather than
          // resolved: whichever file won would be arbitrary, and the sheet
          // would show the value under one component with nothing said about
          // the other.
          warn(
            `static file ${file}: "${km.variable}" is merged by two components (${claimed}, ${sf.component}) — ` +
              `the row can only be filed under one of them`
          );
        }
        componentOf.set(km.variable, sf.component);
      }
    }
    for (const site of result.referenceSites) {
      const existing = referenceSitesByVariable.get(site.variable);
      if (existing) existing.push(...site.sites);
      else referenceSitesByVariable.set(site.variable, [...site.sites]);
    }
    for (const w of result.warnings) warn(w);
    mergedTotal += result.tally.merged;
    composedTotal += result.tally.composed;
    danglingTotal += result.tally.dangling + result.tally.danglingComposed;

  }

  // One summary line for the whole sheet, not one per file — a reader wants
  // "what did substitution do to this sheet", and per-file bindReferences
  // warnings (dangling references, multi-backer merges, matched-nothing)
  // already named exactly where each individual finding came from.
  if (sawSubstitution) {
    warn(`substitution: ${mergedTotal} merged, ${composedTotal} composed left embedded, ${danglingTotal} dangling`);
  }

  const referenceSites: ReferenceSite[] = [...referenceSitesByVariable].map(([variable, sites]) => ({ variable, sites }));
  return { embedded, keyMap, referenceSites, componentOf, artifacts, nestedMembers };
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
    // Built before any source is read: every extraction path notes its entries
    // into it as they survive selection, and `finish()` runs the two-way name
    // check once the whole sheet has been seen.
    // `split:` is one sentence — "this source holds a list of things addressed
    // by an identity field" — standing in for the pair of transforms every such
    // sheet otherwise writes by hand, over the tool's own address grammar. It
    // sets the component side, and prefixes every source's key transform, so
    // the two can never disagree about which list they are talking about.
    const split = sheetSpec.split === undefined ? undefined : (asObject(sheetSpec.split) as unknown as StructuralSplit);
    const declaredComponent = io.component as ComponentSpec | undefined;
    // A `component:` transform alongside a split is COMPOSED, not refused: the
    // split answers "which member is this row of", and a sheet can have rows
    // that are not members of the list at all yet still belong to one — the
    // environment variable feeding a member's field is the case. The split's
    // own step runs first; the declared steps decide what is left.
    const componentSpec: ComponentSpec | undefined = split
      ? {
          ...(declaredComponent ?? {}),
          from: "path",
          steps: [...splitComponentSteps(split, (declaredComponent?.steps ?? []).length > 0), ...(declaredComponent?.steps ?? [])],
        }
      : declaredComponent;
    // `only:` selects members by matching their address; with a nest the
    // component steps must keep what they do not match, so the two cannot both
    // decide. Refused rather than silently applied to one level only.
    if (split?.nest && split.only) {
      throw new Error(`layered recipe: sheet "${name}": "split.only" and "split.nest" cannot be combined — the nested rows would be dropped with the members the list excludes`);
    }
    const componentDeriver = makeComponentDeriver(componentSpec, name, warn, split?.only);
    // A split names the identity field, so it also ANSWERS the extractor's
    // question of which field identifies a list item — declaring `id_fields`
    // again, spec-wide and far away, would be the same fact written twice, and
    // forgetting it makes the split match nothing (the paths come out `[0]`).
    const extractOptions = split
      ? { ...io.extractOptions, idFields: [...(io.extractOptions?.idFields ?? []), split.by] }
      : io.extractOptions;
    // A data map's children are DATA, so a dotted key under one is not
    // structure: `attributes.saml.client.signature` is one key, not three
    // levels. Appended last, after the split and after a source's own steps,
    // because it is about how the finished key is SPELLED. Idempotent by
    // construction — the pattern refuses a key that is already bracketed — so
    // a source that somehow ran it twice comes out the same.
    const dataMapSteps: KeyTransformStep[] = (io.dataMaps ?? []).map((path) => ({
      pattern: `^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.([^"\\[]+)$`,
      replace: `${path}["$1"]`,
    }));
    // Prefixed, not replaced: what a split leaves is still a structural path,
    // and a source's own steps are the judgement calls on top of it (which
    // sub-objects are review material and which are the product's bookkeeping).
    const withSplit = <T extends { key?: KeyTransform }>(spec: T): T => {
      if (!split) return spec;
      if (spec.key?.from === "key") {
        throw new Error(
          `layered recipe: sheet "${name}": a source under "split" cannot key "from: key" — ` +
            `a split addresses rows by their structural path`
        );
      }
      const membersOnly = (spec as { members_only?: boolean }).members_only === true;
      return { ...spec, key: { from: "path", steps: [...splitKeySteps(split, membersOnly), ...(spec.key?.steps ?? [])] } };
    };
    // `defaultFrom` is the source's own untransformed key space, which differs
    // by source: defaults/overlays key by the extracted leaf name, a static
    // file by its structural path (see buildEmbeddedFromStaticFiles). Injecting
    // a transform must not silently move a source into the other one.
    const withKeyShape =
      (defaultFrom: KeyTransform["from"]) =>
      <T extends { key?: KeyTransform }>(spec: T): T => {
        const withSplitApplied = withSplit(spec);
        if (dataMapSteps.length === 0) return withSplitApplied;
        const key = withSplitApplied.key;
        return { ...withSplitApplied, key: { from: key?.from ?? defaultFrom, steps: [...(key?.steps ?? []), ...dataMapSteps] } };
      };

    const defaultsSpecs = asSourceSpecs(sheetSpec.defaults).map(withKeyShape("key"));
    const baseMap =
      defaultsSpecs.length > 0
        ? buildMapFromSources(io, defaultsSpecs, `sheet "${name}": defaults`, selector, extractOptions, warn, componentDeriver, split)
        : new Map();
    // Display fallback: the first defaults source, when there is one. Recorded
    // as `source_file`, NOT `file_path` — it is a file in this repository, and
    // file_path means where the configuration LANDS (types.ts). Putting a repo
    // path in the deployed slot is why one sheet's column read
    // "/etc/httpd/conf/httpd.conf" while the next read
    // "config/keycloak/envs/default.env": the same column was answering two
    // different questions, with nothing to tell a reader which. verify/apply
    // are unaffected — both already prefer source_file and only fall back to
    // file_path. No defaults (snapshot-style sheets) leaves it unset.
    const sourceFallback = defaultsSpecs.length > 0 ? io.resolve(defaultsSpecs[0].path) : undefined;

    const overlayLayers: Extract<ValueLayer, { kind: "overlay" }>[] = Object.entries(asObject(sheetSpec.overlays)).map(
      ([instance, spec]) => ({
        kind: "overlay" as const,
        instance,
        entries: buildMapFromSources(
          io,
          asSourceSpecs(spec as JsonValue).map(withKeyShape("key")),
          `sheet "${name}": overlay "${instance}"`,
          selector,
          extractOptions,
          warn,
          componentDeriver,
          split
        ),
      })
    );

    const staticFilesResult = buildEmbeddedFromStaticFiles(
      io,
      staticFileSpecs(sheetSpec.static_files).map(withKeyShape("path")),
      selector,
      extractOptions,
      baseMap,
      overlayLayers,
      warn,
      name,
      componentDeriver,
      split
    );

    // A pattern that matched nothing means the filter is not doing what its
    // author thinks — most likely rows are missing from the sheet.
    const unmatchedSelector = selector.unmatchedPatterns();
    if (unmatchedSelector.length > 0) {
      warn(`sheet "${name}": include/exclude pattern matched nothing: ${unmatchedSelector.join(", ")}`);
    }
    // A DERIVED component (see RecipeIO.component): the sheet's rows carry the
    // component's identity in their own keys, and the transform lifts it out.
    // `clients[clientId=poc-oidc].protocol` is a row of the poc-oidc client, and
    // saying so moves the client out of the key and into a scope — the same
    // move the AWS sheet made with its Terraform module.
    const components = componentDeriver.finish();
    // Printed AFTER finish(), not before: the component deriver only knows
    // which of its patterns, names and assignments matched nothing once every
    // row has been through it, so a print above this line silently dropped
    // every warning it raises — the "component transform pattern matched
    // nothing" one had never reached a terminal.
    for (const w of warnings) console.warn(`layered recipe: ${w}`);
    // A literal per-file `component:` produces no derived map of its own — the
    // component travels on each embedded entry. The exception is a row the
    // substitution merged away, whose identity is now a base-layer key; those
    // are the entries collected above, and they have to reach assemble through
    // componentOf because there is no embedded entry left to carry them.
    const componentOf =
      staticFilesResult.componentOf.size > 0
        ? new Map([...(components?.componentOf ?? []), ...staticFilesResult.componentOf])
        : components?.componentOf;

    return {
      name,
      ...(sourceFallback ? { sourceFile: sourceFallback } : {}),
      instances: io.instances,
      layers: [{ kind: "base", entries: baseMap }, ...overlayLayers],
      embedded: staticFilesResult.embedded,
      ...(staticFilesResult.nestedMembers.size > 0 ? { nestedMembers: staticFilesResult.nestedMembers } : {}),
      ...(components?.componentLabels ? { componentLabels: components.componentLabels } : {}),
      ...(componentOf ? { componentOf } : {}),
      // The order the files are listed in IS the reading order the author
      // chose; without it the sheet opens on whichever component's rows the
      // assembler happened to see first.
      ...(() => {
        const declared = staticFileSpecs(sheetSpec.static_files).map((f) => f.component).filter((c): c is string => c !== undefined);
        return declared.length > 0 ? { componentOrder: declared } : {};
      })(),
      ...(staticFilesResult.keyMap.length > 0 ? { keyMap: staticFilesResult.keyMap } : {}),
      ...(staticFilesResult.referenceSites.length > 0 ? { referenceSites: staticFilesResult.referenceSites } : {}),
      ...(staticFilesResult.artifacts.length > 0 ? { artifacts: staticFilesResult.artifacts } : {}),
    };
  },
};

registerRecipe(layeredRecipe);
