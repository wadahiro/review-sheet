// crontab files. The blind spot this closed produced garbage rather than
// nothing: read by the key=value parser its extension attracted, a job line
// split at the first `=` inside its COMMAND, so a row appeared named
// `10 4 * * * root /usr/sbin/logrotate ... EXITVALUE` with a fragment of shell
// as its value — something nobody can describe, and describing it would fix a
// source map onto half a command.

import { describe, it, expect } from "bun:test";
import { crontabIndex, crontabLocate, crontabEdit } from "../src/crontab";
import { resolveParser } from "../src/parser";
import "../src/parsers/index.js";

const CRON_D = `# Run the rotation
MAILTO=""
PATH=/sbin:/bin:/usr/sbin:/usr/bin
10 4 * * * root /usr/sbin/logrotate /etc/logrotate.conf >/dev/null 2>&1; EXITVALUE=$?; if [ $EXITVALUE != 0 ]; then /usr/bin/logger -t logrotate "ALERT"; fi
*/5 * * * * root netstat -naptu >> /var/log/netstat/netstat.log
`;

describe("crontabIndex", () => {
  it("keeps a job line whole, however much shell is in it", () => {
    const job = crontabIndex(CRON_D).find((e) => e.key === "job")!;
    expect(job.value).toBe(
      '10 4 * * * root /usr/sbin/logrotate /etc/logrotate.conf >/dev/null 2>&1; EXITVALUE=$?; if [ $EXITVALUE != 0 ]; then /usr/bin/logger -t logrotate "ALERT"; fi'
    );
    // The failure this exists for: the row must not be named after the part of
    // the command before an `=`.
    expect(job.key).not.toContain("EXITVALUE");
  });

  // A key that changed with the line would take every review comment, source
  // map and apply target on that row with it, on the first edit.
  it("identifies a job by its position, not by its text", () => {
    expect(crontabIndex(CRON_D).map((e) => e.key)).toEqual(["MAILTO", "PATH", "job", "job[1]"]);
  });

  // The other half of why this is a crontab parser and not a general
  // verbatim-lines format: these two kinds of line are genuinely different, and
  // only something that knows crontab can tell them apart.
  it("reads an assignment as a setting, quotes and all", () => {
    const entries = crontabIndex(CRON_D);
    // `MAILTO=""` is not `MAILTO=`; cron is what strips the quotes, not this.
    expect(entries.find((e) => e.key === "MAILTO")!.value).toBe('""');
    expect(entries.find((e) => e.key === "PATH")!.value).toBe("/sbin:/bin:/usr/sbin:/usr/bin");
  });

  it("skips comments and blank lines, and numbers the lines it keeps", () => {
    const entries = crontabIndex(CRON_D);
    expect(entries.find((e) => e.key === "job")!.line).toBe(4);
    expect(entries.find((e) => e.key === "job[1]")!.line).toBe(5);
  });

  it("takes a special schedule as a job like any other", () => {
    const entries = crontabIndex("@reboot root /usr/local/bin/warm-cache\n");
    expect(entries.map((e) => [e.key, e.value])).toEqual([["job", "@reboot root /usr/local/bin/warm-cache"]]);
  });

  // cron has no line continuation, so a trailing backslash is part of the
  // command. Folding lines here would rewrite what runs on the host.
  it("does not join a line ending in a backslash to the next", () => {
    expect(crontabIndex("0 * * * * root echo one \\\n0 1 * * * root echo two\n").map((e) => e.key)).toEqual([
      "job",
      "job[1]",
    ]);
  });

  it("keeps both of a repeated assignment rather than dropping one", () => {
    expect(crontabIndex("MAILTO=a\nMAILTO=b\n").map((e) => [e.key, e.value])).toEqual([
      ["MAILTO", "a"],
      ["MAILTO(1)", "b"],
    ]);
  });
});

describe("crontabLocate / crontabEdit", () => {
  it("finds a row by its path", () => {
    expect(crontabLocate(CRON_D, "PATH")).toEqual({ value: "/sbin:/bin:/usr/sbin:/usr/bin" });
    expect(crontabLocate(CRON_D, "nope")).toEqual({ error: "no crontab entry at nope" });
  });

  it("rewrites an assignment in place", () => {
    const r = crontabEdit(CRON_D, "MAILTO", '""', '"ops@example.invalid"');
    expect(r.status).toBe("applied");
    expect((r as { content: string }).content).toContain('MAILTO="ops@example.invalid"');
  });

  it("replaces a job's whole line, because that is what the row is", () => {
    const r = crontabEdit(CRON_D, "job[1]", "*/5 * * * * root netstat -naptu >> /var/log/netstat/netstat.log", "*/10 * * * * root netstat -naptu >> /var/log/netstat/netstat.log");
    expect(r.status).toBe("applied");
    expect((r as { content: string }).content).toContain("*/10 * * * * root netstat");
  });

  it("refuses when the file has moved on", () => {
    const r = crontabEdit(CRON_D, "MAILTO", "stale", "x");
    expect(r.status).toBe("error");
    expect((r as { reason: string }).reason).toContain("stale?");
  });
});

describe("which parser reads a crontab", () => {
  // `/etc/cron.d/logrotate` has no extension at all and fell to the generic
  // key=value reader — the whole bug.
  it("claims the files that hold one", () => {
    for (const f of ["/etc/cron.d/logrotate", "/etc/crontab", "roles/os/files/cron.d/netstat"]) {
      expect(resolveParser(f, CRON_D)?.name).toBe("crontab");
    }
  });

  it("leaves a template to the jinja2 parser, which asks again by base name", () => {
    expect(resolveParser("roles/os/templates/cron.d/logrotate.j2", CRON_D)?.name).toBe("jinja2");
  });

  it("does not claim a file that merely mentions cron", () => {
    expect(resolveParser("/etc/sysconfig/anacron", "X=1\n")?.name).not.toBe("crontab");
  });
});
