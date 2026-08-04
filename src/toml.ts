// TOML support. TOML is essentially line-oriented (`key = value` under `[table]`
// / `[[array-of-tables]]` headers, plus dotted keys), so we index it with a
// single line scan — no position-aware parser needed — producing a stable path
// per scalar plus its source range, mirroring the XML adapter.
//
// Paths reuse the shared syntax: `server.http.port`, array-of-tables by identity
// `servers[name=web].port` (or `[i]` when no identity key). Resolving by path is
// reorder-robust. Scope: scalar values (string/number/bool/datetime) on a single
// line; arrays, inline tables, and multi-line strings are skipped.

export type TomlEntry = { categoryPath: string[]; key: string; value: string; line: number; range: [number, number]; path: string };

const ID_KEYS = ["name", "id", "key"];

// Drop an inline `#` comment that is outside any string.
function stripComment(s: string): string {
  let qn: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (qn) {
      if (ch === qn) qn = null;
    } else if (ch === '"' || ch === "'") qn = ch;
    else if (ch === "#") return s.slice(0, i);
  }
  return s;
}

function unquote(token: string): string {
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
    return token.slice(1, -1);
  }
  return token;
}

// Split a dotted (optionally quoted) key/table name into segments.
function dottedSegs(name: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^.\s"']+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(name)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function quoteSeg(v: string): string {
  return /^[\w.\-:/]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
}

type Prefix = { segs: string[]; arrayPath?: string; arrayIndex?: number };

function joinPath(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}.${b}`;
}

export function tomlIndex(content: string): TomlEntry[] {
  const lines = content.split("\n");
  const raw: (TomlEntry & { arrayPath?: string; arrayIndex?: number; isId?: boolean })[] = [];
  let offset = 0;
  let prefix: Prefix = { segs: [] };
  const arrayCounts = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;

    // [[array of tables]]
    let m = trimmed.match(/^\[\[\s*(.+?)\s*\]\]$/);
    if (m) {
      const segs = dottedSegs(m[1]);
      const apath = segs.join(".");
      const idx = (arrayCounts.get(apath) ?? -1) + 1;
      arrayCounts.set(apath, idx);
      prefix = { segs, arrayPath: apath, arrayIndex: idx };
      continue;
    }
    // [table]
    m = trimmed.match(/^\[\s*(.+?)\s*\]$/);
    if (m) {
      prefix = { segs: dottedSegs(m[1]) };
      continue;
    }

    // key = value
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const keyRaw = line.slice(0, eq).trim();
    if (keyRaw === "") continue;
    const rhsFull = line.slice(eq + 1);
    const rhs = stripComment(rhsFull);
    const leading = rhs.length - rhs.trimStart().length;
    const token = rhs.trim();
    if (token === "" || /^[[{]/.test(token) || token.startsWith('"""') || token.startsWith("'''")) continue; // arrays/inline-tables/multiline: skip

    const tokenStart = lineStart + eq + 1 + leading;
    const range: [number, number] = [tokenStart, tokenStart + token.length];
    const keySegs = dottedSegs(keyRaw);

    const base = prefix.arrayPath !== undefined ? `${prefix.arrayPath}[${prefix.arrayIndex}]` : prefix.segs.join(".");
    const path = joinPath(base, keySegs.join("."));
    const allSegs = (prefix.arrayPath !== undefined ? [...prefix.segs, `[${prefix.arrayIndex}]`] : prefix.segs).concat(keySegs);

    raw.push({
      categoryPath: allSegs.slice(0, -1),
      key: keySegs[keySegs.length - 1],
      value: unquote(token),
      line: i + 1,
      range,
      path,
      arrayPath: prefix.arrayPath,
      arrayIndex: prefix.arrayIndex,
      isId: prefix.arrayPath !== undefined && keySegs.length === 1 && ID_KEYS.includes(keySegs[0]),
    });
  }

  // Upgrade array-of-tables index paths to identity predicates when a unique id
  // field exists, and drop the id field itself from the params.
  const idByArrayItem = new Map<string, { field: string; value: string }>();
  for (const arrayPath of new Set(raw.map((r) => r.arrayPath).filter((p): p is string => !!p))) {
    const items = raw.filter((r) => r.arrayPath === arrayPath);
    const indices = [...new Set(items.map((r) => r.arrayIndex!))];
    for (const f of ID_KEYS) {
      const vals = indices.map((idx) => items.find((r) => r.arrayIndex === idx && r.key === f && r.path.endsWith(`].${f}`))?.value);
      if (vals.every((v) => v !== undefined) && new Set(vals).size === vals.length) {
        indices.forEach((idx, k) => idByArrayItem.set(`${arrayPath}[${idx}]`, { field: f, value: vals[k]! }));
        break;
      }
    }
  }

  const out: TomlEntry[] = [];
  for (const r of raw) {
    if (r.arrayPath !== undefined) {
      const id = idByArrayItem.get(`${r.arrayPath}[${r.arrayIndex}]`);
      if (id) {
        if (r.isId && r.key === id.field) continue; // identity field becomes the predicate
        const pred = `${r.arrayPath}[${id.field}=${quoteSeg(id.value)}]`;
        const tail = r.path.slice(`${r.arrayPath}[${r.arrayIndex}]`.length); // ".key"
        const path = pred + tail;
        const catSegs = [...r.arrayPath.split("."), id.value, ...r.categoryPath.slice(r.arrayPath.split(".").length + 1)];
        out.push({ categoryPath: catSegs, key: r.key, value: r.value, line: r.line, range: r.range, path });
        continue;
      }
    }
    out.push({ categoryPath: r.categoryPath, key: r.key, value: r.value, line: r.line, range: r.range, path: r.path });
  }
  return out;
}

export type TomlLocate = { value: string } | { error: string };
export function tomlLocate(content: string, path: string): TomlLocate {
  const e = tomlIndex(content).find((x) => x.path === path);
  return e ? { value: e.value } : { error: "path not found" };
}

function renderValue(orig: string, suggested: string): string {
  if (orig.startsWith('"')) return JSON.stringify(suggested);
  if (orig.startsWith("'")) return suggested.includes("'") ? JSON.stringify(suggested) : `'${suggested}'`;
  if (/^(-?\d+(\.\d+)?|true|false)$/.test(suggested)) return suggested;
  return JSON.stringify(suggested);
}

export type TomlEdit =
  | { status: "applied"; content: string; before: string; after: string }
  | { status: "skipped" }
  | { status: "error"; reason: string };

export function tomlEdit(content: string, path: string, current: string, suggested: string): TomlEdit {
  const e = tomlIndex(content).find((x) => x.path === path);
  if (!e) return { status: "error", reason: "path not found" };
  if (e.value === suggested && e.value !== current) return { status: "skipped" };
  if (e.value !== current) return { status: "error", reason: `value at path is "${e.value}", expected "${current}"` };
  const [start, end] = e.range;
  const before = content.slice(start, end);
  const after = renderValue(before, suggested);
  return { status: "applied", content: content.slice(0, start) + after + content.slice(end), before, after };
}
