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

// One spelling of presence for the whole model — see types.ts. Re-exported
// here because a value-keyed row is where a membership row is born, and the
// reader of this file should not have to know it lives elsewhere.
export { PRESENCE_VALUE } from "./types.js";

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
  | { pattern: string; replace: string; flags?: string; on_no_match?: "drop" | "keep"; must_match?: boolean }
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
  // The members this sheet reviews, NAMED — the ordered form of `only:`, for a
  // list whose elements cannot be selected by their literal id.
  //
  // A SAML client's id is its entity id, which is the SP's own URL: the old
  // server's file spells a literal production host and the new one an
  // environment reference, so no literal selects both, and a comparison keyed
  // on the raw id shows one client as two one-sided rows. `match` recognises
  // the element; `id` is what it is called on the sheet, on both sides.
  //
  // Ordered, first match wins: `https://*/reporting/saml/metadata` has to be
  // tried before `https://*/saml/metadata`, which would otherwise claim it. A
  // member that matches nothing is an error, so a misordering fails loudly
  // rather than quietly reviewing one client twice.
  //
  // Mutually exclusive with `only:` — both are the same selection, and two
  // selections would have to agree.
  members?: SplitMember[];
  // What the member identity BECOMES.
  //
  //   component  (default) the member is a component, as it always was.
  //   prefix     the member id prefixes every one of its keys
  //              (`poc-oidc.publicClient`) and the component slot is left to
  //              the source's own `component:`. For a sheet whose component
  //              axis is already spent — comparing two RELEASES of a product
  //              whose file holds several clients — this is the only way the
  //              members can be told apart at all.
  //   none       the member identity is dropped: one member, and naming it
  //              anywhere would add a level that says nothing.
  as?: "component" | "prefix" | "none";
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
  // matches every recipe's historical behaviour), the full structural address
  // (Entry.source.path, falling back to the leaf key when the format has none
  // — e.g. a flat tfvars file, where they are identical anyway), or the
  // entry's own VALUE.
  //
  // `value` is for a list whose elements ARE their identity: a firewall's
  // permitted services, a set of enabled modules, any `[a, b, c]` where the
  // strings are the settings rather than values OF a setting. Addressed by
  // position such a list keys as `services[0]`, which names nothing a product
  // knows and makes removing one member read as a value CHANGE of the row that
  // held it — where the honest reading is that one member left the set and
  // another joined. Keyed by value, membership changes read as membership
  // changes, and each row binds to the dictionary entry describing that member.
  //
  // The scalar counterpart of `split` below, which does the same job for a list
  // of OBJECTS carrying an identity field. Two entries reaching the same key is
  // already an error (see the in-file collision check), so a list with a
  // repeated element fails loudly rather than merging two rows into one.
  //
  // Such a row is about MEMBERSHIP: its value is presence, and the site holds
  // the member's own text (SourceLocation.member). Keeping the element's text
  // as the value instead would state one fact in two slots — the key and the
  // value would read the same string, and the value column would say nothing.
  from?: "key" | "path" | "value";
  // Apply this transform only to entries UNDER a structural path; everything
  // else in the same file keeps the key it would have had.
  //
  // `from`/`steps` describe a source as a whole, which is right when one file
  // is one kind of thing. A role's `defaults/main.yml` is not: it holds two
  // dozen scalars that want their own names and one list whose elements ARE
  // their names, and there is no single answer for the file. Declaring where a
  // transform applies keeps the two apart without splitting a project's file to
  // suit this tool.
  //
  // A prefix over the address grammar, matched at a segment boundary: `services`
  // covers `services[0]` and `services.a` and never `services_extra`. An `at:`
  // that matches nothing in the file is an error — a transform applying to
  // nothing is the silent-no-op this codebase refuses everywhere else.
  at?: string;
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

// Whether a transform declaring `at:` covers this entry. Segment-aware, so a
// prefix cannot half-match a longer sibling name.
export function transformCovers(at: string | undefined, key: string, path: string | undefined): boolean {
  if (at === undefined) return true;
  const addr = path ?? key;
  return addr === at || addr.startsWith(`${at}.`) || addr.startsWith(`${at}[`);
}

export function selectKeySource(
  from: KeyTransform["from"],
  key: string,
  path: string | undefined,
  value?: string
): string {
  if (from === "value") return value ?? key;
  return from === "path" ? (path ?? key) : key;
}


// A member of a split list: what it is called here, and how to recognise it.
export type SplitMember = {
  id: string;
  // A glob over the element's own id, where `*` matches any run of characters
  // other than the address's closing bracket. Omitted = the `id` itself,
  // matched literally, which is the ordinary case.
  //
  // Deliberately NOT keyglob's dialect (keyglob.ts), whose `*` does not cross
  // `.` — every hostname has dots, so every match here would silently be none.
  match?: string;
};

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
// A member's `match` glob as a regex fragment: `*` crosses anything except the
// bracket that ends the address.
export function memberPattern(m: SplitMember): string {
  return m.match === undefined ? esc(m.id) : esc(m.match).replace(/\\\*/g, "[^\\]]*");
}

export function splitKeySteps(split: StructuralSplit, membersOnly = false): KeyTransformStep[] {
  const member = `^${esc(split.at)}\\[${esc(split.by)}=("?)`;
  // Named members, each rewritten to its own id. Kept (not dropped) per step,
  // because a member the NEXT step claims has to survive this one; what no
  // step claimed is dropped below, which is the selection `only:` also makes.
  if (split.members) {
    const each = (m: SplitMember): string => `${member}${memberPattern(m)}\\1\\]\\.(.+)$`;
    if (split.as === "prefix") {
      // One rewrite per member, because each puts a DIFFERENT id in front of
      // the key. Kept (not dropped) per step, since a member the next step
      // claims has to survive this one.
      const steps: KeyTransformStep[] = split.members.map((m) => ({
        pattern: each(m),
        replace: `${m.id}.$2`,
        on_no_match: "keep" as const,
        // A named member that recognised no element is a selection reviewing
        // less than it claims — the failure `only:` already reports.
        must_match: true,
      }));
      // Still addressed as a member of the list = a member this sheet did not
      // name, which is the same selection `only:` makes.
      steps.push({ drop: member });
      if (membersOnly) {
        // The source IS the list, so anything that never became a member is
        // another sheet's subject. Recognisable here precisely because each
        // member now wears its own id.
        const ids = split.members.map((m) => esc(m.id)).join("|");
        steps.push({ pattern: `^((?:${ids})\\..+)$`, replace: "$1", on_no_match: "drop" });
      }
      return steps;
    }
    // `component` / `none`: the member id does not enter the key, so every
    // member rewrites the same way and ONE step does it — which is also what
    // keeps `members_only` expressible, since a row that reaches that step
    // without matching is by definition not a member of the list.
    //
    // The probes above it exist only to record that each named member matched
    // something. They rewrite the key to itself, so they change nothing.
    const probes: KeyTransformStep[] = split.members.map((m) => ({
      pattern: each(m),
      replace: "$&",
      on_no_match: "keep" as const,
      must_match: true,
    }));
    const alternation = split.members.map((m) => `(?:${memberPattern(m)})`).join("|");
    return [
      ...probes,
      { pattern: `${member}(?:${alternation})\\1\\]\\.(.+)$`, replace: "$2", on_no_match: membersOnly ? "drop" : "keep" },
      { drop: member },
    ];
  }
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
  // Under `prefix` the member travels in the KEY and the component slot belongs
  // to the source (its release); under `none` there is no member identity to
  // record at all. Deriving a component here would overwrite the first and
  // invent the second.
  if (split.as === "prefix" || split.as === "none") return [];
  if (split.members) {
    // Each member named as itself, so an element whose id differs between two
    // files still lands in one component.
    const named: KeyTransformStep[] = split.members.map((m) => ({
      pattern: `^${esc(split.at)}\\[${esc(split.by)}=("?)${memberPattern(m)}\\1\\]\\..+$`,
      replace: m.id,
      on_no_match: "keep" as const,
      must_match: true,
    }));
    named.push({ drop: `^${esc(split.at)}\\[` });
    return named;
  }
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
    // A "drop" step must match something, and so must one that says so —
    // `must_match` is how a KEEP step (one whose non-matching rows are another
    // step's business) still declares that it is meant to claim rows.
    used: !("pattern" in step) || (step.on_no_match !== "drop" && step.must_match !== true),
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
    from: { enum: ["key", "path", "value"] },
    at: { type: "string" },
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
