// systemd unit files (.service/.timer/.socket/.mount/.target/...). INI-shaped
import type { ContainerNode } from "./types.js";
// (`[Section]` + `Key=Value`) but keys may repeat within a section (e.g. several
// `ExecStartPre=` or `Environment=`). Indexed with a single line scan into a
// stable path per value plus its source range, mirroring the TOML/XML adapters.
//
// Path: `Section.Key`, or `Section.Key[i]` for the i-th occurrence of a repeated
// key (order is significant in systemd, so a positional index is the right
// identity here). Scalar one-line values; line-continued (`\`) values are
// skipped.

export type SystemdEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number]; path: string; containers: ContainerNode[] };

const DEFAULT_SECTION = "Unit";

export function systemdIndex(content: string): SystemdEntry[] {
  const lines = content.split("\n");
  type Raw = { section: string; key: string; value: string; line: number; range: [number, number]; sectionLine?: number };
  const raw: Raw[] = [];
  let offset = 0;
  let section = DEFAULT_SECTION;
  // Undefined until a header is actually read: the default section is assumed,
  // not written, so it has no line of its own (see ContainerNode.line).
  let sectionLine: number | undefined;
  let continuation = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    if (continuation) { continuation = line.trimEnd().endsWith("\\"); continue; } // skip continued value lines
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    const sec = trimmed.match(/^\[(.+)\]$/);
    if (sec) { section = sec[1].trim(); sectionLine = i + 1; continue; }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (key === "") continue;
    const rhs = line.slice(eq + 1);
    const leading = rhs.length - rhs.trimStart().length;
    const value = rhs.trim();
    if (line.trimEnd().endsWith("\\")) { continuation = true; continue; } // multi-line value: skip
    if (value === "") continue;
    const tokenStart = lineStart + eq + 1 + leading;
    raw.push({ section, key, value, line: i + 1, range: [tokenStart, tokenStart + value.length], sectionLine });
  }

  const counts = new Map<string, number>();
  for (const r of raw) counts.set(`${r.section}\u0000${r.key}`, (counts.get(`${r.section}\u0000${r.key}`) ?? 0) + 1);
  const seen = new Map<string, number>();

  return raw.map((r) => {
    const ck = `${r.section}\u0000${r.key}`;
    const repeated = (counts.get(ck) ?? 0) > 1;
    const occ = seen.get(ck) ?? 0;
    seen.set(ck, occ + 1);
    const suffix = repeated ? `[${occ}]` : "";
    // Keep the param key unique within the section so a repeated key (e.g. two
    // ExecStartPre=) stays individually addressable.
    // A section groups and nothing else — it has no argument, so no subject.
    const node: ContainerNode = { name: r.section, pathSeg: r.section, headings: [r.section], ...(r.sectionLine === undefined ? { nameFromDocs: true } : { line: r.sectionLine }) };
    return { categoryPath: [r.section], key: r.key + suffix, value: r.value, line: r.line, range: r.range, path: `${r.section}.${r.key}${suffix}`, containers: [node] };
  });
}

export type SystemdLocate = { value: string } | { error: string };
export function systemdLocate(content: string, path: string): SystemdLocate {
  const e = systemdIndex(content).find((x) => x.path === path);
  return e ? { value: e.value } : { error: "path not found" };
}

export type SystemdEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function systemdEdit(content: string, path: string, current: string, suggested: string): SystemdEdit {
  const e = systemdIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  const before = content.slice(start, end);
  const after = before.startsWith('"') && before.endsWith('"') ? `"${suggested.replace(/"/g, '\\"')}"` : suggested;
  return { status: "applied", content: content.slice(0, start) + after + content.slice(end), before, after };
}
