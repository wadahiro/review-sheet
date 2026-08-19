// HCL (Terraform / Consul / Nomad / Vault / Packer) support.
import type { ContainerNode } from "./types.js";
import { containerSubjectAt } from "./parser.js";
// A self-contained character scanner builds a block tree with source ranges,
// mirroring the nginx adapter. Block paths use name+labels as segments, so
// reordering resources does not break source maps.
//
// Only scalar attribute values are emitted (double-quoted strings, numbers,
// booleans). Everything else — lists, maps, heredocs, interpolations,
// function-call expressions, and variable/data/local/module references — is
// silently skipped (→ AI prompt).

export type HclEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number]; path: string; containers: ContainerNode[] };

// ---- Tokeniser ---------------------------------------------------------------

function lineOf(content: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < content.length; i++) if (content[i] === "\n") n++;
  return n;
}

// Advance past a /* ... */ block comment starting at `i` (pointing to `/*`).
function skipBlockComment(content: string, i: number): number {
  i += 2; // skip /*
  while (i < content.length - 1) {
    if (content[i] === "*" && content[i + 1] === "/") return i + 2;
    i++;
  }
  return content.length;
}

// Read a double-quoted string starting at i (pointing to `"`), return end index
// (past closing `"`). Handles `\"` escapes and `${...}` (just scans, doesn't
// recurse — we only need boundaries).
function readQuotedString(content: string, i: number): number {
  i++; // skip opening "
  while (i < content.length) {
    const ch = content[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === '"') return i + 1;
    i++;
  }
  return i; // unterminated
}

// ---- Block tree types -------------------------------------------------------

type Attr = { name: string; rawValue: string; valStart: number; valEnd: number; line: number };
// `labelRange` spans the labels EXACTLY as the file writes them, quotes and
// spacing included. `labels` is the same text with quotes stripped, because a
// path segment is built from the values; the raw span is what a container row
// shows and what its source map points at, and the two are different questions.
type Block = { name: string; labels: string[]; labelRange?: [number, number]; attrs: Attr[]; blocks: Block[]; line: number };

// ---- Scanner ----------------------------------------------------------------

function scan(content: string): Block {
  const root: Block = { name: "", labels: [], attrs: [], blocks: [], line: 0 };
  const stack: Block[] = [root];
  const len = content.length;
  let i = 0;

  // Skip whitespace (including newlines).
  const skipWs = (): void => { while (i < len && /\s/.test(content[i])) i++; };

  // Skip to end of line (for # and // comments).
  const skipLineComment = (): void => { while (i < len && content[i] !== "\n") i++; };

  // Read a bareword identifier token.
  const readIdent = (): string => {
    const start = i;
    while (i < len && /[\w\-]/.test(content[i])) i++;
    return content.slice(start, i);
  };

  // Read the next "atom": quoted string, bareword, or null on unexpected char.
  // Returns { text, start, end } where text is the raw source slice.
  const readAtom = (): { text: string; start: number; end: number } | null => {
    skipWs();
    if (i >= len) return null;
    const ch = content[i];
    if (ch === '"') {
      const start = i;
      i = readQuotedString(content, i);
      return { text: content.slice(start, i), start, end: i };
    }
    if (/[\w\-]/.test(ch)) {
      const start = i;
      const text = readIdent();
      return { text, start, end: i };
    }
    return null;
  };

  while (i < len) {
    skipWs();
    if (i >= len) break;

    // Comments
    if (content[i] === "#" || (content[i] === "/" && content[i + 1] === "/")) {
      skipLineComment();
      continue;
    }
    if (content[i] === "/" && content[i + 1] === "*") {
      i = skipBlockComment(content, i);
      continue;
    }

    // Closing brace
    if (content[i] === "}") {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }

    // Collect the name token
    const nameAtom = readAtom();
    if (!nameAtom) { i++; continue; } // skip unexpected char

    const nameToken = nameAtom.text;
    const nameLine = lineOf(content, nameAtom.start);

    // Peek ahead: is this a block (labels* then `{`) or an attribute (`name = value`)?
    // We collect tokens until we see `=`, `{`, `}`, `#`, newline-at-top-level,
    // or a heredoc `<<`.
    // Strategy: if the first non-ws char after the name is `=`, it's an attribute.
    skipWs();
    if (i >= len) break;

    if (content[i] === "=") {
      // Attribute: name = value
      i++; // skip =
      skipWs();
      // Skip any block comment right after `=`
      while (i < len && content[i] === "/" && content[i + 1] === "*") {
        i = skipBlockComment(content, i);
        skipWs();
      }
      if (i >= len) continue;

      // Heredoc: skip entirely
      if (content[i] === "<" && content[i + 1] === "<") {
        // Skip to the closing heredoc marker. Find the label.
        i += 2;
        if (content[i] === "-") i++; // <<-EOF
        while (i < len && content[i] === " ") i++; // skip spaces
        const markerStart = i;
        while (i < len && content[i] !== "\n") i++;
        const marker = content.slice(markerStart, i).trim();
        i++; // skip newline
        // Skip until we find a line that is exactly the marker (optionally preceded by spaces for <<-)
        const markerRe = new RegExp(`^\\s*${marker}\\s*$`, "m");
        const rest = content.slice(i);
        const m = markerRe.exec(rest);
        if (m) i += m.index + m[0].length;
        else i = len;
        continue;
      }

      // List/object: skip (these are not scalars)
      if (content[i] === "[" || content[i] === "{") {
        // Skip to matching closer
        let depth = 0;
        while (i < len) {
          const c = content[i];
          if (c === "[" || c === "{") depth++;
          else if (c === "]" || c === "}") { depth--; if (depth === 0) { i++; break; } }
          else if (c === '"') { i = readQuotedString(content, i); continue; }
          else if (c === "#" || (c === "/" && content[i + 1] === "/")) { skipLineComment(); continue; }
          else if (c === "/" && content[i + 1] === "*") { i = skipBlockComment(content, i); continue; }
          i++;
        }
        continue;
      }

      // Read the raw value token
      const valStart = i;
      let valEnd: number;
      let rawValue: string;

      if (content[i] === '"') {
        // Quoted string
        valEnd = readQuotedString(content, i);
        rawValue = content.slice(valStart, valEnd);
        i = valEnd; // advance past closing quote
      } else {
        // Bareword: read until whitespace, comment, or newline
        const start = i;
        while (i < len && !/[\s#\n]/.test(content[i])) i++;
        rawValue = content.slice(start, i);
        valEnd = i;
      }

      // Skip whitespace/comments to end of logical line (don't consume next line)
      // but we don't need to do anything special — just record the attr.

      const attr: Attr = { name: nameToken, rawValue, valStart, valEnd, line: nameLine };
      stack[stack.length - 1].attrs.push(attr);
      continue;
    }

    // Otherwise collect label tokens until `{`
    const labels: string[] = [];
    let labelStart: number | undefined;
    let labelEnd = 0;
    let foundBrace = false;
    // The nameToken is NOT a label — it IS the block name.
    // Labels are the tokens between name and `{`.
    while (i < len) {
      skipWs();
      // comments
      if (i < len && (content[i] === "#" || (content[i] === "/" && content[i + 1] === "/"))) {
        skipLineComment();
        continue;
      }
      if (i < len && content[i] === "/" && content[i + 1] === "*") {
        i = skipBlockComment(content, i);
        continue;
      }
      if (i >= len) break;
      if (content[i] === "{") {
        i++; // consume {
        foundBrace = true;
        break;
      }
      // Collect a label
      const atom = readAtom();
      if (!atom) { i++; continue; }
      // Strip surrounding quotes for path building
      let lbl = atom.text;
      if (lbl.startsWith('"') && lbl.endsWith('"')) lbl = lbl.slice(1, -1);
      labels.push(lbl);
      if (labelStart === undefined) labelStart = atom.start;
      labelEnd = atom.end;
    }
    if (!foundBrace) continue; // malformed — skip

    const block: Block = { name: nameToken, labels, ...(labelStart !== undefined ? { labelRange: [labelStart, labelEnd] as [number, number] } : {}), attrs: [], blocks: [], line: nameLine };
    stack[stack.length - 1].blocks.push(block);
    stack.push(block);
  }
  return root;
}

// ---- Value classification ---------------------------------------------------

// Returns the "logical" scalar value (unquoted string / number / bool), or null
// if this value should be skipped (expression, interpolation, list, etc.).
function parseScalar(raw: string): string | null {
  if (raw === "") return null;

  // Quoted string: must be a pure literal (no interpolation ${...})
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1);
    // Contains interpolation / expression → skip
    if (inner.includes("${")) return null;
    // Unescape simple backslash sequences
    return inner.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;

  // Boolean
  if (raw === "true" || raw === "false") return raw;

  // Everything else (references like var.x, data.x, local.x, module.x;
  // function calls like toset(...); expressions) → skip
  return null;
}

// ---- Indexer ----------------------------------------------------------------

// Path segment: path portion + category display name

// One walk, two consumers. `hclIndex` wants the attributes it can VALUE;
// `hclAttributeSites` wants every attribute the file assigns, valuable or not.
// The block-path logic below (labels, positional indexing of unlabeled repeats)
// is the part that must not be written twice — it decides row identity, and two
// copies would drift.
function walkAttrs(content: string, visit: (nodes: ContainerNode[], attr: Attr) => void): void {
  const root = scan(content);
  const walk = (block: Block, nodes: ContainerNode[]): void => {
    for (const attr of block.attrs) visit(nodes, attr);
    walkBlocks(content, block, nodes, walk);
  };
  walk(root, []);
}

// Every attribute the file assigns, with its structural path and 1-based line —
// INCLUDING the ones `hclIndex` drops because their value is an interpolation,
// a reference or an expression rather than a literal.
//
// That exclusion is right for EXTRACTION: `"app-${var.environment}-"`
// is not a value, and a sheet claiming it as one would be lying. It is wrong
// for anything that needs to know WHERE an attribute is written — showing a
// reviewer the line their row corresponds to needs no value at all. Measured on
// one project's five Terraform modules: 140 attributes assigned, 47 valued, so
// asking the index for positions finds a third of the file.
export type HclAttributeSite = {
  path: string;
  line: number;
  // The scalar written there, when it is one. A caller relating this file to a
  // document that addresses a repeated block by an identifying FIELD rather
  // than by position needs to read that field's value here — the source says
  // `parameter[0].name = "max_connections"`, and only that turns index 0 into
  // the thing the other document calls `parameter[name=max_connections]`.
  value?: string;
};

export function hclAttributeSites(content: string): HclAttributeSite[] {
  const out: HclAttributeSite[] = [];
  walkAttrs(content, (nodes, attr) => {
    const scalar = parseScalar(attr.rawValue);
    out.push({
      path: [...nodes.map((n) => n.pathSeg), attr.name].join("."),
      line: attr.line,
      ...(scalar === null ? {} : { value: scalar }),
    });
  });
  return out;
}

export function hclIndex(content: string): HclEntry[] {
  const out: HclEntry[] = [];
  walkAttrs(content, (nodes, attr) => {
    const scalar = parseScalar(attr.rawValue);
    if (scalar === null) return; // skip non-scalars / expressions
    out.push({
      categoryPath: nodes.flatMap((n) => n.headings),
      key: attr.name,
      value: scalar,
      line: attr.line,
      range: [attr.valStart, attr.valEnd],
      path: [...nodes.map((n) => n.pathSeg), attr.name].join("."),
      containers: nodes,
    });
  });
  return out;
}

function walkBlocks(content: string, block: Block, nodes: ContainerNode[], walk: (b: Block, nodes: ContainerNode[]) => void): void {
  {

    // Child blocks, grouped by name for positional indexing of unlabeled repeats
    const blkGroups = new Map<string, Block[]>();
    for (const b of block.blocks) {
      const g = blkGroups.get(b.name);
      if (g) g.push(b);
      else blkGroups.set(b.name, [b]);
    }

    for (const [name, group] of blkGroups) {
      // All blocks in the group have labels?  And all label-tuples are unique?
      const allLabeled = group.every((b) => b.labels.length > 0);
      const labelTuples = group.map((b) => b.labels.join("."));
      const allUnique = allLabeled && new Set(labelTuples).size === labelTuples.length;

      group.forEach((b, idx) => {
        let node: ContainerNode;
        if (group.length === 1 && b.labels.length === 0) {
          // Single unlabeled block: just use name
          node = { name, pathSeg: name, headings: [name], line: b.line };
        } else if (allUnique) {
          // Labeled blocks: path = name.label1.label2...; category keeps name + all
          // labels so it stays unique (two resource types sharing a label, e.g.
          // aws_instance.web vs google_db.web, do not collapse together).
          //
          // HCL is where a block carries MORE THAN ONE identifying argument
          // (`resource "aws_lb" "this"`), so the subject is the label region
          // sliced STRAIGHT FROM THE SOURCE — quotes and spacing included.
          //
          // Stripping the quotes and re-joining with single spaces produced
          // `aws_lb this`, a string that appears nowhere in the file, while
          // httpd records its label verbatim with the quotes on. The path
          // segment is built from the stripped values, as it must be, but a
          // subject is shown to a reviewer and pointed at by a source map, and
          // the file's own spelling is the only form of it that cannot be
          // wrong. The path segment also contains DOTS, which is the second
          // format after logrotate where reading a chain back out of a joined
          // path is impossible rather than merely awkward.
          const pathParts = [name, ...b.labels];
          node = {
            name,
            ...(b.labelRange ? { subject: content.slice(b.labelRange[0], b.labelRange[1]), subjectRange: b.labelRange } : {}),
            pathSeg: pathParts.join("."),
            headings: [pathParts.join(" ")],
            line: b.line,
          };
        } else {
          // Repeated unlabeled blocks: index them
          node = { name, index: idx, pathSeg: `${name}[${idx}]`, headings: [`${name}[${idx}]`], line: b.line };
        }
        walk(b, [...nodes, node]);
      });
    }
  }
}

// ---- Locate -----------------------------------------------------------------

export type HclLocate = { value: string } | { error: string };

export function hclLocate(content: string, path: string): HclLocate {
  const e = hclIndex(content).find((x) => x.path === path);
  // A BLOCK's own address, which is not an entry (see containerSubjectAt).
  const containerSubject = containerSubjectAt(hclIndex(content), path);
  if (containerSubject !== undefined) return { value: containerSubject };
  return e ? { value: e.value } : { error: "path not found" };
}

// ---- Edit -------------------------------------------------------------------

// Re-render a value in the same style as the original token.
// Strings stay double-quoted (JSON.stringify); numbers/booleans are bare.
function renderValue(orig: string, suggested: string): string {
  if (orig.startsWith('"')) return JSON.stringify(suggested);
  if (/^(-?\d+(\.\d+)?|true|false)$/.test(suggested)) return suggested;
  return JSON.stringify(suggested);
}

export type HclEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function hclEdit(content: string, path: string, current: string, suggested: string): HclEdit {
  const e = hclIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  const before = content.slice(start, end);
  const after = renderValue(before, suggested);
  return { status: "applied", content: content.slice(0, start) + after + content.slice(end), before, after };
}
