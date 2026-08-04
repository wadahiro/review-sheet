// YAML and JSON parsers: wraps extractTree + structuralEdit/structuralLocate
// with a line+anchor fallback for values addressed by line/anchor only.

import { extractTree } from "../extract.js";
import { structuralEdit, structuralLocate } from "../structural.js";
import { locateLine } from "../line-config.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

// No `format` parameter: locating a value is format-independent here —
// structuralLocate parses YAML and JSON through the same document model, and
// the line+anchor fallback is plain text. Only editing needs to know which
// syntax to re-emit (see makeYamlJsonEdit).
function makeYamlJsonLocate() {
  return (content: string, source: SourceLocation, expected: string): LocateResult => {
    // If structural path available, try it first
    let pathError: string | undefined;
    if (source.path) {
      const loc = structuralLocate(content, source.path);
      if ("value" in loc) return { value: loc.value };
      // Fall through to line+anchor if available
      if (source.line === undefined && !source.anchor) {
        return { error: loc.error, status: "unmapped" };
      }
      pathError = loc.error;
    }
    // Line + anchor fallback
    if (source.line !== undefined || source.anchor) {
      const lines = content.split("\n");
      const res = locateLine(lines, source, expected);
      // A recorded path that did not resolve means the line match is standing in
      // for structural addressing — report it rather than pass as a clean hit.
      if ("idx" in res) return pathError === undefined ? { value: expected } : { value: expected, fallback: `path "${source.path}" did not resolve: ${pathError}` };
      if (res.error.includes("ambiguous")) return { error: res.error, status: "warn" };
      return { error: res.error };
    }
    return { error: "no locator", status: "unmapped" };
  };
}

function makeYamlJsonEdit(format: "yaml" | "json") {
  return (content: string, source: SourceLocation, current: string, suggested: string): EditResult => {
    // Try structural path edit first
    let pathError: string | undefined;
    if (source.path) {
      const st = structuralEdit(content, format, source.path, current, suggested);
      if (st.status === "applied" || st.status === "skipped") return st;
      // st.status === "error": fall through to line+anchor
      pathError = st.reason;
    }
    // Line + anchor fallback
    if (source.line !== undefined || source.anchor) {
      const lines = content.split("\n");
      const res = locateLine(lines, source, current);
      if ("idx" in res) {
        const before = lines[res.idx];
        if (before.includes(suggested) && !before.includes(current)) {
          return { status: "skipped" };
        }
        const after = before.replace(current, suggested);
        lines[res.idx] = after;
        // Edited by line match because the recorded path did not resolve — the
        // edit is correct for THIS content but the source map is brittle.
        const fallback = pathError === undefined ? undefined : `path "${source.path}" did not resolve: ${pathError}`;
        return { status: "applied", content: lines.join("\n"), before, after, fallback };
      }
      // Check idempotency via source.line
      if (source.line !== undefined) {
        const lineIdx = source.line - 1;
        if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(suggested)) {
          return { status: "skipped" };
        }
      }
      const errReason = source.path
        ? `structural: path not resolved; line/anchor: ${res.error}`
        : res.error;
      return { status: "error", reason: errReason };
    }
    // No path and no line/anchor
    return { status: "error", reason: source.path ? "path not resolved and no line/anchor fallback" : "no locator" };
  };
}

const yamlParser: ConfigParser = {
  name: "yaml",
  priority: 20,
  meta: {
    title: "YAML",
    summary: "Nested leaves get a structural path; list-of-maps addressed by identity.",
    files: "*.yaml *.yml",
    detection: "extension (.yaml, .yml)",
    delimiter: "key: value",
    comments: "#",
    pathStyle: "services[name=web].port — list-of-maps by identity field; scalar lists by [i]",
    notes: [
      "Nested map keys produce a dotted path (e.g. database.host).",
      "List-of-maps addressed by identity: services[name=web].port.",
      "Scalar list items addressed by index: items[0].",
      "Structural path edit survives key/list reordering.",
    ],
    examples: ["database.host", "services[name=web].port", "items[0]"],
  },
  detect: (file) => {
    const f = file.toLowerCase();
    return f.endsWith(".yaml") || f.endsWith(".yml");
  },
  extract: (content, _file, opts) => extractTree(content, opts),
  locate: makeYamlJsonLocate(),
  edit: makeYamlJsonEdit("yaml"),
};
registerParser(yamlParser);

const jsonParser: ConfigParser = {
  name: "json",
  priority: 20,
  meta: {
    title: "JSON",
    summary: "Same as YAML including minified JSON; no comments.",
    files: "*.json",
    detection: "extension (.json)",
    delimiter: '"key": value',
    pathStyle: "services[name=web].port — same as YAML",
    notes: [
      "Handles minified JSON.",
      "No comment syntax.",
      "Path semantics identical to YAML.",
    ],
    examples: ["database.host", "services[name=web].port"],
  },
  detect: (file) => file.toLowerCase().endsWith(".json"),
  extract: (content, _file, opts) => extractTree(content, opts),
  locate: makeYamlJsonLocate(),
  edit: makeYamlJsonEdit("json"),
};
registerParser(jsonParser);
