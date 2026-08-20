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

// ---------------------------------------------------------------------------
// The expression a `{{ … }}` may hold.
//
// Still deliberately NOT Jinja2. What is understood is a NAMED grammar, and
// everything outside it is left as written and reported:
//
//   expr     := concat ( 'if' cond 'else' concat )?     Jinja's conditional
//   cond     := 'not'? name                             truthiness, one name
//   concat   := filtered ( '~' filtered )*              string concatenation
//   filtered := ( name | string ) ( '|' purefilter )*
//
// It grew from one line no evaluator could touch — `{{ '--endpoint-url ' ~ url
// if url else '' }}`, which is the whole local/AWS difference of a secrets
// fetch — where the alternative was a preview showing the template where it
// promises the deployed file.
//
// The rule that makes it safe: a name this sheet cannot resolve fails the WHOLE
// expression, including one in a branch that is not taken. Jinja treats an
// undefined name as falsy, and adopting that would render "the sheet was never
// pointed at this variable" identically to "the variable is unset" — a
// mis-wired sheet looking exactly like a correct one. `truthyJinja` is the same
// function `{% if %}` uses, so a template's two ways of asking the same
// question cannot disagree here.

type Tok = { kind: "name" | "str" | "op"; text: string };

function lex(src: string): Tok[] | undefined {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          v += src[j + 1];
          j += 2;
          continue;
        }
        v += src[j];
        j++;
      }
      if (j >= src.length) return undefined; // unterminated
      out.push({ kind: "str", text: v });
      i = j + 1;
      continue;
    }
    if (c === "~" || c === "|") {
      out.push({ kind: "op", text: c });
      i++;
      continue;
    }
    const name = /^[A-Za-z_][\w.]*/.exec(src.slice(i));
    if (!name) return undefined;
    out.push({ kind: "name", text: name[0] });
    i += name[0].length;
  }
  return out;
}

// undefined = "not in the grammar, or a name that does not resolve" — one
// answer for both, because they mean the same thing to a caller: this line was
// not computed, and is reported as written.
function evalExpr(src: string, lookup: (name: string) => string | undefined): string | undefined {
  const toks = lex(src);
  if (toks === undefined || toks.length === 0) return undefined;
  let at = 0;
  const peek = (): Tok | undefined => toks[at];
  const isWord = (w: string): boolean => peek()?.kind === "name" && peek()!.text === w;

  const filtered = (): string | undefined => {
    const t = toks[at++];
    if (t === undefined) return undefined;
    let v: string | undefined;
    if (t.kind === "str") v = t.text;
    else if (t.kind === "name") {
      // A keyword is never a value. A variable actually named `if` could not be
      // told apart from the operator, and the operator is what a template means
      // every time.
      if (t.text === "if" || t.text === "else" || t.text === "not") return undefined;
      v = lookup(t.text);
    } else return undefined;
    if (v === undefined) return undefined;
    while (peek()?.kind === "op" && peek()!.text === "|") {
      at++;
      const f = toks[at++];
      if (f?.kind !== "name" || PURE_FILTERS[f.text] === undefined) return undefined;
      v = PURE_FILTERS[f.text](v);
    }
    return v;
  };
  const concat = (): string | undefined => {
    let v = filtered();
    if (v === undefined) return undefined;
    while (peek()?.kind === "op" && peek()!.text === "~") {
      at++;
      const rhs = filtered();
      if (rhs === undefined) return undefined;
      v += rhs;
    }
    return v;
  };

  const first = concat();
  if (first === undefined) return undefined;
  if (at === toks.length) return first;
  if (!isWord("if")) return undefined;
  at++;
  let negated = false;
  if (isWord("not")) {
    negated = true;
    at++;
  }
  const nameTok = toks[at++];
  if (nameTok?.kind !== "name") return undefined;
  // Read BEFORE a branch is chosen: an unreadable name is a fact about this
  // sheet, not about the template, and must not decide anything.
  const condValue = lookup(nameTok.text);
  if (condValue === undefined) return undefined;
  if (!isWord("else")) return undefined;
  at++;
  const other = concat();
  if (other === undefined || at !== toks.length) return undefined;
  return truthyJinja(condValue) !== negated ? first : other;
}

// Every `{{ … }}` region of a text, as offsets. Scanned rather than matched,
// because a quoted string may contain `}}`: the literal a template most often
// writes is a doubled brace it wants shown LITERALLY (`{{ '{{ var }}' }}` in a
// comment explaining the templating), and a non-greedy regex stops inside it.
function expressionSpans(text: string): { start: number; end: number; inner: string }[] {
  const out: { start: number; end: number; inner: string }[] = [];
  let i = 0;
  while (i < text.length - 1) {
    if (text[i] !== "{" || text[i + 1] !== "{") {
      i++;
      continue;
    }
    let j = i + 2;
    let quote: string | undefined;
    let closed = -1;
    while (j < text.length) {
      const c = text[j];
      if (quote !== undefined) {
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === quote) quote = undefined;
        j++;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        j++;
        continue;
      }
      if (c === "}" && text[j + 1] === "}") {
        closed = j + 2;
        break;
      }
      j++;
    }
    if (closed === -1) {
      i += 2;
      continue;
    }
    out.push({ start: i, end: closed, inner: text.slice(i + 2, closed - 2).replace(/^-|-$/g, "") });
    i = closed;
  }
  return out;
}

export function substituteJinja(
  text: string,
  lookup: (name: string) => string | undefined
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  // Every rendered value is held as a placeholder until the very end. Its
  // OUTPUT can contain braces — that is the whole point of a template writing
  // one — and a later sweep would then report the very braces this function
  // legitimately produced, bouncing a line that rendered perfectly into "could
  // not compute".
  const outputs: string[] = [];
  let out = "";
  let at = 0;
  for (const span of expressionSpans(text)) {
    out += text.slice(at, span.start);
    const whole = text.slice(span.start, span.end);
    const value = evalExpr(span.inner, lookup);
    if (value === undefined) {
      unresolved.push(whole);
      out += whole;
    } else {
      outputs.push(value);
      out += `\u0000RsJout${outputs.length - 1}\u0000`;
    }
    at = span.end;
  }
  out += text.slice(at);
  const restore = (v: string): string =>
    outputs.length === 0 ? v : v.replace(/\u0000RsJout(\d+)\u0000/g, (_m, i: string) => outputs[Number(i)]);
  return { text: restore(out), unresolved };
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

// What a line inside a `{% for %}` repeats over, per 1-based line number.
//
// A loop is the one Jinja shape that turns ONE template line into several lines
// of the deployed file — `{% for s in ntp %}server {{ s }} iburst{% endfor %}`
// is three `server` lines on a host with three sources. Left unevaluated, the
// sheet shows the variable instead of the lines, and the settings sit apart
// from the rest of the file they are written in.
//
// Only ONE shape is understood, on the same stance as the conditions above:
// `{% for NAME in LIST %}` over a bare variable, not nested inside another
// loop, with no filter, no tuple unpacking, no `loop.` reference and no
// `{% else %}`. Anything else is reported and its lines stay out, because a
// guess would put lines on the sheet that the deployed file does not have.
export type LineLoop =
  | { supported: true; variable: string; list: string }
  | { supported: false; expr: string };

const PLAIN_FOR = /^\{%-?\s*for\s+([A-Za-z_][\w]*)\s+in\s+([A-Za-z_][\w]*)\s*-?%\}$/;

// A `{% for %}` block as a RANGE — the tag line, its `{% endfor %}`, and what
// it repeats over. `jinjaLoops` above answers "which loop is this line inside",
// which is enough to decide a line's fate one line at a time; this answers
// "where does the body start and stop", which is what rendering it needs.
//
// The difference is visible in the output: a body of several lines is repeated
// AS A BLOCK by Jinja — element one's whole block, then element two's — and a
// renderer that only knew the per-line answer emitted every copy of line 1,
// then every copy of line 2. A one-line body (the case this started with) hides
// that completely.
//
// Only blocks whose own tag is the plain shape are returned, and a block
// containing another `{% for %}` is not: `jinjaLoops` already refuses a nested
// loop, and the two must agree about what is supported.
export type LoopBlock = { start: number; end: number; variable: string; list: string };

export function jinjaLoopBlocks(content: string): LoopBlock[] {
  const lines = content.split("\n");
  const out: LoopBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PLAIN_FOR.exec(lines[i].trim());
    if (!m) continue;
    let depth = 1;
    let nested = false;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const tag = lines[j].trim();
      if (/\{%-?\s*for\b/.test(tag)) {
        depth++;
        nested = true;
        continue;
      }
      if (/\{%-?\s*endfor\b/.test(tag)) {
        depth--;
        if (depth === 0) {
          end = j + 1;
          break;
        }
      }
    }
    if (end === -1 || nested) continue;
    out.push({ start: i + 1, end, variable: m[1], list: m[2] });
    i = end - 1;
  }
  return out;
}

export function jinjaLoops(content: string): Map<number, LineLoop> {
  const lines = content.split("\n");
  const out = new Map<number, LineLoop>();
  const stack: LineLoop[] = [];
  for (let i = 0; i < lines.length; i++) {
    const tag = lines[i].trim();
    if (/\{%-?\s*endfor\b/.test(tag)) {
      stack.pop();
      continue;
    }
    if (/\{%-?\s*for\b/.test(tag)) {
      const m = PLAIN_FOR.exec(tag);
      // A loop inside a loop repeats its lines over two axes at once, and this
      // evaluator addresses a row by one index. Reported rather than expanded
      // over the inner one alone, which would name half the rows.
      const nested = stack.length > 0;
      stack.push(m && !nested ? { supported: true, variable: m[1], list: m[2] } : { supported: false, expr: tag });
      continue;
    }
    // An `{% else %}` belonging to the loop makes the whole block unreadable
    // here for the reason the conditions give: the arm's own membership is a
    // negation this deliberately does not compute.
    if (/\{%-?\s*else\b/.test(tag) && stack.length > 0) {
      stack[stack.length - 1] = { supported: false, expr: tag };
      // The lines BEFORE it were already recorded as supported, so they are
      // corrected here: an arm is not readable in isolation from the branch
      // that follows it.
      for (const [ln, v] of out) if (v === undefined || ln < i + 1) out.set(ln, { supported: false, expr: tag });
      continue;
    }
    if (stack.length === 0) continue;
    const unsupported = stack.find((l) => !l.supported);
    out.set(i + 1, unsupported ?? stack[stack.length - 1]);
  }
  return out;
}

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
