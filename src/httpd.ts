// Apache HTTP Server (httpd) config: httpd.conf, apache2.conf, .htaccess,
// sites/*.conf. Directives are one per line `Name arg1 arg2` (no terminator);
// containers are `<Tag args> ... </Tag>`. We scan it line by line into a block
// tree with source ranges, then walk it like the nginx/XML adapters: containers
// are addressed by their argument label (<VirtualHost *:80>, <Directory
// /var/www>) — reorder-robust; repeated containers / directives get a positional
// index. A directive's value is its raw argument span, edited in place.
//
// Scope: standard line syntax with `#` full-line comments. Line-continued (`\`)
// directives are skipped.

export type HttpdEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number]; path: string };

type Dir = { name: string; value: string; range: [number, number]; line: number };
// `labelRange` is the absolute offset span of the raw label text inside the
// opening tag line — undefined when the tag has no argument (e.g. <Else>).
type Block = { name: string; label: string; labelRange?: [number, number]; dirs: Dir[]; blocks: Block[]; line: number };

// Apache container directives split into two kinds:
//
// - Identity containers: the label names WHAT the block applies to (a host, a
//   path, a URL, a macro name). Changing the label points the block at a
//   different subject, so path/category legitimately changes with it — kept
//   as the (default) label-addressed path, unchanged from before this file
//   grew container support for conditionals.
//
// - Expression containers: the label is a TEST the block evaluates (a
//   condition, a module/version check, an HTTP-method filter) — it is a VALUE
//   of the container, not its identity. The container itself does not change
//   identity when the expression is edited, and an If/ElseIf/ElseIf/Else (or
//   Limit/LimitExcept) sequence is ordered, so members are addressed
//   positionally (`If[0]`, `ElseIf[1]`, …) instead of by the expression text.
//   That keeps a one-character fix to a condition from reading as "container
//   deleted, new container added" in diff, and lets the expression itself
//   become a reviewable, editable synthetic row (see EXPR_CONTAINERS below).
//
// Candidates considered and dropped: "IfFile", "IfSection", "IfDirective" are
// not real Apache directives (no mod_* documents them) — including them would
// invent path syntax nothing ever produces. "RequireAll"/"RequireAny"/
// "RequireNone" (mod_authz_core) take NO argument at all (they just group
// Require lines under a boolean operator), so they carry no expression to
// extract as a row, but still belong here: their identity is "which boolean
// grouping is this", not a name worth deduping by label, and positional
// addressing is the only thing that makes sense for repeats.
const EXPR_CONTAINERS = new Set([
  "If", "ElseIf", "Else",
  "IfModule", "IfDefine", "IfVersion",
  "Limit", "LimitExcept",
  "RequireAll", "RequireAny", "RequireNone",
]);

// A line that looks like an Apache directive: `Name value`, no `=` anywhere
// on the line. Real directives are consistently CamelCase with no separator
// (ServerName, ProxyPass, LogLevel, KeepAlive, LoadModule, …) — the `[ \t]+`
// right after the name means a colon- or equals-adjacent key ("Foo:", "Foo=")
// fails to match at all, and the whole-line `=` check on top of that catches
// a spaced-out assignment ("MaxSize = 100") a bare regex would miss.
const DIRECTIVE_LINE = /^[ \t]*[A-Z][A-Za-z]*[ \t]+\S.*$/;
// A line that looks like a sysctl/ini/properties assignment: `key = value` or
// `key: value` (INI's colon variant). Used as the competing signal below.
const ASSIGNMENT_LINE = /^[ \t]*[^\s=:#]+[ \t]*[=:][ \t]*\S.*$/;

// conf.d/*.conf fragments (the RHEL httpd layout: one directive-only file per
// module/vhost, no <Tag> block anywhere) have no structural marker at all to
// tell them apart from sysctl/ini — both are bare `.conf` files. The one
// remaining signal is vocabulary shape: Apache directives are `CamelCase
// value` (no `=`); sysctl/ini are `key = value`. A single matching line is
// not enough to trust (a stray capitalized value could appear anywhere) — this
// requires directive-shaped lines to actually OUTNUMBER assignment-shaped
// ones, so a file that is mostly sysctl/ini with one incidental capitalized
// line is not swayed, and a minimum count so a one-line fragment doesn't
// decide it either.
function looksLikeHttpdDirectives(content: string): boolean {
  let directiveLines = 0;
  let assignmentLines = 0;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (/^\[.*\]$/.test(line)) continue; // ini section header — not a directive OR an assignment
    if (line.includes("=")) {
      if (ASSIGNMENT_LINE.test(line)) assignmentLines++;
      continue; // a `=` anywhere disqualifies it as a directive line, matched or not
    }
    if (DIRECTIVE_LINE.test(line)) directiveLines++;
    else if (ASSIGNMENT_LINE.test(line)) assignmentLines++;
  }
  return directiveLines >= 2 && directiveLines > assignmentLines;
}

// Detect httpd config (no reliable extension; `.conf` collides with sysctl).
export function isHttpd(file: string, content: string): boolean {
  const base = (file.split("/").pop() ?? "").toLowerCase();
  if (base === "httpd.conf" || base === "apache2.conf" || base === ".htaccess" || base.endsWith(".htaccess")) return true;
  if ((base.endsWith(".conf") || !base.includes(".")) && /^\s*<\/?[A-Za-z]/m.test(content)) return true;
  // conf.d/*.conf (P10 bug 3): directive-only fragments, no <Tag> block at
  // all. Scoped to `.conf` extension only (not extensionless) to keep the
  // blast radius small — an extensionless file still needs a real <Tag>
  // block, same as before this case was added.
  if (base.endsWith(".conf") && looksLikeHttpdDirectives(content)) return true;
  return false;
}

function scan(content: string): Block {
  const root: Block = { name: "", label: "", dirs: [], blocks: [], line: 0 };
  const stack: Block[] = [root];
  const lines = content.split("\n");
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (line.trimEnd().endsWith("\\")) continue; // multi-line directive: skip

    const close = trimmed.match(/^<\/\s*([A-Za-z][\w]*)\s*>$/);
    if (close) { if (stack.length > 1) stack.pop(); continue; }
    const openIndent = line.length - line.trimStart().length;
    const open = trimmed.match(/^<\s*([A-Za-z][\w]*)\b([^>]*)>$/);
    if (open) {
      const rawLabel = open[2]; // between the tag name and `>`, whitespace included
      const label = rawLabel.trim();
      // Offset of rawLabel's start within `trimmed`: the match is anchored at
      // 0, and `>` is the last character, so what's left after removing
      // rawLabel and the trailing `>` is exactly the `<...tagname` prefix.
      const prefixLen = open[0].length - rawLabel.length - 1;
      const labelLead = rawLabel.length - rawLabel.trimStart().length;
      const labelStart = lineStart + openIndent + prefixLen + labelLead;
      const block: Block = {
        name: open[1],
        label,
        labelRange: label ? [labelStart, labelStart + label.length] : undefined,
        dirs: [], blocks: [], line: i + 1,
      };
      stack[stack.length - 1].blocks.push(block);
      stack.push(block);
      continue;
    }

    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    const m = body.match(/^(\S+)(\s+)(\S.*?)\s*$/);
    if (!m) continue; // directive with no argument
    const valueStart = lineStart + indent + m[1].length + m[2].length;
    const value = m[3];
    stack[stack.length - 1].dirs.push({ name: m[1], value, range: [valueStart, valueStart + value.length], line: i + 1 });
  }
  return root;
}

type Seg = { path: string; cat: string };

export function httpdIndex(content: string): HttpdEntry[] {
  const root = scan(content);
  const out: HttpdEntry[] = [];

  const walk = (block: Block, segs: Seg[]): void => {
    const dirGroups = new Map<string, Dir[]>();
    for (const d of block.dirs) { const g = dirGroups.get(d.name); if (g) g.push(d); else dirGroups.set(d.name, [d]); }
    for (const [name, group] of dirGroups) {
      group.forEach((d, i) => {
        const key = group.length > 1 ? `${name}[${i}]` : name;
        out.push({ categoryPath: segs.map((s) => s.cat), key, value: d.value, line: d.line, range: d.range, path: [...segs.map((s) => s.path), key].join(".") });
      });
    }
    const blkGroups = new Map<string, Block[]>();
    for (const b of block.blocks) { const g = blkGroups.get(b.name); if (g) g.push(b); else blkGroups.set(b.name, [b]); }
    for (const [name, group] of blkGroups) {
      const expr = EXPR_CONTAINERS.has(name);
      const labels = group.map((b) => b.label);
      const useLabel = !expr && labels.every((l) => l !== "") && new Set(labels).size === labels.length;
      group.forEach((b, i) => {
        let seg: Seg;
        if (expr) {
          // Positional identity, never the expression text (see EXPR_CONTAINERS).
          seg = group.length > 1 ? { path: `${name}[${i}]`, cat: `${name}[${i}]` } : { path: name, cat: name };
          // The expression itself becomes a synthetic row — the block's own
          // "value" — filed in the ENCLOSING category (same level as sibling
          // directives), one level above where the block's own children land.
          // <Else> and no-argument groupers (RequireAll/…) have no expression,
          // so nothing is emitted for them.
          if (b.labelRange) {
            const key = group.length > 1 ? `${name}[${i}]` : name;
            out.push({
              categoryPath: segs.map((s) => s.cat),
              key,
              value: b.label,
              line: b.line,
              range: b.labelRange,
              path: [...segs.map((s) => s.path), key].join("."),
            });
          }
        } else if (group.length === 1 && b.label === "") seg = { path: name, cat: name };
        else if (useLabel) seg = { path: `${name}[${b.label}]`, cat: `${name} ${b.label}` };
        else seg = { path: `${name}[${i}]`, cat: `${name}[${i}]` };
        walk(b, [...segs, seg]);
      });
    }
  };

  walk(root, []);
  return out;
}

export type HttpdLocate = { value: string } | { error: string };
export function httpdLocate(content: string, path: string): HttpdLocate {
  const e = httpdIndex(content).find((x) => x.path === path);
  return e ? { value: e.value } : { error: "path not found" };
}

export type HttpdEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function httpdEdit(content: string, path: string, current: string, suggested: string): HttpdEdit {
  const e = httpdIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  return { status: "applied", content: content.slice(0, start) + suggested + content.slice(end), before: content.slice(start, end), after: suggested };
}
