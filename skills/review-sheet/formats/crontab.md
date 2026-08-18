# crontab

One row per line: a job verbatim, or a `NAME=value` assignment.

## Detection

**Files:** /etc/crontab, /etc/cron.d/*, cron.d/*.j2

**Detection:** path (crontab, cron.d/)

**Delimiter:** `none for a job — the line IS the value; `=` for an assignment`

**Comments:** `#`

## Path style

job, job[1] — the nth job in the file; an assignment uses its own name

## Notes

- A job line is one indivisible statement, so the whole line is the value. Read as key=value it split at the first `=` inside the command (`EXITVALUE=$?`), producing a row named after half a shell command.
- A job's key is its POSITION among the jobs in the file, not its text: the line is what changes, and a key that changed with it would take every review comment, source map and apply target on that row with it.
- `MAILTO=""` and `PATH=...` are genuine settings and are read as key/value, quotes included — cron is what strips them. This is why crontab has its own parser instead of a general verbatim-lines format: only one that knows crontab can tell the two kinds of line apart.
- No line continuation: cron has none, so a trailing backslash is part of the command and lines are never folded.
- apply rewrites the whole line for a job. Editing one edits a command that runs on the host — which is the only thing such a row can mean.

## Examples

```
job
job[1]
MAILTO
```
