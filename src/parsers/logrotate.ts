// logrotate policy parser: wraps logrotateIndex/logrotateLocate/logrotateEdit.

import { logrotateIndex, logrotateLocate, logrotateEdit } from "../logrotate.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const logrotateParser: ConfigParser = {
  name: "logrotate",
  // Above the brace-structured formats: `/var/log/x { … }` is nginx's grammar
  // too, and nginx detects by content, so the one that knows WHERE a logrotate
  // policy lives has to be asked first.
  priority: 70,
  meta: {
    title: "logrotate",
    summary: "`/path/*.log { … }` blocks: flags, `name args`, and script bodies.",
    files: "/etc/logrotate.conf, /etc/logrotate.d/*, logrotate-*.j2",
    detection: "path (logrotate.conf, logrotate.d/, a logrotate-* template)",
    delimiter: "whitespace (`rotate 30`); a bare word is a flag",
    comments: "#",
    pathStyle: "/var/log/httpd/*log.rotate — the block's patterns, then the directive",
    notes: [
      "A block's path patterns identify it and become the category path; directives outside any block are filed under (global), which is what logrotate.conf's own defaults are.",
      "The patterns may be separated by newlines and the brace may sit on a line of its own. A top-level line is a directive when it NAMES one (the set is closed and defined by logrotate); anything else there starts a block header — so a pattern written as a template substitution works, and so does one this parser has never seen.",
      "A bare flag's value is `true`: it has no argument, its presence IS the setting, and logrotate's flags come in pairs (compress/nocompress) so which one is written is the row that matters.",
      "postrotate/prerotate/firstaction/lastaction/preremove keep their script body as the value — what runs around a rotation is exactly what a review asks about.",
      "Repeated directives in one block are indexed, as everywhere else: postrotate[1].",
      "apply holds on a flag (nothing to rewrite — add or remove the directive) and on a script body (editing it is a change to what runs on the host, not a parameter change).",
    ],
    examples: ["/var/log/httpd/*log.rotate", "/var/log/httpd/*log.missingok", "/var/log/httpd/*log.postrotate"],
  },
  // By path, not by content: a logrotate file has no syntax of its own that
  // something else does not also have (`name { … }` is nginx too), and every
  // one of them lives in a place that names it.
  detect: (file) => {
    const f = file.toLowerCase();
    // Never a `.j2`: that belongs to the jinja2 parser, which strips the
    // suffix and asks again — at which point this answers for the base name.
    // Claiming the template directly would skip the `{{ }}` handling entirely.
    if (f.endsWith(".j2")) return false;
    return /(^|\/)logrotate\.conf$/.test(f) || /(^|\/)logrotate\.d\//.test(f) || /(^|\/)logrotate[-_][^/]*$/.test(f);
  },
  extract: (content) =>
    logrotateIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
          containers: e.containers,
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = logrotateLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return logrotateEdit(content, source.path, current, suggested);
  },
};
registerParser(logrotateParser);
