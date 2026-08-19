// Apache httpd config parser: wraps httpdIndex/httpdLocate/httpdEdit.
// Priority 60 so it beats sysctl/generic line parsers for .conf files.

import { httpdIndex, httpdLocate, httpdEdit, isHttpd } from "../httpd.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const httpdParser: ConfigParser = {
  name: "httpd",
  priority: 60,
  meta: {
    title: "httpd",
    summary: "Apache directives and <Tag> containers by label; repeats indexed.",
    files: "httpd.conf .htaccess conf.d/*.conf *.conf (content-detected)",
    detection:
      "content (<Tag> blocks, or — for a bare *.conf with no <Tag> at all, e.g. conf.d/proxy.conf — CamelCase " +
      "directive lines outnumbering key=value assignment lines) or filename httpd.conf/.htaccess; use --format httpd to force",
    delimiter: "Directive args",
    comments: "#",
    pathStyle: "VirtualHost[*:80].DocumentRoot — container by label",
    notes: [
      "Detected by <Tag>…</Tag> container syntax.",
      "Also detected, for a *.conf with no <Tag> block at all (the RHEL conf.d/ layout — one directive-only file per module/vhost), by CamelCase `Name value` lines (no `=`) outnumbering sysctl/ini-style `key = value` lines — sensitive enough for a handful of directives, but a file that is mostly assignments with one incidental capitalized value stays sysctl/generic.",
      "Containers addressed by label: VirtualHost[*:80].DocumentRoot.",
      "Repeated directives indexed.",
      "Conditional containers (If/ElseIf/Else, IfModule, IfDefine, IfVersion, Limit/LimitExcept) are addressed positionally instead — VirtualHost[*:80].If[0] — and their expression is extracted as its own reviewable/editable row (key = the container name, e.g. `If`), so editing the condition never reshuffles the paths of the directives inside it.",
      ".conf collides with nginx/sysctl; content detection disambiguates.",
    ],
    examples: ["VirtualHost[*:80].DocumentRoot", "VirtualHost[*:80].ServerName", "Directory[/var/www].Options", "VirtualHost[*:80].If[0]"],
  },
  detect: (file, content) => isHttpd(file, content),
  extract: (content) =>
    httpdIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
      containers: e.containers,
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = httpdLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return httpdEdit(content, source.path, current, suggested);
  },
};
registerParser(httpdParser);
