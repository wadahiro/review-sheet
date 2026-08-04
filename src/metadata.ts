// Pluggable metadata provider registry: enrich() resolves parameter documentation
// (description/default/remarks/...) from external sources — a project's own
// metadata file, Ansible argument_specs, or a product dictionary — mirroring the ConfigParser
// registry in parser.ts (array registry, replace-by-name, priority-sorted at
// resolve time, self-registering providers).

import { pickLang, type LangText } from "./types.js";
import { sharedRegistry } from "./registry.js";
import type { Binding } from "./bind.js";

export { pickLang };
export type { LangText };

export type Provenance = "official" | "community" | "machine" | "extracted" | "project";

// A binding from a project parameter key namespace to one dictionary snapshot
// file (<product>@<version>.yml, found on metadataDirs).
export type DictionaryBinding = { product: string; version: string; key_prefix?: string };

export type MetadataQuery = {
  key: string;
  // The already-resolved dictionary bind for this key (bind.ts's bindKey),
  // run ONCE per build before any provider sees this query — see
  // assemble.ts's bindDrafts (assembleSheets path) and enrich.ts's own
  // standalone bind pass (the `import -f` + `--project` path, which never
  // goes through assembleSheets). undefined means "bind.ts found no
  // dictionary counterpart for this key" — most parameters have none. No
  // provider re-derives this: the dictionary provider is a plain lookup off
  // `binding.entry`.
  binding?: Binding;
  sheet?: string;
  categoryPath?: string[];
  file?: string;
  // The row's extracted (pre-keyMap) identity, when it differs from `key` —
  // e.g. an Ansible role variable (`kc_hostname`) whose row is filed under
  // the product's own config key (`hostname`) instead (assemble.ts's
  // resolveKey/keyMap). A native channel that documents the ROLE's variable
  // rather than the product's key — Ansible's meta/argument_specs.yml is the
  // motivating case — cannot be reached by `key` alone once the row's
  // display name has moved on; a provider that wants to try both looks here
  // as the fallback. Never itself the provider's MATCH criterion for
  // anything other than that fallback: `key` still wins when both resolve
  // (see argument-specs.ts).
  variable?: string;
};

export type MetadataResult = {
  description?: LangText;
  default?: string;
  remarks?: LangText;
  docs_url?: string;
  type?: string;
  scope?: string;
  out_of_scope?: { reason: LangText; owner?: string };
  provenance: Provenance;
};

export type MetadataContext = {
  lang: "en" | "ja";
  // The language a NATIVE channel's plain-string documentation is actually
  // written in — Ansible's meta/argument_specs.yml `description:`, Terraform's
  // `variable "x" { description = ... }`. Those formats have no concept of a
  // language tag, so a provider reading them cannot detect the language; it
  // must be told. See argument-specs.ts / terraform-variables.ts, which wrap
  // their plain-string result as `{ [nativeLang]: text }` via
  // `nativeLangText()` below, rather than returning a bare string — a bare
  // string tells resolveMetadata's per-language merge "this speaks for every
  // language at once" (see mergeLangField's doc comment), which is exactly
  // wrong for a channel that is one language and not the other.
  nativeLang: "en" | "ja";
  readFile: (path: string) => string | null;
  project?: string;
  argumentSpecs: string[];
  terraformVariables: string[];
  metadataDirs: string[];
  dictionaries: DictionaryBinding[];
  cache: Map<string, unknown>;
};

// Wrap a native channel's plain-string documentation as a LangText tagged
// with the language it was actually written in (ctx.nativeLang). Shared by
// argument-specs.ts and terraform-variables.ts so both channels stay
// consistent, and centralizes the one piece of logic a caller could get
// subtly wrong (a computed `{ [nativeLang]: text }` object literal on a
// union-typed key does not infer the `LangText` shape cleanly).
export function nativeLangText(nativeLang: "en" | "ja", text: string): LangText {
  return nativeLang === "ja" ? { ja: text } : { en: text };
}

export interface MetadataProvider {
  name: string;
  priority?: number;
  resolve(query: MetadataQuery, ctx: MetadataContext): MetadataResult | undefined;
}

// Process-wide, so a plugin that resolved its own copy of this module still
// registers into the array the CLI reads — see registry.ts.
const registry = sharedRegistry<MetadataProvider>("review-sheet.providers.v1");

export function registerMetadataProvider(p: MetadataProvider): void {
  const i = registry.findIndex((r) => r.name === p.name);
  if (i >= 0) registry[i] = p;
  else registry.push(p);
}

export function listMetadataProviders(): MetadataProvider[] {
  return [...registry];
}

export function getMetadataProvider(name: string): MetadataProvider | undefined {
  return registry.find((p) => p.name === name);
}

export type ResolvedMetadata = {
  description?: LangText;
  default?: string;
  remarks?: LangText;
  docs_url?: string;
  type?: string;
  scope?: string;
  out_of_scope?: { reason: LangText; owner?: string };
  provenance?: Provenance;
  contributions: Record<string, number>;
};

// Fields merged whole, field-level first-wins: the first (highest-priority)
// provider to supply a defined value for the field claims it outright, same
// as before this module gained per-language merging.
const PLAIN_MERGE_FIELDS = ["default", "docs_url", "type", "scope", "out_of_scope"] as const;

// LangText fields merged per language KEY rather than as a whole (see below)
// — the reason this module exists: a project's own metadata file may now
// carry only `ja` (English lives in Terraform's `description =` / Ansible's
// argument_specs `description:`, so it is no longer duplicated in sheet.yml),
// and enrichment needs `en` and `ja` to be able to come from two different
// providers for the SAME parameter.
const LANG_FIELDS = ["description", "remarks"] as const;
type LangField = (typeof LANG_FIELDS)[number];

// Merge one provider's LangText value for `field` into `merged`, per
// language key, first-wins. Returns whether this provider actually
// contributed anything new (for `contributions` bookkeeping — one count per
// FIELD the provider touched, never one per language key: filling `en` and
// `ja` from the same provider's single result is one act of documentation,
// not two).
//
// Semantics for a plain `string` value (a language-agnostic, complete
// description — the shape every native channel this task targets uses,
// since Terraform/Ansible have no concept of `ja`):
//
//   - If NOTHING has claimed this field yet, a plain string claims the
//     WHOLE field and locks it: no lower-priority provider is consulted for
//     it again. There is no "other language" left to merge in — the string
//     already speaks for every language at once — so this also preserves
//     the pre-existing field-level first-wins behavior when no provider
//     ever returns a `{ en, ja }` object for this field.
//   - If a `{ en?, ja? }` object is already partially filled (some language
//     keys present, others still missing), a later plain string is used to
//     fill whichever key(s) are STILL missing (never overwriting a key a
//     higher-priority provider already set) rather than being discarded or
//     locking the field. This is the case the task exists for: sheet.yml
//     (highest priority) supplies `{ ja: "..." }` only, and a lower-priority
//     native channel's plain English string fills the still-open `en` slot.
//     The mirror case — `en` already set, a later plain string only reaches
//     an already-filled `en` and an empty `ja` — fills `ja` with that same
//     (English) text rather than leaving it empty; that is a deliberate,
//     documented trade-off, not the scenario this task motivates, but
//     leaving a language key permanently unfillable once ANY object has
//     touched the field would silently break the motivating case above (the
//     merge logic can't tell in general which language key a bare string is
//     "for", so it fills gaps uniformly rather than special-casing `en`).
//   - Once both `en` and `ja` are filled (by any combination of providers),
//     the field is complete and no further provider is consulted for it.
function mergeLangField(merged: ResolvedMetadata, locked: Set<LangField>, field: LangField, value: LangText): boolean {
  if (locked.has(field)) return false;

  const current = merged[field];

  if (current === undefined) {
    if (typeof value === "string") {
      merged[field] = value;
      locked.add(field);
      return true;
    }
    const obj: { en?: string; ja?: string } = {};
    if (value.en !== undefined) obj.en = value.en;
    if (value.ja !== undefined) obj.ja = value.ja;
    if (obj.en === undefined && obj.ja === undefined) return false;
    merged[field] = obj;
    if (obj.en !== undefined && obj.ja !== undefined) locked.add(field);
    return true;
  }

  // A field only ever reaches this point as a partial `{ en?, ja? }` object:
  // a plain-string claim above locks the field immediately, so `current`
  // having survived the `locked` check above is never itself a string.
  const partial = current as { en?: string; ja?: string };
  const incoming = typeof value === "string" ? { en: value, ja: value } : value;
  let contributed = false;
  if (partial.en === undefined && incoming.en !== undefined) {
    partial.en = incoming.en;
    contributed = true;
  }
  if (partial.ja === undefined && incoming.ja !== undefined) {
    partial.ja = incoming.ja;
    contributed = true;
  }
  if (partial.en !== undefined && partial.ja !== undefined) locked.add(field);
  return contributed;
}

export function resolveMetadata(
  query: MetadataQuery,
  ctx: MetadataContext,
  providers: MetadataProvider[] = listMetadataProviders()
): ResolvedMetadata | undefined {
  const sorted = [...providers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const merged: ResolvedMetadata = { contributions: {} };
  const lockedLangFields = new Set<LangField>();
  let any = false;

  for (const provider of sorted) {
    const result = provider.resolve(query, ctx);
    if (!result) continue;

    let count = 0;

    for (const field of PLAIN_MERGE_FIELDS) {
      if (merged[field] !== undefined) continue;
      const value = result[field];
      if (value === undefined) continue;
      // Field types are heterogeneous (string | object); assign per-field.
      (merged as Record<string, unknown>)[field] = value;
      count++;
    }

    for (const field of LANG_FIELDS) {
      const value = result[field];
      if (value === undefined) continue;
      const wasUnset = merged[field] === undefined;
      if (!mergeLangField(merged, lockedLangFields, field, value)) continue;
      count++;
      // provenance tracks `description` specifically (see ResolvedMetadata).
      // With per-language merging, several providers can now genuinely
      // contribute to the same description (one supplies `ja`, another
      // `en`) — so "the provenance of description" is taken to mean the
      // provider that filled its FIRST language key, i.e. the
      // highest-priority contributor, mirroring what field-level
      // first-wins already credited before this change. A later provider
      // that only plugs a remaining gap does not reassign it.
      if (field === "description" && wasUnset) merged.provenance = result.provenance;
    }

    if (count > 0) {
      merged.contributions[provider.name] = (merged.contributions[provider.name] ?? 0) + count;
      any = true;
    }
  }

  return any ? merged : undefined;
}
