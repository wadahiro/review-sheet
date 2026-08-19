// HAProxy config parser: wraps haproxyIndex/haproxyLocate/haproxyEdit.
// Priority 60 so it beats sysctl/generic line parsers for .conf/.cfg files.

import { haproxyIndex, haproxyLocate, haproxyEdit, isHaproxy } from "../haproxy.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const haproxyParser: ConfigParser = {
  name: "haproxy",
  priority: 60,
  meta: {
    title: "haproxy",
    summary: "Sections and directives; named sections + repeated directive by 1st arg.",
    files: "haproxy.cfg *.cfg (content-detected)",
    detection: "content (haproxy section keywords) or filename haproxy.cfg; use --format haproxy to force",
    delimiter: "key value (space-separated under section)",
    comments: "#",
    pathStyle: "backend[app].server[web1] — named section + directive by 1st arg",
    notes: [
      "Detected by haproxy section keywords (frontend/backend/global/defaults).",
      "Named sections: frontend[http-in], backend[app].",
      "Repeated directive addressed by first argument: server[web1].",
      ".cfg collides with ini; .conf collides with nginx/sysctl.",
    ],
    examples: ["global.maxconn", "frontend[http-in].bind", "backend[app].server[web1]"],
  },
  detect: (file, content) => isHaproxy(file, content),
  extract: (content) =>
    haproxyIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
          containers: e.containers,
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = haproxyLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return haproxyEdit(content, source.path, current, suggested);
  },
};
registerParser(haproxyParser);
