// Generic, deterministic extraction: read a configuration file and produce a
// draft parameter-sheet model with accurate source maps. This is the universal
// foundation — line-oriented key/value formats plus YAML/JSON — that the
// declarative tool profiles (Ansible, Helm, …) will build on later.
//
// Each extracted value carries its source (line + anchor, and a structural path
// for YAML/JSON) so the resulting model passes `verify` and is `apply`-able by
// construction. File I/O lives in the CLI; this module is pure.

import { parseDocument, isMap, isSeq, isScalar, type Node } from "yaml";
import type { ParameterSheetInput, Sheet, Category, SourceLocation, InstanceParameter, Instance, LangText } from "./types.js";
import { getParser, resolveParser, parserNames, type ConfigParser, type ExtractOptions } from "./parser.js";
import "./parsers/index.js";
// Re-export line primitives so external code and parsers can share them.
export { extractLines, LINE_CONFIGS } from "./line-config.js";
export type { LineConfig } from "./line-config.js";
// Re-exported so a caller only needs to import from extract.ts (where the
// options actually get consumed) rather than also reaching into parser.ts.
export type { ExtractOptions } from "./parser.js";

export type Format =
  | "yaml"
  | "json"
  | "xml"
  | "toml"
  | "systemd"
  | "nginx"
  | "httpd"
  | "haproxy"
  | "jinja2"
  | "properties"
  | "dotenv"
  | "sysctl"
  | "ini"
  | "space"
  | "generic";

// A single extracted assignment, with the category path it should nest under.
// Optional doc fields are co-extracted by parsers that can (e.g. annotations).
export type Entry = {
  categoryPath: string[];
  key: string;
  value: string;
  source: SourceLocation;
  description?: string;
  default?: string;
  remarks?: string;
  out_of_scope?: { reason: LangText; owner?: string };
  extra?: Record<string, string>;
  sheet?: string;
  instance?: string;
};

const DEFAULT_CATEGORY = "Parameters";

export function inferFormat(file: string): Format {
  const f = file.toLowerCase();
  if (f.endsWith(".j2")) return "jinja2";
  if (f.endsWith(".yaml") || f.endsWith(".yml")) return "yaml";
  if (f.endsWith(".json")) return "json";
  if (f.endsWith(".xml")) return "xml";
  if (f.endsWith(".toml")) return "toml";
  if (/\.(service|timer|socket|mount|target|path|slice|scope|automount|netdev|network|link)$/.test(f)) return "systemd";
  if (f.endsWith(".env")) return "dotenv";
  if (f.endsWith(".properties")) return "properties";
  if (f.endsWith(".ini") || f.endsWith(".cfg")) return "ini";
  if (f.endsWith(".conf")) return "sysctl";
  return "generic";
}

function basename(file: string): string {
  return file.split("/").pop() ?? file;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content[i] === "\n") line++;
  return line;
}

// ---- YAML / JSON -------------------------------------------------------------

// A path segment for a structured leaf. Sequence-of-map items are addressed by
// an identity predicate `[field=value]` (reorder-robust); other sequence items
// by positional index `[i]`.
type Seg = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "filter"; field: string; value: string };

function quoteSeg(v: string): string {
  return /^[\w.\-:/]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
}

// A key segment is joined with a leading `.`, and an identity predicate/index
// segment with `[...]` — so a key that itself contains `.`, `[`, or `]` is
// ambiguous with those separators once the path is re-parsed by
// `parseSteps` (src/structural.ts). Keycloak SAML client attributes are a real
// example: the key IS `saml.client.signature`, not three nested keys. Such a
// key is rendered bracket-quoted instead — `attributes["saml.client.signature"]`
// — which `parseSteps` already understands (that syntax was added earlier for
// quoted identity-predicate values, so only generation was missing it, not
// interpretation). Keys without those characters keep the plain `.key` form
// unchanged, so paths recorded by earlier versions of this function still
// parse exactly as before.
function keyNeedsQuoting(k: string): boolean {
  return /[.[\]]/.test(k);
}
function quoteKey(k: string): string {
  return k.includes('"') ? `['${k.replace(/'/g, "\\'")}']` : `["${k.replace(/"/g, '\\"')}"]`;
}
function renderPath(segs: Seg[]): string {
  let s = "";
  for (const seg of segs) {
    if (seg.kind === "key") s += keyNeedsQuoting(seg.key) ? quoteKey(seg.key) : s ? `.${seg.key}` : seg.key;
    else if (seg.kind === "index") s += `[${seg.index}]`;
    else s += `[${seg.field}=${quoteSeg(seg.value)}]`;
  }
  return s;
}
function segCatName(seg: Seg): string {
  return seg.kind === "key" ? seg.key : seg.kind === "index" ? `[${seg.index}]` : seg.value;
}

// A field that uniquely identifies every item of a sequence-of-maps, so list
// items can be addressed by identity instead of position.
//
// The built-in names cover most config shapes, but not all: Keycloak's realm
// export identifies a client by `clientId` and carries none of these, so its
// clients fall back to `clients[0]` — a positional address that silently starts
// pointing at a different client the moment the list is reordered. Extra field
// names are therefore configurable, and are tried BEFORE the built-ins: naming a
// field is an explicit statement about this project's data and should win over
// the generic guess (Keycloak clients may also carry a display `name`, which is
// not the identity).
//
// EXTRACTION needs this — a path's predicate carries its own field name, so
// verify/apply resolve `[clientId=…]` with no configuration at all.
//
// Threaded as an ordinary argument (`ExtractOptions.idFields`, parser.ts),
// not process-wide state: spec.ts's `id_fields` → assemble-spec.ts builds
// `RecipeIO.extractOptions` → a recipe passes it to `extractFile()` →
// `extractFile` passes it to `parser.extract()` → the yaml/json parser passes
// it to `extractTree()`. This used to be a process-wide `let`, later a
// shared cross-copy cell (registry.ts), because threading one option through
// every parser looked like a worse trade than a global — until two copies of this
// module could exist in one process (the plugin registries' `sharedRegistry`,
// registry.ts) and a `build.yml`'s `id_fields`, set on ONE copy's cell, was
// silently invisible to whichever copy's `extractTree()` actually ran the
// extraction.
const DEFAULT_ID_FIELDS = ["name", "id", "key"];

function resolveIdFields(opts?: ExtractOptions): string[] {
  return [...(opts?.idFields ?? []), ...DEFAULT_ID_FIELDS];
}

function identityField(items: unknown[], idFields: string[]): string | null {
  for (const f of idFields) {
    if (items.every((it) => isMap(it) && it.has(f))) {
      const vals = items.map((it) => String((it as { get(k: string): unknown }).get(f)));
      if (new Set(vals).size === vals.length) return f;
    }
  }
  return null;
}

export function extractTree(content: string, opts?: ExtractOptions): Entry[] {
  const idFields = resolveIdFields(opts);
  const out: Entry[] = [];
  const doc = parseDocument(content);

  // `skipField` drops a list item's identity field from its own params (it is
  // represented by the category / predicate instead).
  const visit = (node: Node | null, segs: Seg[], keyAnchor?: string, skipField?: string): void => {
    if (node === null) return;
    if (isScalar(node)) {
      // A null scalar is the document stating there is NO value here — YAML's
      // `key:` with nothing after it, JSON's `"key": null`. It is not a row: a
      // row asserts "this parameter is set to this", and `String(null)` used to
      // make that assertion with the four characters "null", a value no format
      // anywhere actually means. That is inventing data, not preserving it,
      // which is why this is a skip and not the silent row-drop this project
      // otherwise refuses — there was never a value to lose.
      //
      // It matters most for machine-rendered artifacts, where absence is
      // spelled out rather than omitted: a `terraform plan` writes every
      // argument a resource HAS, null for each one unset, so 86 of one sheet's
      // 301 "configured" rows were unset arguments claiming to hold the string
      // "null" — and the ones with a documented default were being kept out of
      // the "not set (product default)" section by their own fake value.
      if (node.value === null) return;
      const range = node.range;
      out.push({
        categoryPath: segs.slice(0, -1).map(segCatName),
        key: segs.length > 0 ? segCatName(segs[segs.length - 1]) : DEFAULT_CATEGORY,
        value: String(node.value),
        source: {
          line: range ? lineOf(content, range[0]) : undefined,
          anchor: keyAnchor,
          path: renderPath(segs),
        },
      });
      return;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        const k = pair.key;
        if (!isScalar(k)) continue;
        const kn = String(k.value);
        if (skipField && kn === skipField) continue;
        const keySrc = k.range ? content.slice(k.range[0], k.range[1]) : kn;
        visit((pair.value as Node) ?? null, [...segs, { kind: "key", key: kn }], `${keySrc}:`);
      }
      return;
    }
    if (isSeq(node)) {
      const idf = identityField(node.items, idFields);
      node.items.forEach((item, i) => {
        const seg: Seg = idf && isMap(item)
          ? { kind: "filter", field: idf, value: String((item as { get(k: string): unknown }).get(idf)) }
          : { kind: "index", index: i };
        visit(item as Node, [...segs, seg], undefined, idf ?? undefined);
      });
    }
  };

  visit((doc.contents as Node) ?? null, []);
  // Drop a top-level scalar document (no key) — nothing to map.
  return out.filter((e) => e.source.path !== "" || e.categoryPath.length > 0);
}

// ---- Public API --------------------------------------------------------------

// Shared by extractFile and buildInputWithReport, so the latter can report
// WHICH parser a file resolved to without re-deriving the dispatch rule
// (explicit format wins; otherwise content/extension detection) a second way.
function resolveFileParser(file: string, content: string, format?: Format): ConfigParser | undefined {
  if (format === undefined) return resolveParser(file, content);
  const parser = getParser(format);
  if (!parser) {
    // A named format that no parser answers to is a typo or a plugin that did
    // not load, and it used to be neither: an explicit format deliberately
    // skips detection, so the lookup returned nothing and the file contributed
    // zero rows to a build that then reported success. Measured on a real
    // spec — `format: line` (there is no "line" parser) silently dropped all 29
    // rows of a postgresql.conf and left a sheet holding nothing but the
    // dictionary's defaults, which looked entirely plausible.
    const near = nearestName(format, parserNames());
    throw new Error(
      `extract: no parser named "${format}" (asked for ${file})${near ? `. Did you mean "${near}"?` : ""} ` +
        `Available: ${parserNames().join(", ")}`
    );
  }
  return parser;
}

// A local Levenshtein rather than assemble.ts's suggestNearest: this module is
// imported BY the recipes that assemble.ts drives, and reaching back up for a
// string helper would tie the extraction layer to the assembly one.
function nearestName(name: string, candidates: string[]): string | undefined {
  const dist = (a: string, b: string): number => {
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let corner = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cell = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + (a[i - 1] === b[j - 1] ? 0 : 1));
        corner = prev[j];
        prev[j] = cell;
      }
    }
    return prev[b.length];
  };
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = dist(name, c);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best !== undefined && bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : undefined;
}

export function extractFile(content: string, file: string, format?: Format, opts?: ExtractOptions): Entry[] {
  const parser = resolveFileParser(file, content, format);
  if (!parser) return [];
  return parser.extract(content, file, opts);
}

function ensureCategory(categories: Category[], names: string[]): Category {
  let list = categories;
  let cat!: Category;
  for (const name of names) {
    let found = list.find((c) => c.name === name);
    if (!found) {
      found = { name, params: [], categories: [] };
      list.push(found);
    }
    if (!found.categories) found.categories = [];
    if (!found.params) found.params = [];
    cat = found;
    list = found.categories;
  }
  return cat;
}

// A template entry plus the source where its value actually lives. For a
// `{{ variable }}` value that is the variable file; for a literal it is the
// template itself.
export type ResolvedEntry = Entry & { resolvedSource?: SourceLocation };

// Resolve a template's values against its variable files — the template+vars
// pattern shared by Ansible (.j2 + group_vars/defaults), Helm (.tpl + values),
// Chef (.erb + attributes), Puppet (.epp + data), etc.
//
// The template is parsed (the jinja2 parser records `templateVar`, the variable
// behind each `{{ … }}`); each variable file is parsed into a name→location
// index. For every template entry:
//   - `{{ variable }}` value  -> `resolvedSource` points at where that variable
//     is defined in the first variable file that defines it (so it is the
//     apply/verify target); `undefined` if no file defines it.
//   - literal value           -> `resolvedSource` is the template location
//     itself (the literal is editable in the template).
//
// `variableFiles` are tried in order, first definition wins, so the caller
// encodes precedence (e.g. group_vars before defaults). File I/O is injected;
// this stays pure. The tool-specific parts (which file is "primary", turning
// per-environment files into Pattern B instances) stay in the caller.
export function resolveTemplateVars(
  templateFile: string,
  variableFiles: string[],
  readFile: (path: string) => string | null,
  opts?: ExtractOptions
): ResolvedEntry[] {
  const templateContent = readFile(templateFile);
  if (templateContent === null) return [];
  const entries = extractFile(templateContent, templateFile, undefined, opts);

  // name -> location, indexed by structural path and leaf key; first file (and
  // first definition within a file) wins.
  const index = new Map<string, SourceLocation>();
  for (const file of variableFiles) {
    const content = readFile(file);
    if (content === null) continue;
    for (const e of extractFile(content, file, undefined, opts)) {
      const loc: SourceLocation = {
        file,
        line: e.source.line,
        column: e.source.column,
        end_line: e.source.end_line,
        anchor: e.source.anchor,
        path: e.source.path,
      };
      const names = e.source.path ? [e.source.path, e.key] : [e.key];
      for (const name of names) if (!index.has(name)) index.set(name, loc);
    }
  }

  return entries.map((e): ResolvedEntry => {
    const templateVar = e.source.templateVar;
    if (templateVar !== undefined) {
      return { ...e, resolvedSource: index.get(templateVar) };
    }
    // Literal value: editable in the template itself (drop the jinja-only
    // templateVar hint, keep line/anchor/path/conditional).
    const { line, column, end_line, anchor, path, conditional } = e.source;
    return { ...e, resolvedSource: { file: templateFile, line, column, end_line, anchor, path, conditional } };
  });
}

// Per-file extraction outcome (P10 bug 1): which parser a file resolved to,
// and how many entries it produced. A file with `count === 0` contributed
// NOTHING to the model — before this report existed, buildInput's `continue`
// below made that indistinguishable from "this file had nothing to extract,
// as expected" the moment at least one OTHER file in the same call produced
// something (the single-file case still throws — see the CLI's "No
// parameters extracted" — but that gate only fires when EVERY file is empty,
// so a lone misdetected file hiding behind a working one sailed through
// silently: `import -f httpd.conf proxy.conf` reported "12 parameter(s) from
// 2 file(s)" while proxy.conf, misdetected as sysctl, contributed zero and
// was never mentioned). `parser` is what makes the report actionable — most
// often a zero-count file was matched by the WRONG parser (a `.conf` file
// sysctl claimed instead of the httpd parser that should have), and knowing
// which one it was is what tells a caller to pass --format.
export type FileExtractionReport = { file: string; parser?: string; count: number };
export type BuildReport = { files: FileExtractionReport[] };

// Build a ParameterSheetInput from one or more files, plus a per-file report
// of what happened (see FileExtractionReport) — the CLI uses the report to
// warn about a file that silently contributed nothing (see `import -f` in
// cli.ts). Sheets are keyed by name (an annotation `@rs:config sheet:`
// overrides the file's basename, so several files can contribute to one
// sheet); a value tagged with an `instance` groups with same-key values from
// other files into a Pattern B InstanceParameter.
export function buildInputWithReport(
  files: { file: string; content: string; format?: Format }[],
  opts?: ExtractOptions
): { input: ParameterSheetInput; report: BuildReport } {
  const sheetsByName = new Map<string, Sheet>();
  const order: string[] = [];
  const fileReports: FileExtractionReport[] = [];
  for (const f of files) {
    const parser = resolveFileParser(f.file, f.content, f.format);
    const entries = parser ? parser.extract(f.content, f.file, opts) : [];
    fileReports.push({ file: f.file, parser: parser?.name, count: entries.length });
    if (entries.length === 0) continue;
    for (const e of entries) {
      const sheetName = e.sheet ?? basename(f.file);
      let sheet = sheetsByName.get(sheetName);
      if (!sheet) {
        sheet = { name: sheetName, file_path: f.file, categories: [] };
        sheetsByName.set(sheetName, sheet);
        order.push(sheetName);
      }
      const cat = ensureCategory(sheet.categories, e.categoryPath.length > 0 ? e.categoryPath : [DEFAULT_CATEGORY]);
      cat.params = cat.params ?? [];
      const docs = {
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.default !== undefined ? { default: e.default } : {}),
        ...(e.remarks !== undefined ? { remarks: e.remarks } : {}),
        ...(e.out_of_scope !== undefined ? { out_of_scope: e.out_of_scope } : {}),
        ...(e.extra !== undefined ? { extra: e.extra } : {}),
      };
      if (e.instance) {
        const inst: Instance = { name: e.instance, value: e.value, source: e.source };
        const existing = cat.params.find((p): p is InstanceParameter => p.key === e.key && "instances" in p);
        if (existing) existing.instances.push(inst);
        else cat.params.push({ key: e.key, instances: [inst], ...docs });
      } else {
        cat.params.push({ key: e.key, value: e.value, source: e.source, ...docs });
      }
    }
  }
  return { input: { sheets: order.map((n) => sheetsByName.get(n)!) }, report: { files: fileReports } };
}

// Plain-input convenience for a caller that has no use for the per-file
// report (tests, a script that trusts its own inputs) — same shape as
// assembleSheets() next to assembleSheetsWithReport().
export function buildInput(
  files: { file: string; content: string; format?: Format }[],
  opts?: ExtractOptions
): ParameterSheetInput {
  return buildInputWithReport(files, opts).input;
}
