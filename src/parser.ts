// Pluggable ConfigParser registry: each format registers a parser once, then
// extract/apply/verify all go through resolveParser() instead of per-format
// `if (fmt === "...")` chains.

import type { SourceLocation, LangText } from "./types.js";
import { sharedRegistry } from "./registry.js";

export type Entry = {
  categoryPath: string[];
  key: string;
  value: string;
  source: SourceLocation;
  // Optional documentation a parser can co-extract (e.g. the annotation parser
  // reads these from in-source `@rs` comments). Most parsers only set value/source.
  description?: string;
  default?: string;
  remarks?: string;
  out_of_scope?: { reason: LangText; owner?: string };
  extra?: Record<string, string>;
  // File-level directives (annotation parser): override the sheet name, and tag
  // the value as a Pattern B instance so same-key values across files group.
  sheet?: string;
  instance?: string;
};

// `fallback` on a successful locate/edit records that the value was reached by a
// WEAKER mechanism than its source map claims — the model recorded a structural
// `path`, that path did not resolve, and the line+anchor fallback rescued it.
// Without it, "resolved by path" and "the path is broken but the line happened to
// match" are indistinguishable in verify/apply output, so a source map that is one
// reordering away from breaking reads as sound. It holds a short reason, and is
// only ever set when a path was recorded: a value mapped by line/anchor alone is
// using its intended mechanism, not falling back.
export type EditResult =
  | { status: "applied"; content: string; before: string; after: string; fallback?: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export type LocateResult =
  | { value: string; fallback?: string }
  | { error: string; status?: "warn" | "unmapped" };

// Configuration threaded through extraction (and, for the annotation
// parsers, locate/edit too) as an ordinary argument instead of process-wide
// state. Earlier this WAS process-wide state — a module-scope `let`, later a
// shared cross-copy cell (see registry.ts's history) — because
// `ConfigParser.extract`/`.locate`/`.edit` took no options and threading one
// through every parser to serve one or two settings looked like a worse
// trade than a global. That stopped being true
// the moment two copies of this package could exist in one process (the
// plugin registries' `sharedRegistry`, registry.ts): a `build.yml`'s
// `id_fields`, set on ONE copy's global cell, was invisible to whichever
// copy's `extractTree()` actually ran the extraction — silently ignored.
//
// A caller that actually HAS per-call configuration (assembleFromSpecWithReport
// building from one build.yml's `id_fields`, a CLI flag for one `import`/
// `verify`/`apply`/`serve` invocation) passes it here, all the way down to
// the parser that does the real work — no module-scope cell in between for
// two different copies of this package to disagree about.
export type ExtractOptions = {
  // Extra field names identifying a list-of-maps item, tried before the
  // built-in name/id/key. Consumed by the yaml/json parser (extractTree); a
  // parser with no such concept ignores it.
  idFields?: string[];
  // In-source annotation marker, default "@rs" (see annotation.ts). Consumed
  // by the ts/py annotation parsers' extract/locate/edit.
  marker?: string;
};

export interface ParserMeta {
  title: string;        // display name, e.g. "YAML", "nginx"
  summary: string;      // one-liner for the index/CLI list
  files: string;        // "*.yaml *.yml", "content-detected", "fallback"
  detection: string;    // "extension", "content (<Tag> blocks)", "always (fallback)"
  delimiter?: string;   // line formats only
  comments?: string;    // line formats only
  pathStyle?: string;   // how paths are structured
  notes?: string[];     // limitations / behavior bullets
  examples?: string[];  // example path strings or snippets
}

export interface ConfigParser {
  name: string;
  priority?: number;
  meta?: ParserMeta;
  detect(file: string, content: string): boolean;
  // `opts` is optional and last on all three methods, so an existing
  // implementation with fewer parameters (`extract(content, file) { ... }`,
  // `locate(content, source, expected) { ... }`) still satisfies this type
  // unchanged — TypeScript allows an implementation with fewer parameters
  // than its declared type, and at runtime a JS function simply ignores an
  // argument it never named. A parser with no use for `opts` (most of them —
  // only the yaml/json and ts/py parsers read it) needs no code change at all.
  extract(content: string, file: string, opts?: ExtractOptions): Entry[];
  locate(content: string, source: SourceLocation, expected: string, opts?: ExtractOptions): LocateResult;
  edit(content: string, source: SourceLocation, current: string, suggested: string, opts?: ExtractOptions): EditResult;
}

// Process-wide, so a plugin that resolved its own copy of this module still
// registers into the array the CLI reads — see registry.ts.
const registry = sharedRegistry<ConfigParser>("review-sheet.parsers.v1");

export function registerParser(p: ConfigParser): void {
  const i = registry.findIndex((r) => r.name === p.name);
  if (i >= 0) registry[i] = p;
  else registry.push(p);
}

export function listParsers(): ConfigParser[] {
  return [...registry];
}

export function getParser(name: string): ConfigParser | undefined {
  return registry.find((p) => p.name === name);
}

export function resolveParser(file: string, content: string): ConfigParser | undefined {
  const sorted = [...registry].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return sorted.find((p) => p.detect(file, content));
}
