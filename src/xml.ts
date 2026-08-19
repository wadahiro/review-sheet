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
import type { ContainerNode } from "./types.js";
import { containerSubjectAt } from "./parser.js";

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


const nodePath = (nodes: ContainerNode[]): string => nodes.map((n) => n.pathSeg).join(".");

function quoteSeg(v: string): string {
  return /^[\w.\-:/]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
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

// Which attribute identifies these same-named siblings, if any.
//
// Consulted for a group of ONE as much as for a group of many, deliberately.
// Gating it on arity made an element's address depend on how many siblings it
// happened to have: adding a second `<local-cache>` elsewhere in the file
// re-keyed the first one's every descendant — every source map, review target
// and apply target under it — and DELETED its `@name` row, since a promoted
// attribute is suppressed. A row disappearing because something unrelated was
// added is the failure this project refuses to let happen quietly, and this
// parser's own header claims paths survive reordering, which they did only for
// as long as nobody added anything.
//
// The `@name` row does not disappear now, it CHANGES SHAPE: the element itself
// is a row, carrying that same value at that same attribute, so the fact stays
// on the sheet and gains a description and a review target it never had. That
// row is why this could not ship earlier — before it existed, promoting a
// singleton simply lost the value.
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

export type XmlIndexEntry = XmlEntry & { path: string; containers: ContainerNode[] };

// Public: full index with stable path strings.
export function xmlIndex(content: string): XmlIndexEntry[] {
  const root = parseTree(content);
  if (!root) return [];
  const out: XmlIndexEntry[] = [];

  const walk = (node: XNode, nodes: ContainerNode[]): void => {
    const here = nodes[nodes.length - 1];
    // Every name this chain puts on screen, flattened. Sliced rather than
    // indexed by NODE below, because an element can contribute two of them and
    // the text-leaf row is keyed by the last NAME, not the last element.
    const names = nodes.flatMap((n) => n.headings);
    for (const a of node.attrs) {
      // The subject is already in the address; a row for it would state the
      // same fact a second time, in a second place, free to disagree.
      if (a.name === here.subjectField) continue;
      out.push({ categoryPath: names, key: `@${a.name}`, value: a.value, line: node.line, range: a.range, path: `${nodePath(nodes)}.@${a.name}`, containers: nodes });
    }
    if (node.children.length === 0) {
      const t = textRange(content, node);
      // The text row IS the last element, so its own node is not a container
      // ENCLOSING it — the chain stops one short, exactly as `categoryPath`
      // does.
      if (t) out.push({ categoryPath: names.slice(0, -1), key: names.length ? names[names.length - 1] : node.name, value: t.value, line: node.line, range: t.range, path: nodePath(nodes), containers: nodes.slice(0, -1) });
    }
    const groups = new Map<string, XNode[]>();
    for (const c of node.children) { const g = groups.get(c.name); if (g) g.push(c); else groups.set(c.name, [c]); }
    for (const [name, group] of groups) {
      const idf = identityAttr(group);
      group.forEach((child, i) => {
        const idAttr = idf ? child.attrs.find((a) => a.name === idf)! : undefined;
        const subject = idAttr?.value;
        const index = group.length > 1 && !idf ? i : undefined;
        const pathSeg =
          subject !== undefined ? `${name}[${idf}=${quoteSeg(subject)}]` : index !== undefined ? `${name}[${index}]` : name;
        // XML's flattening splits a promoted element in two — the legacy
        // per-step grain, kept exactly.
        const headings = subject !== undefined ? [name, subject] : index !== undefined ? [name, `[${index}]`] : [name];
        walk(child, [...nodes, { name, ...(subject !== undefined ? { subject, subjectField: idf!, subjectRange: idAttr!.range } : {}), ...(index !== undefined ? { index } : {}), pathSeg, headings, line: child.line }]);
      });
    }
  };
  walk(root, [{ name: root.name, pathSeg: root.name, headings: [root.name], line: root.line }]);
  return out;
}

// Entries for the extraction adapter (drops range).
export function xmlEntries(content: string): { categoryPath: string[]; key: string; value: string; line: number }[] {
  return xmlIndex(content).map(({ categoryPath, key, value, line }) => ({ categoryPath, key, value, line }));
}

export type XmlLocate = { value: string } | { error: string };
export function xmlLocate(content: string, path: string): XmlLocate {
  const index = xmlIndex(content);
  const e = index.find((x) => x.path === path);
  if (e) return { value: e.value };
  // A BLOCK's own address (see containerSubjectAt).
  const subject = containerSubjectAt(index, path);
  return subject === undefined ? { error: "path not found" } : { value: subject };
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
