// TOML parser: wraps tomlIndex/tomlLocate/tomlEdit.

import { tomlIndex, tomlLocate, tomlEdit } from "../toml.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const tomlParser: ConfigParser = {
  name: "toml",
  priority: 20,
  meta: {
    title: "TOML",
    summary: "Tables and array-of-tables; reorder-robust paths; scalar values only.",
    files: "*.toml",
    detection: "extension (.toml)",
    delimiter: "key = value",
    comments: "#",
    pathStyle: "service[name=web].replicas — array-of-tables by identity; table.key — nested",
    notes: [
      "[table] headers become nested path segments.",
      "[[array-of-tables]] addressed by identity predicate: service[name=web].replicas.",
      "Scalar values only (strings, numbers, booleans, dates).",
      "Reorder-robust for tables and identity-keyed arrays.",
    ],
    examples: ["database.host", "service[name=web].replicas", "server.port"],
  },
  detect: (file) => file.toLowerCase().endsWith(".toml"),
  extract: (content) =>
    tomlIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = tomlLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return tomlEdit(content, source.path, current, suggested);
  },
};
registerParser(tomlParser);
