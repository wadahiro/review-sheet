// Side-effect imports: each module registers its parser(s) at module load time.
// Import this file once to populate the registry before calling resolveParser().

import "./line.js";
import "./yamljson.js";
import "./xml.js";
import "./toml.js";
import "./systemd.js";
import "./shell.js";
import "./nginx.js";
import "./httpd.js";
import "./haproxy.js";
import "./hcl.js";
import "./jinja2.js";
import "./ts.js";
import "./py.js";
