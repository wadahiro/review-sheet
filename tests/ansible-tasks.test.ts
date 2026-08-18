// Reading a file whose content is written inline in an Ansible task. Such a
// file has no template of its own, so it had no preview — and it is as real as
// any other: it lands on the host, and a value in it is judged by what sits
// around it.

import { describe, it, expect } from "bun:test";
import { inlineFileFor } from "../src/ansible-tasks";

const TASKS = `---
- name: place the drop-in
  ansible.builtin.copy:
    dest: /etc/sysctl.d/10-tuning.conf
    owner: root
    content: |
      net.ipv4.tcp_keepalive_time = {{ keepalive_time }}
      net.ipv4.tcp_keepalive_intvl = {{ keepalive_intvl }}

- name: install the unit
  ansible.builtin.template:
    src: unit.j2
    dest: /etc/systemd/system/app.service
`;

describe("inlineFileFor", () => {
  it("returns the content the task writes", () => {
    const r = inlineFileFor(TASKS, "/etc/sysctl.d/10-tuning.conf");
    expect("file" in r && r.file.content).toBe(
      "net.ipv4.tcp_keepalive_time = {{ keepalive_time }}\nnet.ipv4.tcp_keepalive_intvl = {{ keepalive_intvl }}\n"
    );
    expect("file" in r && r.file.task).toBe("place the drop-in");
  });

  it("reads the short module name too", () => {
    const r = inlineFileFor("- copy:\n    dest: /etc/x.conf\n    content: a=1\n", "/etc/x.conf");
    expect("file" in r && r.file.content).toBe("a=1");
  });

  // A role's main.yml is often nothing but blocks. Assuming a flat list would
  // report "no such task" for a file that is right there.
  it("finds a task nested in a block", () => {
    const nested = `---
- name: tuning
  block:
    - name: drop-in
      ansible.builtin.copy:
        dest: /etc/sysctl.d/10-tuning.conf
        content: "net.core.somaxconn = 4096\\n"
`;
    const r = inlineFileFor(nested, "/etc/sysctl.d/10-tuning.conf");
    expect("file" in r && r.file.content).toBe("net.core.somaxconn = 4096\n");
  });

  // Every failure is reported. A preview that quietly does not appear looks
  // exactly like a file the project forgot to declare, and naming it in the
  // spec was the project saying it exists.
  it("says when no task writes that path", () => {
    const r = inlineFileFor(TASKS, "/etc/nope.conf");
    expect("error" in r && r.error).toContain('no task writes "/etc/nope.conf"');
  });

  it("says when the task copies a file instead of writing content", () => {
    const r = inlineFileFor("- copy:\n    dest: /etc/x.conf\n    src: files/x.conf\n", "/etc/x.conf");
    expect("error" in r && r.error).toContain("files/x.conf");
  });

  // Which of them the file ends as is a fact about the playbook, and picking
  // one would decide what the reviewer is shown.
  it("refuses when two tasks write the same path", () => {
    const twice = `---
- copy: { dest: /etc/x.conf, content: "a=1" }
- copy: { dest: /etc/x.conf, content: "a=2" }
`;
    const r = inlineFileFor(twice, "/etc/x.conf");
    expect("error" in r && r.error).toContain("2 tasks write");
  });

  it("reports unreadable YAML rather than throwing", () => {
    const r = inlineFileFor("- name: x\n  copy: {dest: [\n", "/etc/x.conf");
    expect("error" in r && r.error).toContain("not readable as YAML");
  });
});
