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

// One block, its paths on their own lines and the brace on another. Ordinary
// logrotate: a pattern is "a path, a glob, or a whitespace-separated list", and
// newlines are whitespace. Read as one-line-only, every directive in the block
// was filed under the global scope — so a sheet said these settings applied to
// every log on the host — and each path line became a row of its own.
const MULTILINE_HEADER = `/var/log/app/server.log
/var/log/app/access_log.txt
{
    rotate 7
    daily
    copytruncate
}
`;

describe("a block header spread over several lines", () => {
  it("files the directives under the block, not the global scope", () => {
    const entries = logrotateIndex(MULTILINE_HEADER);
    const scopes = new Set(entries.map((e) => e.categoryPath[0]));
    expect([...scopes]).toEqual(["/var/log/app/server.log /var/log/app/access_log.txt"]);
  });

  it("does not turn the path lines into directives", () => {
    expect(logrotateIndex(MULTILINE_HEADER).map((e) => e.key)).toEqual(["rotate", "daily", "copytruncate"]);
  });

  it("keeps the values and lines addressable", () => {
    const entries = logrotateIndex(MULTILINE_HEADER);
    const rotate = entries.find((e) => e.key === "rotate")!;
    expect(rotate.value).toBe("7");
    expect(rotate.line).toBe(4);
    expect(logrotateLocate(MULTILINE_HEADER, rotate.path)).toEqual({ value: "7" });
  });

  it("still reads the one-line form, and a mix of both", () => {
    const mixed = `/var/log/a.log /var/log/b.log {
    rotate 3
}
/var/log/c.log
/var/log/d.log
{
    rotate 9
}
`;
    const entries = logrotateIndex(mixed);
    expect(entries.map((e) => [e.categoryPath[0], e.key, e.value])).toEqual([
      ["/var/log/a.log /var/log/b.log", "rotate", "3"],
      ["/var/log/c.log /var/log/d.log", "rotate", "9"],
    ]);
  });

  // Global directives and a multi-line header in the same file: a bare flag is
  // one word and so is nothing else here, so the two are told apart by shape.
  it("does not mistake a global flag for a path", () => {
    const withGlobals = `compress
su root root
/var/log/a.log
/var/log/b.log
{
    rotate 7
}
`;
    expect(logrotateIndex(withGlobals).map((e) => [e.categoryPath[0], e.key])).toEqual([
      ["(global)", "compress"],
      ["(global)", "su"],
      ["/var/log/a.log /var/log/b.log", "rotate"],
    ]);
  });

  // Malformed rather than clever: a pattern with no brace after it must still
  // reach the sheet, because a line that disappears is the failure this exists
  // to prevent.
  it("emits a pattern that never got its brace instead of dropping it", () => {
    expect(logrotateIndex("/var/log/orphan.log\ncompress\n").map((e) => e.key))
      .toEqual(["/var/log/orphan.log", "compress"]);
    expect(logrotateIndex("/var/log/at-eof.log\n").map((e) => e.key)).toEqual(["/var/log/at-eof.log"]);
  });
});

// A logrotate policy is routinely written as a .j2 with the install prefix in a
// variable. A block header that begins with one has to be recognised as a
// header, or every directive under it is read as a global default applying to
// every log on the host.
//
// These go THROUGH the .j2 parser as well as straight in, because the two see
// different text: jinja2.ts masks every substitution into an opaque token
// before the base parser runs, so a fix that recognises `{{` passes a direct
// test and changes nothing at all in the pipeline. That is exactly what
// happened once.
describe("a pattern that begins with a template substitution", () => {
  const TEMPLATED = `/var/log/keycloak/server.log
{
    rotate 7
    daily
}

{{ keycloak_home }}/data/log/keycloak-http-access.log
{
    rotate 14
    weekly
}
`;

  it("reads it as a block header, not as global directives", () => {
    const entries = logrotateIndex(TEMPLATED);
    expect(entries.map((e) => [e.categoryPath[0], e.key, e.value])).toEqual([
      ["/var/log/keycloak/server.log", "rotate", "7"],
      ["/var/log/keycloak/server.log", "daily", "true"],
      ["{{ keycloak_home }}/data/log/keycloak-http-access.log", "rotate", "14"],
      ["{{ keycloak_home }}/data/log/keycloak-http-access.log", "weekly", "true"],
    ]);
  });

  it("addresses a row inside it like any other", () => {
    const entries = logrotateIndex(TEMPLATED);
    const rotate = entries.find((e) => e.categoryPath[0].startsWith("{{") && e.key === "rotate")!;
    expect(logrotateLocate(TEMPLATED, rotate.path)).toEqual({ value: "14" });
  });

  it("takes the brace on the same line too", () => {
    const same = `{{ home }}/log/*.log {
    rotate 3
}
`;
    expect(logrotateIndex(same).map((e) => [e.categoryPath[0], e.key])).toEqual([
      ["{{ home }}/log/*.log", "rotate"],
    ]);
  });

  // A directive whose ARGUMENT is templated is still a directive: the shape
  // test reads the first token, not the line.
  it("does not mistake a templated argument for a pattern", () => {
    const args = `/var/log/a.log {
    rotate {{ keep_days }}
    su {{ svc_user }} {{ svc_group }}
}
`;
    expect(logrotateIndex(args).map((e) => [e.key, e.value])).toEqual([
      ["rotate", "{{ keep_days }}"],
      ["su", "{{ svc_user }} {{ svc_group }}"],
    ]);
  });

  // A templated pattern with no brace after it must not be split on whitespace:
  // that names the row `{{`, which names nothing.
  it("keeps a strayed templated pattern whole", () => {
    expect(logrotateIndex("{{ home }}/log/x.log\ncompress\n").map((e) => [e.key, e.value])).toEqual([
      ["{{ home }}/log/x.log", "true"],
      ["compress", "true"],
    ]);
  });

  // The pipeline, not the core: the base parser sees a MASKED template, so this
  // is the only test that can tell whether the fix reaches a real file.
  it("works through the .j2 parser, where the substitution is masked", () => {
    const file = "roles/keycloak/templates/logrotate-keycloak.j2";
    const parser = resolveParser(file, TEMPLATED);
    expect(parser?.name).toBe("jinja2");
    const entries = parser!.extract(TEMPLATED, file, {});
    expect(entries.map((e) => [e.categoryPath?.join(" > "), e.key, e.value])).toEqual([
      ["/var/log/keycloak/server.log", "rotate", "7"],
      ["/var/log/keycloak/server.log", "daily", "true"],
      ["{{ keycloak_home }}/data/log/keycloak-http-access.log", "rotate", "14"],
      ["{{ keycloak_home }}/data/log/keycloak-http-access.log", "weekly", "true"],
    ]);
  });
});

// A block header only ever appears at the TOP LEVEL, so nothing inside a block
// has to be told apart from one — which is what makes a directive logrotate
// gained after this was written safe there.
describe("telling a directive from a pattern", () => {
  it("reads an unknown directive inside a block as a directive", () => {
    const entries = logrotateIndex("/var/log/a.log {\n    somethingnew 5\n    futureflag\n}\n");
    expect(entries.map((e) => [e.categoryPath[0], e.key, e.value])).toEqual([
      ["/var/log/a.log", "somethingnew", "5"],
      ["/var/log/a.log", "futureflag", "true"],
    ]);
  });

  it("still reads the ordinary global directives as directives", () => {
    const entries = logrotateIndex("compress\nsu root root\nrotate 4\ninclude /etc/logrotate.d\n");
    expect(entries.map((e) => [e.categoryPath[0], e.key])).toEqual([
      ["(global)", "compress"],
      ["(global)", "su"],
      ["(global)", "rotate"],
      ["(global)", "include"],
    ]);
  });
});
