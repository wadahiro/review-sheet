// XML support: extract values (element text + attributes) with reorder-robust
// paths, and locate/edit them by surgical range replacement (format-preserving).
//
// Paths reuse the same syntax as YAML/JSON (`server.connector`, an attribute as
// `.@port`, a repeated element by identity `services.service[name=web]`, or by
// index `[i]`). The path is treated as an opaque, stable key: extract and
// locate/edit regenerate it identically from the parsed tree, so it keeps
// pointing at the same value even if elements are reordered.
//
// Limits: element text and attribute values only; mixed content, CDATA, and
// entity-encoded values are skipped (left for the line/anchor or AI-prompt path).

import { SaxesParser } from "saxes";

export type XmlEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number] };

const ID_ATTRS = ["name", "id", "key"];

type Attr = { name: string; value: string; range: [number, number] };
type XNode = {
  name: string;
  attrs: Attr[];
  children: XNode[];
  line: number;
  textEnd?: number;
  textValue?: string;
};

type Seg = { kind: "key"; key: string } | { kind: "index"; index: number } | { kind: "filter"; field: string; value: string };

function quoteSeg(v: string): string {
  return /^[\w.\-:/]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
}
function renderPath(segs: Seg[]): string {
  let s = "";
  for (const seg of segs) {
    if (seg.kind === "key") s += s ? `.${seg.key}` : seg.key;
    else if (seg.kind === "index") s += `[${seg.index}]`;
    else s += `[${seg.field}=${quoteSeg(seg.value)}]`;
  }
  return s;
}
function segName(seg: Seg): string {
  return seg.kind === "key" ? seg.key : seg.kind === "index" ? `[${seg.index}]` : seg.value;
}

function attrValueRange(region: string, base: number, attr: string): [number, number] | null {
  const re = new RegExp(`(?:^|\\s)${attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(['"])`);
  const m = re.exec(region);
  if (!m) return null;
  const after = m.index + m[0].length;
  const close = region.indexOf(m[1], after);
  if (close < 0) return null;
  return [base + after, base + close];
}

// Parse the document into a lightweight tree with source ranges for attribute
// values and leaf text.
function parseTree(content: string): XNode | null {
  const parser = new SaxesParser({ position: true } as ConstructorParameters<typeof SaxesParser>[0]);
  const pos = (): number => (parser as unknown as { position: number }).position;
  const line = (): number => (parser as unknown as { line: number }).line;
  let root: XNode | null = null;
  const stack: XNode[] = [];
  let tagStart = 0;

  parser.on("opentagstart", () => { tagStart = pos(); });
  parser.on("opentag", (t) => {
    const region = content.slice(tagStart, pos());
    const attrs: Attr[] = [];
    for (const [name, value] of Object.entries(t.attributes as Record<string, string>)) {
      const range = attrValueRange(region, tagStart, name);
      if (range) attrs.push({ name, value, range });
    }
    const node: XNode = { name: t.name, attrs, children: [], line: line() };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    // saxes emits a matching closetag even for self-closing tags, so always push
    // (a self-closing element is pushed then immediately popped).
    stack.push(node);
  });
  parser.on("text", (txt) => {
    if (!stack.length || txt.trim() === "") return;
    const top = stack[stack.length - 1];
    // saxes reports position AFTER the `<` that terminated the text, so the text
    // itself ends one char earlier.
    top.textEnd = pos() - 1;
    top.textValue = txt;
  });
  parser.on("closetag", () => { stack.pop(); });

  try {
    parser.write(content).close();
  } catch {
    return null;
  }
  return root;
}

function identityAttr(group: XNode[]): string | null {
  for (const f of ID_ATTRS) {
    const vals = group.map((n) => n.attrs.find((a) => a.name === f)?.value);
    if (vals.every((v) => v !== undefined) && new Set(vals).size === vals.length) return f;
  }
  return null;
}

// Resolve a leaf element's text range from saxes' text end position.
function textRange(content: string, node: XNode): { value: string; range: [number, number] } | null {
  if (node.textEnd === undefined || node.textValue === undefined) return null;
  const value = node.textValue;
  let start = node.textEnd - value.length;
  if (content.slice(start, node.textEnd) !== value) {
    start = content.lastIndexOf(">", node.textEnd - 1) + 1;
    if (content.slice(start, node.textEnd).trim() !== value.trim()) return null; // mixed/entities — skip
    return { value: value.trim(), range: [start, node.textEnd] };
  }
  return { value, range: [start, node.textEnd] };
}

export type XmlIndexEntry = XmlEntry & { path: string };

// Public: full index with stable path strings.
export function xmlIndex(content: string): XmlIndexEntry[] {
  const root = parseTree(content);
  if (!root) return [];
  const out: XmlIndexEntry[] = [];

  const walk = (node: XNode, segs: Seg[]): void => {
    const idUsed = segs.length && segs[segs.length - 1].kind === "filter" ? (segs[segs.length - 1] as { field: string }).field : null;
    for (const a of node.attrs) {
      if (a.name === idUsed) continue;
      const leaf: Seg[] = [...segs, { kind: "key", key: `@${a.name}` }];
      out.push({ categoryPath: segs.map(segName), key: `@${a.name}`, value: a.value, line: node.line, range: a.range, path: renderPath(leaf) });
    }
    if (node.children.length === 0) {
      const t = textRange(content, node);
      if (t) out.push({ categoryPath: segs.slice(0, -1).map(segName), key: segs.length ? segName(segs[segs.length - 1]) : node.name, value: t.value, line: node.line, range: t.range, path: renderPath(segs) });
    }
    const groups = new Map<string, XNode[]>();
    for (const c of node.children) { const g = groups.get(c.name); if (g) g.push(c); else groups.set(c.name, [c]); }
    for (const [name, group] of groups) {
      const idf = group.length > 1 ? identityAttr(group) : null;
      group.forEach((child, i) => {
        const childSegs: Seg[] = [...segs, { kind: "key", key: name }];
        if (group.length > 1) childSegs.push(idf ? { kind: "filter", field: idf, value: child.attrs.find((a) => a.name === idf)!.value } : { kind: "index", index: i });
        walk(child, childSegs);
      });
    }
  };
  walk(root, [{ kind: "key", key: root.name }]);
  return out;
}

// Entries for the extraction adapter (drops range).
export function xmlEntries(content: string): { categoryPath: string[]; key: string; value: string; line: number }[] {
  return xmlIndex(content).map(({ categoryPath, key, value, line }) => ({ categoryPath, key, value, line }));
}

export type XmlLocate = { value: string } | { error: string };
export function xmlLocate(content: string, path: string): XmlLocate {
  const e = xmlIndex(content).find((x) => x.path === path);
  return e ? { value: e.value } : { error: "path not found" };
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type XmlEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function xmlEdit(content: string, path: string, current: string, suggested: string): XmlEdit {
  const e = xmlIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  const before = content.slice(start, end);
  const after = escapeXml(suggested);
  return { status: "applied", content: content.slice(0, start) + after + content.slice(end), before, after };
}
