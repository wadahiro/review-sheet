// `import --interactive` (P8): when a strict metadata failure (see enrich.ts's
// ScaffoldableBuildError) names parameters fixable by editing sheet.yml —
// missing category, missing description — this resolves them at the terminal
// instead of only printing a paste-able scaffold, and writes the answers
// straight back into the project metadata file.
//
// Split in the same shape as apply.ts/verify.ts: a pure core plus injected
// I/O.
//   - runInteractiveSession: decides WHAT to ask and, from the answers, WHAT
//     the result should be. The only thing it touches outside its own
//     arguments is the injected `ask` callback — no fs, no real prompting, no
//     TTY concept at all, so a test drives it with a canned `ask` (a plain
//     queue of answers) and asserts both the exact sequence of questions
//     asked and the resulting ResolvedAnswer/skipped/newCategoriesBySheet.
//   - applyInteractiveAnswers: decides WHAT TO WRITE — a pure string ->
//     string transform (parseDocument + setIn + String(doc), same recipe as
//     structural.ts, verified to preserve leading/trailing comments) with NO
//     I/O of its own, so a test feeds it a real sheet.yml fixture (with
//     comments) and asserts the comments survive.
// cli.ts owns the only impure part: reading sheet.yml, prompting a real
// terminal (readline over stdin/stdout), and writing the result back.
//
// P9 adds two things to the category question, both purely in the pure core:
//   - Bulk apply: once a category is picked for one entry, offer to apply it
//     to every OTHER still-open entry that shares a structural identity
//     prefix (see deriveBulkPattern below) — the 15-clients-in-a-row / 20-
//     httpd-directives problem from the PoC. Always shown before it acts
//     (pattern, count, sample keys), always defaults to "no". Description is
//     NEVER bulk-applied — only category.
//   - Incremental search: typed (non-numeric) text at the category prompt
//     narrows the choices shown next instead of being flatly "invalid",
//     without disturbing the existing number-to-pick workflow at all.

import { parseDocument, isSeq, type YAMLSeq } from "yaml";
import type { ScaffoldEntry, ScaffoldShape } from "./enrich.js";
import type { Binding } from "./bind.js";

// ---- Questions -----------------------------------------------------------

export type InteractiveQuestion =
  | {
      kind: "category";
      sheet: string;
      key: string;
      choices: string[]; // the currently VISIBLE choices — narrowed by `query` when set, numbering (1..N) is always against THIS list
      query?: string; // the active search narrowing, if any (undefined = showing the full list)
      binding?: Binding;
      invalid?: string;
    }
  | { kind: "newCategoryName"; sheet: string; key: string; empty?: boolean }
  | { kind: "descriptionEn"; sheet: string; key: string; allowSkip: boolean }
  | { kind: "descriptionJa"; sheet: string; key: string }
  | {
      kind: "bulkApply";
      sheet: string;
      key: string; // the entry whose answer this offer follows
      pattern: string; // display form, e.g. "clients[clientId=poc-oidc].*"
      category: string; // the category just picked for `key`, offered to every match below
      matches: string[]; // every OTHER still-open key this pattern matches (never empty when this question is asked)
      expanded?: boolean; // true once the reader asked ("l") to see the full `matches` list rather than a sample
    };

export type ResolvedAnswer = {
  sheet: string;
  key: string;
  category?: string;
  descriptionEn?: string;
  descriptionJa?: string;
};

export type InteractiveOutcome = {
  resolved: ResolvedAnswer[];
  skipped: ScaffoldEntry[];
  // Category names newly created THIS session, per sheet, in creation order
  // — applyInteractiveAnswers appends these to that sheet's `categories:`
  // list (or creates it) rather than each resolved answer re-deriving
  // whether its own category was "new".
  newCategoriesBySheet: Record<string, string[]>;
  // How many of `resolved`'s categories came from accepting a bulk-apply
  // offer rather than their own individual question — purely informational,
  // for the CLI's post-write summary.
  bulkApplied: number;
};

// ---- Bulk apply: pattern derivation ----------------------------------------
//
// Conservative on purpose: a pattern is derived ONLY from a structural
// identity predicate (`[field=value]`, e.g. `clients[clientId=poc-oidc]` —
// the same syntax structural.ts's path parser uses), because that is the one
// place a review-sheet key already names a specific real-world entity.
// Everything textually after that predicate belongs to the same entity no
// matter how deeply nested (a client's protocolMappers are still that
// client's), so cutting at the FIRST such bracket and turning the rest into
// `.*` groups the whole entity correctly in one shot.
//
// A bare snake_case key (`httpd_keep_alive` vs `httpd_keep_alive_timeout`)
// carries no such marker — the only way to split it into "shared prefix" +
// "rest" is to guess a word boundary, and a wrong guess silently
// miscategorizes real rows across an unrelated boundary. So bare keys get NO
// pattern at all. Declining to propose one is the safe choice the task
// explicitly calls out, not a gap to fill in later — see interactive.test.ts
// for cases this deliberately does NOT propose anything for.
//
// A plain positional index (`redirectUris[0]`) is likewise never a split
// point: `[0]` names a slot, not an entity, so two different keys sharing
// `redirectUris[0]` could easily be unrelated once id_fields isn't in play.
const IDENTITY_PREDICATE_RE = /^(.*?\[\s*[\w.\-:/]+\s*=\s*[^\]]+?\s*\])(\.|$)/;

export function deriveBulkPattern(key: string): string | undefined {
  const m = key.match(IDENTITY_PREDICATE_RE);
  if (!m) return undefined;
  return `${m[1]}.*`;
}

// The literal prefix a derived pattern's trailing ".*" stands for. Matching
// (matchesBulkPattern below) is a plain `startsWith` against this — never a
// real glob/regex engine — so there is no wildcard-in-the-middle behavior to
// reason about; the ".*" is display sugar for "and everything under it".
export function bulkPatternPrefix(pattern: string): string {
  return pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
}

export function matchesBulkPattern(key: string, pattern: string): boolean {
  return key.startsWith(bulkPatternPrefix(pattern));
}

// ---- Incremental search -----------------------------------------------------
//
// Case-insensitive; prefix matches sort before other substring matches, so
// typing the start of a name surfaces it first even when a shorter name
// elsewhere also happens to contain the same text. Used only when the
// existing number-to-pick path (unchanged) doesn't apply — see the "category"
// branch in runInteractiveSession below — so a short list where every choice
// is still just picked by number never even calls this.
export function filterCategories(choices: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...choices];
  const starts: string[] = [];
  const contains: string[] = [];
  for (const c of choices) {
    const lower = c.toLowerCase();
    if (lower.startsWith(q)) starts.push(c);
    else if (lower.includes(q)) contains.push(c);
  }
  return [...starts, ...contains];
}

// Drives one question/answer cycle at a time via the injected `ask`. Only
// entries that can actually be resolved this way are visited — a `ScaffoldEntry`
// with `unused: true` (a project-metadata key no sheet ever produced) has
// nothing an interactive Q&A can fix (deleting it, or fixing a typo, is a
// sheet.yml edit no menu can guess), so the caller is expected to filter
// those out before calling this (or accept that they pass through untouched:
// this function still ignores them either way).
export async function runInteractiveSession(
  entries: ScaffoldEntry[],
  categoryChoicesBySheet: Record<string, string[]>,
  ask: (q: InteractiveQuestion) => Promise<string>
): Promise<InteractiveOutcome> {
  const addable = entries.filter((e) => !e.unused);

  // Per-sheet working copy: a category created for one entry must be
  // offered to the NEXT entry in the same sheet, without mutating the
  // caller's own map.
  const workingChoices: Record<string, string[]> = {};
  for (const [sheet, choices] of Object.entries(categoryChoicesBySheet)) {
    workingChoices[sheet] = [...choices];
  }
  const newCategoriesBySheet: Record<string, string[]> = {};
  const resolved: ResolvedAnswer[] = [];
  const skipped: ScaffoldEntry[] = [];
  let bulkApplied = 0;

  // Category pre-filled by an EARLIER entry's bulk-apply acceptance, keyed
  // by "sheet\0key" — consumed (below) the moment the loop reaches that
  // entry, so it is asked no category question at all, only a description
  // question if it needs one (description is never bulk-applied).
  const bulkCategory = new Map<string, string>();
  // Every entry already spoken for — resolved, skipped, or bulk-prefilled —
  // so it is never re-offered as a bulk-apply candidate for a later pattern.
  const claimed = new Set<string>();
  const idOf = (e: { sheet: string; key: string }) => `${e.sheet} ${e.key}`;

  for (const entry of addable) {
    const id = idOf(entry);
    const answer: ResolvedAnswer = { sheet: entry.sheet, key: entry.key };
    let entrySkipped = false;

    if (entry.needsCategory) {
      const prefilled = bulkCategory.get(id);
      if (prefilled !== undefined) {
        answer.category = prefilled;
      } else {
        const choices = workingChoices[entry.sheet] ?? (workingChoices[entry.sheet] = []);
        let category: string | undefined;
        let invalid: string | undefined;
        let query: string | undefined;
        let visible = [...choices];
        while (category === undefined && !entrySkipped) {
          // Snapshot `visible` — it's reassigned in place below (a search
          // query narrows it, "n" doesn't touch it), and a later question
          // must never retroactively rewrite what an earlier one recorded
          // itself as having asked.
          const raw = (
            await ask({ kind: "category", sheet: entry.sheet, key: entry.key, choices: [...visible], query, binding: entry.binding, invalid })
          ).trim();
          invalid = undefined;
          const lower = raw.toLowerCase();
          if (lower === "s") {
            entrySkipped = true;
          } else if (lower === "n") {
            let name = "";
            let empty = false;
            while (name.length === 0) {
              name = (await ask({ kind: "newCategoryName", sheet: entry.sheet, key: entry.key, empty })).trim();
              empty = true;
            }
            choices.push(name);
            (newCategoriesBySheet[entry.sheet] ?? (newCategoriesBySheet[entry.sheet] = [])).push(name);
            category = name;
          } else if (raw === "") {
            // Blank Enter clears an active search narrowing, back to the
            // full list; with no narrowing active this is unparseable, same
            // as before (re-ask, flagged).
            if (query !== undefined) {
              query = undefined;
              visible = [...choices];
            } else {
              invalid = raw;
            }
          } else {
            const idx = Number(raw);
            if (Number.isInteger(idx) && idx >= 1 && idx <= visible.length) {
              category = visible[idx - 1];
            } else {
              // Not a valid index into what's currently shown: treat it as
              // an incremental-search query against the FULL choice list
              // (retyping always restarts the search rather than compounding
              // it — a mis-narrowed query is one keystroke from a fresh one).
              // Only when it matches nothing does this fall back to
              // "invalid", exactly the pre-existing behavior for
              // unparseable input (an out-of-range digit behaves the same,
              // unchanged).
              const filtered = filterCategories(choices, raw);
              if (filtered.length > 0) {
                query = raw;
                visible = filtered;
              } else {
                invalid = raw;
                query = undefined;
                visible = [...choices];
              }
            }
          }
        }
        if (entrySkipped) {
          skipped.push(entry);
          claimed.add(id);
          continue;
        }
        answer.category = category;

        // Offer to bulk-apply this same category to every OTHER still-open
        // entry sharing a structural identity prefix with this key — see
        // deriveBulkPattern. Never for the description fields, and never
        // without presenting the pattern/count/sample first (constraint:
        // always show before applying, default "no").
        const pattern = deriveBulkPattern(entry.key);
        if (pattern !== undefined) {
          const candidates = addable.filter(
            (c) => c.sheet === entry.sheet && c.needsCategory && c.key !== entry.key && !claimed.has(idOf(c)) && matchesBulkPattern(c.key, pattern)
          );
          if (candidates.length > 0) {
            let expanded = false;
            for (;;) {
              const raw = (
                await ask({
                  kind: "bulkApply",
                  sheet: entry.sheet,
                  key: entry.key,
                  pattern,
                  category: category!,
                  matches: candidates.map((c) => c.key),
                  expanded,
                })
              )
                .trim()
                .toLowerCase();
              if (raw === "l" && !expanded) {
                expanded = true;
                continue;
              }
              if (raw === "y") {
                for (const c of candidates) {
                  bulkCategory.set(idOf(c), category!);
                  claimed.add(idOf(c));
                }
                bulkApplied += candidates.length;
              }
              // Anything else (blank, "n", stray text) — default is "no",
              // nothing pre-filled, candidates are asked individually when
              // the loop reaches them.
              break;
            }
          }
        }
      }
    }

    if (entry.needsDescription) {
      // A skip shortcut ("s") is only offered as the FIRST question asked
      // about an entry — once a category has already been picked for it
      // (above), the entry is committed and free text is taken literally
      // (an actual description that happens to be the single letter "s" is
      // far more plausible at that point than "I changed my mind").
      const allowSkip = !entry.needsCategory;
      const rawEn = (await ask({ kind: "descriptionEn", sheet: entry.sheet, key: entry.key, allowSkip })).trim();
      if (allowSkip && rawEn.toLowerCase() === "s") {
        skipped.push(entry);
        claimed.add(id);
        continue;
      }
      answer.descriptionEn = rawEn.length > 0 ? rawEn : "TODO";

      const rawJa = (await ask({ kind: "descriptionJa", sheet: entry.sheet, key: entry.key })).trim();
      answer.descriptionJa = rawJa.length > 0 ? rawJa : "TODO";
    }

    resolved.push(answer);
    claimed.add(id);
  }

  return { resolved, skipped, newCategoriesBySheet, bulkApplied };
}

// ---- Write-back ------------------------------------------------------------

// Applies a resolved interactive session to a sheet.yml's TEXT content,
// preserving every comment (leading, mid-line, trailing) — verified against
// both small fixtures (interactive.test.ts) and a real ~370-line project
// sheet.yml (see this task's manual demo): parseDocument + setIn +
// String(doc) never drops or moves a comment, anywhere in the file, even
// though (unlike structural.ts's scalar-only edits, which splice a single
// byte range) this re-serializes the whole document. The one real, purely
// cosmetic side effect is that a MAP whose sibling key this function adds to
// loses any manual column-alignment whitespace on its OTHER (untouched)
// keys — the writer doesn't preserve incidental inter-token spacing, only
// comments and values. `lineWidth: 0` below (also load-bearing) keeps that
// to exactly that map, instead of rewrapping unrelated long scalars
// elsewhere in the file.
//
// `content` may be "" (the project metadata file doesn't exist yet — see
// ScaffoldableBuildError.missingProjectPath) — a brand-new file is created
// from the answers alone.
export function applyInteractiveAnswers(
  content: string,
  shape: ScaffoldShape,
  resolved: ResolvedAnswer[],
  newCategoriesBySheet: Record<string, string[]>
): string {
  const doc = parseDocument(content);

  for (const [sheet, names] of Object.entries(newCategoriesBySheet)) {
    if (names.length === 0) continue;
    const path = shape === "sheets" ? ["sheets", sheet, "categories"] : ["categories"];
    const existing = doc.getIn(path, true);
    if (existing && isSeq(existing)) {
      for (const name of names) (existing as YAMLSeq).add(doc.createNode(name));
    } else {
      doc.setIn(path, names);
    }
  }

  for (const r of resolved) {
    const base = shape === "sheets" ? ["sheets", r.sheet, "params", r.key] : ["params", r.key];
    if (r.category !== undefined) doc.setIn([...base, "category"], r.category);
    if (r.descriptionEn !== undefined) doc.setIn([...base, "description", "en"], r.descriptionEn);
    if (r.descriptionJa !== undefined) doc.setIn([...base, "description", "ja"], r.descriptionJa);
  }

  // lineWidth: 0 disables the yaml library's default 80-column rewrapping —
  // without it, re-serializing the WHOLE document (not just the node(s) this
  // function touched) reflows every long single-line scalar elsewhere in the
  // file into a folded multi-line block, which is a much noisier diff than
  // the actual edit (confirmed against a real ~370-line project sheet.yml:
  // with this option, the diff is exactly the touched lines; without it,
  // dozens of untouched long descriptions get rewrapped too). Comments are
  // unaffected either way — this is purely about scalar line-wrapping.
  return doc.toString({ lineWidth: 0 });
}
