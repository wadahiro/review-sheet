// systemd unit file parser: wraps systemdIndex/systemdLocate/systemdEdit.

import { systemdIndex, systemdLocate, systemdEdit } from "../systemd.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const systemdParser: ConfigParser = {
  name: "systemd",
  priority: 20,
  meta: {
    title: "systemd",
    summary: "[Section]+Key=Value unit files; repeated keys indexed.",
    files: "*.service *.timer *.socket *.mount *.target *.path *.slice *.scope *.automount *.netdev *.network *.link",
    detection: "extension (.service, .timer, .socket, .mount, .target, …)",
    delimiter: "Key=Value",
    comments: "# ;",
    pathStyle: "Service.ExecStartPre[1] — Section.Key; repeated keys indexed",
    notes: [
      "[Section] headings become category path segments.",
      "Repeated keys are indexed: Service.ExecStartPre[1].",
      "Unique param key is Section.Key (or Section.Key[i] for repeats).",
    ],
    examples: ["Service.ExecStart", "Service.ExecStartPre[1]", "Unit.Description"],
  },
  detect: (file) =>
    /\.(service|timer|socket|mount|target|path|slice|scope|automount|netdev|network|link)$/.test(
      file.toLowerCase()
    ),
  extract: (content) =>
    systemdIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = systemdLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return systemdEdit(content, source.path, current, suggested);
  },
};
registerParser(systemdParser);
