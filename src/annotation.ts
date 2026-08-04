// Language-agnostic core for in-source `@rs` annotations (see spec/annotation.md).
//
// It scans comment nodes for the marker and turns each into sheet metadata. The
// only language-specific knowledge lives in a `LangDescriptor` (which node kinds
// are "name = RHS value", and which ancestor kinds contribute a path segment), so
// the same engine works for any tree-sitter language. The parameter `value` is the
// verbatim source text of the property's right-hand side (literal OR a wrapped
// expression like `Duration.seconds(30)`); write-back replaces that node's range.

import { parse } from "@ast-grep/napi";
import type { NapiLang } from "@ast-grep/napi/types/lang";
import type { SgNode } from "@ast-grep/napi/types/sgnode";
import type { SourceLocation } from "./types.js";
import type { Entry, EditResult, LocateResult } from "./parser.js";

function unquote(t: string): string {
  const m = t.match(/^(['"`])([\s\S]*)\1$/);
  return m ? m[2] : t;
}

export const DEFAULT_MARKER = "@rs";

// The in-source annotation marker (CLI `--annotation-marker`, default "@rs")
// is threaded as an ordinary argument, all the way from the CLI down to
// wherever a file actually gets scanned — `annotationExtract` (extraction),
// `annotationLocate`/`annotationEdit` (verify/apply), `lintAnnotations`. Each
// defaults its `marker` parameter to `DEFAULT_MARKER`, so a caller that has
// no marker of its own (most callers, most of the time) gets the same
// behavior as an explicit "@rs". There used to be a process-wide getter/setter
// pair behind this because `locate`/`edit` had no natural place to receive a
// marker through — a `SourceLocation` carries no such field. It was removed
// once `ConfigParser.locate`/`.edit` grew an optional trailing `opts` parameter
// (parser.ts) that carries it the same way `ExtractOptions.marker` already
// carried it for `extract`. A process-wide box was fragile in the first
// place (two copies of this module in one process disagreeing
// about which cell is "the" marker).

// One language's syntactic shape. `valueKinds` are the "name = RHS" node kinds
// (TS: pair, variable_declarator). `pathSegments`/`constructKinds` are ancestor
// kinds that contribute a stable path segment (a declarator/class name, or a
// construct's id string), used to build a re-locatable `path`.
export type LangDescriptor = {
  lang: NapiLang;
  valueKinds: { kind: string; keyField: string; valueField: string }[];
  pathSegments: { kind: string; field: string }[];
  constructKinds: string[];
  // Node kinds that are plain string literals: their surrounding quotes are stripped
  // for display (`value`) and re-added on write-back (via `quote`). Wrapped values
  // and template literals are left verbatim.
  stringKinds: string[];
};

export type AnnotationSource = {
  line?: number; // 1-based
  column?: number; // 1-based
  end_line?: number;
  anchor?: string;
  path?: string;
};

export type AnnotationEntry = {
  categoryPath: string[];
  key: string;
  value: string;
  description?: string;
  default?: string;
  remarks?: string;
  outOfScope?: boolean;
  outOfScopeReason?: string;
  extra?: Record<string, string>;
  source: AnnotationSource;
  // Byte range of the value node, for surgical write-back.
  range: [number, number];
  // The original quote char for a plain string literal (so write-back can re-add it
  // around an unquoted `value`); undefined for non-string / wrapped values.
  quote?: string;
};

export type FileConfig = { sheet?: string; instance?: string; sourceFile?: string; lang?: string };

export type AnnotationResult = { config: FileConfig; entries: AnnotationEntry[]; warnings: string[] };

type AnyNode = SgNode;

// ---- comment text ------------------------------------------------------------

// Strip comment delimiters and per-line `*` to inner lines.
function commentLines(raw: string): string[] {
  let body = raw;
  if (body.startsWith("//")) body = body.slice(2);
  else if (body.startsWith("#")) body = body.slice(1);
  else if (body.startsWith("/*")) {
    body = body.slice(2);
    if (body.endsWith("*/")) body = body.slice(0, -2);
    return body.split("\n").map((l, i) => (i === 0 ? l : l.replace(/^\s*\*?/, "")).trim());
  }
  return body.split("\n").map((l) => l.trim());
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Split a line into leading text (before the first `<marker>:field`) and the fields.
// Fields are namespaced (`@rs:default`, `@rs:remarks`, …) for consistency with the
// `@rs:config`/`@rs:category` directives and to avoid clashing with JSDoc tags. A
// field value runs until the next `<marker>:` or end of line.
function splitFields(text: string, marker: string): { leading: string; fields: { name: string; value: string }[] } {
  const tag = `${marker}:`;
  const idx = text.indexOf(tag);
  if (idx < 0) return { leading: text, fields: [] };
  const leading = text.slice(0, idx);
  const rest = text.slice(idx);
  const fields: { name: string; value: string }[] = [];
  const re = new RegExp(`${escapeRe(tag)}([\\w.]+)[ \\t]*([\\s\\S]*?)(?=${escapeRe(tag)}|$)`, "g");
  for (const m of rest.matchAll(re)) fields.push({ name: m[1], value: m[2].trim() });
  return { leading, fields };
}

type ValueAnno = {
  param?: string;
  description?: string;
  default?: string;
  remarks?: string;
  outOfScope?: boolean;
  outOfScopeReason?: string;
  extra?: Record<string, string>;
};

// Parse a value annotation. The leading text on line 1 and any plain block lines
// are the description; `@field`s set the structured fields. The parameter key stays
// the code identifier unless `@param` overrides it — so `// @rs バケット名` keeps
// key = the property name and puts the Japanese in the description column.
function parseValueAnno(lines: string[], marker: string): ValueAnno {
  const collected: { name: string; value: string }[] = [];
  const desc: string[] = [];
  for (const ln of lines) {
    if (!ln) continue;
    const { leading, fields } = splitFields(ln, marker);
    const lead = leading.trim();
    if (lead) desc.push(lead);
    collected.push(...fields);
  }
  const anno: ValueAnno = {};
  for (const { name, value } of collected) {
    if (name === "param") anno.param = value;
    else if (name === "desc" || name === "description") desc.push(value);
    else if (name === "default") anno.default = value;
    else if (name === "remarks") anno.remarks = value;
    else if (name === "scope") {
      const v = value.trim();
      if (v.startsWith("out")) {
        anno.outOfScope = true;
        const reason = v.slice(3).trim();
        if (reason) anno.outOfScopeReason = reason;
      }
    } else if (name.startsWith("col.") || name.startsWith("extra.")) {
      anno.extra ??= {};
      anno.extra[name.slice(name.indexOf(".") + 1)] = value;
    }
  }
  if (desc.length) anno.description = desc.join("\n");
  return anno;
}

function parseConfig(text: string): FileConfig {
  const keys = ["sheet", "instance", "source_file", "lang"];
  const re = new RegExp(`(${keys.join("|")})\\s*:\\s*([^]*?)(?=\\s+(?:${keys.join("|")})\\s*:|$)`, "g");
  const cfg: FileConfig = {};
  for (const m of text.matchAll(re)) {
    const v = m[2].trim();
    if (m[1] === "sheet") cfg.sheet = v;
    else if (m[1] === "instance") cfg.instance = v;
    else if (m[1] === "source_file") cfg.sourceFile = v;
    else if (m[1] === "lang") cfg.lang = v;
  }
  return cfg;
}

// ---- comment classification --------------------------------------------------

type Kind = "config" | "category" | "value" | "none";
type Parsed = { node: AnyNode; lines: string[]; kind: Kind; rest: string };

function classify(node: AnyNode, marker: string): Parsed {
  const lines = commentLines(node.text());
  const first = lines[0] ?? "";
  if (!first.startsWith(marker)) return { node, lines, kind: "none", rest: "" };
  const after = first.slice(marker.length);
  if (after.startsWith(":config")) return { node, lines, kind: "config", rest: after.slice(":config".length).trim() };
  if (after.startsWith(":category")) return { node, lines, kind: "category", rest: after.slice(":category".length).trim() };
  // Bare marker or `@rs <label>` (next char is whitespace or end) → value annotation.
  if (after === "" || /^[\s@]/.test(after)) {
    lines[0] = first.slice(marker.length).trim();
    return { node, lines, kind: "value", rest: "" };
  }
  return { node, lines, kind: "none", rest: "" };
}

// ---- node helpers ------------------------------------------------------------

const startIdx = (n: AnyNode): number => n.range().start.index;
const endIdx = (n: AnyNode): number => n.range().end.index;

function firstStringArg(node: AnyNode): string | undefined {
  const str = node.find({ rule: { kind: "string" } });
  return str ? str.text().replace(/^['"`]|['"`]$/g, "") : undefined;
}

function buildPath(node: AnyNode, key: string, desc: LangDescriptor): string {
  const segs: string[] = [];
  for (const anc of node.ancestors()) {
    const k = String(anc.kind());
    const ps = desc.pathSegments.find((p) => p.kind === k);
    if (ps) {
      const f = anc.field(ps.field);
      if (f) segs.push(f.text());
    } else if (desc.constructKinds.includes(k)) {
      const id = firstStringArg(anc);
      if (id) segs.push(id);
    }
  }
  segs.reverse(); // ancestors() is inner→outer; we want outer→inner
  segs.push(key);
  return segs.join(".");
}

// ---- category lexical scope --------------------------------------------------

type CatScope = { node: AnyNode; name: string; start: number; end: number };

// Scope of a category comment = following siblings in its parent block + their
// descendants, until the next category comment in the same parent (bounded by the
// parent block). Accumulation outer→inner happens at resolve time.
function categoryScopes(cats: Parsed[]): CatScope[] {
  return cats.map((c) => {
    const parent = c.node.parent();
    const start = endIdx(c.node);
    let end = parent ? endIdx(parent) : start;
    if (parent) {
      const next = parent
        .children()
        .filter((ch) => startIdx(ch) > startIdx(c.node) && cats.some((cc) => cc.node.id() === ch.id()))
        .sort((a, b) => startIdx(a) - startIdx(b))[0];
      if (next) end = startIdx(next);
    }
    return { node: c.node, name: c.rest, start, end };
  });
}

function resolveCategory(node: AnyNode, scopes: CatScope[]): string[] {
  const at = startIdx(node);
  return scopes
    .filter((s) => s.start <= at && at < s.end)
    .sort((a, b) => startIdx(a.node) - startIdx(b.node))
    .flatMap((s) => s.name.split("/").map((x) => x.trim()).filter(Boolean));
}

// ---- association -------------------------------------------------------------

type ValueNode = { node: AnyNode; vk: LangDescriptor["valueKinds"][number] };

function trailingTarget(comment: AnyNode, values: ValueNode[]): ValueNode | undefined {
  const cs = comment.range().start;
  // A value node that ends before the comment, on the comment's line.
  return values
    .filter((v) => v.node.range().start.line === cs.line && endIdx(v.node) <= cs.index)
    .sort((a, b) => endIdx(b.node) - endIdx(a.node))[0];
}

// The value node after a leading comment, walking over consecutive line-adjacent
// continuation comments (e.g. a follow-up `// @remarks …` line). Returns the extra
// continuation lines to merge into the annotation. A following comment that itself
// starts with the marker is a separate annotation and stops the walk.
function leadingTarget(comment: AnyNode, values: ValueNode[], marker: string): { vn: ValueNode; extra: string[] } | undefined {
  const extra: string[] = [];
  let cur = comment;
  for (;;) {
    const nxt = cur.next();
    if (!nxt) return undefined;
    if (String(nxt.kind()) === "comment") {
      if (nxt.range().start.line !== cur.range().end.line + 1) return undefined; // a gap → not a continuation
      // A separate annotation (value/`@rs:config`/`@rs:category`) stops the merge;
      // an `@rs:field` line classifies as "none" and is absorbed as a continuation.
      if (classify(nxt, marker).kind !== "none") return undefined;
      extra.push(...commentLines(nxt.text()));
      cur = nxt;
      continue;
    }
    const vn = values.find((v) => v.node.id() === nxt.id());
    return vn ? { vn, extra } : undefined;
  }
}

// ---- public API --------------------------------------------------------------

export function extractAnnotations(content: string, desc: LangDescriptor, marker = DEFAULT_MARKER): AnnotationResult {
  const root = parse(desc.lang, content).root();
  const warnings: string[] = [];

  const parsedComments = root
    .findAll({ rule: { kind: "comment" } })
    .map((n) => classify(n, marker))
    .filter((p) => p.kind !== "none");

  const config: FileConfig = {};
  for (const p of parsedComments.filter((c) => c.kind === "config")) Object.assign(config, parseConfig(p.rest));

  const scopes = categoryScopes(parsedComments.filter((c) => c.kind === "category"));

  const values: ValueNode[] = desc.valueKinds.flatMap((vk) =>
    root.findAll({ rule: { kind: vk.kind } }).map((node) => ({ node, vk }))
  );

  // Detect a value node carrying both a leading and a trailing @rs (ambiguous).
  const targets = new Map<number, Parsed[]>();
  const entries: AnnotationEntry[] = [];

  for (const p of parsedComments.filter((c) => c.kind === "value")) {
    let target = trailingTarget(p.node, values);
    let extraLines: string[] = [];
    if (!target) {
      const led = leadingTarget(p.node, values, marker);
      if (led) {
        target = led.vn;
        extraLines = led.extra;
      }
    }
    if (!target) {
      warnings.push(`@rs comment not associated with a value: ${JSON.stringify(p.node.text())}`);
      continue;
    }
    const id = target.node.id();
    const seen = targets.get(id);
    if (seen) {
      seen.push(p);
      warnings.push(`value has multiple @rs annotations (leading + trailing): ${JSON.stringify(target.node.text())}`);
      continue;
    }
    targets.set(id, [p]);

    const valueNode = target.node.field(target.vk.valueField);
    const keyNode = target.node.field(target.vk.keyField);
    if (!valueNode || !keyNode) {
      warnings.push(`value node missing key/value field: ${JSON.stringify(target.node.text())}`);
      continue;
    }
    const anno = parseValueAnno(extraLines.length ? [...p.lines, ...extraLines] : p.lines, marker);
    // Structural key (unquoted, e.g. a Python dict's "read_capacity") for the path
    // and as the default param label.
    const structKey = unquote(keyNode.text());
    const key = anno.param ?? structKey;
    const r = valueNode.range();
    // Plain string literals: show the inner text, remember the quote for write-back.
    const raw = valueNode.text();
    let value = raw;
    let quote: string | undefined;
    if (desc.stringKinds.includes(String(valueNode.kind()))) {
      const m = raw.match(/^(['"`])([\s\S]*)\1$/);
      if (m) {
        quote = m[1];
        value = m[2];
      }
    }
    entries.push({
      categoryPath: resolveCategory(target.node, scopes),
      key,
      value,
      description: anno.description,
      default: anno.default,
      remarks: anno.remarks,
      outOfScope: anno.outOfScope,
      outOfScopeReason: anno.outOfScopeReason,
      extra: anno.extra,
      source: {
        line: r.start.line + 1,
        column: r.start.column + 1,
        end_line: r.end.line + 1,
        anchor: raw,
        path: buildPath(target.node, structKey, desc),
      },
      range: [r.start.index, r.end.index],
      quote,
    });
  }

  return { config, entries, warnings };
}

// ---- shared ConfigParser pieces (used by the per-language parsers) -----------

function errorCount(src: string, lang: NapiLang): number {
  try {
    return parse(lang, src).root().findAll({ rule: { kind: "ERROR" } }).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

// Map annotation entries to the registry `Entry` shape (config sheet/instance
// threaded in; an instance value pins its file so apply edits the right one).
//
// `marker` defaults to DEFAULT_MARKER so a caller with no opts to give gets
// "@rs"; the ts/py parsers pass `opts?.marker` explicitly, which is
// `undefined` (falling through to the default) exactly when the caller
// didn't set one.
export function annotationExtract(content: string, file: string, desc: LangDescriptor, marker: string = DEFAULT_MARKER): Entry[] {
  const { config, entries } = extractAnnotations(content, desc, marker);
  return entries.map((e) => ({
    categoryPath: e.categoryPath,
    key: e.key,
    value: e.value,
    description: e.description,
    default: e.default,
    remarks: e.remarks,
    out_of_scope: e.outOfScope ? { reason: e.outOfScopeReason ?? "" } : undefined,
    extra: e.extra,
    sheet: config.sheet,
    instance: config.instance,
    source: {
      line: e.source.line,
      column: e.source.column,
      end_line: e.source.end_line,
      anchor: e.source.anchor,
      path: e.source.path,
      ...(config.instance ? { file } : {}),
    },
  }));
}

export function annotationLocate(content: string, source: SourceLocation, desc: LangDescriptor, marker: string = DEFAULT_MARKER): LocateResult {
  if (!source.path) return { error: "no path", status: "unmapped" };
  const e = extractAnnotations(content, desc, marker).entries.find((x) => x.source.path === source.path);
  return e ? { value: e.value } : { error: "path not found" };
}

// Edit by RHS range; re-quote a string literal (value is stored unquoted); reject
// any change that would increase the parse-error count (broken syntax).
export function annotationEdit(content: string, source: SourceLocation, current: string, suggested: string, desc: LangDescriptor, marker: string = DEFAULT_MARKER): EditResult {
  if (!source.path) return { status: "error", reason: "no path" };
  const e = extractAnnotations(content, desc, marker).entries.find((x) => x.source.path === source.path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is ${JSON.stringify(e.value)}, expected ${JSON.stringify(current)}` };
  const [start, end] = e.range;
  const before = content.slice(start, end);
  const after = e.quote ? `${e.quote}${suggested}${e.quote}` : suggested;
  const updated = content.slice(0, start) + after + content.slice(end);
  if (errorCount(updated, desc.lang) > errorCount(content, desc.lang)) {
    return { status: "error", reason: "edit would produce invalid syntax" };
  }
  return { status: "applied", content: updated, before, after };
}

export type LintIssue = { line: number; rule: string; message: string };

// Tooling-friction checks (language-agnostic). `no-jsdoc` only fires where a
// language has `/** */` block comments (never for Python `#`), so one impl serves
// all languages.
export function lintAnnotations(content: string, lang: NapiLang, marker: string = DEFAULT_MARKER): LintIssue[] {
  const lines = content.split("\n");
  const issues: LintIssue[] = [];
  for (const c of parse(lang, content).root().findAll({ rule: { kind: "comment" } })) {
    const text = c.text();
    if (!text.includes(marker)) continue;
    const r = c.range();
    if (text.startsWith("/**")) {
      issues.push({ line: r.start.line + 1, rule: "no-jsdoc", message: `${marker} inside /** */ collides with doc tooling/hover — use /* */ or //` });
    }
    const inner = text.replace(/^\/\*+|^\/\/|^#/, "").trim();
    if (inner.startsWith(`${marker}:category`) && (lines[r.start.line]?.slice(0, r.start.column) ?? "").trim() !== "") {
      issues.push({ line: r.start.line + 1, rule: "category-own-line", message: `${marker}:category should be on its own line (a formatter may relocate an inline comment)` });
    }
  }
  return issues;
}
