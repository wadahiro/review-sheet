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
import { PRESENCE_VALUE } from "./types.js";
import type { LocateResult, EditResult } from "./parser.js";

export type Entry = {
  categoryPath: string[];
  key: string;
  value: string;
  source: SourceLocation;
  // This entry's value is PRESENCE — a directive standing alone on its line,
  // where being written IS the setting. Mirrors parser.ts's Entry.presence.
  presence?: true;
};

export type LineConfig = {
  delims: string[];
  comments: string[];
  sections: boolean;
  space: boolean;
  exportPrefix: boolean;
  // A directive with no argument IS a setting, and its value is its presence.
  // `rtcsync` in chrony.conf, `noclientlog`, `dumponexit` — the file says the
  // thing by naming it and says nothing by leaving it out.
  //
  // Off for every DELIMITED format, and that is not caution, it is meaning: in
  // `key=value` a line with no delimiter is not a flag, it is prose, a typo, or
  // a line this parser was never meant to read — `generic` is the lowest
  // priority fallback and would turn a README into rows. In a whitespace
  // format there is no delimiter to be missing, so a lone token is the only
  // shape a flag can have.
  //
  // The value is the string below rather than a boolean because everything
  // downstream — the sheet cell, a review's `current`, a dictionary's
  // `default` — is text.
  bareFlag?: string;
};

// No invented fallback here. A format with no sections reports NO category, and
// what to call such a row is then answered where category is decided — a
// project's own `category:`, a bound dictionary's group, the file it belongs
// to — or not at all, which is an error naming the row.
//
// It used to stamp every one of them with the constant "Parameters": a word in
// no file, needed by nothing that parses, existing only to be shown. That is
// the same thing a logrotate block's noun was, removed for the same reason —
// a parser carries the vocabulary it needs to READ a format, and a display
// label is not that. Sitting in the resolution chain's last slot, its only
// possible effect was to turn "this row has no category" into a meaningless
// tab instead of the declaration this project asks for by name. Measured
// before removing: zero occurrences across every example and one real project.

export const LINE_CONFIGS: Record<"properties" | "dotenv" | "sysctl" | "ini" | "space" | "generic", LineConfig> = {
  properties: { delims: ["=", ":"], comments: ["#", "!"], sections: false, space: false, exportPrefix: false },
  dotenv: { delims: ["="], comments: ["#"], sections: false, space: false, exportPrefix: true },
  sysctl: { delims: ["="], comments: ["#", ";"], sections: false, space: false, exportPrefix: false },
  ini: { delims: ["=", ":"], comments: ["#", ";"], sections: true, space: false, exportPrefix: false },
  space: { delims: [], comments: ["#"], sections: false, space: true, exportPrefix: false, bareFlag: PRESENCE_VALUE },
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

    let isPresence = false;
    let value: string | undefined;
    let anchor: string | undefined;

    if (cfg.space) {
      const m = body.match(/^(\S+)(\s+)(\S.*?)\s*$/);
      if (m) {
        key = m[1];
        value = m[3];
        anchor = body.slice(0, m[1].length + m[2].length); // "key " incl. the gap
      } else if (cfg.bareFlag !== undefined && /^\S+$/.test(body.trimEnd())) {
        isPresence = true;
        // A directive standing alone. Dropping it lost a real setting with no
        // report — the row simply never existed, which is the one failure this
        // project refuses to leave silent.
        key = body.trimEnd();
        value = cfg.bareFlag;
        anchor = key;
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
      categoryPath: section ? [section] : [],
      key,
      value,
      // Stated, not inferred from the value: a setting whose legitimate value
      // is the string this tool spells presence with would otherwise be read
      // as presence, with nothing saying so.
      ...(isPresence ? { presence: true as const } : {}),
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
// `bareFlag` (LineConfig.bareFlag) makes this resolve a row whose value is its
// own PRESENCE. Such a row's value is nowhere on the line — the line is the
// directive and nothing else — so the ordinary "the line still carries the
// current value" test can never pass, and without this a flag row would come
// back unresolved on every verify. The substitute test is exact rather than
// substring: the whole line must BE the directive, so `rtcsync` never resolves
// against `rtcsyncfoo` or against a line that merely mentions it.
export function locateLine(
  lines: string[],
  loc: { line?: number; anchor?: string } | undefined,
  current: string,
  bareFlag?: string
): { idx: number } | { error: string } {
  const anchor = loc?.anchor;
  const asFlag = bareFlag !== undefined && current === bareFlag && anchor !== undefined;
  const holds = (ln: string): boolean => (asFlag ? ln.trim() === anchor : ln.includes(current));
  if (loc?.line !== undefined) {
    const i = loc.line - 1;
    if (i >= 0 && i < lines.length) {
      const ln = lines[i];
      if ((!anchor || ln.includes(anchor)) && holds(ln)) return { idx: i };
    }
  }
  if (anchor) {
    const matches: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(anchor) && holds(lines[i])) matches.push(i);
    }
    if (matches.length === 1) return { idx: matches[0] };
    if (matches.length > 1) return { error: `anchor matches ${matches.length} lines; ambiguous` };
    return { error: asFlag ? "no line is exactly this directive" : "anchor not found with the current value" };
  }
  return { error: "no anchor to verify the location" };
}

// Ready-to-use `ConfigParser.locate` for a line-oriented format: resolve a
// value by (line, anchor), re-locating by a file-wide anchor scan when the
// line has drifted. Assign directly — `locate: lineLocate` — no wrapping
// needed; it already matches the ConfigParser method signature.
export function lineLocate(content: string, source: SourceLocation, expected: string): LocateResult {
  return locateWithFlag(content, source, expected, undefined);
}

// The same locate, told which value means "this row's value is its presence".
// NOT an extra parameter on `lineLocate`: `ConfigParser.locate`'s fourth
// argument is `ExtractOptions`, so widening that position would hand this an
// options object at runtime while typechecking clean at the assignment. The
// config is closed over instead, which is also what keeps the flag value a
// property of the FORMAT rather than of each call.
export function lineLocateFor(cfg: LineConfig): (content: string, source: SourceLocation, expected: string) => LocateResult {
  return (content, source, expected) => locateWithFlag(content, source, expected, cfg.bareFlag);
}

function locateWithFlag(content: string, source: SourceLocation, expected: string, bareFlag: string | undefined): LocateResult {
  if (source.line === undefined && !source.anchor) {
    return { error: "no anchor to verify the location", status: "unmapped" };
  }
  const lines = content.split("\n");
  const res = locateLine(lines, source, expected, bareFlag);
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
  return editWithFlag(content, source, current, suggested, undefined);
}

// The edit half of `lineLocateFor`. A presence flag is deliberately NOT
// editable: turning one off means DELETING its line, and turning one on means
// inventing a position for a line the file does not have — neither is the
// literal current->suggested replacement this function performs, and guessing
// either would rewrite the artifact in a way nobody reviewed.
//
// Refusing here is not a dead end. `computeApply` turns an `error` from a
// parser's edit into a HELD change with this reason attached, which is exactly
// the path a `substituted` row already takes: the change survives into the AI
// prompt for a human to make, instead of being silently dropped or silently
// guessed at.
export function lineEditFor(cfg: LineConfig): (content: string, source: SourceLocation, current: string, suggested: string) => EditResult {
  return (content, source, current, suggested) => editWithFlag(content, source, current, suggested, cfg.bareFlag);
}

function editWithFlag(
  content: string,
  source: SourceLocation,
  current: string,
  suggested: string,
  bareFlag: string | undefined
): EditResult {
  if (bareFlag !== undefined && current === bareFlag && source.anchor !== undefined) {
    if (current === suggested) return { status: "skipped" };
    return {
      status: "error",
      reason:
        `"${source.anchor}" is a directive whose value IS its presence, so changing it means adding or ` +
        `removing the line rather than editing it — held for a human to decide where the line goes`,
    };
  }
  const lines = content.split("\n");
  const res = locateLine(lines, source, current, bareFlag);
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
