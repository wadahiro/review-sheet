// Shell script parser: wraps shellIndex/shellLocate/shellEdit.

import { shellIndex, shellLocate, shellEdit, isShell } from "../shell.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const shellParser: ConfigParser = {
  name: "shell",
  // Above the generic fallback, below the content-detected config formats: a
  // `.conf`/`.cfg` never has a shebang, so there is nothing to contend with.
  priority: 20,
  meta: {
    title: "Shell",
    summary: "Variable assignments and long options with values; a CLI wrapper's arguments become parameters.",
    files: "*.sh *.bash *.ksh *.zsh, or any file with a #! shell shebang",
    detection: "extension, or a #!…sh shebang",
    delimiter: "NAME=value, --opt value, --opt=value",
    comments: "# (whole-line only)",
    pathStyle: "--region — the variable name, or the option WITH its dashes; repeats indexed (--region[0])",
    notes: [
      "Only two shapes are extracted: a variable assignment at the start of a statement (optionally behind export/local/readonly/declare), and a long option carrying a value (`--opt value` or `--opt=value`).",
      "Deliberately NOT extracted: the command word, positional arguments, bare flags with no value, and short options (`-r`) — a short option cannot be told apart from a bundle like `-rf` without knowing the command.",
      "Keys keep the option's dashes (`--region`) so an option and a same-named variable can never collide.",
      "A key occurring more than once is indexed by position (`--region[0]`, `--region[1]`); order is the only identity a command line offers.",
      "Heredoc bodies are skipped — they are payload (an embedded config, a SQL script), not this script's own configuration.",
      "Quotes are kept as written and restored on apply, so replacing `\"a b\"` never silently turns one argument into two.",
      "Only whole-line `#` comments are recognised; a trailing comment is left in place (its words are not options, so nothing is extracted from it).",
      "Combined with the jinja2 parser this gives `*.sh.j2` a base format: `--secret-id {{ kc_db_secret_name }}` records its templateVar and resolves against the role's variable file.",
    ],
    examples: ["--region", "--secret-id", "REGION", "--endpoint-url[1]"],
  },
  detect: (file, content) => isShell(file, content),
  extract: (content) =>
    shellIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = shellLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return shellEdit(content, source.path, current, suggested);
  },
};
registerParser(shellParser);
