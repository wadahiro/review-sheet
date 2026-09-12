// Two extractions of ONE product, merged into one dictionary.
//
// A product answers two different questions through two different channels, and
// an extraction almost always uses one of them:
//
//   the product itself   what a setting DEFAULTS to, and its type
//                        (`sshd -T`, `pg_settings`, `getsebool`, `kc.sh show-config`)
//   its documentation    what a setting MEANS, and how the product groups them
//                        (a man page, an admin console's message bundles)
//
// Measured across forty shipped dictionaries, the split is almost total: the
// ones read from the product carry defaults for 88-100% of their entries and
// describe 0-12%, the ones read from prose describe ~100% and carry defaults
// for 1-12%. `sshd` had every default and no description at all; `firewalld`
// the exact reverse. Nobody was missing the idea of merging — each extraction
// simply had one channel, and the other half was then written by hand, per
// project, in an overlay.
//
// So this is deliberately NOT the overlay merge. An overlay is a PROJECT
// annotating a dictionary and may only touch prose (see `parseOverlay`); this
// is one product's two readings of ITSELF, both authoritative, each for the
// fields its channel can actually see.
//
// Pure: it merges documents, it does not read or write them.

import type { DictionaryDoc, DictionaryParam } from "./providers/dictionary.js";
import { normalizeKey } from "./bind.js";

export type MergeReport = {
  // How many keys the two readings spelled differently for the same setting.
  // Not a curiosity: `sshd -T` reports `addressfamily` and sshd_config(5)
  // documents `AddressFamily`, so an exact-match merge of those two produced
  // 212 entries out of ~112 settings — two half-filled dictionaries side by
  // side, each looking plausible. Matched with the SAME normalization the
  // binder uses (bind.ts's `normalizeKey`), because a dictionary that
  // considered two spellings distinct while the binder considered them one
  // would be a dictionary the binder cannot read.
  matchedByNormalization: number;
  // Keys only one side had. Not an error — two channels legitimately enumerate
  // different sets (a man page documents a keyword the binary does not report,
  // a binary reports one the page forgot) — but never silent either, because
  // "the dictionary covers the product" is exactly the claim `coverage: full`
  // makes and a merge is where it stops being true.
  onlyInFirst: string[];
  onlyInSecond: string[];
  // Fields one side filled that the other left empty. The point of the merge.
  filled: Record<string, number>;
};

export class DictionaryMergeError extends Error {}

const isEmpty = (v: unknown): boolean =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// Same value written two ways is still the same value. Compared structurally
// because `description` is a LangText map and `options` an array.
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Merge `second` into `first`, field by field, FILL-ONLY.
 *
 * A field the first document already states is kept. A field it leaves empty is
 * taken from the second. A field BOTH state differently is an error naming the
 * key and the field: two readings of one product disagreeing about a default is
 * a fact somebody has to look at, and picking one silently is how a sheet ends
 * up asserting a default the product does not have.
 *
 * Every offending key is collected before throwing — a version bump that moves
 * several at once must not make the author fix-and-rerun to find the next.
 */
export function mergeDictionaries(
  first: DictionaryDoc,
  second: DictionaryDoc
): { doc: DictionaryDoc; report: MergeReport } {
  if (first.product !== second.product) {
    throw new DictionaryMergeError(
      `cannot merge ${second.product} into ${first.product}: these are two products, not two readings of one`
    );
  }
  if (first.version !== second.version) {
    throw new DictionaryMergeError(
      `cannot merge ${first.product}@${second.version} into ${first.product}@${first.version}: ` +
        `a dictionary is pinned to one build, and two builds' defaults are not interchangeable`
    );
  }

  const report: MergeReport = { onlyInFirst: [], onlyInSecond: [], filled: {}, matchedByNormalization: 0 };
  // The second reading's keys, reachable by the binder's own normalization.
  // A normalized form two of its keys share is left out rather than guessed
  // at — the same refusal bind.ts makes on an ambiguous match.
  const byNorm = new Map<string, string | null>();
  for (const k of Object.keys(second.parameters)) {
    const n = normalizeKey(k);
    byNorm.set(n, byNorm.has(n) ? null : k);
  }
  const ambiguous: string[] = [];
  // The FIRST document's spelling is the one that survives, so a caller decides
  // which channel names the settings by the order it passes them — the config
  // file's own spelling is what a reviewer reads, and only the caller knows
  // which reading has it.
  const takenFromSecond = new Set<string>();
  const out: Record<string, DictionaryParam> = {};
  const conflicts: string[] = [];

  for (const [key, a] of Object.entries(first.parameters)) {
    let b = second.parameters[key];
    if (b === undefined) {
      const alt = byNorm.get(normalizeKey(key));
      if (alt === null) {
        ambiguous.push(key);
      } else if (alt !== undefined) {
        b = second.parameters[alt];
        takenFromSecond.add(alt);
        report.matchedByNormalization++;
      }
    } else {
      takenFromSecond.add(key);
    }
    if (b === undefined) {
      report.onlyInFirst.push(key);
      out[key] = a;
      continue;
    }
    // Shallow-cloned only where there is something to add, so an entry neither
    // side supplements stays the object the first document parsed.
    let merged: DictionaryParam | undefined;
    for (const [field, bv] of Object.entries(b) as [keyof DictionaryParam, unknown][]) {
      if (isEmpty(bv)) continue;
      const av = a[field];
      if (isEmpty(av)) {
        merged ??= { ...a };
        (merged as Record<string, unknown>)[field] = bv;
        report.filled[field] = (report.filled[field] ?? 0) + 1;
      } else if (!same(av, bv)) {
        conflicts.push(`  ${key}.${String(field)}: ${JSON.stringify(av)} vs ${JSON.stringify(bv)}`);
      }
    }
    out[key] = merged ?? a;
  }
  for (const key of Object.keys(second.parameters)) {
    if (takenFromSecond.has(key)) continue;
    report.onlyInSecond.push(key);
    out[key] = second.parameters[key]!;
  }
  if (ambiguous.length > 0) {
    throw new DictionaryMergeError(
      `${first.product}@${first.version}: ${ambiguous.length} key(s) of the first reading match more than one key of the second ` +
        `once spelling is normalized away, so which entry supplements which is not decidable here: ${ambiguous.slice(0, 10).join(", ")}`
    );
  }

  if (conflicts.length > 0) {
    throw new DictionaryMergeError(
      `${first.product}@${first.version}: the two readings disagree about ${conflicts.length} field(s). ` +
        `One of them is wrong about this build — decide which before merging:\n${conflicts.slice(0, 20).join("\n")}` +
        (conflicts.length > 20 ? `\n  …and ${conflicts.length - 20} more` : "")
    );
  }

  // The document's own fields follow the same fill-only rule, except the two
  // that identify it (checked above) and `parameters` (merged). `coverage` is
  // deliberately NOT merged upward: whichever document claimed less about the
  // key space still claims it, because a merge adds entries and never proves
  // the union is complete.
  const doc: DictionaryDoc = {
    ...second,
    ...first,
    parameters: out,
  };
  // `coverage` is the FIRST reading's alone, never inherited from the second.
  // Spreading `first` over `second` is not enough — a `first` that makes no
  // coverage claim has no key to override with, so the second's would survive,
  // and a merge that ADDS entries has not proved the union covers the product.
  // (Caught by breaking the guard and watching nothing fail: the test that was
  // meant to pin this passed for the wrong reason, because `first` happened to
  // carry a claim of its own.)
  if (first.coverage === undefined) delete (doc as { coverage?: unknown }).coverage;
  else doc.coverage = first.coverage;
  return { doc, report };
}
