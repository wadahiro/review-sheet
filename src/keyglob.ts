// Glob selection over extracted keys, shared by the recipes that need to review
// only part of what a file yields (`snapshot`'s machine-generated artifacts,
// `ansible`'s multi-role group_vars). One implementation so `include`/`exclude`
// means the same thing wherever a spec writes it.

// `*` matches within one segment, `**` crosses segment boundaries. Everything
// else is literal (`.`, `[`, `]` included, so `Tags[0].Value` and `kc_db_url`
// can both be written as-is).
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^.]*";
      }
      continue;
    }
    re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export type KeySelector = {
  select: (key: string) => boolean;
  // Patterns that never matched any key the selector was asked about. A filter
  // that selects nothing is the failure mode this whole area keeps producing —
  // rows vanish and a shorter sheet looks exactly like a correct one — so the
  // caller is expected to report these rather than let them pass.
  unmatchedPatterns: () => string[];
};

// An EMPTY list is refused rather than read as "no filter". `makeKeySelector`
// starts from `included = inc.length === 0`, so an empty `include:` selects
// EVERYTHING — the exact opposite of what somebody writing it means, and
// silently: a role's whole variable file arrives as rows of a sheet that asked
// for none of it. "Take nothing from this source" is said by removing the
// source (`defaults:`/`overlays:`/`static_files:` are each optional), not by
// naming no patterns, and there is deliberately no never-matching-pattern
// convention to reach for instead.
export function makeKeySelector(include: string[], exclude: string[]): KeySelector {
  const compiled = [...include, ...exclude].map((pattern) => ({ pattern, re: globToRegExp(pattern), used: false }));
  const inc = compiled.slice(0, include.length);
  const exc = compiled.slice(include.length);

  return {
    select: (key: string): boolean => {
      // Record every pattern that matches, whichever way the verdict goes: an
      // exclude pattern that matched is doing its job even though it removes the key.
      let included = inc.length === 0;
      for (const p of inc) if (p.re.test(key)) { p.used = true; included = true; }
      if (!included) return false;
      let excluded = false;
      for (const p of exc) if (p.re.test(key)) { p.used = true; excluded = true; }
      return !excluded;
    },
    unmatchedPatterns: (): string[] => compiled.filter((p) => !p.used).map((p) => p.pattern),
  };
}
