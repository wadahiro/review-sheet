// Side-effect imports: each module registers its parser(s) at module load time.
// Import this file once to populate the registry before calling resolveParser().

import "./line.js";
import "./yamljson.js";
import "./xml.js";
import "./toml.js";
import "./logrotate.js";
import "./crontab.js";
import "./systemd.js";
import "./shell.js";
import "./nginx.js";
import "./httpd.js";
import "./haproxy.js";
import "./hcl.js";
import "./jinja2.js";
import "./ts.js";
import "./py.js";

import { listParsers } from "../parser.js";

// What counts as a BUILT-IN parser, derived from the imports above rather than
// hand-listed — the same reasoning as `providers/index.ts`'s
// `BUILT_IN_PROVIDER_NAMES`, and needed for the same reason: the parser
// registry is process-wide (registry.ts keys it off `Symbol.for`), so a parser
// any test file registers is visible to every other one, in whatever order the
// runner happens to pick. A test asserting on what the SHIPPED parsers extract
// wants only these answering.
export const BUILT_IN_PARSER_NAMES: readonly string[] = listParsers().map((p) => p.name);
