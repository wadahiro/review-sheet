// Declarative key transform: renames (and optionally filters) an extracted
// entry's key via a chain of regex/case steps, applied at EXTRACTION time —
// before the entry ever reaches assembleSheets.
//
// Why this has to live here and not in AssembleHooks.keyFor (assemble.ts):
// a hook only sees a parameter AFTER its extracted key has already resolved
// an identity and (for a nested/repeated structure) already collided with its
// siblings in an ExtractedMap. hcl's `variable "x" { default = ... }` block
// emits one Entry per scalar attribute, ALL with `Entry.key === "default"` /
// `"description"` / `"type"` — indistinguishable without the full address,
// which lives only in `Entry.source.path` (`variable.x.default`). By the time
// a hook could rename `"default"`, four different variables' entries have
// already overwritten each other under that one leaf key. Likewise ECS's
// `environment[name=X].value` — every array element's Entry.key is the same
// leaf ("value"). The fix has to run at extraction, against source.path, one
// entry at a time, before merging into a base/overlay map — see
// layered.ts/ansible.ts, the two callers.
//
// A "drop" step is deliberately opt-in (default "keep"): this project's
// worst failure mode is a row vanishing with no trace (see keyglob.ts's same
// stance on include/exclude), so silently discarding an entry requires the
// author to say so explicitly, and a "drop" step that never once matched is
// reported back to the caller to warn about — the single most likely way a
// hand-written pattern quietly empties a sheet.

// A regex step is a plain JS String.replace(pattern, replace) — it only
// rewrites the MATCHED substring, leaving anything outside the match
// untouched. That is exactly right for a normalization step meant to touch
// part of an already-short key (`^KC_` -> "", a global `_` -> `-`), but a
// step meant to EXTRACT an identity out of a longer structural path (hcl's
// `variable.<name>.default`, an array element's `...[name=X].value`) must
// anchor front-to-back (`^...$`) so the match consumes the whole string —
// otherwise the unmatched prefix/suffix survives concatenated onto the
// replacement instead of being discarded. See tests/keytransform.test.ts for
// a worked example of both.
export type KeyTransformStep =
  | { pattern: string; replace: string; flags?: string; on_no_match?: "drop" | "keep" }
  | { lowercase: true }
  | { uppercase: true };

export type KeyTransform = {
  // Where the untransformed key comes from: the extracted leaf key (default,
  // matches every recipe's historical behaviour) or the full structural
  // address (Entry.source.path, falling back to the leaf key when the format
  // has none — e.g. a flat tfvars file, where they are identical anyway).
  from?: "key" | "path";
  steps: KeyTransformStep[];
};

export type KeyTransformer = {
  // The transformed key, or undefined if a "drop" step's pattern did not
  // match — the entry is not a reviewable value under this transform and
  // should be left out of the sheet entirely.
  apply: (rawKey: string) => string | undefined;
  // "drop" patterns that never matched ANY key passed to apply(), across the
  // whole call sequence. Mirrors keyglob.ts's KeySelector.unmatchedPatterns —
  // report these to the user instead of letting a sheet quietly come up short.
  unmatchedDropPatterns: () => string[];
};

export function selectKeySource(from: KeyTransform["from"], key: string, path: string | undefined): string {
  return from === "path" ? (path ?? key) : key;
}

export function makeKeyTransformer(transform: KeyTransform): KeyTransformer {
  const tracked = transform.steps.map((step) => ({
    step,
    // Only a "drop" pattern step needs tracking; everything else starts
    // "used" so it never shows up in unmatchedDropPatterns().
    used: !("pattern" in step) || step.on_no_match !== "drop",
  }));

  return {
    apply(rawKey: string): string | undefined {
      let key: string | undefined = rawKey;
      for (const t of tracked) {
        if (key === undefined) break;
        const s = t.step;
        if ("lowercase" in s) {
          key = key.toLowerCase();
        } else if ("uppercase" in s) {
          key = key.toUpperCase();
        } else {
          // Two separate RegExp instances (not one reused across test/replace):
          // a global-flagged regex is stateful (lastIndex) across calls, and
          // reusing one here would make matches depend on call order.
          if (new RegExp(s.pattern, s.flags).test(key)) {
            t.used = true;
            key = key.replace(new RegExp(s.pattern, s.flags), s.replace);
          } else if (s.on_no_match === "drop") {
            key = undefined;
          }
          // on_no_match "keep" (default): leave the key unchanged and move on.
        }
      }
      return key;
    },
    unmatchedDropPatterns(): string[] {
      return tracked.filter((t) => !t.used).map((t) => ("pattern" in t.step ? t.step.pattern : "")).filter(Boolean);
    },
  };
}

// ajv JSON Schema fragment for KeyTransform, shared by every recipe that
// accepts one (layered, ansible) so the declarative surface looks identical
// everywhere it appears.
export const keyTransformSchema = {
  type: "object",
  required: ["steps"],
  properties: {
    from: { enum: ["key", "path"] },
    steps: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        oneOf: [
          {
            required: ["pattern", "replace"],
            properties: {
              pattern: { type: "string" },
              replace: { type: "string" },
              flags: { type: "string" },
              on_no_match: { enum: ["drop", "keep"] },
            },
            additionalProperties: false,
          },
          { required: ["lowercase"], properties: { lowercase: { const: true } }, additionalProperties: false },
          { required: ["uppercase"], properties: { uppercase: { const: true } }, additionalProperties: false },
        ],
      },
    },
  },
  additionalProperties: false,
};
