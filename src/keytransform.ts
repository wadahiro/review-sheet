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
  // Drop the entry when the pattern DOES match — the mirror of
  // `on_no_match: "drop"`, which drops when it does not. Needed to express
  // selection ("this sheet reviews these two of the list, not the other two")
  // without a negative lookahead: rewrite the wanted ones first, then drop
  // whatever is still addressed as a member of the list.
  | { drop: string; flags?: string }
  | { lowercase: true }
  | { uppercase: true };

// A structural split: "this source holds a LIST of things, each addressed by an
// identity field; each one is a component, and a row's key is what follows".
//
// It exists because that sentence was otherwise written as a pair of regexes
// over the tool's OWN address grammar — `^clients\[clientId=("?)(.+?)\1\]\.(.+)$`
// — once per list, in every project. The quoting alternation there is a project
// reverse-engineering `structural.ts`'s output format; getting it wrong fails
// silently, by matching nothing. Declaring the split lets the tool write those
// patterns, since it is the one that decided how an address is spelled.
export type StructuralSplit = {
  // The field holding the list (`clients` in `clients[clientId=x].protocol`).
  at: string;
  // The field each element is addressed BY (`clientId`).
  by: string;
  // Which elements this sheet reviews. Omitted = all of them. A listed value
  // that no element has is an error, like every other declaration here that
  // matches nothing.
  only?: string[];
  // A list nested INSIDE each member — a Keycloak LDAP store's mappers being
  // the case this exists for. Two things make it more than another split:
  //
  //   - the component becomes `<member> / <nested member>`, because a mapper
  //     belongs to the store it was created with and is meaningless beside
  //     another store's;
  //   - `key_from` names a SIBLING field of the nested member whose VALUE
  //     prefixes every one of its keys. That is what makes the rows bindable
  //     at all: a mapper's meaning comes from its TYPE (`providerId`), 16
  //     property names are declared by more than one type and 8 of those
  //     differ between them, and the type appears nowhere in the address.
  //
  // Reading a sibling field is not a new channel — `by:` already reads one to
  // identify the member. This reads a second field of the same object.
  nest?: NestedSplit;
};

export type NestedSplit = {
  at: string;
  by: string;
  // The sibling field whose value prefixes the nested member's keys.
  key_from: string;
  // The category the nested members are filed UNDER, inside their member's own
  // component. A mapper is part of the store, not a sibling of it: a reviewer
  // asking what corp-ldap does means the connection AND what it makes of a
  // directory entry, so the outline reads `corp-ldap > Mappers > username`
  // rather than seventeen components in a row.
  under: string;
  only?: string[];
};

export type KeyTransform = {
  // Where the untransformed key comes from: the extracted leaf key (default,
  // matches every recipe's historical behaviour) or the full structural
  // address (Entry.source.path, falling back to the leaf key when the format
  // has none — e.g. a flat tfvars file, where they are identical anyway).
  from?: "key" | "path";
  // Optional: `{ from: path }` alone means "key by the structural address,
  // verbatim", which used to have to be spelled as a no-op `^(.*)$ -> $1`.
  steps?: KeyTransformStep[];
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

// Regex-escape a literal for embedding in a generated pattern.
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The steps a `split:` stands for. Written here, next to the transformer that
// runs them, because the whole point is that the tool owns the address grammar
// these patterns have to match: `structural.ts` emits `[field=value]` with the
// value quoted only when it has to be, so the quote is optional and captured.
//
// Two steps, in this order: rewrite the members this sheet reviews down to the
// remainder of their address, then drop whatever is still addressed as a member
// (that is the `only:` selection). A row that is not a member of the list at
// all — a plain variable from an env file on the same sheet — matches neither
// and passes through untouched.
export function splitKeySteps(split: StructuralSplit, membersOnly = false): KeyTransformStep[] {
  const member = `^${esc(split.at)}\\[${esc(split.by)}=("?)`;
  const values = split.only ? `(?:${split.only.map(esc).join("|")})` : `(?:.+?)`;
  const steps: KeyTransformStep[] = [
    // "keep" by default: a source can hold rows that are not members of the
    // list — the env file feeding them, on the same sheet — and those must
    // survive. A source that IS the list says so with `members_only`, and then
    // anything else in it is noise to drop.
    { pattern: `${member}${values}\\1\\]\\.(.+)$`, replace: "$2", on_no_match: membersOnly ? "drop" : "keep" },
  ];
  if (split.only) steps.push({ drop: `${member}` });
  if (split.nest) {
    const n = split.nest;
    const nestedValues = n.only ? `(?:${n.only.map(esc).join("|")})` : `(?:.+?)`;
    // Runs on what the outer step left. "keep" because a member has rows of
    // its own as well as nested ones, and those must survive untouched.
    steps.push({
      pattern: `^${esc(n.at)}\\[${esc(n.by)}=("?)${nestedValues}\\1\\]\\.(.+)$`,
      replace: "$2",
      on_no_match: "keep",
    });
  }
  return steps;
}

// The path of the nested member an entry belongs to, or undefined. Used to look
// up the `key_from` value that prefixes its keys — a lookup, not a rewrite,
// because a string transform cannot read another entry's value.
// The nested member's own id — `username` for a mapper — which is what the
// category under `nest.under` is named after.
export function nestedMemberId(split: StructuralSplit, path: string | undefined): string | undefined {
  if (!split.nest || path === undefined) return undefined;
  const n = split.nest;
  const m = new RegExp(`${esc(n.at)}\\[${esc(n.by)}=("?)(.+?)\\1\\]\\.`).exec(path);
  return m?.[2];
}

export function nestedMemberPath(split: StructuralSplit, path: string | undefined): string | undefined {
  if (!split.nest || path === undefined) return undefined;
  const n = split.nest;
  const m = new RegExp(`^(.*${esc(n.at)}\\[${esc(n.by)}=("?).+?\\2\\])\\.`).exec(path);
  return m?.[1];
}

// The identity itself, for the component side of the same declaration.
export function splitComponentSteps(split: StructuralSplit, more = false): KeyTransformStep[] {
  const values = split.only ? `(?:${split.only.map(esc).join("|")})` : `(?:.+?)`;
  const steps: KeyTransformStep[] = [];
  steps.push({
    pattern: `^${esc(split.at)}\\[${esc(split.by)}=("?)(${values})\\1\\]\\..+$`,
    replace: "$2",
    // A row that is not a member belongs to no component — unless the sheet
    // has further rules for it, in which case it has to survive to reach
    // them. (A sheet reading the list AND the env variables that feed it
    // files those variables under the member they belong to.)
    //
    // With a nest, this must KEEP instead: the step before it has already
    // turned a nested row into `<member> / <nested>`, and dropping whatever
    // this one fails to match would throw that away. Steps run in sequence,
    // so the second one sees the first one's output.
    on_no_match: more ? "keep" : "drop",
  });
  // What neither pattern claimed is still a structural path, and a path is not
  // a component id. Only with a nest, where the step above had to stop
  // dropping: without one the behaviour is exactly what it was.
  return steps;
}

export function makeKeyTransformer(transform: KeyTransform): KeyTransformer {
  const tracked = (transform.steps ?? []).map((step) => ({
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
        } else if ("drop" in s) {
          if (new RegExp(s.drop, s.flags).test(key)) key = undefined;
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
          {
            required: ["drop"],
            properties: { drop: { type: "string" }, flags: { type: "string" } },
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
