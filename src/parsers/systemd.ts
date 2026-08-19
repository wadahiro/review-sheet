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
    containers:
      "Each `[Section]` is a block. Sections take no argument, so none becomes a row. Keys written before any header belong to an ASSUMED section, which the file never writes — so it carries no line and no row can point at it.",
    notes: [
      "[Section] headings become category path segments.",
      "Repeated keys are indexed: Service.ExecStartPre[1].",
      "Unique param key is Section.Key (or Section.Key[i] for repeats).",
    ],
    examples: ["Service.ExecStart", "Service.ExecStartPre[1]", "Unit.Description"],
  },
  detect: (file) =>
    /\.(service|timer|socket|mount|target|path|slice|scope|automount|netdev|network|link)$/.test(file.toLowerCase()) ||
    // A daemon's own configuration and its drop-ins: journald.conf,
    // system.conf, and any `*.conf` under a `*.conf.d/` directory — the way
    // every systemd daemon is configured without editing the shipped file.
    // Same INI-with-sections grammar as a unit; only the extension differs, and
    // a bare `.conf` is far too common to claim on its own, which is why the
    // directory has to be part of the evidence.
    /(^|\/)(journald|system|logind|resolved|networkd|timesyncd|coredump|homed|oomd|pstore|sleep|user)\.conf$/.test(
      file.toLowerCase()
    ) ||
    /\.conf\.d\/[^/]+\.conf$/.test(file.toLowerCase()),
  extract: (content) =>
    systemdIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
          containers: e.containers,
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
