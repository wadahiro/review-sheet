// Product dictionary metadata provider: a simple lookup off the query's
// already-resolved dictionary binding (bind.ts's bindKey, run once per build
// — see assemble.ts's bindDrafts and enrich.ts's standalone bind pass). This
// provider does no key matching of its own and loads no files: "does this
// project key correspond to a dictionary entry, and which one" is answered
// entirely by bind.ts before this provider ever runs.

import { parse, stringify } from "yaml";
import Ajv from "ajv";
import dictionarySchema from "../schema/dictionary.schema.json";
import { suggestNearest, formatAjvErrors } from "../schema-errors.js";
import {
  registerMetadataProvider,
  collapseProvenance,
  type MetadataProvider,
  type MetadataContext,
  type MetadataQuery,
  type MetadataResult,
  type LangText,
  type Provenance,
  type LangProvenance,
} from "../metadata.js";

export type DictionaryParam = {
  // What the PRODUCT calls this setting where a human meets it — Keycloak's
  // admin console label, an nginx directive's own display name. The key is the
  // setting's identity (`attributes["saml.signature.algorithm"]`, which
  // verify/apply resolve by); this is what the console shows for it
  // (「署名アルゴリズム」), and it is the only one a reviewer has seen before.
  //
  // Display only, and never identity: two settings may legitimately share a
  // label, and a label changes with a product's UI wording while the key does
  // not.
  label?: LangText;
  description?: LangText;
  default?: string | number | boolean;
  type?: string;
  // Where/when the setting applies, in the product's own terms (Keycloak's
  // build-time vs runtime, an nginx directive's valid context). Documentation.
  scope?: string;
  // The product's OWN grouping of its parameters (PostgreSQL's pg_settings
  // category, "Write-Ahead Log / Archive Recovery"). Structure, not
  // documentation: it is NOT returned by resolve() — enrich never writes it
  // onto a parameter. The assembler reads it directly as the category fallback
  // for a materialized (`origin: "default"`) row, exactly like it reads
  // `category` off the project metadata. Keeping it out of resolve() is what
  // stops a product taxonomy from silently overwriting a project's own.
  //
  // A LIST is a path, exactly like the project metadata's `category:` — a
  // product whose own taxonomy has levels can say so instead of spelling the
  // hierarchy into one name. Keycloak's realm groups did the latter for want of
  // this ("Tokens / Access tokens", "Sessions / Access tokens"), which reads as
  // a hierarchy and is one flat name: nothing folds or sorts by "Tokens",
  // because no such category exists. A bare string is the one-segment case.
  group?: string | string[];
  docs_url?: string;
  // Which sub-product of this dictionary the option belongs to, when the
  // dictionary covers more than one. A Terraform provider is the case: one
  // `aws@5.100.0` document holds the arguments of 21 resource TYPES, and
  // `idle_timeout` is an option of `aws_lb` — not an option of "AWS".
  //
  // materialize reads it. An unset option is only a fact about a component
  // that HAS the thing it belongs to: "the Keycloak DB has an unset aws_lb
  // argument" is not a gap in the ledger, it is a sentence about nothing. So
  // an entry carrying a unit is expanded only into a component already using
  // that unit, and the component's own rows are the evidence of which it uses.
  //
  // Omitted = the whole dictionary is one product (every Keycloak option is an
  // option OF Keycloak), which is every dictionary predating this field and
  // every single-product one after it. Those expand unconditionally, as before.
  unit?: string;
  // Widened to LangProvenance (metadata.ts) so an entry can claim different
  // trust levels per language — e.g. a hand-transcribed English description
  // (official) paired with this repo's own Japanese translation (community).
  // A bare `Provenance` scalar (every dictionary predating this field) is
  // still valid here: LangProvenance is a strict supertype, so nothing
  // existing needs to change. See providers/dictionary.ts's provenanceFor
  // for how this resolves per language against the document-level default
  // below, and metadata.ts's collapseProvenance for why a uniform value
  // renders identically to the plain scalar it used to be.
  provenance?: LangProvenance;
  // Whether this entry has a value at all. Most of a product's dictionary is
  // "value" — a setting with a default, a type, a value in effect — but a
  // structural element (Apache's `<IfModule>`/`<VirtualHost>`, a block that
  // only groups OTHER directives) has none: "what is its default?" is not a
  // question that has an answer for a container. Optional, and OMITTED means
  // `"value"` — the safe default, because it is what almost every entry is,
  // and it is what every dictionary predating this field already meant.
  // `materialize` (assemble.ts) skips `"container"` entries: turning one into
  // an `origin: "default"` row would assert a default value a syntax element
  // does not have, making the ledger lie. A container entry is not dead
  // weight, though — enrich() still resolves it by name, so a parser that
  // emits a synthetic row for the container's own expression (httpd.ts's
  // `IfModule "value"` row, the condition itself) gets the product's
  // description for free.
  kind?: "value" | "container";
  // How the PRODUCT'S OWN administrative UI exposes this parameter. A fact
  // about the UI, deliberately NOT about whether the parameter can be set at
  // all: almost everything here is still writable through the product's API,
  // which is how a provisioning tool sets it. Conflating the two would make
  // the dictionary claim something false.
  //
  //   "editable" — a control writes it. The ordinary case.
  //   "readonly" — the UI reads the value (displays it, or branches on it) but
  //                offers no way to choose one. Keycloak's realm `notBefore` is
  //                this: a read-only box beside Set-to-now / Clear / Push, so
  //                the only values it can hold are "now" and 0. What it records
  //                is an OPERATION, not a decision.
  //   "absent"   — the UI never mentions it. A legacy field the API still
  //                accepts, typically.
  //
  // Omitted = no claim, which is every dictionary predating this field and
  // every product with no UI to speak of (httpd, PostgreSQL). Nothing changes
  // for those — see assemble.ts's uiFiltered pass for what a claim does.
  //
  // Only an extraction that can SEE the UI may set this. It is exactly the
  // kind of fact a person would otherwise guess at from a field name, which is
  // why it belongs to the generator and not to an overlay.
  ui?: "editable" | "readonly" | "absent";
};

// The field names dictionary.schema.json declares, kept beside the types they
// describe so the two cannot drift apart unnoticed. The `Exclude` assertions
// below fail to COMPILE if a field is added to a type and not to this list;
// tests/dictionary-schema.test.ts fails if it is in this list and not in the
// schema. Between them, adding a field to one place and forgetting the other
// two is a build failure rather than a field that silently does nothing —
// which is the exact failure this whole schema exists to remove.
export const DICTIONARY_PARAM_FIELDS = [
  "label",
  "description",
  "default",
  "type",
  "scope",
  "group",
  "unit",
  "kind",
  "ui",
  "docs_url",
  "provenance",
] as const;

export const DICTIONARY_DOC_FIELDS = ["product", "version", "provenance", "coverage", "generated_by", "docs_url", "parameters"] as const;

type Empty<T extends never> = T;
type _ParamFieldsCoverType = Empty<Exclude<keyof DictionaryParam, (typeof DICTIONARY_PARAM_FIELDS)[number]>>;
type _ParamFieldsAreReal = Empty<Exclude<(typeof DICTIONARY_PARAM_FIELDS)[number], keyof DictionaryParam>>;
type _DocFieldsCoverType = Empty<Exclude<keyof DictionaryDoc, (typeof DICTIONARY_DOC_FIELDS)[number]>>;
type _DocFieldsAreReal = Empty<Exclude<(typeof DICTIONARY_DOC_FIELDS)[number], keyof DictionaryDoc>>;

export type DictionaryDoc = {
  product: string;
  version: string;
  // Document-level default provenance, same LangProvenance widening as
  // DictionaryParam.provenance above — a doc-level map is what lets nginx/
  // httpd (hand-transcribed English, community-translated Japanese) declare
  // `{ en: official, ja: community }` ONCE instead of on every entry.
  provenance?: LangProvenance;
  // Whether `parameters` is a genuine, mechanical extraction of the PRODUCT'S
  // OWN full option space (Java reflection over its option classes, a
  // `pg_settings` dump — something that enumerates, not something someone
  // curated) or a hand-picked subset a person chose to write down. This is a
  // different axis from `provenance`: a hand-transcribed dictionary can be
  // `official` (correctly copied from the docs) while covering only a dozen
  // directives out of hundreds.
  //
  // `assemble.ts`'s `materialize` reads this and refuses to expand anything
  // but `"full"` — turning a `"partial"` dictionary's keys into `origin:
  // "default"` rows would tell a reviewer "this is everything the product
  // has", when it is really "this is everything someone got around to
  // writing down": a fake full-inventory that looks identical to a real one.
  //
  // Optional, but the OMITTED case is treated as `"partial"` — the safe
  // side. An author who forgets to set this gets a hard error at materialize
  // time (a loud, fixable failure) instead of silently shipping a sheet that
  // claims completeness it does not have.
  coverage?: "full" | "partial";
  generated_by?: string;
  docs_url?: string;
  parameters: Record<string, DictionaryParam>;
};

// The coverage claim materialize is allowed to act on. Centralized so the
// "omitted -> partial" default is defined exactly once.
export function dictionaryCoverage(doc: DictionaryDoc): "full" | "partial" {
  return doc.coverage ?? "partial";
}

// `verbose: true` for the same reason spec.ts wants it: an
// additionalProperties error only carries the schema that rejected the field —
// and so the list of names it DOES accept — when verbose is on, which is what
// turns "unknown field" into "did you mean".
// `allowUnionTypes` for `default` alone: a documented default is genuinely a
// scalar of whichever kind the setting takes (a port is a number, a toggle a
// boolean), and spelling that as three branches of anyOf would say the same
// thing less clearly.
const dictAjv = new Ajv({ allErrors: true, verbose: true, allowUnionTypes: true });
const validateDictionary = dictAjv.compile(dictionarySchema);

// Validated against the schema, not spot-checked. Until this existed the check
// was three `typeof`s and a cast, so a dictionary could misspell any field and
// the value simply never arrived — no error, no warning, the row just showing
// nothing where its default or its group should be. Every other input this
// tool reads (build.yml, an overlay, the model itself) is schema-checked; this
// was the one that was not, and it is the input a project is most likely to
// hand-edit or receive from elsewhere.
//
// A hard error, deliberately, matching build.yml and the overlay: there is no
// warning channel here, and a rejected field is loud and immediately fixable.
function parseDictionary(path: string, content: string): DictionaryDoc {
  const raw = parse(content) as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") throw new Error("malformed dictionary: " + path);
  if (!validateDictionary(raw)) {
    throw new Error(`dictionary validation error in ${path}:\n${formatAjvErrors(validateDictionary.errors)}`);
  }
  return raw as unknown as DictionaryDoc;
}

// Find <product>@<version>.yml across dirs, first readable wins.
function findFile(
  product: string,
  version: string,
  metadataDirs: string[],
  readFile: (path: string) => string | null
): { path: string; content: string } | undefined {
  const filename = `${product}@${version}.yml`;
  for (const dir of metadataDirs) {
    const path = `${dir}/${filename}`;
    const content = readFile(path);
    if (content !== null) return { path, content };
  }
  return undefined;
}

// Find every readable <product>@<version>.overlay.yml across ALL dirs, in dir
// order — unlike findFile's base lookup, more than one is legal by design: a
// project-local metadata dir can overlay a shared team dictionary without
// forking it (see mergeOverlays).
function findOverlayFiles(
  product: string,
  version: string,
  metadataDirs: string[],
  readFile: (path: string) => string | null
): { path: string; content: string }[] {
  const filename = `${product}@${version}.overlay.yml`;
  const found: { path: string; content: string }[] = [];
  for (const dir of metadataDirs) {
    const path = `${dir}/${filename}`;
    const content = readFile(path);
    if (content !== null) found.push({ path, content });
  }
  return found;
}

// Load a whole dictionary — used by bind.ts's loadBindSources() (which builds
// the BindSources bindKey() resolves against) and by assemble.ts's
// materialize (which needs every key, not just one this provider's resolve()
// is asked about). This is the SOLE place a whole dictionary is assembled, so
// it is also the sole place the overlay merge (mergeOverlays) runs — every
// consumer above sees the merged result with no change of its own, including
// the dictionary provider's resolve(), which only ever sees a DictionaryParam
// already reached through bind.ts's Binding.
export function findDictionary(
  product: string,
  version: string,
  metadataDirs: string[],
  readFile: (path: string) => string | null
): DictionaryDoc | undefined {
  const found = findFile(product, version, metadataDirs, readFile);
  const overlays = findOverlayFiles(product, version, metadataDirs, readFile);
  if (!found) {
    // An overlay has nothing to overlay without a base — this is what makes
    // "overlay without base" fail loud instead of silently contributing
    // nothing (the same failure mode a version-upgrade rename would produce
    // if this were left unchecked: the file just sits there, unread).
    if (overlays.length > 0) {
      throw new Error(
        `${overlays.map((o) => o.path).join(", ")}: overlay file found for ${product}@${version}, ` +
          `but no base dictionary ${product}@${version}.yml exists on metadata_dirs — ` +
          `an overlay has nothing to overlay without one`
      );
    }
    return undefined;
  }
  const base = parseDictionary(found.path, found.content);
  return overlays.length > 0 ? mergeOverlays(base, overlays) : base;
}

// ---- Overlay: hand-authored community/gap-filling translations ------------
//
// The base is written wholesale by a generator (renderDictionary, "# GENERATED
// ... do not edit by hand"). An overlay is the opposite: never written by any
// generator, hand-authored like sheet.yml, and merged in HERE so regeneration
// safety comes from the generator physically not knowing overlays exist —
// not from anyone's discipline about which file they edit.
//
// Fields an overlay entry may set are documentation prose ONLY.
// default/type/scope/group/kind/ui/since/until are product facts the extraction
// owns; letting an overlay set them would let a community claim reshape
// materialize's inventory ledger (see the design doc's "Unsure" section for
// the one tempting exception, `default`).
export type DictionaryOverlayParam = {
  description?: LangText;
  docs_url?: string;
  provenance?: LangProvenance;
};

export type DictionaryOverlayDoc = {
  product: string;
  version: string;
  // Document-level default provenance for whatever THIS FILE adds — same
  // shape as DictionaryDoc.provenance, but scoped to the overlay's OWN
  // contributions; it never touches an entry the overlay doesn't mention.
  provenance?: LangProvenance;
  parameters: Record<string, DictionaryOverlayParam>;
};

const OVERLAY_DOC_FIELDS = ["product", "version", "provenance", "parameters"];
const OVERLAY_PARAM_FIELDS = ["description", "docs_url", "provenance"];


// Strict overlay parsing: unlike parseDictionary's lax four-field check (base
// dictionaries stay unvalidated deliberately — see the module-level design
// doc), the overlay is a NEW format with no installed base to break, so it is
// strict from day one. An unknown field is an error naming it, with a "did
// you mean" hint when one is close — the same quality build.yml's own
// additionalProperties:false rejection gives (spec.ts's suggestNearest use).
export function parseOverlay(path: string, content: string): DictionaryOverlayDoc {
  const raw = parse(content) as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== "object") {
    throw new Error(`${path}: malformed overlay (must be a YAML map)`);
  }
  for (const field of Object.keys(raw)) {
    if (!OVERLAY_DOC_FIELDS.includes(field)) {
      const hint = suggestNearest(field, OVERLAY_DOC_FIELDS);
      throw new Error(
        `${path}: unknown field "${field}" — an overlay may set only ${OVERLAY_DOC_FIELDS.join("/")}` +
          (hint ? ` (did you mean "${hint}"?)` : "")
      );
    }
  }
  if (typeof raw.product !== "string" || typeof raw.version !== "string" || typeof raw.parameters !== "object" || raw.parameters === null) {
    throw new Error(`${path}: malformed overlay (product/version/parameters are required)`);
  }
  for (const [key, entry] of Object.entries(raw.parameters as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`${path}: parameter "${key}" must be a map`);
    }
    // The SHAPE of a LangText, not just which fields exist: `description:
    // { enn: "..." }` used to pass every check here and then fill neither
    // language — mergeOverlays reads `en`/`ja` off it and finds both
    // undefined, so the entry contributed nothing, with no error and no
    // warning. That is the silent no-op this file exists to prevent
    // everywhere else. The base dictionary gets the same guarantee from the
    // schema's `langText` definition; an overlay is hand-written, so it is
    // the one that most needed it.
    const desc = (entry as Record<string, unknown>).description;
    if (desc !== undefined && typeof desc === "object" && desc !== null) {
      for (const lang of Object.keys(desc as Record<string, unknown>)) {
        if (lang !== "en" && lang !== "ja") {
          const hint = suggestNearest(lang, ["en", "ja"]);
          throw new Error(
            `${path}: parameter "${key}" description has unknown language "${lang}" — only en/ja exist` +
              (hint ? ` (did you mean "${hint}"?)` : "")
          );
        }
      }
    }
    for (const field of Object.keys(entry as Record<string, unknown>)) {
      if (!OVERLAY_PARAM_FIELDS.includes(field)) {
        const hint = suggestNearest(field, OVERLAY_PARAM_FIELDS);
        throw new Error(
          `${path}: parameter "${key}" has unknown field "${field}" — an overlay entry may set only ` +
            `${OVERLAY_PARAM_FIELDS.join("/")} (default/type/scope/group/kind/ui/since/until are product facts ` +
            `the extraction owns, not the overlay's to set)` +
            (hint ? ` (did you mean "${hint}"?)` : "")
        );
      }
    }
  }
  return raw as unknown as DictionaryOverlayDoc;
}

// A base entry's bare-string description is, by this repo's own extraction
// convention, plain text in whichever single language the product/extractor
// actually supplied — shown to a reader of the OTHER language only through
// pickLang's cross-language fallback (types.ts), which is a display
// convenience, not a claim that the other language's text also exists. Here
// it counts as filling ONLY `en`: every base dictionary this design targets
// is English-sourced, and treating a bare string as covering `ja` too would
// make the keycloak `db` case (English-only base, `ja` gap-filled by the
// overlay) impossible to ever overlay.
function baseDescLangs(t: LangText | undefined): { en?: string; ja?: string } {
  if (t === undefined) return {};
  return typeof t === "string" ? { en: t } : { ...t };
}

// An overlay's OWN bare-string description patches BOTH languages at once —
// mirrors resolveMetadata's "a plain string locks the whole field" rule for a
// provider's result (metadata.ts). This is what DESC_EXTRA-style entries need:
// a base entry the product describes in NEITHER language yet.
function overlayDescLangs(t: LangText): { en?: string; ja?: string } {
  return typeof t === "string" ? { en: t, ja: t } : t;
}

// Layer a single-language provenance patch onto a base entry's own
// provenance. A base SCALAR is expanded to both keys first (an entry-level
// scalar already claims both languages, so patching one must not silently
// widen what the OTHER language claims beyond that); a base that is
// undefined, or already a partial map, is left exactly as sparse as it was —
// "no entry-level claim for this language" must survive the merge unchanged,
// or provenanceFor's own fallthrough to the document-level default (the
// keycloak `db` case: `en` falls through to the doc's "extracted") would stop
// working the instant an overlay touched the OTHER language. Collapses back
// to a bare scalar only when both languages end up defined AND equal — the
// same "nothing left to disagree about" rule collapseProvenance (metadata.ts)
// applies at resolve time, reimplemented here because collapseProvenance
// itself would wrongly treat "one side still undefined" as "collapse to the
// other side's value", which is exactly the bug this paragraph exists to avoid.
function mergeProv(base: LangProvenance | undefined, patch: { en?: Provenance; ja?: Provenance }): LangProvenance | undefined {
  if (patch.en === undefined && patch.ja === undefined) return base;
  const baseMap = typeof base === "string" ? { en: base, ja: base } : (base ?? {});
  const en = patch.en ?? baseMap.en;
  const ja = patch.ja ?? baseMap.ja;
  if (en === undefined && ja === undefined) return undefined;
  if (en === undefined) return { ja };
  if (ja === undefined) return { en };
  return en === ja ? en : { en, ja };
}

// Merge every overlay onto the base, per the design's normative rules:
//   - a key the base no longer has -> error (renamed/removed upstream)
//   - a language the base (or an earlier overlay) already supplies -> error
//     ("the dictionary now supplies <lang> for K — drop it from the overlay")
//   - otherwise fill-only: description per language key, docs_url, and layer
//     provenance via mergeProv
// Every offending key across every overlay is collected and reported in ONE
// error — a version upgrade that starts supplying several languages at once
// must not make the author fix-and-rerun one key at a time to find the next.
function mergeOverlays(base: DictionaryDoc, overlays: { path: string; content: string }[]): DictionaryDoc {
  // Entries the overlay never touches stay the SAME object reference the base
  // parsed them as ("untouched entries bit-identical" — only a touched key's
  // entry is ever shallow-cloned, on its first touch, below).
  const parameters: Record<string, DictionaryParam> = { ...base.parameters };
  // Which overlay file already filled a given key+language / key's docs_url —
  // catches two overlays racing to fill the SAME slot (never a silent
  // first-wins pick, same stance bind.ts takes on an ambiguous bind).
  const filledLang = new Map<string, string>();
  const filledDocsUrl = new Map<string, string>();
  const errors: string[] = [];

  for (const { path, content } of overlays) {
    const doc = parseOverlay(path, content);
    if (doc.product !== base.product || doc.version !== base.version) {
      // A product/version mismatch means this file is not describing the
      // dictionary it sits next to at all — not the "many keys drifted at
      // once" failure mode the errors[] batching exists for, so this fails
      // fast rather than joining the batch.
      throw new Error(
        `${path}: overlay declares ${doc.product}@${doc.version}, but the base dictionary next to it is ` +
          `${base.product}@${base.version} — an overlay's product/version must match its base's`
      );
    }
    const docProvenance = doc.provenance ?? "community";

    for (const [key, overlayEntry] of Object.entries(doc.parameters)) {
      const baseEntry = base.parameters[key];
      if (baseEntry === undefined) {
        const hint = suggestNearest(key, Object.keys(base.parameters));
        errors.push(
          `overlay names a key ${base.product}@${base.version} no longer has: "${key}" — renamed or removed ` +
            `upstream; fix or drop it.` +
            (hint ? ` (did you mean "${hint}"?)` : "") +
            ` [${path}]`
        );
        continue;
      }

      const alreadyTouched = parameters[key] !== base.parameters[key];
      const merged: DictionaryParam = alreadyTouched ? parameters[key] : { ...base.parameters[key] };

      if (overlayEntry.description !== undefined) {
        const baseLangs = baseDescLangs(baseEntry.description);
        const patchLangs = overlayDescLangs(overlayEntry.description);
        const mergedLangs = baseDescLangs(merged.description);
        const provPatch: { en?: Provenance; ja?: Provenance } = {};
        for (const lang of ["en", "ja"] as const) {
          const text = patchLangs[lang];
          if (text === undefined) continue;
          if (baseLangs[lang] !== undefined) {
            errors.push(`the dictionary now supplies ${lang} for "${key}" — drop it from the overlay. [${path}]`);
            continue;
          }
          const fillKey = `${key}\u0000${lang}`;
          const already = filledLang.get(fillKey);
          if (already !== undefined) {
            errors.push(`two overlays both supply ${lang} for "${key}" (${already} and ${path}) — drop the duplicate.`);
            continue;
          }
          filledLang.set(fillKey, path);
          mergedLangs[lang] = text;
          provPatch[lang] = provenanceFor(lang, overlayEntry.provenance, docProvenance);
        }
        merged.description = mergedLangs;
        merged.provenance = mergeProv(merged.provenance, provPatch);
      }

      if (overlayEntry.docs_url !== undefined) {
        if (baseEntry.docs_url !== undefined) {
          errors.push(`the dictionary now supplies docs_url for "${key}" — drop it from the overlay. [${path}]`);
        } else {
          const already = filledDocsUrl.get(key);
          if (already !== undefined) {
            errors.push(`two overlays both supply docs_url for "${key}" (${already} and ${path}) — drop the duplicate.`);
          } else {
            filledDocsUrl.set(key, path);
            merged.docs_url = overlayEntry.docs_url;
          }
        }
      }

      parameters[key] = merged;
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `${errors.length} overlay problem(s) for ${base.product}@${base.version}:\n` + errors.map((e) => `  - ${e}`).join("\n")
    );
  }

  return { ...base, parameters };
}

// Resolve ONE language's provenance for a dictionary entry: entry map's key
// -> entry scalar -> doc map's key -> doc scalar -> "community". Four tiers,
// tried in that order, and each one is checked in full before moving to the
// next — an object at a given tier that has no key for `lang` does NOT fall
// back to reading its OTHER language's key; it falls through to the NEXT
// TIER, exactly the way an absent tier would.
//
// This is deliberately NOT pickLang (types.ts): pickLang's job is to make
// SOME text available for display, so it is right for pickLang to answer
// "give me `ja`, or `en` if `ja` is missing" — the reader still gets prose.
// Provenance is a trust claim, not prose: the origin of a Japanese
// translation is never answered by the origin of the English text sitting
// next to it in the same entry. Confusing the two here would let e.g. a
// dictionary's `provenance: { en: official }` (silent on `ja`) get read as
// "ja is official too" via pickLang's en-fallback — exactly the misreport
// this whole design exists to close (see the keycloak@26.7.0 DESC_JA case:
// hand-written `ja` credited with the document's `extracted` claim, which
// Keycloak never actually vouched for).
export function provenanceFor(lang: "en" | "ja", entryProv: LangProvenance | undefined, docProv: LangProvenance | undefined): Provenance {
  if (entryProv !== undefined) {
    if (typeof entryProv === "string") return entryProv;
    if (entryProv[lang] !== undefined) return entryProv[lang];
  }
  if (docProv !== undefined) {
    if (typeof docProv === "string") return docProv;
    if (docProv[lang] !== undefined) return docProv[lang];
  }
  return "community";
}

const dictionaryProvider: MetadataProvider = {
  name: "dictionary",
  priority: 30,
  resolve(query: MetadataQuery, _ctx: MetadataContext): MetadataResult | undefined {
    // Nothing to look up: bind.ts's bindKey() already decided this project
    // key has no dictionary counterpart (the common case — most parameters
    // don't). No file access, no candidate matching — that all happened once,
    // upstream, in the single bind pass (assemble.ts's bindDrafts or
    // enrich.ts's own standalone pass for the `import -f` path).
    if (!query.binding) return undefined;

    const { entry, docProvenance } = query.binding;
    return {
      // Carry the full LangText through; the viewer resolves the display
      // language at render time so the in-page language toggle switches it.
      label: entry.label,
      description: entry.description,
      default: entry.default !== undefined ? String(entry.default) : undefined,
      type: entry.type,
      scope: entry.scope,
      docs_url: entry.docs_url,
      // provenanceFor always resolves to a defined Provenance per language
      // (its own last tier is the "community" default, replacing the old
      // `?? "community"`), so collapseProvenance here only ever decides
      // between "both languages agree -> bare scalar" (every dictionary
      // that has not adopted per-language provenance, byte-identical to
      // today) and "they genuinely differ -> keep the map".
      provenance: collapseProvenance({ en: provenanceFor("en", entry.provenance, docProvenance), ja: provenanceFor("ja", entry.provenance, docProvenance) }),
    };
  },
};
registerMetadataProvider(dictionaryProvider);

// ---- Authoring a dictionary --------------------------------------------------

// Turn a dictionary document into the YAML text of a `<product>@<version>.yml`.
//
// A dictionary is normally produced by a small per-product script that reshapes
// whatever the product itself yields — a `pg_settings` dump, Java reflection
// over an image's option classes, a docs scrape. Those scripts are inherently
// product-specific, but the SHAPE they have to produce is this package's, so
// they should not each be re-deriving it from an example: taking a typed
// `DictionaryDoc` here is what makes a wrong field a compile error instead of a
// silently ignored key.
//
// The output is deterministic for identical input (no timestamps), so a
// regenerated dictionary is an empty diff unless the product actually changed.
export function renderDictionary(doc: DictionaryDoc, opts?: { generator?: string; notes?: string[] }): string {
  const header = [
    `# GENERATED${opts?.generator ? ` by ${opts.generator}` : ""} — do not edit by hand.`,
    ...(doc.generated_by ? [`# Source: ${doc.generated_by}`] : []),
    ...(opts?.notes ?? []).map((n) => `# ${n}`),
  ].join("\n");

  // Field order is fixed so the file reads the same way for every product.
  // `coverage` sits next to `provenance` — both are document-level trust
  // claims about `parameters` (how much the wording is worth vs. how much of
  // the product it accounts for).
  const ordered = {
    product: doc.product,
    version: doc.version,
    ...(doc.provenance ? { provenance: doc.provenance } : {}),
    ...(doc.coverage ? { coverage: doc.coverage } : {}),
    ...(doc.generated_by ? { generated_by: doc.generated_by } : {}),
    ...(doc.docs_url ? { docs_url: doc.docs_url } : {}),
    parameters: doc.parameters,
  };
  return `${header}\n${stringify(ordered, { lineWidth: 0 })}`;
}
