// crontab files: `/etc/crontab`, `/etc/cron.d/*`, and the templates that render
// them.
//
// The format every other line parser here assumes — one line, a delimiter, a
// key and a value — is wrong for this one, and wrong in a way that produces
// garbage rather than nothing. Read as `key=value`, a job line splits at the
// first `=` inside the COMMAND, so
//
//     10 4 * * * root /usr/sbin/logrotate ... ; EXITVALUE=$?; if ...
//
// becomes a "setting" named `10 4 * * * root /usr/sbin/logrotate ... EXITVALUE`
// whose value is a fragment of shell. Nobody can write a description for that,
// and writing one would fix a source map onto a piece of a command.
//
// Two things make this a crontab parser rather than a general "each line is one
// entry" format:
//
//   - A crontab has TWO kinds of line. `MAILTO=""` and `PATH=/usr/bin` are
//     genuine key/value settings and a reviewer cares about them as such; a job
//     line is one indivisible statement. Only a parser that knows crontab can
//     tell them apart, and a verbatim-lines format would flatten the
//     difference.
//   - A job's KEY cannot be the line. The line is what changes; a key that
//     changes with it takes every review comment, source map and apply target
//     on that row with it. So a job is identified by its position among the
//     jobs in its file — `job`, `job[1]`, ... — which is the same way repeated
//     directives are indexed everywhere else here, and the value is the line
//     verbatim, which is what the paper sheet this replaces put in the cell.
//
// No line continuation: cron has none. A trailing backslash is part of the
// command, and folding lines here would silently rewrite what runs on the host.

export type CrontabEntry = {
  key: string;
  value: string;
  line: number;
  path: string;
};

// `NAME = value` at the start of a line. A job line cannot look like this: its
// first field is a schedule, which begins with a digit, `*`, `,`, `-`, `/` or
// `@`. So the two kinds are told apart without guessing.
const ENV = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

const stripComment = (line: string): string => (line.trimStart().startsWith("#") ? "" : line.trim());

export function crontabIndex(content: string): CrontabEntry[] {
  const out: CrontabEntry[] = [];
  let jobs = 0;
  const seen = new Map<string, number>();

  content.split("\n").forEach((raw, i) => {
    const text = stripComment(raw);
    if (!text) return;

    const env = ENV.exec(text);
    const key = env === null ? (jobs === 0 ? "job" : `job[${jobs}]`) : env[1];
    if (env === null) jobs++;
    // An environment name repeated in one file is the last one that wins, but
    // both lines are in the file and both are rows: dropping either would lose
    // a line somebody wrote.
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    const finalKey = n === 0 ? key : `${key}(${n})`;
    out.push({
      key: finalKey,
      // A job is its whole line. An assignment keeps its value verbatim,
      // quotes included: `MAILTO=""` means something different from `MAILTO=`,
      // and cron is what strips them, not this.
      value: env === null ? text : env[2].trim(),
      line: i + 1,
      path: finalKey,
    });
  });
  return out;
}

export function crontabLocate(content: string, path: string): { value: string } | { error: string } {
  const hit = crontabIndex(content).find((e) => e.path === path);
  return hit ? { value: hit.value } : { error: `no crontab entry at ${path}` };
}

export function crontabEdit(
  content: string,
  path: string,
  current: string,
  suggested: string
): { status: "applied"; content: string; before: string; after: string } | { status: "error"; reason: string } {
  const hit = crontabIndex(content).find((e) => e.path === path);
  if (!hit) return { status: "error", reason: `no crontab entry at ${path}` };
  if (hit.value !== current) return { status: "error", reason: `value is "${hit.value}", expected "${current}" — stale?` };
  const lines = content.split("\n");
  const idx = hit.line - 1;
  const before = lines[idx];
  // A job IS its line, so the line is replaced whole. Editing one is editing a
  // command that runs on the host — the same thing logrotate's script bodies
  // refuse — but here it is the only thing the row can mean, so it is allowed
  // and the caller is the one deciding whether to write it.
  const after = hit.key.startsWith("job")
    ? before.replace(current, suggested)
    : before.replace(new RegExp(`(=\\s*)${current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), `$1${suggested}`);
  if (after === before) return { status: "error", reason: `"${current}" not found on line ${hit.line}` };
  lines[idx] = after;
  return { status: "applied", content: lines.join("\n"), before, after };
}
