// HAProxy config (haproxy.cfg). Section-based: `global` / `defaults` /
import type { ContainerNode } from "./types.js";
// `frontend <name>` / `backend <name>` / `listen <name>` / … headers, with
// `key value` directives under them (no nesting). Directives often repeat
// (`server`, `bind`, `acl`). Scanned line by line into sections with source
// ranges; named sections are addressed by name and a repeated directive by its
// first argument when unique (e.g. `server web1` → `backend[app].server[web1]`)
// — reorder-robust — else by index. A directive's value is its argument span.

export type HaproxyEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number]; path: string; containers: ContainerNode[] };

const SECTIONS = new Set([
  "global", "defaults", "frontend", "backend", "listen", "peers", "resolvers",
  "mailers", "userlist", "ring", "http-errors", "program", "cache", "fcgi-app",
]);

type Dir = { name: string; value: string; range: [number, number]; line: number };
// `line` is the section header's own — a container has a definition site just
// as a directive does, and until the chain was recorded nothing had asked for
// it.
type Section = { name: string; label: string; dirs: Dir[]; line: number };

export function isHaproxy(file: string, content: string): boolean {
  const base = (file.split("/").pop() ?? "").toLowerCase();
  if (base === "haproxy.cfg") return true;
  if ((base.endsWith(".cfg") || base.endsWith(".conf") || !base.includes(".")) && /^(global|defaults|frontend|backend|listen)\b/m.test(content)) return true;
  return false;
}

function scan(content: string): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;
  const lines = content.split("\n");
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const head = trimmed.match(/^(\S+)(?:\s+(.*))?$/);
    if (head && SECTIONS.has(head[1]) && line[0] !== " " && line[0] !== "\t") {
      current = { name: head[1], label: (head[2] ?? "").trim(), dirs: [], line: i + 1 };
      sections.push(current);
      continue;
    }
    if (!current) continue;

    const indent = line.length - line.trimStart().length;
    const body = line.slice(indent);
    const m = body.match(/^(\S+)(\s+)(\S.*?)\s*$/);
    if (!m) continue;
    const valueStart = lineStart + indent + m[1].length + m[2].length;
    const value = m[3];
    current.dirs.push({ name: m[1], value, range: [valueStart, valueStart + value.length], line: i + 1 });
  }
  return sections;
}

export function haproxyIndex(content: string): HaproxyEntry[] {
  const out: HaproxyEntry[] = [];
  for (const sec of scan(content)) {
    // A section's label is its subject — which frontend, which backend — so it
    // goes in the address and, later, in the container row's value.
    const node: ContainerNode = sec.label
      ? { name: sec.name, subject: sec.label, pathSeg: `${sec.name}[${sec.label}]`, headings: [`${sec.name} ${sec.label}`], line: sec.line }
      : { name: sec.name, pathSeg: sec.name, headings: [sec.name], line: sec.line };
    const groups = new Map<string, Dir[]>();
    for (const d of sec.dirs) { const g = groups.get(d.name); if (g) g.push(d); else groups.set(d.name, [d]); }
    for (const [name, group] of groups) {
      const firstArgs = group.map((d) => d.value.split(/\s+/)[0]);
      const useArg = group.length > 1 && new Set(firstArgs).size === firstArgs.length;
      group.forEach((d, i) => {
        const key = group.length === 1 ? name : useArg ? `${name}[${firstArgs[i]}]` : `${name}[${i}]`;
        out.push({ categoryPath: node.headings, key, value: d.value, line: d.line, range: d.range, path: `${node.pathSeg}.${key}`, containers: [node] });
      });
    }
  }
  return out;
}

export type HaproxyLocate = { value: string } | { error: string };
export function haproxyLocate(content: string, path: string): HaproxyLocate {
  const e = haproxyIndex(content).find((x) => x.path === path);
  return e ? { value: e.value } : { error: "path not found" };
}

export type HaproxyEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function haproxyEdit(content: string, path: string, current: string, suggested: string): HaproxyEdit {
  const e = haproxyIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  return { status: "applied", content: content.slice(0, start) + suggested + content.slice(end), before: content.slice(start, end), after: suggested };
}
