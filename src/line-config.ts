// Line-oriented format configuration, extraction, and locate/edit. Split into
// its own module to avoid circular dependency: parsers/line.ts imports this,
// and extract.ts also imports this (without going through parsers/index).
//
// locateLine/lineLocate/lineEdit are exported from the package root (see
// index.ts) as the public API for a custom ConfigParser whose format is
// "one value per line, found by line number + a literal anchor substring" —
// the same mechanism every shipped line-oriented parser (properties, dotenv,
// sysctl, ini, space, generic) uses for its `locate`/`edit`. Write a custom
// `locate`/`edit` from scratch only if the format needs structural
// (path-based) addressing that a line scan cannot express; see
// parsers/yamljson.ts for how a structural parser can still fall back to
// locateLine for values that only carry a line/anchor.

import type { SourceLocation } from "./types.js";
import type { LocateResult, EditResult } from "./parser.js";

export type Entry = { categoryPath: string[]; key: string; value: string; source: SourceLocation };

export type LineConfig = { delims: string[]; comments: string[]; sections: boolean; space: boolean; exportPrefix: boolean };

const DEFAULT_CATEGORY = "Parameters";

export const LINE_CONFIGS: Record<"properties" | "dotenv" | "sysctl" | "ini" | "space" | "generic", LineConfig> = {
  properties: { delims: ["=", ":"], comments: ["#", "!"], sections: false, space: false, exportPrefix: false },
  dotenv: { delims: ["="], comments: ["#"], sections: false, space: false, exportPrefix: true },
  sysctl: { delims: ["="], comments: ["#", ";"], sections: false, space: false, exportPrefix: false },
  ini: { delims: ["=", ":"], comments: ["#", ";"], sections: true, space: false, exportPrefix: false },
  space: { delims: [], comments: ["#"], sections: false, space: true, exportPrefix: false },
  generic: { delims: ["=", ":"], comments: ["#", ";", "!"], sections: false, space: false, exportPrefix: false },
};

export function extractLines(content: string, cfg: LineConfig): Entry[] {
  const out: Entry[] = [];
  const lines = content.split("\n");
  let section: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (cfg.comments.some((c) => trimmed.startsWith(c))) continue;
    if (cfg.sections && /^\[.*\]$/.test(trimmed)) {
      section = trimmed.slice(1, -1).trim();
      continue;
    }

    const indent = raw.length - raw.trimStart().length;
    let body = raw.slice(indent);
    if (cfg.exportPrefix) {
      const m = body.match(/^export\s+/);
      if (m) body = body.slice(m[0].length);
    }

    let key: string | undefined;
    let value: string | undefined;
    let anchor: string | undefined;

    if (cfg.space) {
      const m = body.match(/^(\S+)(\s+)(\S.*?)\s*$/);
      if (m) {
        key = m[1];
        value = m[3];
        anchor = body.slice(0, m[1].length + m[2].length); // "key " incl. the gap
      }
    } else {
      let idx = -1;
      let delim = "";
      for (const d of cfg.delims) {
        const at = body.indexOf(d);
        if (at > 0 && (idx < 0 || at < idx)) {
          idx = at;
          delim = d;
        }
      }
      if (idx > 0) {
        key = body.slice(0, idx).trim();
        value = body.slice(idx + delim.length).trim();
        anchor = body.slice(0, idx + delim.length); // "key =" / "key:"
      }
    }

    if (key === undefined || value === undefined || value === "") continue;
    out.push({
      categoryPath: section ? [section] : [DEFAULT_CATEGORY],
      key,
      value,
      source: { line: i + 1, anchor },
    });
  }
  return out;
}

// Locate the 0-based line index to edit. Mirrors the prompt's resolution
// protocol: trust the given line if it carries the anchor and the current
// value; otherwise re-locate by a unique anchor match.
//
// This is the low-level primitive — most custom parsers want lineLocate/
// lineEdit below instead, which already wire this up to the ConfigParser
// locate/edit shape. Reach for locateLine directly only when it needs to be
// combined with something else first, the way parsers/yamljson.ts falls
// back to it after a structural path lookup fails.
export function locateLine(
  lines: string[],
  loc: { line?: number; anchor?: string } | undefined,
  current: string
): { idx: number } | { error: string } {
  const anchor = loc?.anchor;
  if (loc?.line !== undefined) {
    const i = loc.line - 1;
    if (i >= 0 && i < lines.length) {
      const ln = lines[i];
      if ((!anchor || ln.includes(anchor)) && ln.includes(current)) return { idx: i };
    }
  }
  if (anchor) {
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(anchor) && lines[i].includes(current)) matches.push(i);
    }
    if (matches.length === 1) return { idx: matches[0] };
    if (matches.length > 1) return { error: `anchor matches ${matches.length} lines; ambiguous` };
    return { error: "anchor not found with the current value" };
  }
  return { error: "no anchor to verify the location" };
}

// Ready-to-use `ConfigParser.locate` for a line-oriented format: resolve a
// value by (line, anchor), re-locating by a file-wide anchor scan when the
// line has drifted. Assign directly — `locate: lineLocate` — no wrapping
// needed; it already matches the ConfigParser method signature.
export function lineLocate(content: string, source: SourceLocation, expected: string): LocateResult {
  if (source.line === undefined && !source.anchor) {
    return { error: "no anchor to verify the location", status: "unmapped" };
  }
  const lines = content.split("\n");
  const res = locateLine(lines, source, expected);
  if ("idx" in res) return { value: expected };
  if (res.error.includes("ambiguous")) return { error: res.error, status: "warn" };
  return { error: res.error };
}

// Ready-to-use `ConfigParser.edit` for a line-oriented format: same
// resolution as lineLocate, then a literal current->suggested replacement on
// that line. Idempotent (a line already carrying the suggested value, and
// not the current one, is reported "skipped" rather than re-applied or
// treated as an error) — including when locateLine itself cannot resolve the
// line but the recorded source.line already holds the suggested value.
export function lineEdit(content: string, source: SourceLocation, current: string, suggested: string): EditResult {
  const lines = content.split("\n");
  const res = locateLine(lines, source, current);
  if ("idx" in res) {
    const before = lines[res.idx];
    if (before.includes(suggested) && !before.includes(current)) {
      return { status: "skipped" };
    }
    const after = before.replace(current, suggested);
    lines[res.idx] = after;
    return { status: "applied", content: lines.join("\n"), before, after };
  }
  if (source.line !== undefined) {
    const lineIdx = source.line - 1;
    if (lineIdx >= 0 && lineIdx < lines.length && lines[lineIdx].includes(suggested)) {
      return { status: "skipped" };
    }
  }
  return { status: "error", reason: res.error };
}
