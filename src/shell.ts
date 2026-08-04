// Shell scripts (.sh/.bash, or anything with a `#!…sh` shebang). A shell script
// is far too free-form to extract "the configuration" from in general, so this
// adapter deliberately recognises only the two shapes that ARE unambiguous and
// that carry reviewable values in practice:
//
//   - a variable assignment at the start of a statement — `REGION=ap-northeast-1`,
//     optionally behind `export`/`local`/`readonly`/`declare`
//   - a long option carrying a value — `--region ap-northeast-1` or
//     `--region=ap-northeast-1`
//
// That covers the case this exists for: a wrapper script around a CLI, where the
// reviewable parameters are the command's arguments (an `aws secretsmanager
// get-secret-value --secret-id … --region …` line, a `kc.sh build --db=postgres
// --health-enabled=true`). Everything else on a line — the command itself,
// positional arguments, bare flags with no value, short options — is left alone:
// a bare flag has no value to map or edit, and a short option cannot be told
// apart from a bundle (`-rf`) without knowing the command.
//
// Key: the variable name for an assignment, the option WITH its dashes for a
// flag (`--region`), so the two can never collide and a sheet row reads the way
// the script does. A key that occurs more than once is indexed (`--region[0]`,
// `--region[1]`) — order is the only identity a command line offers.
//
// Because `.j2` is stripped before the base format is resolved (see
// parsers/jinja2.ts), this also gives `*.sh.j2` a base format: a
// `--secret-id {{ kc_db_secret_name }}` argument then records its templateVar
// and resolves against the role's variable file like any other template value.

export type ShellEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number]; path: string };

type Token = { text: string; start: number; end: number };

// Split one line into shell-ish words, keeping quotes as written (the value must
// go back verbatim on apply) and recording each word's absolute byte range.
function tokenize(line: string, base: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue; }
    const start = i;
    let quote: string | undefined;
    while (i < line.length) {
      const c = line[i];
      if (quote) {
        if (c === "\\" && quote === '"') { i += 2; continue; }
        if (c === quote) quote = undefined;
        i++;
        continue;
      }
      if (c === "'" || c === '"') { quote = c; i++; continue; }
      if (/\s/.test(c)) break;
      if (c === "\\" && i + 1 < line.length) { i += 2; continue; }
      i++;
    }
    out.push({ text: line.slice(start, i), start: base + start, end: base + i });
  }
  return out;
}

// Tokens that end one statement and begin another, so the next word is again a
// position where `NAME=value` means an assignment rather than an argument.
const SEPARATORS = new Set(["|", "||", "&&", ";", "&", "(", ")", "{", "}", "!", "then", "do", "else"]);
const ASSIGN_PREFIX = new Set(["export", "local", "readonly", "declare", "typeset"]);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
const LONG_FLAG_INLINE = /^(--[A-Za-z0-9][A-Za-z0-9._-]*)=([\s\S]*)$/;
const LONG_FLAG = /^(--[A-Za-z0-9][A-Za-z0-9._-]*)$/;

// A word that cannot be a flag's value: another option, a separator, or a
// redirection target marker.
function isValueLike(t: Token | undefined): boolean {
  if (!t) return false;
  if (SEPARATORS.has(t.text)) return false;
  if (t.text.startsWith("-") && t.text.length > 1) return false;
  return !/^[<>]/.test(t.text);
}

// A command line often sits inside a command substitution — `X=$(aws … --region
// r --output text)` — and the surrounding `$(` / `)` end up glued to the first
// and last word. Handled locally rather than by tracking substitution depth,
// which is the point where this stops being a line scanner and starts being a
// shell: a word carrying an unclosed `$(` is not a literal value at all (it is a
// command whose output becomes the value), and a trailing `)` with no opener in
// the same word belongs to the substitution, not to the value.
function unwrapValue(text: string): { text: string; trimmedRight: number } | undefined {
  if (/\$\(|`/.test(text) && !/\$\([^)]*\)/.test(text)) return undefined;
  let out = text;
  let trimmed = 0;
  while (out.endsWith(")") && (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length) {
    out = out.slice(0, -1);
    trimmed++;
  }
  return out === "" ? undefined : { text: out, trimmedRight: trimmed };
}

export function shellIndex(content: string): ShellEntry[] {
  const lines = content.split("\n");
  type Raw = { key: string; value: string; line: number; range: [number, number]; category: string };
  const raw: Raw[] = [];
  let offset = 0;
  // Heredoc bodies are payload (an embedded config file, a SQL script), not this
  // script's own configuration — scanning them would invent parameters.
  let heredocTerminator: string | undefined;
  // A `\`-continued line carries on the previous statement, so its first word is
  // an argument, not a command. Getting this wrong swallows the first option of
  // every wrapped command line — which is how these scripts are normally written.
  let continued = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;

    if (heredocTerminator !== undefined) {
      if (line.trim() === heredocTerminator) heredocTerminator = undefined;
      continue;
    }
    const trimmed = line.trim();
    const continuesNext = trimmed.endsWith("\\");
    if (trimmed === "" || trimmed.startsWith("#")) { continued = continuesNext && trimmed !== ""; continue; }

    const heredoc = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (heredoc) heredocTerminator = heredoc[2];

    // Drop the continuation marker before tokenizing: left in, it is a word of
    // its own and the option before it looks like `--verbose \`, i.e. a flag
    // whose value is a backslash.
    const scanned = continuesNext ? line.slice(0, line.lastIndexOf("\\")) : line;
    const tokens = tokenize(scanned, lineStart);
    let statementStart = !continued;
    continued = continuesNext;
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      if (SEPARATORS.has(tok.text)) { statementStart = true; continue; }
      if (statementStart && ASSIGN_PREFIX.has(tok.text)) continue; // still a statement start

      if (statementStart) {
        const m = ASSIGNMENT.exec(tok.text);
        statementStart = false;
        if (m) {
          const v = unwrapValue(m[2]);
          if (v) {
            const valueStart = tok.start + m[1].length + 1;
            raw.push({ key: m[1], value: v.text, line: i + 1, range: [valueStart, valueStart + v.text.length], category: "Variables" });
          }
        }
        continue; // an assignment is handled above; anything else is the command word
      }

      const inline = LONG_FLAG_INLINE.exec(tok.text);
      if (inline) {
        const v = unwrapValue(inline[2]);
        if (v) {
          const valueStart = tok.start + inline[1].length + 1;
          raw.push({ key: inline[1], value: v.text, line: i + 1, range: [valueStart, valueStart + v.text.length], category: "Options" });
        }
        continue;
      }
      if (LONG_FLAG.test(tok.text) && isValueLike(tokens[t + 1])) {
        const next = tokens[t + 1];
        const v = unwrapValue(next.text);
        if (v) {
          raw.push({ key: tok.text, value: v.text, line: i + 1, range: [next.start, next.end - v.trimmedRight], category: "Options" });
        }
        t++; // the value is consumed, not read again as a word of its own
      }
    }
  }

  const counts = new Map<string, number>();
  for (const r of raw) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  const seen = new Map<string, number>();

  return raw.map((r) => {
    const repeated = (counts.get(r.key) ?? 0) > 1;
    const occ = seen.get(r.key) ?? 0;
    seen.set(r.key, occ + 1);
    const key = repeated ? `${r.key}[${occ}]` : r.key;
    return { categoryPath: [r.category], key, value: r.value, line: r.line, range: r.range, path: key };
  });
}

export type ShellLocate = { value: string } | { error: string };
export function shellLocate(content: string, path: string): ShellLocate {
  const e = shellIndex(content).find((x) => x.path === path);
  return e ? { value: e.value } : { error: "path not found" };
}

export type ShellEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function shellEdit(content: string, path: string, current: string, suggested: string): ShellEdit {
  const e = shellIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  const before = content.slice(start, end);
  // Keep whatever quoting the script used: replacing `"a b"` with an unquoted
  // `c d` would silently turn one argument into two.
  const q = before.length >= 2 && (before[0] === '"' || before[0] === "'") && before[before.length - 1] === before[0] ? before[0] : undefined;
  const after = q ? `${q}${suggested.replace(new RegExp(q, "g"), `\\${q}`)}${q}` : suggested;
  return { status: "applied", content: content.slice(0, start) + after + content.slice(end), before, after };
}

// `#!/bin/sh`, `#!/usr/bin/env bash`, … — enough to claim an extensionless file.
export function isShell(file: string, content: string): boolean {
  const f = file.toLowerCase();
  if (f.endsWith(".sh") || f.endsWith(".bash") || f.endsWith(".ksh") || f.endsWith(".zsh")) return true;
  return /^#!.*\b(sh|bash|ksh|zsh|dash)\b/.test(content.split("\n", 1)[0] ?? "");
}
