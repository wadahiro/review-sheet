// Line-oriented parsers: wraps extractLines for the 6 line formats, all
// sharing the same locate/edit — lineLocate/lineEdit (line-config.ts), the
// public "find by line + anchor" ConfigParser methods every one of these
// formats uses unchanged. Each format is registered as a ConfigParser with
// detect-by-extension logic.

import { extractLines, LINE_CONFIGS, lineLocate, lineEdit, lineLocateFor, lineEditFor } from "../line-config.js";
import { registerParser, type ConfigParser } from "../parser.js";

// properties: .properties files
const propertiesParser: ConfigParser = {
  name: "properties",
  priority: 10,
  meta: {
    title: "properties",
    summary: "Java .properties key=value files; # and ! comments; no sections, so no category of its own.",
    files: "*.properties",
    detection: "extension (.properties)",
    delimiter: "= or :",
    comments: "# !",
    pathStyle: "flat key; the format has no sections, so a row reports no category and one is decided elsewhere",
    notes: [
      "Key=value or key: value (colon variant).",
      "# and ! start comment lines.",
      "No sections, so no row carries a category of its own: what to call it is answered by a project declaration, a bound dictionary group, or the file it belongs to — and a row none of those answer for is an error naming it, rather than a tab named after nothing.",
    ],
    examples: ["server.port", "database.url"],
  },
  detect: (file) => file.toLowerCase().endsWith(".properties"),
  extract: (content) => extractLines(content, LINE_CONFIGS.properties),
  locate: lineLocate,
  edit: lineEdit,
};
registerParser(propertiesParser);

// dotenv: .env files
const dotenvParser: ConfigParser = {
  name: "dotenv",
  priority: 10,
  meta: {
    title: "dotenv",
    summary: ".env KEY=value files; export prefix stripped; quotes KEPT; # comments.",
    files: "*.env",
    detection: "extension (.env)",
    delimiter: "=",
    comments: "#",
    pathStyle: "flat key; the format has no sections, so a row reports no category and one is decided elsewhere",
    notes: [
      "Leading export keyword is stripped.",
      "# starts comment lines.",
      "No sections, so no row carries a category of its own — see the properties parser.",
      "Quotes are NOT stripped: `NAME=\"IAM Platform\"` extracts as `\"IAM Platform\"`, quotes included. The value is the file's text, which is what apply must put back — stripping them would make a quoted and an unquoted value indistinguishable, and re-quoting on apply a guess. Two consequences worth knowing: the sheet shows the quotes to reviewers, and such a value never compares equal to an unquoted dictionary default.",
      "No shell semantics: `$VAR` interpolation, escapes and multi-line values are taken literally.",
    ],
    examples: ["DATABASE_URL", "APP_PORT"],
  },
  detect: (file) => file.toLowerCase().endsWith(".env"),
  extract: (content) => extractLines(content, LINE_CONFIGS.dotenv),
  locate: lineLocate,
  edit: lineEdit,
};
registerParser(dotenvParser);

// sysctl: .conf files (lower priority than nginx/httpd/haproxy which also use .conf)
const sysctlParser: ConfigParser = {
  name: "sysctl",
  priority: 5,
  meta: {
    title: "sysctl",
    summary: "sysctl-style key = value .conf files; # and ; comments.",
    files: "*.conf (lower priority than nginx/httpd/haproxy)",
    detection: "extension (.conf, priority 5 — beaten by nginx/httpd/haproxy at 60)",
    delimiter: "=",
    comments: "# ;",
    pathStyle: "flat key; the format has no sections, so a row reports no category and one is decided elsewhere",
    notes: [
      "Lower priority than nginx/httpd/haproxy for .conf files.",
      "# and ; start comment lines.",
      "No sections, so no row carries a category of its own — see the properties parser.",
    ],
    examples: ["net.ipv4.tcp_fin_timeout", "vm.swappiness"],
  },
  detect: (file) => file.toLowerCase().endsWith(".conf"),
  extract: (content) => extractLines(content, LINE_CONFIGS.sysctl),
  locate: lineLocate,
  edit: lineEdit,
};
registerParser(sysctlParser);

// ini: .ini or .cfg files
const iniParser: ConfigParser = {
  name: "ini",
  priority: 10,
  meta: {
    title: "ini",
    summary: "INI/CFG [section] files; sections become categories.",
    files: "*.ini *.cfg",
    detection: "extension (.ini, .cfg)",
    delimiter: "= or :",
    comments: "# ;",
    pathStyle: "flat key within section category",
    notes: [
      "[section] headers become category path segments.",
      "Keys are flat within each section.",
      "# and ; start comment lines.",
    ],
    examples: ["database.host", "server.port"],
  },
  detect: (file) => {
    const f = file.toLowerCase();
    return f.endsWith(".ini") || f.endsWith(".cfg");
  },
  extract: (content) => extractLines(content, LINE_CONFIGS.ini),
  locate: lineLocate,
  edit: lineEdit,
};
registerParser(iniParser);

// space: whitespace-delimited — not auto-detected (force via getParser("space"))
const spaceParser: ConfigParser = {
  name: "space",
  priority: -50,
  meta: {
    title: "space",
    summary: "Whitespace-delimited files (e.g. sshd_config); force-only, not auto-detected.",
    files: "(force only — no dedicated extension)",
    detection: "force only (use --format space or getParser('space'))",
    delimiter: "whitespace",
    comments: "#",
    pathStyle: "flat key; the format has no sections, so a row reports no category and one is decided elsewhere",
    notes: [
      "Not auto-detected; must be forced with --format space.",
      "First whitespace run splits key from value.",
      "Useful for sshd_config, chrony.conf, MaxClients-style files.",
      "A directive with NO argument is a row whose value is `true`: in a whitespace format the file says the thing by naming it (`rtcsync`) and says nothing by leaving it out, so presence IS the value. Delimited formats (properties/dotenv/sysctl/ini/generic) deliberately do not do this — there a line with no delimiter is prose or a typo, not a flag.",
      "Such a row is verified by the line being EXACTLY that directive, not by finding its value on the line (the value is nowhere in the file). Apply HOLDS it: turning a flag off means deleting its line and turning one on means inventing a position for it, neither of which is the literal replacement apply performs.",
    ],
    examples: ["MaxClients", "PermitRootLogin", "rtcsync"],
  },
  detect: (_file, _content) => false,
  extract: (content) => extractLines(content, LINE_CONFIGS.space),
  // Flag-aware (LineConfig.bareFlag): `space` is the one shipped format where a
  // lone token is a setting, so its locate/edit must know that such a row's
  // value is nowhere on its own line.
  locate: lineLocateFor(LINE_CONFIGS.space),
  edit: lineEditFor(LINE_CONFIGS.space),
};
registerParser(spaceParser);

// generic: always matches as the last-resort fallback
const genericParser: ConfigParser = {
  name: "generic",
  priority: -100,
  meta: {
    title: "generic",
    summary: "Last-resort fallback; tries = then : as delimiter; always matches.",
    files: "anything else (fallback)",
    detection: "always (fallback, priority -100)",
    delimiter: "= or :",
    comments: "# ; !",
    pathStyle: "flat key; the format has no sections, so a row reports no category and one is decided elsewhere",
    notes: [
      "Matches everything — lowest priority (-100).",
      "Tries = first, then : as delimiter.",
      "# ; ! start comment lines.",
    ],
    examples: ["key=value", "key: value"],
  },
  detect: (_file, _content) => true,
  extract: (content) => extractLines(content, LINE_CONFIGS.generic),
  locate: lineLocate,
  edit: lineEdit,
};
registerParser(genericParser);
