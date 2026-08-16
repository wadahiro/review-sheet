// Pluggable metadata provider registry: enrich() resolves parameter documentation
// (description/default/remarks/...) from external sources — a project's own
// metadata file, Ansible argument_specs, or a product dictionary — mirroring the ConfigParser
// registry in parser.ts (array registry, replace-by-name, priority-sorted at
// resolve time, self-registering providers).

import type { KeyTransformStep } from "./keytransform.js";
import { pickLang, type LangText, type ParamOption } from "./types.js";
import { sharedRegistry } from "./registry.js";
import type { Binding } from "./bind.js";

export { pickLang };
export type { LangText, ParamOption };

export type Provenance = "official" | "community" | "machine" | "extracted" | "project";

// A provenance claim, per language, in the same shape LangText already uses:
// a plain scalar claims/covers EVERY language ("this whole description came
// from one place"), while a `{ en?, ja? }` object lets a claim differ per
// language — needed because a description's two languages can genuinely come
// from two different sources (a product's own English docs transcribed here
// vs. this repo's own Japanese translation; see providers/dictionary.ts and
// this module's resolveMetadata). `LangProvenance` is a strict supertype of
// `Provenance` (every existing scalar value is still valid everywhere this
// type is used), which is what keeps every pre-existing dictionary/provider
// loading unchanged.
export type LangProvenance = Provenance | { en?: Provenance; ja?: Provenance };

// One language key of a LangProvenance-shaped map.
type LangKey = "en" | "ja";

// Reduce a per-language provenance pair to the bare scalar whenever there is
// nothing to disagree with: both languages equal, or only one language has a
// value at all. Only a GENUINE split (two languages, two different values)
// stays a map. This is what makes T2's dictionary provider (every existing
// dictionary has one scalar `provenance:` for the whole document, so both
// languages always resolve to the SAME value) produce byte-identical output
// to today, and what lets resolveMetadata's provByLang bookkeeping below
// collapse back to "just credit the one provider" in the common case where a
// single provider supplied the whole description.
//
// Not expected to be called with neither key defined by either of this
// module's own callers (resolveMetadata guards on that below; dictionary.ts's
// provenanceFor always resolves to a defined value, defaulting to
// "community") — the "community" fallback here exists only to keep this a
// total function rather than one that throws on an input no caller reaches.
export function collapseProvenance(p: { en?: Provenance; ja?: Provenance }): LangProvenance {
  const { en, ja } = p;
  if (en === undefined && ja === undefined) return "community";
  if (en === undefined) return ja as Provenance;
  if (ja === undefined) return en;
  return en === ja ? en : { en, ja };
}

// Extract one language's provenance out of a single provider's OWN
// LangProvenance result (metadata.ts has only this one layer to resolve — the
// entry/document layering with a "community" default belongs to
// providers/dictionary.ts's provenanceFor, which is a separate, deeper
// resolution for the dictionary provider specifically). A scalar result
// speaks for every language; an object result is read at exactly that
// language's key, with NO fallback to the other key — the same
// deliberately-not-`pickLang` stance dictionary.ts's provenanceFor documents:
// which provider is credited for `ja` must never be answered by what
// happened to fill `en`.
function provenanceForLang(p: LangProvenance | undefined, lang: LangKey): Provenance | undefined {
  if (p === undefined) return undefined;
  return typeof p === "string" ? p : p[lang];
}

// A binding from a project parameter key namespace to one dictionary snapshot
// file (<product>@<version>.yml, found on metadataDirs).
export type DictionaryBinding = {
  product: string;
  version: string;
  key_prefix?: string;
  // A declarative rewrite from the ROW key to the dictionary key, for the case
  // `key_prefix` cannot express: the row's identity legitimately carries more
  // than the dictionary's does. A Terraform plan names two ALB listeners
  // `aws_lb_listener.https.ssl_policy` and `aws_lb_listener.http_redirect.ssl_policy`
  // — two rows, because they are two resources — while the provider documents
  // one `aws_lb_listener.ssl_policy`. Stripping the instance is wiring, so it
  // is declared once here rather than as one `dict_key` alias per row.
  //
  // Same steps grammar as a recipe's `key:` (keytransform.ts), and the same
  // discipline: a step that never matches any key is reported, never silently
  // tolerated.
  key_steps?: KeyTransformStep[];
};

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
  // The product's own display name for this setting (a Keycloak admin-console
  // label). Display only — see DictionaryParam.label.
  label?: LangText;
  description?: LangText;
  default?: string;
  remarks?: LangText;
  docs_url?: string;
  type?: string;
  scope?: string;
  // The values this setting may take, with the product's own name for each.
  // Merged plainly (first provider with any wins the whole list) rather than
  // per-language like description: an option LIST is one statement about the
  // setting, and interleaving two providers' lists would produce a set of
  // choices neither of them describes.
  options?: ParamOption[];
  out_of_scope?: { reason: LangText; owner?: string };
  provenance: LangProvenance;
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
  label?: LangText;
  description?: LangText;
  default?: string;
  remarks?: LangText;
  docs_url?: string;
  type?: string;
  scope?: string;
  options?: ParamOption[];
  out_of_scope?: { reason: LangText; owner?: string };
  provenance?: LangProvenance;
  contributions: Record<string, number>;
};

// Fields merged whole, field-level first-wins: the first (highest-priority)
// provider to supply a defined value for the field claims it outright, same
// as before this module gained per-language merging.
const PLAIN_MERGE_FIELDS = ["default", "docs_url", "type", "scope", "options", "out_of_scope"] as const;

// LangText fields merged per language KEY rather than as a whole (see below)
// — the reason this module exists: a project's own metadata file may now
// carry only `ja` (English lives in Terraform's `description =` / Ansible's
// argument_specs `description:`, so it is no longer duplicated in sheet.yml),
// and enrichment needs `en` and `ja` to be able to come from two different
// providers for the SAME parameter.
// `label` joins them for the same reason: a product supplies both languages of
// its own display name (Keycloak ships a Japanese admin console), while a
// project overriding one language of it must not blank the other.
const LANG_FIELDS = ["label", "description", "remarks"] as const;
type LangField = (typeof LANG_FIELDS)[number];

// Merge one provider's LangText value for `field` into `merged`, per
// language key, first-wins. Returns WHICH language keys this call actually
// filled (empty when the field was already locked or nothing new landed) —
// used for two things by the caller: `contributions` bookkeeping (one count
// per FIELD the provider touched, never one per language key: filling `en`
// and `ja` from the same provider's single result is one act of
// documentation, not two) and, for `description` specifically, crediting
// PER-LANGUAGE provenance to whichever provider actually supplied that
// language's text (see resolveMetadata's provByLang below) — the truthful
// answer this function used to only approximate.
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
function mergeLangField(merged: ResolvedMetadata, locked: Set<LangField>, field: LangField, value: LangText): LangKey[] {
  if (locked.has(field)) return [];

  const current = merged[field];

  if (current === undefined) {
    if (typeof value === "string") {
      merged[field] = value;
      locked.add(field);
      return ["en", "ja"];
    }
    const obj: { en?: string; ja?: string } = {};
    const filled: LangKey[] = [];
    if (value.en !== undefined) {
      obj.en = value.en;
      filled.push("en");
    }
    if (value.ja !== undefined) {
      obj.ja = value.ja;
      filled.push("ja");
    }
    if (filled.length === 0) return [];
    merged[field] = obj;
    if (obj.en !== undefined && obj.ja !== undefined) locked.add(field);
    return filled;
  }

  // A field only ever reaches this point as a partial `{ en?, ja? }` object:
  // a plain-string claim above locks the field immediately, so `current`
  // having survived the `locked` check above is never itself a string.
  const partial = current as { en?: string; ja?: string };
  const incoming = typeof value === "string" ? { en: value, ja: value } : value;
  const filled: LangKey[] = [];
  if (partial.en === undefined && incoming.en !== undefined) {
    partial.en = incoming.en;
    filled.push("en");
  }
  if (partial.ja === undefined && incoming.ja !== undefined) {
    partial.ja = incoming.ja;
    filled.push("ja");
  }
  if (partial.en !== undefined && partial.ja !== undefined) locked.add(field);
  return filled;
}

export function resolveMetadata(
  query: MetadataQuery,
  ctx: MetadataContext,
  providers: MetadataProvider[] = listMetadataProviders()
): ResolvedMetadata | undefined {
  const sorted = [...providers].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const merged: ResolvedMetadata = { contributions: {} };
  const lockedLangFields = new Set<LangField>();
  // Which provider's provenance answers "where did description's `en`/`ja`
  // actually come from" — filled as `description` gets filled, per language
  // key, and NEVER reassigned once set (mergeLangField only ever reports a
  // language key as newly-filled once, the first time some provider's text
  // lands in that slot). This replaces the old "first contributor wins the
  // whole field" approximation: when `en` and `ja` land from two different
  // providers (sheet.yml's `ja` + a native channel's `en`, the case
  // mergeLangField exists for), each language is now credited to the
  // provider that actually supplied IT, not to whichever provider happened
  // to run first. Collapsed to a bare scalar below when both languages agree
  // (the overwhelmingly common case, and every case this repo's shipped
  // examples hit today), so unsplit output is byte-identical to before.
  const provByLang: { en?: Provenance; ja?: Provenance } = {};
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
      const filledLangs = mergeLangField(merged, lockedLangFields, field, value);
      if (filledLangs.length === 0) continue;
      count++;
      // provenance tracks `description` specifically (see ResolvedMetadata):
      // remarks never drove it, before or after this change.
      if (field === "description") {
        for (const lang of filledLangs) {
          provByLang[lang] = provenanceForLang(result.provenance, lang);
        }
      }
    }

    if (count > 0) {
      merged.contributions[provider.name] = (merged.contributions[provider.name] ?? 0) + count;
      any = true;
    }
  }

  // Collapse per-language credit down to a scalar whenever both languages
  // trace to the same provenance — including the case where only one
  // language ever got a description at all (nothing to disagree with).
  // provByLang stays empty (and merged.provenance stays undefined, as
  // before) whenever no provider ever contributed a description.
  if (provByLang.en !== undefined || provByLang.ja !== undefined) {
    merged.provenance = collapseProvenance(provByLang);
  }

  return any ? merged : undefined;
}
