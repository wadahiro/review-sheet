// Jinja2 template support (an extraction aid for conversion scripts).
//
// A `.j2` template carries the *structure* of a config file, but its values are
// often `{{ variable }}` substitutions resolved from a separate variable file
// (Ansible defaults / group_vars). This module exposes the small, pure
// primitives the jinja2 parser uses to annotate extracted entries: the variable
// name behind a value, and which lines sit inside a conditional/loop block
// (whose line numbers are unstable once the template is rendered).

// Strip a trailing `.j2` so the base format can be detected from the remaining
// name (`keycloak.conf.j2` -> `keycloak.conf`).
export function baseFileName(file: string): string {
  return file.replace(/\.j2$/i, "");
}

// The first Jinja variable referenced by a value, when the value is a `{{ … }}`
// substitution. `{{ keycloak_hostname }}` and `{{ keycloak_hostname | default('') }}`
// both yield "keycloak_hostname". Returns undefined for a plain literal.
export function jinjaVariable(value: string): string | undefined {
  const m = value.match(/\{\{-?\s*([A-Za-z_][\w.]*)/);
  return m ? m[1] : undefined;
}

// Every variable a line references, in order. `jinjaVariable` answers "which
// variable IS this value"; this answers "which variables does this line
// mention", which is what a row keyed by the LINE needs.
export function jinjaVariables(text: string): string[] {
  return [...text.matchAll(/\{\{-?\s*([A-Za-z_][\w.]*)/g)].map((m) => m[1]);
}

// Substitute a line's `{{ var }}` references with the values they resolve to,
// leaving everything else — the literal text a template puts around them —
// exactly as written. This is what lets a row be the artifact's LINE rather
// than the variable inside it: `CustomLog "{{ httpd_access_log }}" proxied`
// becomes `CustomLog "/var/log/httpd/access_log" proxied`, and the trailing
// `proxied` stops being invisible.
//
// Deliberately NOT a Jinja2 implementation. It handles a bare variable and the
// one filter chain that is a pure string function; anything else — an
// expression, an unknown filter, a name nothing defines — is left as written
// and REPORTED. A partial engine that guessed would produce a value that looks
// rendered and is wrong, which is worse than admitting the line cannot be
// resolved. Callers show the unresolved list rather than the guess.
const PURE_FILTERS: Record<string, (s: string) => string> = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  trim: (s) => s.trim(),
};

// A quoted STRING LITERAL as the whole expression: `{{ 'text' }}`. Jinja emits
// the string, so rendering it is exact rather than a guess — the same standard
// the pure filters meet. Anchored on the quotes, not on the braces, because the
// literal a template most often writes is a doubled brace it wants to show
// LITERALLY (`{{ '{{ var }}' }}` in a comment explaining the templating), and a
// brace-anchored pattern stops at the inner `}}`.
const STRING_LITERAL = /\{\{-?\s*'((?:[^'\\]|\\.)*)'\s*-?\}\}|\{\{-?\s*"((?:[^"\\]|\\.)*)"\s*-?\}\}/g;

export function substituteJinja(
  text: string,
  lookup: (name: string) => string | undefined
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  // Literals are held as placeholders until the very end. Their OUTPUT can
  // contain braces — that is the whole point of writing one — and the sweep
  // below would then report the braces this function legitimately produced,
  // bouncing a line that rendered perfectly into "could not compute".
  const literals: string[] = [];
  const withLiterals = text.replace(STRING_LITERAL, (_m, single: string | undefined, double: string | undefined) => {
    literals.push(single ?? double ?? "");
    return `\u0000RsJlit${literals.length - 1}\u0000`;
  });
  const restoreLiterals = (v: string): string =>
    literals.length === 0 ? v : v.replace(/\u0000RsJlit(\d+)\u0000/g, (_m, i: string) => literals[Number(i)]);
  const out = withLiterals.replace(/\{\{-?\s*([A-Za-z_][\w.]*)((?:\s*\|\s*[a-z_]+)*)\s*-?\}\}/g, (whole, name: string, filters: string) => {
    const value = lookup(name);
    if (value === undefined) {
      unresolved.push(whole);
      return whole;
    }
    let s = value;
    for (const f of filters.split("|").map((x) => x.trim()).filter(Boolean)) {
      const fn = PURE_FILTERS[f];
      if (!fn) {
        unresolved.push(whole);
        return whole;
      }
      s = fn(s);
    }
    return s;
  });
  // Anything still in braces was never even a plain variable reference — an
  // expression, a concatenation, a conditional. Reported the same way.
  for (const m of out.match(/\{\{[\s\S]*?\}\}/g) ?? []) if (!unresolved.includes(m)) unresolved.push(m);
  return { text: restoreLiterals(out), unresolved: unresolved.map(restoreLiterals) };
}

// Mask Jinja2 syntax so a brace-structured base format (nginx/httpd/haproxy) does
// not mis-read `{{ … }}` / `{% … %}` as its own block braces. Expressions become
// reversible placeholders (alnum, no braces) so the extracted value can be
// restored to its original `{{ … }}` text and its templateVar derived; statements
// and comments are blanked in place (every newline kept, so line numbers — which
// the adapters rely on — are preserved). Line-based base formats round-trip
// unchanged (placeholder in, original out).
export function maskJinja(content: string): { masked: string; restore: (s: string) => string; mask: (s: string) => string } {
  const map = new Map<string, string>();
  let n = 0;
  // `{{ expr }}` (single line) -> placeholder. The trailing `q` delimits the index
  // so no token is a prefix of another.
  let masked = content.replace(/\{\{.*?\}\}/g, (m) => {
    const token = `RsJtmpl${n++}q`;
    map.set(token, m);
    return token;
  });
  // `{% stmt %}` / `{# comment #}` (possibly multi-line) -> blanks, newlines kept.
  masked = masked.replace(/\{%-?[\s\S]*?-?%\}|\{#[\s\S]*?#\}/g, (m) => m.replace(/[^\n]/g, " "));
  const restore = (s: string): string => {
    if (map.size === 0 || !s.includes("RsJtmpl")) return s;
    let out = s;
    for (const [token, original] of map) {
      if (out.includes(token)) out = out.split(token).join(original);
    }
    return out;
  };
  // The forward direction, for a string that came OUT of a previous mask/restore
  // round trip and has to go back in: a row's structural path is recorded
  // restored (it is the row's identity, and an internal token has no business
  // there), so locating that row in the template means masking the path again
  // to match the index the base parser builds from `masked`.
  const mask = (s: string): string => {
    if (map.size === 0 || !s.includes("{{")) return s;
    let out = s;
    for (const [token, original] of map) {
      if (out.includes(original)) out = out.split(original).join(token);
    }
    return out;
  };
  return { masked, restore, mask };
}

// What governs a line's PRESENCE in the rendered file, per 1-based line number.
//
// `conditionalLineSet` below answers "is this line conditional at all", which is
// enough to leave it out. This answers the next question — WHETHER it is there
// for a given set of variable values — so a row can exist for the instances
// that render it and not for the ones that do not, which is exactly what
// Pattern B already expresses for a row's value.
//
// Only ONE shape is understood: `{% if name %}` / `{% if not name %}` … `{%
// endif %}`, testing a bare variable's truthiness, with no `elif` and no
// `else`. Everything else — a comparison, `and`/`or`, a filter, a `for` loop,
// an `else` branch — is reported as unsupported and its lines are left out
// exactly as before. The stance is `substituteJinja`'s: support the plain shape
// and REPORT the rest, because a partial evaluator that guessed would put a
// line on the sheet that the deployed file does not have, which is worse than
// the line being absent and said so.
export type LineCondition =
  | { supported: true; tests: { variable: string; negated: boolean }[] }
  | { supported: false; expr: string };

const PLAIN_IF = /^\{%-?\s*(?:el)?if\s+(not\s+)?([A-Za-z_][\w]*)\s*-?%\}$/;

export function jinjaConditions(content: string): Map<number, LineCondition> {
  const lines = content.split("\n");
  const out = new Map<number, LineCondition>();
  // Each open block contributes either a test or the reason it cannot.
  const stack: LineCondition[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const tag = line.trim();
    const opensIf = /\{%-?\s*if\b/.test(line);
    const opensFor = /\{%-?\s*for\b/.test(line);
    const closes = /\{%-?\s*(endif|endfor)\b/.test(line);
    const branches = /\{%-?\s*(elif|else)\b/.test(line);

    if (closes) {
      stack.pop();
      continue;
    }
    if (branches) {
      // An `elif`/`else` is a second arm of the block already on the stack. Its
      // condition is the negation of everything before it, which this
      // deliberately does not compute — the whole block becomes unsupported
      // from here on, including the arm that opened it.
      stack[stack.length - 1] = { supported: false, expr: tag };
      continue;
    }
    if (opensFor) {
      stack.push({ supported: false, expr: tag });
      continue;
    }
    if (opensIf) {
      const m = PLAIN_IF.exec(tag);
      stack.push(
        m ? { supported: true, tests: [{ variable: m[2], negated: m[1] !== undefined }] } : { supported: false, expr: tag }
      );
      continue;
    }
    if (stack.length === 0) continue;
    const unsupported = stack.find((c) => !c.supported);
    out.set(
      i + 1,
      unsupported ?? {
        supported: true,
        // Nested plain ifs are an AND of their tests, which needs no extra
        // machinery: every one of them has to hold.
        tests: stack.flatMap((c) => (c.supported ? c.tests : [])),
      }
    );
  }
  return out;
}

// Jinja/Python truthiness, over the STRING an extractor hands back for a YAML
// scalar. `false`/`no`/`off` are here because Ansible's YAML spells a boolean
// that way and the extractor preserves what was written; a quoted `"false"`
// would be truthy in Jinja and is indistinguishable at this point, which is the
// one case this gets wrong and the reason a project should not lean on it.
const FALSY = new Set(["", "false", "no", "off", "0", "none", "null", "~", "[]", "{}"]);

export function truthyJinja(value: string | undefined): boolean {
  return value !== undefined && !FALSY.has(value.trim().toLowerCase());
}

// 1-based line numbers that sit strictly inside a `{% if %}` / `{% for %}` …
// `{% endif %}` / `{% endfor %}` block. Such lines may not exist (or may shift)
// after rendering, so the adapter flags them as conditional.
export function conditionalLineSet(content: string): Set<number> {
  const lines = content.split("\n");
  const out = new Set<number>();
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const open = /\{%-?\s*(if|for)\b/.test(lines[i]);
    const close = /\{%-?\s*(endif|endfor)\b/.test(lines[i]);
    if (close) depth = Math.max(0, depth - 1);
    if (depth > 0 && !open && !close) out.add(i + 1);
    if (open) depth++;
  }
  return out;
}
