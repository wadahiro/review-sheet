// nginx config (nginx.conf, sites-available/*). Directives `name args...;` and
import type { ContainerNode } from "./types.js";
import { containerSubjectAt } from "./parser.js";
// blocks `name label... { ... }` (http / server / location / upstream / …).
// A small character scanner builds a block tree with source ranges, then we
// walk it (like the XML adapter): labeled blocks (location /api, upstream name)
// are addressed by their label — reorder-robust; unlabeled repeats (server) and
// repeated directives (listen) get a positional index. A directive's value is
// its argument span, edited in place.
//
// Scope: standard `;`/`{`/`}` syntax with `#` comments and quoted args. The
// value is the raw argument text (multi-arg kept verbatim).

export type NginxEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number]; path: string; containers: ContainerNode[] };

// nginx files have no reliable extension (`.conf` collides with sysctl), so
// detect by name or by the presence of block syntax (a line ending in `{`).
export function isNginx(file: string, content: string): boolean {
  const base = (file.split("/").pop() ?? "").toLowerCase();
  if (base === "nginx.conf" || base.endsWith(".nginx")) return true;
  if ((base.endsWith(".conf") || !base.includes(".")) && /^[^\n#=]*\{[ \t]*$/m.test(content)) return true;
  return false;
}

type Dir = { name: string; value: string; range: [number, number]; line: number };
// `labelRange` is the raw source span of the block's argument tokens
// (undefined for an unlabeled block, e.g. a bare `server {}`).
type Block = { name: string; label: string; labelRange?: [number, number]; dirs: Dir[]; blocks: Block[]; line: number };

// `if (...)` is the one nginx block whose "label" is a TEST the block
// evaluates, not an identity — same distinction as httpd's <If>/<IfModule>
// (see the comment there). `location`/`upstream`/`map`/`geo`/… stay
// label-addressed: their argument names WHAT the block applies to (a path, a
// map's input), so a changed argument is legitimately a different object.
// `if` conditions are also typically NOT chained the way Apache's
// If/ElseIf/Else are (nginx has no ElseIf/Else), but positional addressing
// still applies: several sibling `if`s at the same nesting level are common,
// and the condition text is exactly the kind of thing a reviewer edits
// in-place (tightening a regex, fixing a typo) without meaning to swap in a
// whole new block.
const EXPR_CONTAINERS = new Set(["if"]);

function lineOf(content: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content[i] === "\n") n++;
  return n;
}

function scan(content: string): Block {
  const root: Block = { name: "", label: "", dirs: [], blocks: [], line: 0 };
  const stack: Block[] = [root];
  const len = content.length;
  let i = 0;

  while (i < len) {
    while (i < len && /\s/.test(content[i])) i++;
    if (i >= len) break;
    if (content[i] === "#") { while (i < len && content[i] !== "\n") i++; continue; }
    if (content[i] === "}") { if (stack.length > 1) stack.pop(); i++; continue; }

    const tokens: { text: string; start: number; end: number }[] = [];
    let term: ";" | "{" | "}" | null = null;
    while (i < len) {
      while (i < len && /\s/.test(content[i])) i++;
      if (i >= len) break;
      const ch = content[i];
      if (ch === "#") { while (i < len && content[i] !== "\n") i++; continue; }
      if (ch === ";") { term = ";"; i++; break; }
      if (ch === "{") { term = "{"; i++; break; }
      if (ch === "}") { term = "}"; break; }
      const start = i;
      if (ch === '"' || ch === "'") {
        i++;
        while (i < len && content[i] !== ch) { if (content[i] === "\\") i++; i++; }
        i++;
      } else {
        while (i < len && !/[\s;{}#]/.test(content[i])) i++;
      }
      tokens.push({ text: content.slice(start, i), start, end: i });
    }

    if (tokens.length === 0) continue;
    if (term === "{") {
      const labelTokens = tokens.slice(1);
      const labelRange: [number, number] | undefined =
        labelTokens.length > 0 ? [labelTokens[0].start, labelTokens[labelTokens.length - 1].end] : undefined;
      const block: Block = {
        name: tokens[0].text,
        label: labelTokens.map((t) => t.text).join(" "),
        labelRange,
        dirs: [], blocks: [], line: lineOf(content, tokens[0].start),
      };
      stack[stack.length - 1].blocks.push(block);
      stack.push(block);
    } else {
      const args = tokens.slice(1);
      if (args.length > 0) {
        const range: [number, number] = [args[0].start, args[args.length - 1].end];
        stack[stack.length - 1].dirs.push({ name: tokens[0].text, value: content.slice(range[0], range[1]), range, line: lineOf(content, tokens[0].start) });
      }
    }
  }
  return root;
}

export function nginxIndex(content: string): NginxEntry[] {
  const root = scan(content);
  const out: NginxEntry[] = [];

  const walk = (block: Block, nodes: ContainerNode[]): void => {
    const cats = nodes.flatMap((n) => n.headings);
    const addr = (key: string): string => [...nodes.map((n) => n.pathSeg), key].join(".");
    // Directives, grouped by name (repeated → indexed).
    const dirGroups = new Map<string, Dir[]>();
    for (const d of block.dirs) { const g = dirGroups.get(d.name); if (g) g.push(d); else dirGroups.set(d.name, [d]); }
    for (const [name, group] of dirGroups) {
      group.forEach((d, i) => {
        const key = group.length > 1 ? `${name}[${i}]` : name;
        out.push({ categoryPath: cats, key, value: d.value, line: d.line, range: d.range, path: addr(key), containers: nodes });
      });
    }
    // Child blocks, grouped by name.
    const blkGroups = new Map<string, Block[]>();
    for (const b of block.blocks) { const g = blkGroups.get(b.name); if (g) g.push(b); else blkGroups.set(b.name, [b]); }
    for (const [name, group] of blkGroups) {
      const expr = EXPR_CONTAINERS.has(name);
      const labels = group.map((b) => b.label);
      const useLabel = !expr && labels.every((l) => l !== "") && new Set(labels).size === labels.length;
      group.forEach((b, i) => {
        let node: ContainerNode;
        if (expr) {
          // Positional identity, never the condition text (see EXPR_CONTAINERS)
          // — the condition is a value somebody edits, so it must not be the
          // address that edit is applied through.
          node =
            group.length > 1
              ? { name, index: i, pathSeg: `${name}[${i}]`, headings: [`${name}[${i}]`], line: b.line }
              : { name, pathSeg: name, headings: [name], line: b.line };
          // The condition becomes a synthetic row filed in the enclosing
          // category, one level above the block's own children — the value is
          // sliced straight from source (not the space-joined `b.label`) so it
          // round-trips exactly through edit.
          if (b.labelRange) {
            const key = group.length > 1 ? `${name}[${i}]` : name;
            out.push({
              categoryPath: cats,
              key,
              value: content.slice(b.labelRange[0], b.labelRange[1]),
              line: b.line,
              range: b.labelRange,
              path: addr(key),
              // Filed in the enclosing category, so the block it describes is
              // not among its own containers.
              containers: nodes,
            });
          }
        } else if (group.length === 1 && b.label === "") node = { name, pathSeg: name, headings: [name], line: b.line };
        // A `location /api` label is the block's subject — what it governs —
        // so it goes in the address and, later, in the row's value.
        else if (useLabel) node = { name, subject: content.slice(b.labelRange![0], b.labelRange![1]), subjectRange: b.labelRange!, pathSeg: `${name}[${b.label}]`, headings: [`${name} ${b.label}`], line: b.line };
        else node = { name, index: i, pathSeg: `${name}[${i}]`, headings: [`${name}[${i}]`], line: b.line };
        walk(b, [...nodes, node]);
      });
    }
  };

  walk(root, []);
  return out;
}

export type NginxLocate = { value: string } | { error: string };
export function nginxLocate(content: string, path: string): NginxLocate {
  const e = nginxIndex(content).find((x) => x.path === path);
  // A BLOCK's own address, which is not an entry (see containerSubjectAt).
  const containerSubject = containerSubjectAt(nginxIndex(content), path);
  if (containerSubject !== undefined) return { value: containerSubject };
  return e ? { value: e.value } : { error: "path not found" };
}

export type NginxEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function nginxEdit(content: string, path: string, current: string, suggested: string): NginxEdit {
  const e = nginxIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  return { status: "applied", content: content.slice(0, start) + suggested + content.slice(end), before: content.slice(start, end), after: suggested };
}
