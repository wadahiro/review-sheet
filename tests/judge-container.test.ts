// A ROW THAT IS A BLOCK, not a setting.
//
// `<Directory "/var/www">`, a logrotate pattern, `[Service]` — the opening of a
// block, which holds other rows and has no value of its own to compare. What
// "checked" means for it is that the block is there.
//
// …except that an opening is not nothing. It is written at a LINE, and what it
// says is an IDENTITY a reviewer signs: which log a rotation policy is for is
// the pattern the block opens with, and it is the whole of what that row means.
// The parsers all record both (`ContainerNode.line` / `.subject`); the judge's
// own read of a file threw them away and kept only the leaves, so a container
// row could be told two things about itself, both weaker than the file allows —
// that it exists, and nothing about where.

import { describe, it, expect } from "bun:test";
import { judgeFiles, type Observation } from "../src/judge";
import type { TestPlan, TestItem } from "../src/testplan";

const POLICY = [
  "# Ansible managed",
  "/var/log/httpd/*log {",
  "    daily",
  "    rotate 30",
  "}",
  "",
].join("\n");

const item = (over: Partial<TestItem>): TestItem =>
  ({
    target: { sheet: "os", path: [], key: "/var/log/httpd/*log", instance: "prod" },
    unit: "u",
    file: "/etc/logrotate.d/httpd",
    kind: "value",
    decider: "project",
    ...over,
  }) as TestItem;

const planOf = (items: TestItem[]): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { en: "m" } }, sheets: ["os"] }], items, functional: [] }) as never;

const obs = (text: string | null): Observation =>
  ({
    environment: "prod",
    hosts: { h1: { files: { "/etc/logrotate.d/httpd": text } } },
  }) as never;

const judged = (i: TestItem, text: string | null = POLICY) =>
  judgeFiles(planOf([i]), [obs(text)], { at: "X", lang: "en" }).results[0]!;

describe("a container row", () => {
  // The line the BLOCK opens at, not a line borrowed from one of its children:
  // an earlier attempt took the first child's line and pointed the row at an
  // unrelated setting.
  it("points at the line its own opening is written on", () => {
    const got = judged(item({ container: true, expected: "/var/log/httpd/*log" }));
    expect(got.status).toBe("pass");
    expect(got.evidence?.line).toBe(2);
  });

  it("fails when the file holds no such block", () => {
    const got = judged(item({ container: true, expected: "/var/log/httpd/*log" }), "# nothing here\n");
    expect(got.status).toBe("fail");
    expect(got.evidence?.line).toBeUndefined();
  });

  // The identity is a VALUE and is compared. Saying "a block holds no value of
  // its own" about a row that visibly states one is a sentence the document
  // contradicts on the same line.
  it("says what the opening is, having compared it", () => {
    expect(judged(item({ container: true, expected: "/var/log/httpd/*log" })).detail).toContain(
      "opening with /var/log/httpd/*log"
    );
  });

  it("fails a block whose opening says something else", () => {
    const got = judged(item({ container: true, expected: "/var/log/nginx/*log" }));
    expect(got.status).toBe("fail");
    expect(got.actual).toBe("/var/log/httpd/*log");
  });

  // …and the old sentence is the TRUE one for a row that states no identity —
  // a block the sheet lists by address alone.
  // …and for a block whose GRAMMAR has no identity to record. A systemd
  // `[Service]` header names a kind and nothing else, so there is nothing to
  // compare; failing such a row would be failing it for the format's shape.
  it("does not fail a block whose opening carries no identity", () => {
    const unit = ["[Service]", "Type=simple", ""].join("\n");
    const got = judgeFiles(
      planOf([
        item({
          target: { sheet: "os", path: [], key: "Service", instance: "prod" },
          file: "/etc/systemd/system/x.service",
          container: true,
          expected: "Service",
        }),
      ]),
      [{ environment: "prod", hosts: { h1: { files: { "/etc/systemd/system/x.service": unit } } } } as never],
      { at: "X", lang: "en" }
    ).results[0]!;
    expect(got.status).toBe("pass");
    expect(got.detail).toContain("holds no value of its own");
  });

  it("keeps the old sentence for a row that states none", () => {
    const got = judged(item({ container: true }));
    expect(got.status).toBe("pass");
    expect(got.detail).toContain("holds no value of its own");
  });

  // A parser records the opening VERBATIM and the row carries the same text —
  // quotes included, where the file wrote them. Neither side is tidied.
  it("compares a quoted label exactly as both sides spell it", () => {
    const conf = ['<Directory "/var/www">', "    AllowOverride None", "</Directory>", ""].join("\n");
    const got = judgeFiles(
      planOf([
        item({
          target: { sheet: "os", path: [], key: 'Directory["/var/www"]', instance: "prod" },
          file: "/etc/httpd/conf/httpd.conf",
          container: true,
          expected: '"/var/www"',
        }),
      ]),
      [{ environment: "prod", hosts: { h1: { files: { "/etc/httpd/conf/httpd.conf": conf } } } } as never],
      { at: "X", lang: "en" }
    ).results[0]!;
    expect(got.status).toBe("pass");
    expect(got.evidence?.line).toBe(1);
  });
});
