// Pure renderers for parser documentation. No fs — called from CLI and gen-docs script.

import type { ConfigParser } from "./parser.js";

export function renderParserPage(p: ConfigParser): string {
  if (!p.meta) return "";
  const m = p.meta;
  const lines: string[] = [];
  lines.push(`# ${m.title}`);
  lines.push("");
  lines.push(m.summary);
  lines.push("");
  lines.push("## Detection");
  lines.push("");
  lines.push(`**Files:** ${m.files}`);
  lines.push("");
  lines.push(`**Detection:** ${m.detection}`);
  if (m.delimiter !== undefined) {
    lines.push("");
    lines.push(`**Delimiter:** \`${m.delimiter}\``);
  }
  if (m.comments !== undefined) {
    lines.push("");
    lines.push(`**Comments:** \`${m.comments}\``);
  }
  if (m.pathStyle !== undefined) {
    lines.push("");
    lines.push("## Path style");
    lines.push("");
    lines.push(m.pathStyle);
  }
  if (m.notes && m.notes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    for (const note of m.notes) {
      lines.push(`- ${note}`);
    }
  }
  if (m.examples && m.examples.length > 0) {
    lines.push("");
    lines.push("## Examples");
    lines.push("");
    lines.push("```");
    for (const ex of m.examples) {
      lines.push(ex);
    }
    lines.push("```");
  }
  lines.push("");
  return lines.join("\n");
}

function sortedParsers(parsers: ConfigParser[]): ConfigParser[] {
  return [...parsers]
    .filter((p) => p.meta !== undefined)
    .sort((a, b) => {
      const pa = b.priority ?? 0;
      const pb = a.priority ?? 0;
      if (pa !== pb) return pa - pb;
      return a.name.localeCompare(b.name);
    });
}

export function renderParserIndex(parsers: ConfigParser[]): string {
  const sorted = sortedParsers(parsers);
  const lines: string[] = [];
  lines.push("| Format | Summary | Details |");
  lines.push("| --- | --- | --- |");
  for (const p of sorted) {
    const m = p.meta!;
    lines.push(`| \`${p.name}\` | ${m.summary} | [details](formats/${p.name}.md) |`);
  }
  return lines.join("\n");
}

export function renderReadmeTable(parsers: ConfigParser[]): string {
  const sorted = sortedParsers(parsers);
  const lines: string[] = [];
  lines.push("| Format | Files | Notes |");
  lines.push("| --- | --- | --- |");
  for (const p of sorted) {
    const m = p.meta!;
    // Notes = first note bullet, or summary
    const note = m.notes && m.notes.length > 0 ? m.summary : m.summary;
    lines.push(`| \`${p.name}\` | ${m.files} | ${note} |`);
  }
  return lines.join("\n");
}

export function renderParserList(parsers: ConfigParser[]): string {
  const sorted = sortedParsers(parsers);
  const lines: string[] = [];
  for (const p of sorted) {
    const m = p.meta!;
    lines.push(`${p.name.padEnd(12)} ${m.detection.padEnd(40)} ${m.summary}`);
  }
  return lines.join("\n");
}
