// Product dictionary metadata provider: a simple lookup off the query's
// already-resolved dictionary binding (bind.ts's bindKey, run once per build
// — see assemble.ts's bindDrafts and enrich.ts's standalone bind pass). This
// provider does no key matching of its own and loads no files: "does this
// project key correspond to a dictionary entry, and which one" is answered
// entirely by bind.ts before this provider ever runs.

import { parse, stringify } from "yaml";
import { registerMetadataProvider, type MetadataProvider, type MetadataContext, type MetadataQuery, type MetadataResult, type LangText, type Provenance } from "../metadata.js";

export type DictionaryParam = {
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
  group?: string;
  since?: string;
  until?: string;
  docs_url?: string;
  provenance?: Provenance;
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
};

export type DictionaryDoc = {
  product: string;
  version: string;
  provenance?: Provenance;
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

function parseDictionary(path: string, content: string): DictionaryDoc {
  const raw = parse(content) as Record<string, unknown> | null | undefined;
  if (
    !raw ||
    typeof raw.product !== "string" ||
    typeof raw.version !== "string" ||
    typeof raw.parameters !== "object" ||
    raw.parameters === null
  ) {
    throw new Error("malformed dictionary: " + path);
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

// Load a whole dictionary — used by bind.ts's loadBindSources() (which builds
// the BindSources bindKey() resolves against) and by assemble.ts's
// materialize (which needs every key, not just one this provider's resolve()
// is asked about).
export function findDictionary(
  product: string,
  version: string,
  metadataDirs: string[],
  readFile: (path: string) => string | null
): DictionaryDoc | undefined {
  const found = findFile(product, version, metadataDirs, readFile);
  return found ? parseDictionary(found.path, found.content) : undefined;
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
      description: entry.description,
      default: entry.default !== undefined ? String(entry.default) : undefined,
      type: entry.type,
      scope: entry.scope,
      docs_url: entry.docs_url,
      provenance: entry.provenance ?? docProvenance ?? "community",
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
