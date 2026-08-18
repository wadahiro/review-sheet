// logrotate policy files: `/path/to/*.log { directive … }`.
//
// The format a rotation policy is written in, and — until this existed — a
// blind spot with real consequences: a project reviewing its retention had
// nothing to point at but the Ansible variables feeding the template, so
// `missingok`, `copytruncate`, `su`, and the whole `postrotate` script were
// present in the deployed file and absent from every sheet. `copytruncate` in
// particular is a decision with a cost (a line written between the copy and the
// truncate is lost), and the reviewer could not see it was taken.
//
// The grammar is small and stable:
//
//   - a BLOCK is one or more path patterns followed by `{ … }`. The patterns
//     identify the block. They may be separated by whitespace, by newlines, or
//     both, and the brace may sit on its own line — all three are ordinary in
//     files shipped by distribution packages.
//   - inside, a DIRECTIVE is either a bare flag (`daily`, `missingok`) or a
//     name with arguments (`rotate 30`, `su keycloak keycloak`).
//   - a SCRIPT is `postrotate` … `endscript` (also prerotate, firstaction,
//     lastaction, preremove). Its body is the value: what runs around a
//     rotation is exactly the kind of thing a review asks about.
//   - directives may also appear OUTSIDE any block (logrotate.conf's global
//     defaults), where they apply to everything.
//
// A bare flag's value is `true`. A flag has no argument — its presence IS the
// setting — and logrotate's flags come in pairs (`compress`/`nocompress`,
// `ifempty`/`notifempty`), so the row that matters is which of the pair is
// written. An absent flag produces no row, which is the same rule every other
// format here follows: the sheet transcribes what the file says.

export type LogrotateEntry = {
  categoryPath: string[];
  key: string;
  value: string;
  line: number;
  path: string;
};

const SCRIPT_DIRECTIVES = new Set(["postrotate", "prerotate", "firstaction", "lastaction", "preremove"]);

// Where a block's directives are filed when the file has no block at all —
// logrotate.conf's own top level, which applies to every log on the host.
const GLOBAL = "(global)";

function stripComment(line: string): string {
  // logrotate has no escape for `#`, so a comment starts wherever one appears.
  const i = line.indexOf("#");
  return (i === -1 ? line : line.slice(0, i)).trim();
}

export function logrotateIndex(content: string): LogrotateEntry[] {
  const lines = content.split("\n");
  const out: LogrotateEntry[] = [];
  let block: string | undefined;
  // Pattern lines seen since the last directive, waiting for their `{`.
  let pending: string[] = [];
  let script: { key: string; line: number; body: string[] } | undefined;
  // Repeated directives in one block are indexed, the same way every other
  // parser here indexes them: two `postrotate` scripts are two rows.
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const text = stripComment(raw);

    if (script) {
      if (text === "endscript") {
        const scope = block ?? GLOBAL;
        const n = seen.get(`${scope}\u0000${script.key}`) ?? 0;
        seen.set(`${scope}\u0000${script.key}`, n + 1);
        const key = n === 0 ? script.key : `${script.key}[${n}]`;
        out.push({
          categoryPath: [scope],
          key,
          // Kept as written, minus the indentation the template gave it: the
          // command is the value, and a reviewer compares commands.
          value: script.body.map((l) => l.trim()).filter(Boolean).join("\n"),
          line: script.line,
          path: `${scope}.${key}`,
        });
        script = undefined;
        continue;
      }
      script.body.push(raw);
      continue;
    }

    if (!text) continue;

    if (text === "}") {
      block = undefined;
      continue;
    }

    // `pattern[ pattern…] {` — the block header. The brace may close the same
    // line, or sit on its own after any number of pattern lines:
    //
    //     /var/log/a.log
    //     /var/log/b.log
    //     {
    //
    // which is why the patterns are COLLECTED rather than read off one line.
    // Reading only the one-line form filed every directive in such a block
    // under the global scope and turned each path line into a row of its own —
    // and the comment above this code claimed to handle it, which is how it
    // went unnoticed.
    if (text.endsWith("{")) {
      const head = [...pending, text.slice(0, -1).trim()].filter(Boolean);
      pending = [];
      // `{` with nothing before it anywhere: not a block header, and not
      // something to guess about.
      if (head.length > 0) block = head.join(" ");
      continue;
    }

    const [name, ...args] = text.split(/\s+/);

    // A path line and a bare flag are both a single word, so which one this is
    // cannot be read off the line alone — it is decided by SHAPE. A directive
    // is a bare identifier (`daily`, `su root root`); a pattern is absolute,
    // `~`-relative, quoted, or a glob. logrotate itself requires that much of a
    // pattern, so nothing legal is misread.
    if (looksLikePattern(name)) {
      pending.push(text);
      continue;
    }

    // A pattern line followed by something that is not `{` is malformed. Emit
    // what was collected rather than dropping it: a line that disappears from
    // the sheet is the failure this whole area exists to prevent.
    for (const stray of pending) emit(stray, i + 1);
    pending = [];
    if (SCRIPT_DIRECTIVES.has(name)) {
      script = { key: name, line: i + 1, body: [] };
      continue;
    }
    emit(text, i + 1);
  }
  // A file that ends while patterns are still waiting for a brace.
  for (const stray of pending) emit(stray, lines.length);
  return out;

  function emit(text: string, line: number): void {
    const [name, ...args] = text.split(/\s+/);
    const scope = block ?? GLOBAL;
    const n = seen.get(`${scope}\u0000${name}`) ?? 0;
    seen.set(`${scope}\u0000${name}`, n + 1);
    const key = n === 0 ? name : `${name}[${n}]`;
    out.push({
      categoryPath: [scope],
      key,
      value: args.length > 0 ? args.join(" ") : "true",
      line,
      path: `${scope}.${key}`,
    });
  }
}

// See the block-header comment: shape is what separates a path pattern from a
// bare flag when both are one word on a line of their own.
function looksLikePattern(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith("~") ||
    token.startsWith('"') ||
    token.startsWith("'") ||
    /[*?[]/.test(token)
  );
}

export function logrotateLocate(content: string, path: string): { value: string } | { error: string } {
  const hit = logrotateIndex(content).find((e) => e.path === path);
  return hit ? { value: hit.value } : { error: `no logrotate directive at ${path}` };
}

export function logrotateEdit(
  content: string,
  path: string,
  current: string,
  suggested: string
): { status: "applied"; content: string; before: string; after: string } | { status: "error"; reason: string } {
  const hit = logrotateIndex(content).find((e) => e.path === path);
  if (!hit) return { status: "error", reason: `no logrotate directive at ${path}` };
  if (hit.value !== current) return { status: "error", reason: `value is "${hit.value}", expected "${current}" — stale?` };
  // A script's body spans lines and a flag has no argument to rewrite: both
  // refuse rather than guess, and apply turns a refusal into a held change with
  // this reason attached. Editing a `postrotate` body is editing a shell script
  // that runs on the host, which is not a parameter change.
  if (hit.value === "true") return { status: "error", reason: "a flag has no value to rewrite — add or remove the directive instead" };
  // By DIRECTIVE, not by looking for a newline: a one-line postrotate is still
  // a script, and rewriting it is still editing what runs on the host.
  if (SCRIPT_DIRECTIVES.has(hit.key.replace(/\[\d+\]$/, "")))
    return { status: "error", reason: "a script body is not a parameter value" };
  const lines = content.split("\n");
  const idx = hit.line - 1;
  const line = lines[idx];
  const at = line.lastIndexOf(current);
  if (at === -1) return { status: "error", reason: `"${current}" not found on line ${hit.line}` };
  const after = line.slice(0, at) + suggested + line.slice(at + current.length);
  lines[idx] = after;
  return { status: "applied", content: lines.join("\n"), before: line, after };
}
