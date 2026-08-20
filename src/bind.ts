// Pure key-resolution core: the ONE place a project parameter key gets
// matched against a bound product dictionary entry. This replaces the ad hoc
// candidate-list matching and leaf-directive normalizer that used to live
// directly in providers/dictionary.ts — everything that resolves a key
// against a dictionary is meant to route through here, and only here.
//
// Why this exists: a project today hand-writes `dict_key: TimeOut` to bind
// `httpd_timeout` to Apache's `TimeOut` directive. For years the project's
// alias and the dictionary's own key were BOTH misspelled "Timeout" (lower
// case o) and nobody noticed, because an exact string match doesn't care
// which side is wrong. Delimiter-insensitive, casefolded matching
// (normalizeKey below) closes that hole for THIS KIND of mistake: since
// `httpd_timeout` normalizes to the same string as `TimeOut` regardless of
// which one is "correct", the dictionary's spelling always wins and there is
// no longer a way to write a wiring alias that quietly agrees with a typo.
//
// The flip side is `SSO_SMTP_HOST` vs `smtpServer.host`: normalizing does
// NOT make these equal (the env var elides "Server"), and that is not a bug
// in the matcher — it is the matcher correctly reporting that this is real
// information (a true rename), not wiring. `dict_key` exists for exactly
// that case, and only that case.
//
// The organizing principle: normalization that makes two spellings equal
// erases wiring. Normalization that would NOT make them equal, so a human
// wrote an explicit alias instead, is preserving information. bindKey()'s
// tier order (see TIERS below) is built to prefer "erase wiring" whenever
// possible and fall back to the explicit alias only when it must.

import { parseSteps } from "./structural.js";
import { makeKeyTransformer, type KeyTransformer, type KeyTransformStep } from "./keytransform.js";
import type { DictionaryBinding, LangProvenance } from "./metadata.js";
import { findDictionary, resolveVariantDefaults, type DictionaryDoc, type DictionaryParam } from "./providers/dictionary.js";

// How a key ended up bound, in the order bindKey() tries them:
//   alias      - the project's own `dict_key` declaration, matched verbatim.
//                A human said "these are the same thing" explicitly; nothing
//                else should ever outrank that.
//   aka        - the raw key is one of a dictionary entry's own `aliases`:
//                a second spelling THE PRODUCT accepts for that same setting
//                (Keycloak's `cache-embedded-realms-max-count` and
//                `spi-cache-embedded--default--realms-max-count` are one
//                option, the first being a mapper whose target is the
//                second). Immediately after `exact` because it is the same
//                kind of statement — a key named verbatim by the product —
//                and above everything that RESHAPES the key, since a
//                reshaping tier is this tool guessing and this is the
//                product answering.
//   exact      - the raw key IS a dictionary key, verbatim. The common case
//                for a row named by a product key (see assemble.ts's
//                keyMap), where the project's key space already IS the
//                product's.
//   prefix     - the raw key, with the binding's own `key_prefix` stripped,
//                IS a dictionary key, verbatim. A project namespacing
//                convention (`nginx_`, `httpd_`) peeled off before matching.
//   derived    - the raw key, rewritten by the binding's own `key_steps`
//                (metadata.ts's DictionaryBinding), IS a dictionary key,
//                verbatim. `key_prefix` peels a fixed namespace off the
//                front; this handles the case where the row's identity is
//                legitimately RICHER than the dictionary's and the surplus
//                is in the middle: a Terraform plan's
//                `aws_lb_listener.https.ssl_policy` and
//                `aws_lb_listener.http_redirect.ssl_policy` are two rows —
//                two real resources — against one documented
//                `aws_lb_listener.ssl_policy`. Below `prefix` because it is
//                the more powerful and so the less specific statement, and
//                above `leaf` because a caller that went to the trouble of
//                declaring the rewrite means it.
//   derived-default
//              - the same rewrite, but the RECIPE's, not the project's
//                (SheetInputs.dictKeySteps, applied where a binding declared
//                no key_steps). Ranked below `derived` because it is not the
//                project saying anything: the tier order above is built on how
//                much of a statement a match is — `alias` leads because a human
//                wrote it — and a default nobody wrote is the least of them.
//                Kept ABOVE `leaf` so an existing sheet's answers do not move:
//                a recipe-derived hit already outranked a leaf one.
//   repeat     - the key with a trailing repetition index dropped
//                (`Service.Environment[1]` -> `Service.Environment`). A
//                repeated directive is the same parameter written twice, and
//                the product documents it once. Immediately after `exact`
//                because it IS the key, minus bookkeeping no product states.
//   leaf       - the last identity-bearing segment of a dotted/bracketed
//                structural path (see leafKey()) IS a dictionary key,
//                verbatim. Handles a repeated or nested structural leaf
//                (`redirectUris[0]`, `attributes["saml.client.signature"]`)
//                resolving against a dictionary that documents only the bare
//                leaf name.
//   normalized - any of the candidates above, with `_`/`-`/`.` stripped and
//                casefolded, matches a dictionary key normalized the same
//                way. This is what makes `httpd_timeout` find `TimeOut`
//                without anyone declaring an alias. Tried LAST, after every
//                verbatim tier, so a dictionary that happens to define BOTH
//                `Timeout` and `TimeOut` (unlikely, but not this module's
//                problem to prevent) still prefers whichever one actually
//                matches exactly.
export type BindMethod = "alias" | "exact" | "aka" | "repeat" | "prefix" | "derived" | "derived-default" | "leaf" | "normalized";

// The tiers a CONTAINER row may legitimately reach.
//
// Passing the noun instead of the key already makes `leaf` and `repeat` inert,
// but construction alone does not cover the rest: a project's `key_prefix` or
// `key_steps` are written for row keys and can mangle a bare noun into a match
// that means nothing. So the tier a container actually reached is checked
// against this, per build, against the project's OWN dictionaries — because
// whether a wrong match exists at all depends on a dictionary this repository
// does not ship, which is exactly why a unit test on today's data could not be
// the guard.
//
// `normalized` is allowed on purpose: a casefolded noun finding the
// dictionary's own spelling is the same inference that lets `httpd_timeout`
// find `TimeOut`, and it is inference over vocabulary, not over an address.
export const CONTAINER_BIND_METHODS: readonly BindMethod[] = ["alias", "exact", "aka", "normalized"];

// A resolved binding. `entry` is the dictionary's own DictionaryParam,
// unfiltered — including `kind: "container"` entries. A container (Apache's
// `<IfModule>`, a syntax element with no default value of its own) is a
// legitimate bind target: enrich() still wants to pull its description by
// name. Only assemble.ts's materialize() treats `kind: "container"`
// specially (it must not manufacture a default row for one) — that is a
// concern of what to DO with a resolved entry, not of whether one resolves.
export type Binding = {
  product: string;
  version: string;
  dictKey: string;
  entry: DictionaryParam;
  method: BindMethod;
  // The bound dictionary DOCUMENT's own provenance (providers/dictionary.ts's
  // DictionaryDoc.provenance — LangProvenance, type-only change from this
  // module's point of view: bind.ts carries it, never interprets it),
  // carried alongside `entry` so a consumer (the dictionary metadata
  // provider) can resolve `entry.provenance` layered over `docProvenance`
  // per language (see providers/dictionary.ts's provenanceFor) without
  // re-loading or re-searching the document itself — bindKey() already had
  // it in hand while resolving.
  docProvenance?: LangProvenance;
  // Where the binding document's defaults were read, when a distribution's
  // shipped file supplied them — see DictionaryDoc.defaults_from. Carried on
  // the binding for the same reason `docProvenance` is: it is a fact about the
  // document a row bound to, and the row is where it has to be readable.
  defaultsFrom?: string;
};

export type BindMatch = { product: string; version: string; dictKey: string };

// Two (or more) dictionary keys tied at the same tier. This is always an
// error, never a silent first-wins pick — an unnoticed wrong pick here is
// exactly the failure mode (a wrong description quietly attached to a
// parameter) that made the TimeOut/Timeout coincidence dangerous in the
// first place.
export type BindError = {
  kind: "ambiguous";
  method: BindMethod;
  key: string;
  matches: BindMatch[];
  message: string;
};

export function isBindError(result: Binding | undefined | BindError): result is BindError {
  return result !== undefined && "kind" in result && result.kind === "ambiguous";
}

// One declared dictionary binding, paired with its already-loaded document.
// bindKey() is pure (no fs access), so loading `<product>@<version>.yml` off
// ctx.metadataDirs stays the caller's job (see providers/dictionary.ts).
export type BindSource = {
  binding: DictionaryBinding;
  doc: DictionaryDoc;
  // Built once per source, NOT per bindKey() call, because a KeyTransformer is
  // stateful: it remembers which "drop" steps never matched anything so the
  // caller can report a rewrite that silently applied to nothing. Rebuilding
  // it per key would reset that memory every time. bindKey() itself stays
  // pure — it only calls apply(). Use makeBindSource() rather than building
  // this by hand.
  keyTransformer?: KeyTransformer;
  // The RECIPE's own understanding of how its rows relate to a product
  // dictionary (SheetInputs.dictKeySteps), compiled only for a binding that
  // declared no `key_steps` of its own.
  //
  // Kept apart from `keyTransformer` rather than written into the binding,
  // which is what used to happen: the project's steps and the recipe's default
  // then became indistinguishable, so a hit through each landed in one tier and
  // came out an ambiguity — the project's own statement outranked by nothing,
  // beaten by nothing, simply tied with a default nobody wrote.
  defaultKeyTransformer?: KeyTransformer;
};

// The one place a DictionaryBinding becomes a BindSource, so `key_steps` is
// compiled identically for every caller (loadBindSources below, and tests).
//
// `defaultSteps` is the recipe's, and applies ONLY where the binding declares
// nothing — the per-binding half of "the project's own key_steps always wins",
// enforced here by construction rather than by an assignment that erases which
// was which.
export function makeBindSource(
  binding: DictionaryBinding,
  doc: DictionaryDoc,
  defaultSteps?: readonly KeyTransformStep[]
): BindSource {
  if (binding.key_steps) return { binding, doc, keyTransformer: makeKeyTransformer({ steps: [...binding.key_steps] }) };
  if (defaultSteps && defaultSteps.length > 0) {
    return { binding, doc, defaultKeyTransformer: makeKeyTransformer({ steps: [...defaultSteps] }) };
  }
  return { binding, doc };
}

// The project's own `dict_key` declaration for this parameter:
//   undefined - not declared. The alias tier is skipped; matching proceeds
//               through exact/prefix/leaf/normalized as normal.
//   a string  - a true alias (SSO_SMTP_HOST -> smtpServer.host): tried FIRST,
//               verbatim, against every bound dictionary.
//   null      - an explicit severance: this project key is declared to bind
//               to NOTHING, overriding whatever exact/prefix/leaf/normalized
//               matching would otherwise have found. bindKey() returns
//               `undefined` immediately — a deliberate escape hatch for the
//               rare case where a key coincidentally collides with an
//               unrelated dictionary entry.
export type ProjectDictKey = string | null | undefined;

// Tier order. See the BindMethod doc comment above for why each tier exists
// and why this is the order. Exported so a caller building a per-method
// tally (assemble.ts's BindingReport) enumerates every possible method
// without re-deriving this list.
export const BIND_METHODS: readonly BindMethod[] = ["alias", "exact", "aka", "repeat", "prefix", "derived", "derived-default", "leaf", "normalized"];
const TIERS = BIND_METHODS;

// The three delimiter conventions this project's key spaces actually use:
// `_` (env vars, snake_case Ansible variables), `-` (kebab-case CLI flags),
// `.` (dotted structural paths / JSON-ish keys). Stripping exactly these
// three, and no others, is what lets `httpd_timeout` and `TimeOut` collide
// without also collapsing keys that only coincidentally share letters —
// nothing in this codebase's key spaces uses e.g. space or `:` as a
// segment delimiter, so widening the set would only invite accidental
// matches, not close a real gap.
const SEPARATORS = /[_\-.]/g;

export function normalizeKey(key: string): string {
  return key.replace(SEPARATORS, "").toLowerCase();
}

// The last identity-bearing segment of a dotted/bracketed structural path.
//
//   clients[clientId=x].attributes["saml.client.signature"] -> saml.client.signature
//   redirectUris[0]                                          -> redirectUris
//   server[main].listen[1]                                   -> listen
//
// The old leaf-directive normalizer (providers/dictionary.ts) found this with
// `lastIndexOf(".")` on the whole string, then stripped a trailing
// `[...]`. That breaks on the first example above: the dots inside the
// quoted attribute key are not segment separators, so a naive last-dot split
// returns `signature"]` garbage.
//
// structural.ts's parseSteps() already tokenizes exactly this grammar for
// YAML/JSON path resolution, bracket by bracket, and reusing it here happens
// to solve the problem outright: `foo["bar.baz"]` parses as TWO key steps
// (`foo`, then `bar.baz` — a quoted-bracket access is another key access,
// same as `foo.bar.baz` would be), while `foo[0]` and `foo[x=y]` parse as
// ONE key step (`foo`) plus an index/filter modifier that carries no
// identity of its own. So the leaf is: the value of the LAST `key` step,
// walking back over any trailing `index`/`filter` steps. A label that
// parseSteps' grammar does not recognize at all (a bare `[main]`, neither a
// digit index nor an `=` filter nor a quoted key) is simply skipped by its
// scanner, which is also the right outcome here — it carries no identity
// beyond "which container", and dropping it still leaves the real leaf
// (`listen`) as the last key step.
// What a row is matched against a dictionary BY.
//
// A container row's key is an address segment, and the tiers below read those
// with `parseSteps` — right for a row key, which is what they were written for,
// and wrong for a container's: a quoted bracket parses as a map key, so
// `Directory["/var/www"]` yields the argument rather than the directive, and a
// logrotate pattern contains the step separator, so it splits mid-path. Neither
// fails loudly. Both would bind a block to whatever entry happens to carry that
// name (tests/container-key-binding.test.ts records exactly what each shape
// does today).
//
// So a container is matched by its NOUN, which carries no address syntax at
// all — `leaf` and `repeat` return undefined when their candidate equals the
// key, so the dangerous tiers go inert by construction rather than by anyone
// remembering to skip them.
//
// Derived HERE and nowhere else. There are two doors into binding — the
// assembler's single pass, and enrich's own for the `import -f` path — and two
// copies of this rule would eventually disagree about which rows are containers.
export function bindableKey(key: string, container?: { name?: string }): string | undefined {
  // A block the grammar gives no keyword has nothing to match a dictionary by —
  // its address is a deployment path, and matching by that is how a container
  // binds to an unrelated entry. Undefined means "do not bind", which is the
  // honest answer and not a failure.
  if (container) return container.name;
  return key;
}

export function leafKey(key: string): string {
  const steps = parseSteps(key);
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === "key") return step.key;
  }
  return key;
}

// The verbatim candidate for a single (non-normalized) tier, or undefined if
// that tier does not apply to this key/binding at all (no dict_key declared,
// key_prefix does not match, or the leaf is identical to the raw key).
function candidateForMethod(
  // "aka" is absent on purpose: it is a lookup INTO the dictionary (an entry
  // claims the key), not a candidate derived FROM the key, so it has nothing
  // to return here and nothing to contribute to the normalized tier either —
  // a product's own second spelling is already exact.
  method: "alias" | "exact" | "repeat" | "prefix" | "derived" | "derived-default" | "leaf",
  key: string,
  dictKey: ProjectDictKey,
  source: BindSource
): string | undefined {
  const binding = source.binding;
  switch (method) {
    case "alias":
      return typeof dictKey === "string" ? dictKey : undefined;
    case "exact":
      return key;
    case "repeat": {
      // A repeated directive's index is bookkeeping, not identity: a unit with
      // two `Environment=` lines has two rows, and the product documents ONE
      // `Environment`. Every parser here indexes repeats the same way
      // (`Service.ExecStartPre[1]`, `postrotate[1]`), so one rule covers them
      // all — and it is deliberately not the `leaf` tier, which would ALSO
      // discard the section and hand `Service.Environment[0]` the answer for a
      // bare `Environment` in some other section.
      const stripped = key.replace(/\[\d+\]$/, "");
      return stripped !== key ? stripped : undefined;
    }
    case "prefix":
      return binding.key_prefix && key.startsWith(binding.key_prefix) ? key.slice(binding.key_prefix.length) : undefined;
    case "derived": {
      // undefined when no rewrite is declared, when a "drop" step did not
      // match, and when the rewrite is the identity — the last so a declared
      // transform that happens to leave a key alone does not restate the
      // `exact` tier under a different name in the report.
      const derived = source.keyTransformer?.apply(key);
      return derived !== undefined && derived !== key ? derived : undefined;
    }
    case "derived-default": {
      const derived = source.defaultKeyTransformer?.apply(key);
      return derived !== undefined && derived !== key ? derived : undefined;
    }
    case "leaf": {
      const leaf = leafKey(key);
      return leaf !== key ? leaf : undefined;
    }
  }
}

// Every verbatim candidate (alias/exact/prefix/leaf), normalized and
// deduplicated, for the normalized tier.
function normalizedCandidates(key: string, dictKey: ProjectDictKey, source: BindSource): string[] {
  // The recipe's default is in here too: without it, a rewrite the recipe
  // supplied would silently lose the normalized fallback that the same rewrite
  // had while it was being written into the binding.
  const raw = (["alias", "exact", "prefix", "derived", "derived-default", "leaf"] as const)
    .map((m) => candidateForMethod(m, key, dictKey, source))
    .filter((v): v is string => v !== undefined);
  return [...new Set(raw.map(normalizeKey))];
}

// normalized dict key -> every original dict key that normalizes to it.
// More than one entry in a bucket is itself a same-tier collision (two real
// dictionary entries that happen to normalize the same way) and is reported
// as ambiguous exactly like a cross-binding collision — see bindKey().
// alias -> every dictionary key that claims it. More than one is a document
// contradicting itself and is reported as an ambiguity exactly like a
// cross-binding collision — see bindKey().
const akaIndexes = new WeakMap<DictionaryDoc, Map<string, string[]>>();

function akaIndex(doc: DictionaryDoc): Map<string, string[]> {
  const cached = akaIndexes.get(doc);
  if (cached) return cached;
  const index = new Map<string, string[]>();
  for (const [dictKey, entry] of Object.entries(doc.parameters)) {
    for (const alias of entry.aliases ?? []) {
      const bucket = index.get(alias);
      if (bucket) bucket.push(dictKey);
      else index.set(alias, [dictKey]);
    }
  }
  akaIndexes.set(doc, index);
  return index;
}

function normalizedIndex(doc: DictionaryDoc): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const dictKey of Object.keys(doc.parameters)) {
    const n = normalizeKey(dictKey);
    const bucket = index.get(n);
    if (bucket) bucket.push(dictKey);
    else index.set(n, [dictKey]);
  }
  return index;
}

type Hit = { source: BindSource; dictKeyHit: string };

// Hits that resolve to the literal same entry (same product+version+dictKey)
// are not a real ambiguity — they're the same answer reached two ways (e.g.
// a dictionary appearing twice in `sources`, or two normalized candidates
// both landing on one entry). Collapse before judging tier-uniqueness.
function dedupeHits(hits: Hit[]): Hit[] {
  const seen = new Map<string, Hit>();
  for (const hit of hits) {
    const id = `${hit.source.binding.product}@${hit.source.binding.version}:${hit.dictKeyHit}`;
    if (!seen.has(id)) seen.set(id, hit);
  }
  return [...seen.values()];
}

function ambiguousError(key: string, method: BindMethod, hits: Hit[]): BindError {
  const matches = hits.map((h) => ({
    product: h.source.binding.product,
    version: h.source.binding.version,
    dictKey: h.dictKeyHit,
  }));
  const list = matches.map((m) => `${m.product}@${m.version}:${m.dictKey}`).join(", ");
  return {
    kind: "ambiguous",
    method,
    key,
    matches,
    message: `ambiguous ${method} match for "${key}": ${list}`,
  };
}

// Resolve one project parameter key against every declared dictionary
// binding. Tries each tier in TIERS order; within a tier, evaluates EVERY
// source (a project can bind more than one product dictionary — see
// aws-ec2/sheet.yml's keycloak + httpd bindings). A tier with exactly one
// hit (after deduping identical answers, see dedupeHits) resolves the whole
// call. A tier with more than one DISTINCT hit is an ambiguity error —
// never a silent first-source-wins pick. A tier with zero hits falls
// through to the next tier. No tier matching anything returns undefined
// (not an error: most parameters simply have no dictionary counterpart).
export function bindKey(key: string, dictKey: ProjectDictKey, sources: readonly BindSource[]): Binding | undefined | BindError {
  if (dictKey === null) return undefined;

  for (const method of TIERS) {
    const hits: Hit[] = [];

    for (const source of sources) {
      if (method === "aka") {
        for (const dictKeyHit of akaIndex(source.doc).get(key) ?? []) {
          hits.push({ source, dictKeyHit });
        }
      } else if (method === "normalized") {
        const index = normalizedIndex(source.doc);
        for (const candidate of normalizedCandidates(key, dictKey, source)) {
          for (const dictKeyHit of index.get(candidate) ?? []) {
            hits.push({ source, dictKeyHit });
          }
        }
      } else {
        const candidate = candidateForMethod(method, key, dictKey, source);
        if (candidate !== undefined && Object.hasOwn(source.doc.parameters, candidate)) {
          hits.push({ source, dictKeyHit: candidate });
        }
      }
    }

    if (hits.length === 0) continue;

    const unique = dedupeHits(hits);
    if (unique.length === 1) {
      const { source, dictKeyHit } = unique[0];
      return {
        product: source.binding.product,
        version: source.binding.version,
        dictKey: dictKeyHit,
        entry: source.doc.parameters[dictKeyHit],
        method,
        docProvenance: source.doc.provenance,
        defaultsFrom: source.doc.defaults_from,
      };
    }
    return ambiguousError(key, method, unique);
  }

  return undefined;
}

// ---- Loading -----------------------------------------------------------------
//
// bindKey() above is pure (no fs access): it resolves against already-loaded
// BindSources. Turning a project's declared `dictionaries:` bindings into
// those BindSources means reading `<product>@<version>.yml` off disk, which
// every caller needs done the SAME way — this is that one I/O loader, shared
// by assemble.ts (once per build, all sheets) and enrich.ts's standalone bind
// pass (the `import -f` + `--project` path, which never goes through
// assembleSheets and so has no BindingReport handed to it).
export function loadBindSources(
  dictionaries: readonly DictionaryBinding[],
  metadataDirs: readonly string[],
  readFile: (path: string) => string | null,
  // The recipe's own dictKeySteps, applied to whichever bindings declared none
  // — see makeBindSource.
  defaultSteps?: readonly KeyTransformStep[]
): BindSource[] {
  return dictionaries.map((binding) => {
    const found = findDictionary(binding.product, binding.version, [...metadataDirs], readFile);
    const doc = found && resolveVariantDefaults(found, binding.variant, `bind: ${binding.product}@${binding.version}`);
    if (!doc) {
      throw new Error(
        `bind: dictionary not found: ${binding.product}@${binding.version} ` +
          `(searched: ${metadataDirs.length > 0 ? metadataDirs.join(", ") : "no metadata dirs configured"})`
      );
    }
    return makeBindSource(binding, doc, defaultSteps);
  });
}
