// nginx config parser: wraps nginxIndex/nginxLocate/nginxEdit.
// Priority 60 so it beats sysctl/generic line parsers for .conf files.

import { nginxIndex, nginxLocate, nginxEdit, isNginx } from "../nginx.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const nginxParser: ConfigParser = {
  name: "nginx",
  priority: 60,
  meta: {
    title: "nginx",
    summary: "Directives and {} blocks; labeled blocks by label; repeats indexed.",
    files: "nginx.conf *.conf (content-detected)",
    detection: "content (nginx block syntax) or filename nginx.conf; use --format nginx to force",
    delimiter: "directive args;",
    comments: "#",
    pathStyle: "http.server.location[/api].proxy_pass — block by label; repeats indexed",
    notes: [
      "Detected by content (block syntax), not just extension.",
      "Labeled blocks addressed by label: http.server.location[/api].proxy_pass.",
      "Repeated directives indexed.",
      "`if (...)` blocks are addressed positionally instead — http.server.location[/api].if[0] — and the condition is extracted as its own reviewable/editable row (key `if`), so editing the condition never reshuffles the paths of the directives inside it.",
      "No reliable dedicated extension; .conf collides with sysctl/haproxy.",
    ],
    examples: ["http.server.listen", "http.server.location[/api].proxy_pass", "http.upstream[backend].server[0]", "http.server.location[/api].if[0]"],
  },
  detect: (file, content) => isNginx(file, content),
  extract: (content) =>
    nginxIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
          containers: e.containers,
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = nginxLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return nginxEdit(content, source.path, current, suggested);
  },
};
registerParser(nginxParser);
