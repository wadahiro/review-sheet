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

// Mask Jinja2 syntax so a brace-structured base format (nginx/httpd/haproxy) does
// not mis-read `{{ … }}` / `{% … %}` as its own block braces. Expressions become
// reversible placeholders (alnum, no braces) so the extracted value can be
// restored to its original `{{ … }}` text and its templateVar derived; statements
// and comments are blanked in place (every newline kept, so line numbers — which
// the adapters rely on — are preserved). Line-based base formats round-trip
// unchanged (placeholder in, original out).
export function maskJinja(content: string): { masked: string; restore: (s: string) => string } {
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
  return { masked, restore };
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
