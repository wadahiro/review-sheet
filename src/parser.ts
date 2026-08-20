// Pluggable ConfigParser registry: each format registers a parser once, then
// extract/apply/verify all go through resolveParser() instead of per-format
// `if (fmt === "...")` chains.

import type { SourceLocation, LangText, ContainerNode } from "./types.js";
import { sharedRegistry } from "./registry.js";

export type Entry = {
  categoryPath: string[];
  // The blocks ENCLOSING this value, innermost last, as the parser's own walk
  // saw them — one entry per element/block, never per address step.
  //
  // `categoryPath` is the same chain flattened for display and cannot be read
  // back: a parser may put one block on screen as two names, and the shape
  // differs per format, so which is which is unrecoverable from the strings.
  // `source.path` cannot be read back either — a logrotate pattern contains the
  // separator (`/var/log/a.log.rotate`), so its own boundaries are ambiguous.
  // Both are PROJECTIONS of this; joining runs one way and always works, while
  // splitting never did.
  //
  // Optional because it is a capability, not an obligation: a parser with no
  // tree to walk (ini, sysctl, the line formats) omits it rather than inventing
  // a chain, which is the honest answer and the one a reader can act on.
  containers?: ContainerNode[];
  key: string;
  value: string;
  source: SourceLocation;
  // This entry's value is PRESENCE — the file records the setting by the thing
  // being there, not by writing a value beside a name (a logrotate `missingok`,
  // a service listed in a firewall zone). Stated by the parser that read it,
  // because how a format records a setting is a fact about the format.
  //
  // Deliberately not left to be inferred from `value === PRESENCE_VALUE`: a
  // product whose legitimate value happens to be the string `true` would be
  // read as presence, and nothing would say so.
  presence?: true;
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
  // The base format of a `.j2`, when its own stripped name cannot say. A
  // template is named for the file it produces, and that name is usually
  // enough (`keycloak.conf.j2` -> `.conf`) — until it is not: a systemd drop-in
  // is a bare `.conf`, claimed by nothing, and only the path it is DEPLOYED to
  // identifies it. Consumed by the jinja2 parser as a fallback, never as an
  // override: it must not silently reinterpret a template whose own name is
  // unambiguous.
  //
  // Deliberately not `format` on extractFile: naming a format there SKIPS
  // detection entirely, which for a `.j2` means skipping the jinja2 parser and
  // with it every `{{ var }}` link — the rows come out holding template text.
  baseFormat?: string;
};

export interface ParserMeta {
  title: string;        // display name, e.g. "YAML", "nginx"
  summary: string;      // one-liner for the index/CLI list
  files: string;        // "*.yaml *.yml", "content-detected", "fallback"
  detection: string;    // "extension", "content (<Tag> blocks)", "always (fallback)"
  delimiter?: string;   // line formats only
  comments?: string;    // line formats only
  pathStyle?: string;   // how paths are structured
  // What this parser reports as the BLOCKS enclosing a value, and which of them
  // carry an argument that becomes a row of its own. Absent means the format
  // has no tree to report, which is an answer — not a gap.
  containers?: string;
  notes?: string[];     // limitations / behavior bullets
  examples?: string[];  // example path strings or snippets
}

export interface ConfigParser {
  name: string;
  priority?: number;
  meta?: ParserMeta;
  // This parser WRAPS another one and resolves the inner format itself from
  // `ExtractOptions.baseFormat` (jinja2 is the only shipped example: a `.j2`
  // is a template around a config, not a config). It changes one thing —
  // `parserForSource` below hands such a parser the declared base format to
  // delegate with, instead of using that format to replace it, which would
  // read the raw template as if the `{{ }}` were not there.
  wrapsBaseFormat?: boolean;
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

// The identity a BLOCK's address names, found in a parser's own index.
//
// A block is not an entry — an element is not a value — so no index lookup
// answers for its address, and a container row on a format that resolves by
// path reported "no locator" and went unchecked. But the identity IS written in
// the file, at a place the same walk already recorded, so every parser answers
// the same way: rebuild each entry's chain and see whether one of its prefixes
// is the address being asked about.
//
// Shared rather than repeated per parser: eight copies of a six-line search is
// how the two spellings of a path drifted apart in the first place.
export function containerSubjectAt(entries: { containers?: ContainerNode[] }[], path: string): string | undefined {
  for (const e of entries) {
    let addr = "";
    for (const n of e.containers ?? []) {
      addr = addr ? `${addr}.${n.pathSeg}` : n.pathSeg;
      if (addr === path && n.subject !== undefined) return n.subject;
    }
  }
  return undefined;
}

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

// Every registered parser's name, for an error message that can list what IS
// available rather than only what is not.
export function parserNames(): string[] {
  return registry.map((p) => p.name).sort();
}

export function resolveParser(file: string, content: string): ConfigParser | undefined {
  const sorted = [...registry].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return sorted.find((p) => p.detect(file, content));
}

// The parser to READ a recorded location back with, and the options to read it
// under. Detection alone is not enough here: a format that had to be DECLARED
// (`SourceLocation.baseFormat`) is one the file name cannot answer for, and
// `space` is never detected at all — so a row written by the declared parser
// would be read back by whichever one the extension happens to select, and
// resolve differently or not at all.
//
// Two shapes, decided by `wrapsBaseFormat`:
//   - a template parser stays, and is TOLD the base format to delegate to
//     (replacing it would read the raw `{{ }}` template as a config);
//   - anything else is replaced by the declared format outright.
// With no declared format this is exactly `resolveParser` plus the caller's
// own options, which is what every source recorded before this field had.
export function parserForSource(
  file: string,
  content: string,
  source: SourceLocation,
  opts?: ExtractOptions
): { parser: ConfigParser | undefined; opts: ExtractOptions | undefined } {
  const detected = resolveParser(file, content);
  const declared = source.baseFormat;
  if (declared === undefined) return { parser: detected, opts };
  const merged = { ...opts, baseFormat: declared };
  if (detected?.wrapsBaseFormat) return { parser: detected, opts: merged };
  return { parser: getParser(declared) ?? detected, opts: merged };
}
