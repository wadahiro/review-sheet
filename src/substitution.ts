// Declarative reference substitution: classifies each entry a static file
// yields against a project-declared regex ("$(env:X)", "${X}", "%{X}", ...)
// and decides whether it names a reference into the sheet's own base/overlay
// layers — merging it into the row the reference points at when it safely
// can, and always recording the wiring as a checked `ref` site rather than
// leaving it as prose in sheet.yml. The five-row classification below is
// the whole specification; this module implements exactly that, nothing more.
//
// Why a regex, not a blessed list of named syntaxes: `$(env:X)` is one tool's
// convention today; `${X}`/`%{X}`/`@X@` are somebody else's tomorrow, and none
// of them needs a code change here — only a pattern the caller validates via
// `compileSubstitution` and this module proves matched something real. The
// one machine-checked constraint is "exactly one capturing group" (that
// capture IS the layer key being referenced) — see `compileSubstitution`.
//
// Independence: this module deliberately does NOT import from assemble.ts or
// depend on any type it does not yet export (assemble.ts/types.ts are being
// extended by concurrent work — SourceLocation.ref and SheetInputs.referenceSites).
// `EmbeddedEntry`/`LayerEntry`/`OverlayLayer`/`KeyMapEntry` below mirror
// assemble.ts's own shapes structurally (value/source, boundKey/variable, ...)
// so a caller (the layered recipe) can pass its real assemble.ts objects
// through unchanged — TypeScript's structural typing makes that free — without
// this module ever importing assemble.ts. `SourceLocation` itself IS imported
// from types.ts (a stable, already-shipped type); only `ref` is not yet a
// field on it, so `ReferenceSourceLocation` adds it locally via intersection,
// which stays correct once `ref?: string` lands on the real type too.
//
// Pure: no fs, no console — every finding (a merge, a warning, a tally) is
// returned to the caller, exactly like keyglob.ts/keytransform.ts. Matching a
// rule against nothing is reported, never silent — same stance those two
// modules take for `unmatchedPatterns`/`unmatchedDropPatterns`:
//   - a `substitution.pattern` that matches no value anywhere in the file:
//     `tally.matchedNothing` + a warning.
//   - a whole-value reference whose captured key resolves in NO layer (the
//     variable is likely pipeline-supplied, or the reference/env-var drifted
//     apart): kept embedded, warned per site, counted in `tally.dangling`.
//   - the SAME dangling condition inside a composed value (one piece of the
//     substring references a key nothing defines): warned per piece too,
//     counted separately in `tally.danglingComposed` — see the row 4 note
//     below for why this is a warning and not a shape decision.
//   - a whole-value reference that backs more than one site for the same
//     variable: merged (no site is dropped — see below), but WITHOUT a
//     keyMap entry, and warned naming the variable and every site it drives
//     — the "no single product key can honestly claim this row" rule ansible.ts
//     already applies to `{{ var }}` backing more than one directive
//     (entryKeysByVariable there; the same shape here, converged deliberately).
//
// The five-row classification, by what each embedded entry's
// value looks like after the file's own key transform + include/exclude
// selector have already run (i.e. exactly the entries that would become
// embedded rows today):
//   1. No match at all             -> untouched (still embedded).
//   2. Whole value = one reference, key resolves, backs exactly one site
//                                   -> MERGED: keyMap entry + one ref site.
//   3. Whole value = one reference, key resolves, backs SEVERAL sites
//                                   -> MERGED, no keyMap, warned, all sites
//                                      recorded (no site lost — an N-row
//                                      cluster carrying only the literal
//                                      string "$(env:X)" is strictly less
//                                      informative than N verified ref sites).
//   4. Composed (reference is a substring, not the whole value)
//                                   -> NOT merged (the composed literal is a
//                                      genuinely distinct reviewable thing).
//                                      When a piece's captured key resolves,
//                                      the site becomes a checked ref on the
//                                      VARIABLE's own row (one summary
//                                      warning per call lists every entry
//                                      left embedded this way, not one per
//                                      site, since the row's SHAPE didn't
//                                      change). When a piece's captured key
//                                      resolves in NO layer, that piece warns
//                                      individually and is counted in
//                                      `tally.danglingComposed` — see below.
//   5. Whole value = one reference, key resolves in NO layer ("dangling")
//                                   -> NOT merged, warned per site (never
//                                      drop the row — the variable may
//                                      legitimately come from the deploy
//                                      pipeline's process environment).
//
// A composed piece whose captured key resolves nowhere still warns, exactly
// like row 5, even though the entry itself stays embedded either way. The
// warning is not a statement about the row's SHAPE (which is genuinely
// unaffected — it was always going to stay embedded) but about a fact worth
// telling someone: this reference points at nothing. That fact is equally
// true and equally actionable whether it sits alone as the whole value or
// stitched into a URL — a typo'd `https://$(env:SSO_SAML_HSOT)/x` ships an
// unsubstituted reference at deploy time either way, which is exactly the
// class of mistake a review sheet exists to catch. Row 5 already accepts the
// "the variable may be pipeline-supplied" noise risk and warns anyway; that
// same risk cannot justify silence three rows up just because the container
// happens to be composed rather than whole-value. Counted separately from
// `tally.dangling` (whole-value only) — "the row stayed embedded because its
// own reference dangles" and "the row stayed embedded because it is composed,
// AND one of its pieces dangles" are different findings, and a caller may
// reasonably want to act on them differently (e.g. treat the former as
// blocking and the latter as a lint warning, or vice versa).

import type { SourceLocation } from "./types.js";

// Mirrors assemble.ts's `ExtractedEntry` minus its `origin` field (this
// module never needs it: origin is assemble.ts's own bookkeeping for where a
// row sits in the base layer, decided after merging, not before it).
export type LayerEntry = { value: string; source: SourceLocation };

// Mirrors assemble.ts's `ValueLayer`'s overlay arm.
export type OverlayLayer = { instance: string; entries: ReadonlyMap<string, LayerEntry> };

// Mirrors assemble.ts's `EmbeddedEntry` exactly.
export type EmbeddedEntry = { key: string; value: string; source: SourceLocation };

// Mirrors assemble.ts's `KeyMapEntry` exactly.
export type KeyMapEntry = { boundKey: string; variable: string };

// A source location that marks a REFERENCE site rather than a value site —
// `ref` is the literal reference text (e.g. "$(env:SSO_SESSION_IDLE_TIMEOUT)")
// expected to appear (by containment) at this location; never a write target.
// See types.ts's `SourceLocation.ref` doc once T1 lands — this is the same
// contract, expressed locally so this module has no dependency on that field
// existing yet.
export type ReferenceSourceLocation = SourceLocation & { ref: string };

// Every reference site this module found for one variable — the shape
// assemble.ts's future `SheetInputs.referenceSites` entry carries verbatim.
export type ReferenceSite = { variable: string; sites: ReferenceSourceLocation[] };

export type SubstitutionTally = {
  // Embedded rows removed by a whole-value merge (rows 2 + 3 combined — a
  // multi-backer merge counts every site it removed, not one per variable).
  merged: number;
  // Distinct embedded entries left in place that gained at least one composed
  // ref site (row 4). Counts ENTRIES, not sites: one composed value can
  // reference more than one variable.
  composed: number;
  // Whole-value sites whose captured key resolved in no layer (row 5).
  dangling: number;
  // Composed PIECES whose captured key resolved in no layer (row 4's
  // dangling corner) — kept apart from `dangling` on purpose, see the module
  // doc: a dangling whole-value site and a dangling piece of an otherwise-
  // fine composed value are different findings.
  danglingComposed: number;
  // The declared pattern matched no value anywhere among the entries this
  // call was given.
  matchedNothing: boolean;
};

export type CompiledSubstitution = { pattern: string };

export type BindReferencesInput = {
  embedded: EmbeddedEntry[];
  baseMap: ReadonlyMap<string, LayerEntry>;
  overlayLayers: OverlayLayer[];
  compiled: CompiledSubstitution;
};

export type BindReferencesResult = {
  // Whole-value-merged entries removed; every other entry (literal, composed,
  // dangling) kept, in its original order.
  embedded: EmbeddedEntry[];
  keyMap: KeyMapEntry[];
  referenceSites: ReferenceSite[];
  warnings: string[];
  tally: SubstitutionTally;
};

// Counts a pattern's capturing groups without hand-parsing group syntax
// (nesting, escaped parens, `(?:...)` non-capturing groups, named groups all
// need to be told apart correctly, and a hand-rolled parser is exactly the
// kind of thing that quietly miscounts on someone's real pattern). The
// standard trick: append `|` so the regex gets an always-matching empty
// alternative, then `exec("")` against it always succeeds — and the length of
// its result array (one slot per capturing group, `undefined` for a group
// that did not participate in the winning alternative) is the group count.
function countCapturingGroups(pattern: string): number {
  const probe = new RegExp(`${pattern}|`);
  const result = probe.exec("");
  // Cannot actually be null (the empty alternative always matches), but
  // TypeScript has no way to know that from the regex text.
  return result === null ? 0 : result.length - 1;
}

// Validates a `substitution.pattern` field: exactly one capturing group,
// which is the layer key the whole design hangs off (see module doc). Zero
// groups means nothing to bind to; two or more means an ambiguous reference
// (which one names the layer key?) — both are hard errors, naming the count
// found rather than just "wrong", so a project author can tell at a glance
// whether they forgot parens or wrote one capture group too many.
export function compileSubstitution(pattern: string): CompiledSubstitution {
  let count: number;
  try {
    count = countCapturingGroups(pattern);
  } catch (e) {
    throw new Error(`substitution: invalid pattern "${pattern}": ${(e as Error).message}`);
  }
  if (count !== 1) {
    throw new Error(
      `substitution: pattern must have exactly one capturing group naming the referenced layer key, found ${count}: "${pattern}"`
    );
  }
  return { pattern };
}

type CapturedMatch = { text: string; variable: string };

// Every match of `compiled` in `value`, keeping only matches whose (single,
// validated) capturing group actually participated — a pathological pattern
// with an optional group (`(x)?`) could otherwise match text with no key to
// bind to, which is meaningless for this module's purpose and treated the
// same as not matching at all.
//
// A fresh RegExp per call, "g" flag added HERE rather than stored on
// CompiledSubstitution: a global-flagged regex is stateful (lastIndex) across
// calls, and reusing one instance across entries would make matches depend on
// call order — same discipline keytransform.ts documents for its own
// pattern/replace steps.
function capturedMatches(compiled: CompiledSubstitution, value: string): CapturedMatch[] {
  const out: CapturedMatch[] = [];
  for (const m of value.matchAll(new RegExp(compiled.pattern, "g"))) {
    const variable = m[1];
    if (variable === undefined) continue;
    out.push({ text: m[0], variable });
  }
  return out;
}

function resolvesInLayers(variable: string, baseMap: ReadonlyMap<string, LayerEntry>, overlayLayers: OverlayLayer[]): boolean {
  return baseMap.has(variable) || overlayLayers.some((l) => l.entries.has(variable));
}

type WholeValueHit = { entry: EmbeddedEntry; variable: string; matchText: string };

// Classifies every entry in `input.embedded` against `input.compiled` and
// returns the merge result: which embedded rows survive, which keyMap
// entries + reference sites the merge produced, and every warning a rule
// that matched nothing (or matched something with nowhere to go) earned.
// See the module doc's five-row table — this function IS that table.
export function bindReferences(input: BindReferencesInput): BindReferencesResult {
  const { embedded, baseMap, overlayLayers, compiled } = input;

  const keptEmbedded: EmbeddedEntry[] = [];
  const wholeValueHits: WholeValueHit[] = [];
  const composedByVariable = new Map<string, ReferenceSourceLocation[]>();
  const composedEntryKeys = new Set<string>();
  const warnings: string[] = [];
  let anyMatch = false;
  let danglingCount = 0;
  let danglingComposedCount = 0;

  for (const entry of embedded) {
    const matches = capturedMatches(compiled, entry.value);
    if (matches.length === 0) {
      keptEmbedded.push(entry);
      continue;
    }
    anyMatch = true;
    const trimmed = entry.value.trim();

    if (matches.length === 1 && matches[0].text === trimmed) {
      // Whole-value reference (table rows 2/3/5) — the entry's ENTIRE value
      // (trimmed) is the one reference expression, so extraction has already
      // stripped any format quoting around it.
      const { variable, text } = matches[0];
      if (resolvesInLayers(variable, baseMap, overlayLayers)) {
        wholeValueHits.push({ entry, variable, matchText: text });
      } else {
        // Row 5: dangling. Never drop the row — the variable may legitimately
        // come from the deploy pipeline's process environment rather than
        // any file this build reads.
        danglingCount++;
        warnings.push(
          `substitution: dangling reference "${text}" at "${entry.key}" — "${variable}" is not defined in the base layer or any overlay`
        );
        keptEmbedded.push(entry);
      }
      continue;
    }

    // Row 4: composed. The literal stays embedded exactly as today — it is a
    // genuinely distinct reviewable thing (e.g. a URL built from the var),
    // not a duplicate of the variable's own row. Only the wiring becomes a
    // checked ref site, attached to each resolved variable's OWN row. A piece
    // that resolves nowhere warns exactly like row 5 (see module doc) —
    // "the row didn't change shape" is not the same claim as "this piece's
    // reference is real".
    for (const m of matches) {
      if (!resolvesInLayers(m.variable, baseMap, overlayLayers)) {
        danglingComposedCount++;
        warnings.push(
          `substitution: dangling reference (composed) "${m.text}" at "${entry.key}" — "${m.variable}" is not defined in the base layer or any overlay`
        );
        continue;
      }
      const site: ReferenceSourceLocation = { ...entry.source, ref: m.text, anchor: m.text };
      const list = composedByVariable.get(m.variable);
      if (list) list.push(site);
      else composedByVariable.set(m.variable, [site]);
      composedEntryKeys.add(entry.key);
    }
    keptEmbedded.push(entry);
  }

  // Group whole-value hits by variable BEFORE deciding merge shape — a
  // variable's one-backer-vs-several verdict can only be made once every site
  // referencing it is known, same two-pass shape as ansible.ts's
  // entryKeysByVariable/bound passes.
  const hitsByVariable = new Map<string, WholeValueHit[]>();
  for (const hit of wholeValueHits) {
    const list = hitsByVariable.get(hit.variable);
    if (list) list.push(hit);
    else hitsByVariable.set(hit.variable, [hit]);
  }

  const keyMap: KeyMapEntry[] = [];
  const referenceSitesMap = new Map<string, ReferenceSourceLocation[]>();
  const addSite = (variable: string, site: ReferenceSourceLocation): void => {
    const list = referenceSitesMap.get(variable);
    if (list) list.push(site);
    else referenceSitesMap.set(variable, [site]);
  };

  let mergedCount = 0;
  for (const [variable, hits] of hitsByVariable) {
    mergedCount += hits.length;
    if (hits.length === 1) {
      // Row 2: single backer — the row earns the product key, the variable
      // surfaces via the existing keyMap -> under_key mechanism.
      const { entry, matchText } = hits[0];
      keyMap.push({ boundKey: entry.key, variable });
      addSite(variable, { ...entry.source, ref: matchText, anchor: matchText });
    } else {
      // Row 3: several backers — no single product key can honestly claim
      // the row without misrepresenting the others (same rule ansible.ts
      // applies to a {{ var }} driving more than one directive), so it merges
      // WITHOUT a keyMap entry and keeps the variable's own name. Every site
      // is still recorded — an N-row cluster whose entire content is the
      // identical reference string carries strictly less information than N
      // verified ref sites on one row.
      const keys = hits.map((h) => h.entry.key);
      warnings.push(
        `substitution: "${variable}" backs ${hits.length} whole-value sites (not 1:1): ${keys.join(", ")} -> merged without a product key, filed as "${variable}"`
      );
      for (const { entry, matchText } of hits) addSite(variable, { ...entry.source, ref: matchText, anchor: matchText });
    }
  }

  for (const [variable, sites] of composedByVariable) {
    for (const site of sites) addSite(variable, site);
  }

  if (composedEntryKeys.size > 0) {
    warnings.push(`substitution: ${composedEntryKeys.size} composed site(s) left embedded: ${[...composedEntryKeys].join(", ")}`);
  }

  const matchedNothing = !anyMatch;
  if (matchedNothing) {
    warnings.push("substitution: pattern matched no value");
  }

  const referenceSites: ReferenceSite[] = [...referenceSitesMap].map(([variable, sites]) => ({ variable, sites }));

  return {
    embedded: keptEmbedded,
    keyMap,
    referenceSites,
    warnings,
    tally: {
      merged: mergedCount,
      composed: composedEntryKeys.size,
      dangling: danglingCount,
      danglingComposed: danglingComposedCount,
      matchedNothing,
    },
  };
}
