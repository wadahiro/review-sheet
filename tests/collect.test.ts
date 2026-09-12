// Gathering through whatever already reaches the host. The tool does not
// reach; it runs the command the operator gave it, and everything that is the
// same in every such command lives here.

import { describe, it, expect } from "bun:test";
import { collectHost, reachWith, type Ran } from "../src/collect";
import type { CollectPlan } from "../src/judge";

const PLAN: CollectPlan = {
  files: { stg: ["/etc/httpd/conf/httpd.conf", "/etc/missing.conf"] },
  commands: ["getenforce", "rpm -q a b"],
  includes: [{ file: "/etc/httpd/conf/httpd.conf", pattern: "^\\s*Include(?:Optional)?\\s+(\\S+)", root: '^\\s*ServerRoot\\s+"?([^"\\s]+)"?' }],
};

const HOST_FS: Record<string, Ran> = {
  "cat /etc/httpd/conf/httpd.conf": { ok: true, out: 'ServerRoot "/etc/httpd"\nInclude conf.d/*.conf\nIncludeOptional /extra/*.conf\n' },
  "cat /etc/missing.conf": { ok: false, out: "" },
  getenforce: { ok: false, out: "" },
  "rpm -q a b": { ok: false, out: "a 1.0\npackage b is not installed\n" },
  "ls -1 /etc/httpd/conf.d/*.conf": { ok: true, out: "/etc/httpd/conf.d/one.conf\n" },
  "ls -1 /extra/*.conf": { ok: true, out: "/extra/two.conf\n" },
  "cat /etc/httpd/conf.d/one.conf": { ok: true, out: "one\n" },
  "cat /extra/two.conf": { ok: true, out: "two\n" },
};
const run = (_h: string, c: string): Ran => HOST_FS[c] ?? { ok: false, out: "" };

describe("gathering one host", () => {
  const got = collectHost(PLAN, "stg", "web01", run);

  // A file the host does not have is an ANSWER — the judge reports it against
  // every row of that file — so it is recorded as null, never dropped.
  it("records a file the host does not have rather than leaving it out", () => {
    expect(got.files["/etc/httpd/conf/httpd.conf"]).toContain("ServerRoot");
    expect(got.files["/etc/missing.conf"]).toBeNull();
  });

  // `rpm -q` exits non-zero for a batch with one package missing and prints
  // the rest; discarding that loses every answer it gave.
  it("keeps what a failing command printed, and nulls one that printed nothing", () => {
    expect(got.commands["rpm -q a b"]).toBe("a 1.0\npackage b is not installed");
    expect(got.commands["getenforce"]).toBeNull();
  });

  // The trailing newline of a command's output is punctuation — Ansible's own
  // `command` drops it, and two collectors of one host must agree byte for
  // byte. A FILE's is content and stays.
  it("drops a command's trailing newline and keeps a file's", () => {
    expect(got.commands["rpm -q a b"]!.endsWith("installed")).toBe(true);
    expect(got.files["/etc/httpd/conf/httpd.conf"]!.endsWith("\n")).toBe(true);
  });

  // The files a configuration NAMES, through the product's grammar as the plan
  // states it — including the relative one, resolved against the root the file
  // itself declares, and expanded ON THE HOST because that is where they are.
  it("follows the files the configuration names, relative and absolute", () => {
    expect(got.included_by["/etc/httpd/conf/httpd.conf"]).toEqual(["/etc/httpd/conf.d/one.conf", "/extra/two.conf"]);
    expect(got.included["/etc/httpd/conf.d/one.conf"]).toBe("one\n");
    expect(got.included["/extra/two.conf"]).toBe("two\n");
  });
});

describe("running one command on one host", () => {
  // `{cmd}` travels as ONE argument of the outer command, so a space in it
  // would otherwise split into two.
  it("quotes the command it hands to whatever reaches the host", () => {
    expect(reachWith("docker exec {host} sh -c {cmd}", "web01", "rpm -q a b")).toEqual([
      "sh",
      "-c",
      "docker exec web01 sh -c 'rpm -q a b'",
    ]);
    // …and a quote inside it does not end the quoting.
    expect(reachWith("sh -c {cmd}", "h", "echo 'x'")[2]).toBe(`sh -c 'echo '\\''x'\\'''`);
  });

  it("puts the host wherever the template says, as many times as it says", () => {
    expect(reachWith("kubectl exec {host} -c {host} -- sh -c {cmd}", "pod", "id")[2]).toBe(
      "kubectl exec pod -c pod -- sh -c 'id'"
    );
  });
});
