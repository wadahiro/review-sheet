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

// Every directive logrotate(8) defines. Used to tell a DIRECTIVE from a path
// pattern at the top level of a file, where both are one word on a line of
// their own.
//
// Recognising the directives rather than guessing at the shape of a path: a
// pattern is whatever the admin wrote, and the guesses that seemed safe were
// not. `/`, `~`, quotes and globs miss a template substitution — and by the
// time such a file reaches this parser the substitution has been MASKED by
// jinja2.ts into an opaque token, so no amount of looking for `{{` would have
// found it either. The directives, by contrast, are a closed set defined by the
// program.
const DIRECTIVES = new Set([
  "addextension", "allowhardlink", "compress", "compresscmd", "compressext", "compressoptions",
  "copy", "copytruncate", "create", "createolddir", "daily", "dateext", "dateformat",
  "datehourago", "dateyesterday", "delaycompress", "extension", "firstaction", "hourly",
  "ifempty", "include", "lastaction", "mail", "mailfirst", "maillast", "maxage", "maxsize",
  "minage", "minsize", "missingok", "monthly", "noallowhardlink", "nocompress", "nocopy",
  "nocopytruncate", "nocreate", "nocreateolddir", "nodateext", "nodelaycompress", "nomail",
  "nomissingok", "noolddir", "nosharedscripts", "noshred", "notifempty", "olddir", "postrotate",
  "preremove", "prerotate", "renamecopy", "rotate", "sharedscripts", "shred", "shredcycles",
  "size", "start", "su", "tabooext", "taboopat", "weekly", "yearly",
]);

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

    // A path line and a bare flag are both a single word, so which one a line
    // is cannot be read off the line alone.
    //
    // Two things decide it, and neither is a guess about what a path looks
    // like. A block header only ever appears at the TOP LEVEL, so inside a
    // block every line is a directive whatever it resembles. At the top level,
    // a line is a directive when it names one — the set is closed and defined
    // by logrotate itself, while a pattern is whatever the admin wrote, quite
    // possibly a template substitution this parser receives already masked.
    if (block === undefined && !DIRECTIVES.has(name)) {
      pending.push(text);
      continue;
    }

    // A pattern line followed by something that is not `{` is malformed. Emit
    // what was collected rather than dropping it: a line that disappears from
    // the sheet is the failure this whole area exists to prevent.
    for (const stray of pending) emitPattern(stray, i + 1);
    pending = [];
    if (SCRIPT_DIRECTIVES.has(name)) {
      script = { key: name, line: i + 1, body: [] };
      continue;
    }
    emit(text, i + 1);
  }
  // A file that ends while patterns are still waiting for a brace.
  for (const stray of pending) emitPattern(stray, lines.length);
  return out;

  // A pattern that never got its brace. The whole line is the key: splitting it
  // on whitespace the way a directive is split turns `{{ home }}/x.log` into a
  // row named `{{`, which names nothing.
  function emitPattern(text: string, line: number): void {
    push(text, "true", line);
  }

  function emit(text: string, line: number): void {
    const [name, ...args] = text.split(/\s+/);
    push(name, args.length > 0 ? args.join(" ") : "true", line);
  }

  function push(name: string, value: string, line: number): void {
    const scope = block ?? GLOBAL;
    const n = seen.get(`${scope}\u0000${name}`) ?? 0;
    seen.set(`${scope}\u0000${name}`, n + 1);
    const key = n === 0 ? name : `${name}[${n}]`;
    out.push({ categoryPath: [scope], key, value, line, path: `${scope}.${key}` });
  }
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
