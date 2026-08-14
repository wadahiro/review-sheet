// logrotate policy files. The blind spot this closed was concrete: a project
// reviewing its log retention had nothing on the sheet but the Ansible
// variables feeding the template, so `copytruncate` — a decision that trades a
// lost line for the ability to rotate a file a process holds open — was in the
// deployed file and invisible to every reviewer.

import { describe, it, expect } from "bun:test";
import { logrotateIndex, logrotateLocate, logrotateEdit } from "../src/logrotate";
import { resolveParser } from "../src/parser";
import "../src/parsers/index.js";

const HTTPD = `# {{ ansible_managed }}
/var/log/httpd/*log {
    daily
    rotate 30
    missingok
    notifempty
    sharedscripts
    compress
    delaycompress
    postrotate
        /bin/systemctl reload httpd.service > /dev/null 2>/dev/null || true
    endscript
}
`;

const TWO_BLOCKS = `compress
/var/log/a/*.log {
    rotate 7
}
/var/log/b/*.log {
    rotate 30
    su app app
}
`;

describe("logrotate", () => {
  it("is chosen by where the file lives, not by guessing at its syntax", () => {
    // `name { … }` is nginx too, so content detection would be a coin toss.
    expect(resolveParser("/etc/logrotate.d/httpd", HTTPD)?.name).toBe("logrotate");
    expect(resolveParser("roles/httpd/templates/logrotate-httpd.j2", HTTPD)?.name).toBe("jinja2");
    expect(resolveParser("/etc/logrotate.conf", HTTPD)?.name).toBe("logrotate");
  });

  it("reads every directive of a block, under the block's own patterns", () => {
    const idx = logrotateIndex(HTTPD);
    expect(idx.map((e) => e.key)).toEqual([
      "daily",
      "rotate",
      "missingok",
      "notifempty",
      "sharedscripts",
      "compress",
      "delaycompress",
      "postrotate",
    ]);
    expect(idx.every((e) => e.categoryPath[0] === "/var/log/httpd/*log")).toBe(true);
  });

  // A flag has no argument; its presence IS the setting, and logrotate's flags
  // come in pairs, so which one is written is the row that matters.
  it("gives a bare flag the value true and a directive its arguments", () => {
    const by = new Map(logrotateIndex(HTTPD).map((e) => [e.key, e.value]));
    expect(by.get("missingok")).toBe("true");
    expect(by.get("rotate")).toBe("30");
  });

  it("keeps a script body as the value — what runs around a rotation is review material", () => {
    const by = new Map(logrotateIndex(HTTPD).map((e) => [e.key, e.value]));
    expect(by.get("postrotate")).toBe("/bin/systemctl reload httpd.service > /dev/null 2>/dev/null || true");
  });

  it("keeps two blocks apart, and files a global directive under (global)", () => {
    const idx = logrotateIndex(TWO_BLOCKS);
    expect(idx.find((e) => e.key === "compress")!.categoryPath).toEqual(["(global)"]);
    expect(idx.filter((e) => e.key === "rotate").map((e) => `${e.categoryPath[0]}=${e.value}`)).toEqual([
      "/var/log/a/*.log=7",
      "/var/log/b/*.log=30",
    ]);
    expect(logrotateLocate(TWO_BLOCKS, "/var/log/b/*.log.su")).toEqual({ value: "app app" });
  });

  it("edits a directive's arguments in place", () => {
    const r = logrotateEdit(HTTPD, "/var/log/httpd/*log.rotate", "30", "14");
    expect(r.status).toBe("applied");
    if (r.status === "applied") expect(r.content).toContain("rotate 14");
  });

  // Both refusals are the point: apply turns them into a held change with the
  // reason attached, rather than writing something nobody asked for.
  it("refuses to rewrite a flag, which has no value to rewrite", () => {
    const r = logrotateEdit(HTTPD, "/var/log/httpd/*log.missingok", "true", "false");
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toContain("add or remove the directive");
  });

  it("refuses to rewrite a script body, which is not a parameter value", () => {
    const idx = logrotateIndex(HTTPD);
    const body = idx.find((e) => e.key === "postrotate")!.value;
    const r = logrotateEdit(HTTPD, "/var/log/httpd/*log.postrotate", body, "echo hi");
    expect(r.status).toBe("error");
    if (r.status === "error") expect(r.reason).toContain("script body");
  });

  it("ignores comments, including one after a directive", () => {
    const idx = logrotateIndex("/var/log/x {\n  rotate 5 # keep five\n}\n");
    expect(idx.map((e) => `${e.key}=${e.value}`)).toEqual(["rotate=5"]);
  });
});
