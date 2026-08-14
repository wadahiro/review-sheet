// Structural (path-based) edit + locate for YAML and JSON, used as a fallback
// when a value cannot be isolated by a single line + anchor: nested or repeated
// leaves, minified JSON, or scalars inside multi-line containers.
//
// Edits are surgical — the scalar's source range is replaced in place, so all
// surrounding formatting and comments are preserved (no full re-serialization).
// YAML block scalars (| and >) are intentionally not edited here; they stay for
// the AI prompt.

import { parseDocument, isScalar, isMap, isSeq, type Scalar } from "yaml";

export type Format = "yaml" | "json";

export function inferFormat(file: string): Format | null {
  const lower = file.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  return null;
}

// Structured formats whose values are addressed by path (YAML/JSON via this
// module, XML via ./xml, TOML via ./toml). Used by apply/verify to resolve by
// path first.
export function structuredFormat(file: string): Format | "xml" | "toml" | "systemd" | null {
  const f = inferFormat(file);
  if (f) return f;
  const lower = file.toLowerCase();
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".toml")) return "toml";
  if (/\.(service|timer|socket|mount|target|path|slice|scope|automount|netdev|network|link)$/.test(lower)) return "systemd";
  // A systemd drop-in: `*.conf` under a `*.conf.d/` directory, which is how
  // every one of its daemons is configured without editing the shipped file
  // (journald.conf.d, system.conf.d, resolved.conf.d). Same INI-with-sections
  // grammar as a unit; only the extension differs, and `.conf` alone is far too
  // common to claim.
  if (/\.conf\.d\/[^/]+\.conf$/.test(lower)) return "systemd";
  return null;
}

// A path step. Maps are addressed by key (position-independent), sequences by an
// identity predicate `[field=value]` (robust to reordering) or, as a fallback,
// a positional index `[i]`.
export type PathStep =
  | { kind: "key"; key: string }
  | { kind: "index"; index: number }
  | { kind: "filter"; field: string; value: string };

// Parse a path like "server.port", "hosts[0]", or "services[name=web].port"
// (also "$"-prefixed and quoted keys) into steps.
export function parseSteps(path: string): PathStep[] {
  let p = path.trim();
  if (p.startsWith("$")) p = p.slice(1);
  const steps: PathStep[] = [];
  const re = /\.([^.[\]]+)|\[(\d+)\]|\[\s*([\w.\-:/]+)\s*=\s*"([^"]*)"\s*\]|\[\s*([\w.\-:/]+)\s*=\s*'([^']*)'\s*\]|\[\s*([\w.\-:/]+)\s*=\s*([^\]]+?)\s*\]|\["([^"]+)"\]|\['([^']+)'\]|^([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(p)) !== null) {
    if (m[1] !== undefined) steps.push({ kind: "key", key: m[1] });
    else if (m[2] !== undefined) steps.push({ kind: "index", index: Number(m[2]) });
    else if (m[3] !== undefined) steps.push({ kind: "filter", field: m[3], value: m[4] });
    else if (m[5] !== undefined) steps.push({ kind: "filter", field: m[5], value: m[6] });
    else if (m[7] !== undefined) steps.push({ kind: "filter", field: m[7], value: m[8] });
    else if (m[9] !== undefined) steps.push({ kind: "key", key: m[9] });
    else if (m[10] !== undefined) steps.push({ kind: "key", key: m[10] });
    else if (m[11] !== undefined) steps.push({ kind: "key", key: m[11] });
  }
  return steps;
}

// Walk the parsed document by steps to the addressed scalar (or null). Map keys
// resolve by name, sequence filters by matching a child field, index by
// position — so a reordered map or a reordered list (addressed by identity) both
// still resolve to the right value.
function resolveScalar(doc: ReturnType<typeof parseDocument>, path: string): Scalar | null {
  let node: unknown = doc.contents;
  for (const step of parseSteps(path)) {
    if (node == null) return null;
    if (step.kind === "key") {
      if (!isMap(node)) return null;
      node = node.get(step.key, true) ?? null;
    } else if (step.kind === "index") {
      if (!isSeq(node)) return null;
      node = node.get(step.index, true) ?? null;
    } else {
      if (!isSeq(node)) return null;
      node = node.items.find((it) => isMap(it) && String((it.get(step.field) as unknown) ?? "") === step.value) ?? null;
    }
  }
  return node != null && isScalar(node) ? (node as Scalar) : null;
}

// A value that is safe to write unquoted in YAML (when in doubt, we quote).
function isPlainSafeYaml(s: string): boolean {
  if (s === "") return false;
  if (/^\s|\s$/.test(s)) return false;
  if (/[:#]/.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  return true;
}

// Render the replacement scalar so it matches the original's quoting style and
// stays valid for the format.
function renderScalar(orig: string, suggested: string, format: Format): string {
  if (orig.startsWith('"')) return JSON.stringify(suggested);
  if (orig.startsWith("'")) return "'" + suggested.replaceAll("'", "''") + "'";
  // plain
  if (format === "json") {
    return /^(-?\d+(\.\d+)?|true|false|null)$/.test(suggested) ? suggested : JSON.stringify(suggested);
  }
  return isPlainSafeYaml(suggested) ? suggested : JSON.stringify(suggested);
}

export type StructuralLocate = { value: string } | { error: string };

export function structuralLocate(content: string, path: string): StructuralLocate {
  let doc;
  try {
    doc = parseDocument(content);
  } catch {
    return { error: "could not parse file" };
  }
  const node = resolveScalar(doc, path);
  if (!node) return { error: "path not found or not a scalar" };
  return { value: String(node.value) };
}

export type StructuralEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function structuralEdit(
  content: string,
  format: Format,
  path: string,
  current: string,
  suggested: string
): StructuralEdit {
  let doc;
  try {
    doc = parseDocument(content);
  } catch {
    return { status: "error", reason: "could not parse file" };
  }
  const node = resolveScalar(doc, path);
  if (!node) return { status: "error", reason: "path not found or not a scalar" };
  const val = String(node.value);
  if (val === suggested && val !== current) return { status: "skipped" }; // idempotent
  if (val !== current) return { status: "error", reason: `value at path is "${val}", expected "${current}"` };
  const range = node.range;
  if (!range) return { status: "error", reason: "no source range" };
  const [start, valueEnd] = range;
  const orig = content.slice(start, valueEnd);
  if (orig.startsWith("|") || orig.startsWith(">")) {
    return { status: "error", reason: "block scalar (deferred to AI)" };
  }
  const after = renderScalar(orig, suggested, format);
  return { status: "applied", content: content.slice(0, start) + after + content.slice(valueEnd), before: orig, after };
}
