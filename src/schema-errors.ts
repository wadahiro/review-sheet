// "Did you mean" hints, and the ajv error rendering built on them.
//
// A LEAF: it imports nothing from this package, so any module may use it
// without creating a cycle. That is the whole reason it exists — three modules
// had grown their own copy of the same Levenshtein, each carrying a comment
// explaining which cycle it was avoiding (assemble.ts imports findDictionary
// from providers/dictionary.ts, so dictionary.ts could not import back; spec.ts
// reached up into assemble.ts for it). A leaf is what those comments were
// describing the absence of.
//
// `src/extract.ts` deliberately keeps its own: its threshold is `length / 3`
// rather than `length / 4`, so folding it in here would change which
// suggestions it makes. That is a behaviour decision for the extraction layer,
// not duplication to clean up.
import type { ErrorObject } from "ajv";

function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

// Tight on purpose: a wrong suggestion is worse than none, so a candidate has
// to be within a quarter of the key's length (and at least 2) to be offered.
export function suggestNearest(key: string, candidates: Iterable<string>): string | undefined {
  const threshold = Math.max(2, Math.floor(key.length / 4));
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(key, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= threshold ? best : undefined;
}

// Requires the validating Ajv to be built with `verbose: true`: an
// `additionalProperties` error only carries `parentSchema` — the schema that
// rejected the field, and therefore the list of names it DOES accept — when
// verbose is on. That list is what makes the hint possible without every throw
// site hand-maintaining its own copy of "what fields does this object take".
export function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((e) => {
      if (e.keyword === "additionalProperties") {
        const bad = (e.params as { additionalProperty: string }).additionalProperty;
        const candidates = Object.keys((e.parentSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {});
        const hint = suggestNearest(bad, candidates);
        return `${e.instancePath || "/"}: must NOT have additional property "${bad}"` + (hint ? ` — did you mean "${hint}"?` : "");
      }
      return `${e.instancePath || "/"}: ${e.message}`;
    })
    .join("\n");
}
