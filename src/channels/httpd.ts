// What httpd says about its own defaults.
//
// A row claiming "the product's own default applies" is answered by the file
// only when nothing ELSE decides the value, and httpd has two something-elses
// that every project running it meets:
//
//   the BINARY's compiled-in defaults — `httpd -V` prints them as
//   `-D NAME="value"`, and a distribution's build routinely differs from the
//   manual the dictionary was written from (PidFile is the usual one);
//
//   a file BESIDE the configuration — `/etc/sysconfig/httpd`'s `OPTIONS` reach
//   the server as `httpd $OPTIONS`, and a `-C "Directive value"` in there sets
//   a directive that appears in no configuration file at all.
//
// Both are httpd's knowledge, not one project's, and copied into each project's
// judging script they are tested in none.

// Directive -> the name httpd prints it under. Only the directives whose
// default the binary actually reports: `httpd -V` is not a dump of every
// default, and a directive that is not here is answered by the dictionary as
// before.
const COMPILED_IN_NAME: Record<string, string> = {
  PidFile: "DEFAULT_PIDLOG",
  ScoreBoardFile: "DEFAULT_SCOREBOARD",
  ServerRoot: "HTTPD_ROOT",
  TypesConfig: "AP_TYPES_CONFIG_FILE",
  ServerConfigFile: "SERVER_CONFIG_FILE",
  ErrorLog: "DEFAULT_ERRORLOG",
  AccessConfigFile: "AP_ACCESS_CONFIG_FILE",
};

// `httpd -V` prints one `-D NAME="value"` per line among its other output.
export function compiledInDefaults(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of (text ?? "").matchAll(/^\s*-D\s+([A-Z_]+)="([^"]*)"/gm)) out.set(m[1]!, m[2]!);
  return out;
}

// The compiled-in default for a directive, where the binary reports one.
export function compiledInFor(text: string | null | undefined, directive: string): string | undefined {
  const name = COMPILED_IN_NAME[directive];
  return name === undefined ? undefined : compiledInDefaults(text).get(name);
}

// What `/etc/sysconfig/httpd` passes on the command line, when it passes
// anything that can SET configuration. `-C`/`-c` insert directives and `-D`
// defines a name an `<IfDefine>` can test — any of the three means the file
// alone can no longer say a default is in force.
//
// The file being ABSENT is the ordinary case on RHEL and is itself the answer:
// no OPTIONS, nothing injected.
export function injectedOptions(text: string | null | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const m = /^\s*OPTIONS=(.*)$/m.exec(text);
  const value = (m === null ? "" : m[1]!.trim()).replace(/^["']|["']$/g, "");
  return /(^|\s)-[CcD]\b/.test(value) ? value : undefined;
}

// Which line of an output a value was read at, so a verdict points at the words
// rather than at the whole of `httpd -V`.
export function lineOfCompiledIn(text: string | null | undefined, directive: string): number | undefined {
  const name = COMPILED_IN_NAME[directive];
  if (name === undefined || typeof text !== "string") return undefined;
  const at = text.split("\n").findIndex((l) => new RegExp(`^\\s*-D\\s+${name}="`).test(l));
  return at < 0 ? undefined : at + 1;
}

// WHICH files a configuration NAMES, and how to resolve them.
//
// "Nothing sets this, so the product's default applies" is a claim about every
// file the subject reads, and a collector has to fetch them before anyone can
// judge it. Where they are is httpd's grammar: `Include` and `IncludeOptional`
// take a glob, and a relative one is resolved against `ServerRoot` — which the
// file itself states. A project writing that out was writing httpd's manual
// into its playbook, and getting `IncludeOptional` or the ServerRoot arm wrong
// costs it nothing visible: the files are simply not fetched, and every row
// that depended on them says the default applies.
//
// Keyed off the file's NAME, because the collect plan is made before anything
// has been read — there is no content to detect from yet.
export function includeSyntaxFor(path: string): { pattern: string; root?: string }[] {
  if (!/httpd\.conf$|apache2\.conf$|\/conf\.d\/.*\.conf$/.test(path)) return [];
  return [
    {
      // The glob each Include line carries.
      pattern: "(?m)^\\s*Include(?:Optional)?\\s+(\\S+)",
      // …and what a relative one is relative to.
      root: '(?m)^\\s*ServerRoot\\s+"?([^"\\s]+)"?',
    },
  ];
}
