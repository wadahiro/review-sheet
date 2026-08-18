// crontab parser: wraps crontabIndex/crontabLocate/crontabEdit.

import { crontabIndex, crontabLocate, crontabEdit } from "../crontab.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const crontabParser: ConfigParser = {
  name: "crontab",
  // Above the extension-driven line formats. `/etc/cron.d/logrotate` has no
  // extension at all and fell to the generic key=value reader, which split a
  // job at the first `=` inside its command.
  priority: 70,
  meta: {
    title: "crontab",
    summary: "One row per line: a job verbatim, or a `NAME=value` assignment.",
    files: "/etc/crontab, /etc/cron.d/*, cron.d/*.j2",
    detection: "path (crontab, cron.d/)",
    delimiter: "none for a job — the line IS the value; `=` for an assignment",
    comments: "#",
    pathStyle: "job, job[1] — the nth job in the file; an assignment uses its own name",
    notes: [
      "A job line is one indivisible statement, so the whole line is the value. Read as key=value it split at the first `=` inside the command (`EXITVALUE=$?`), producing a row named after half a shell command.",
      "A job's key is its POSITION among the jobs in the file, not its text: the line is what changes, and a key that changed with it would take every review comment, source map and apply target on that row with it.",
      "`MAILTO=\"\"` and `PATH=...` are genuine settings and are read as key/value, quotes included — cron is what strips them. This is why crontab has its own parser instead of a general verbatim-lines format: only one that knows crontab can tell the two kinds of line apart.",
      "No line continuation: cron has none, so a trailing backslash is part of the command and lines are never folded.",
      "apply rewrites the whole line for a job. Editing one edits a command that runs on the host — which is the only thing such a row can mean.",
    ],
    examples: ["job", "job[1]", "MAILTO"],
  },
  // By path: a crontab line has no syntax that marks it out, and every file
  // that holds one lives somewhere that names it.
  detect: (file) => {
    const f = file.toLowerCase();
    // Never a `.j2` — that is the jinja2 parser's, which strips the suffix and
    // asks again with the base name (see the logrotate parser for the same).
    if (f.endsWith(".j2")) return false;
    return /(^|\/)crontab$/.test(f) || /(^|\/)cron\.d\//.test(f) || /(^|\/)cron[-_.][^/]*$/.test(f);
  },
  extract: (content) =>
    crontabIndex(content).map((e) => ({
      // Flat: a crontab has no sections. The FILE is the grouping, which
      // `group_by: file` supplies from outside.
      categoryPath: [],
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = crontabLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return crontabEdit(content, source.path, current, suggested);
  },
};
registerParser(crontabParser);
