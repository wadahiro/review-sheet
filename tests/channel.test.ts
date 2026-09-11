// A channel: something other than a deployed file that answers a row.
//
// What is asserted is that the three ways of reading an output are the three a
// real command has — and that a channel says WHAT TO COLLECT, so the commands
// exist once instead of once here and once in whatever reaches the hosts.

import { describe, it, expect, beforeEach } from "bun:test";
import "../src/parsers/index";
import { commandChannel, registerChannel, listChannels } from "../src/channel";
import { judgeFiles, collectPlan, answerTheRest, judgeFunctional, type Observation } from "../src/judge";
import type { TestItem, TestPlan } from "../src/testplan";

const item = (key: string, expected?: string, sheet = "os baseline"): TestItem =>
  ({ target: { sheet, path: ["c"], key, instance: "stg" }, unit: "u", kind: "value", decider: "project", expected }) as TestItem;

const planOf = (items: TestItem[]): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { ja: "m" } }, sheets: ["os baseline"] }], items, functional: [] }) as TestPlan;

const obs = (commands: Record<string, string | null>): Observation => ({
  environment: "stg",
  hosts: { web01: { files: {}, commands } },
});

// The registry is process-wide (registry.ts), so a test that registers has to
// leave it as it found it or the next file inherits a channel it never asked
// for — the same hazard the shared registry exists to make visible.
const clear = (): void => {
  const reg = listChannels();
  for (const c of reg) {
    const arr = (globalThis as Record<symbol, unknown>)[Symbol.for("review-sheet.channels.v1")] as unknown[];
    const i = arr.indexOf(c);
    if (i >= 0) arr.splice(i, 1);
  }
};
beforeEach(clear);

describe("the three ways a command's output answers a row", () => {
  it("is the whole output, for a command that reports one thing", () => {
    registerChannel(commandChannel({ sheet: "os baseline", keys: ["selinux_state"], command: "getenforce", read: { whole: true, lower: true } }));
    const got = judgeFiles(planOf([item("selinux_state", "disabled")]), [obs({ getenforce: "Disabled\n" })], { at: "X", lang: "en" });
    expect(got.results[0].status).toBe("pass");
    expect(got.results[0].evidence).toEqual({ host: "web01", command: "getenforce", line: 1 });
  });

  // One line of the output names the row, and a capture is its value. `{key}`
  // is the row's own name, so ONE entry covers every boolean a project sets.
  it("is a line the row names, and the line it was read at", () => {
    registerChannel(
      commandChannel({
        sheet: "os baseline",
        key_prefix: "sebool.",
        command: "getsebool -a",
        read: { pattern: "^{key}\\s*-->\\s*(\\S+)", map: { on: "true", off: "false" } },
      })
    );
    const out = "a --> off\nhttpd_can_network_connect --> on\nz --> off\n";
    const got = judgeFiles(planOf([item("sebool.httpd_can_network_connect", "true")]), [obs({ "getsebool -a": out })], { at: "X", lang: "en" });
    expect(got.results[0].status).toBe("pass");
    expect(got.results[0].evidence?.line).toBe(2);
  });

  it("is whether the row is among the words the output lists", () => {
    registerChannel(commandChannel({ sheet: "os baseline", key_prefix: "firewalld.", command: "firewall-cmd --list-services", read: { member: true } }));
    const p = planOf([item("firewalld.ssh", "true"), item("firewalld.http", "true")]);
    const got = judgeFiles(p, [obs({ "firewall-cmd --list-services": "ssh dhcpv6-client\n" })], { at: "X", lang: "en" });
    expect(got.results.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(got.results[1].actual).toBe("false");
  });
});

describe("what a channel says about a host that cannot answer", () => {
  // An environment nobody collected is "nobody has been here yet", not "nothing
  // can answer this" — two different facts, and two different fixes.
  it("says an environment nobody collected was not collected", () => {
    registerChannel(commandChannel({ sheet: "os baseline", keys: ["selinux_state"], command: "getenforce", read: { whole: true } }));
    const got = judgeFiles(planOf([item("selinux_state", "disabled")]), [], { at: "X", lang: "en" });
    expect(got.results[0].status).toBe("not_run");
    expect(got.results[0].reason).toContain("has not been collected");
    expect(got.unanswered).toEqual([]);
  });

  // A command the host does not have is an answer ABOUT THE HOST — a container
  // with no getenforce does not apply SELinux — and never a pass.
  it("says the host has no such command, rather than passing or failing", () => {
    registerChannel(commandChannel({ sheet: "os baseline", keys: ["selinux_state"], command: "getenforce", read: { whole: true } }));
    const got = judgeFiles(planOf([item("selinux_state", "disabled")]), [obs({ getenforce: null })], { at: "X", lang: "en" });
    expect(got.results[0].status).toBe("not_run");
    expect(got.results[0].reason).toContain("has no getenforce");
  });

  // …and an output that simply says nothing about this row is a different fact
  // again: the command ran, and the setting was not in what it reported.
  it("says the output reports nothing about the row", () => {
    registerChannel(commandChannel({ sheet: "os baseline", key_prefix: "sebool.", command: "getsebool -a", read: { pattern: "^{key}\\s*-->\\s*(\\S+)" } }));
    const got = judgeFiles(planOf([item("sebool.nothing_here", "true")]), [obs({ "getsebool -a": "a --> off\n" })], { at: "X", lang: "en" });
    expect(got.results[0].status).toBe("not_run");
    expect(got.results[0].reason).toContain("reports nothing");
  });
});

// The reason a channel declares `needs` at all: the commands exist ONCE. Written
// here and again in whatever reaches the hosts, nothing checked the two agreed.
describe("what a collector has to gather", () => {
  it("is every file the sheets describe and every command a channel asks for", () => {
    registerChannel(commandChannel({ sheet: "os baseline", key_prefix: "firewalld.", command: "firewall-cmd --list-services", read: { member: true } }));
    registerChannel(commandChannel({ sheet: "os baseline", keys: ["selinux_state"], command: "getenforce", read: { whole: true } }));
    const withFile = (key: string, file: string): TestItem => ({ ...item(key, "1"), file }) as TestItem;
    const p = planOf([item("firewalld.ssh", "true"), item("selinux_state", "disabled"), withFile("Listen", "/etc/httpd/conf/httpd.conf")]);
    expect(collectPlan(p)).toEqual({
      files: { stg: ["/etc/httpd/conf/httpd.conf"] },
      commands: ["firewall-cmd --list-services", "getenforce"],
    });
  });

  it("asks for no command when no channel covers anything", () => {
    const withFile = (key: string, file: string): TestItem => ({ ...item(key, "1"), file }) as TestItem;
    expect(collectPlan(planOf([withFile("Listen", "/etc/app.conf")])).commands).toEqual([]);
  });
});

// A row a channel covers is answered by the channel even when a file also holds
// it: a file says what was written, a channel says what the host is doing.
describe("a channel and a file that both cover a row", () => {
  it("is answered by the channel", () => {
    registerChannel(commandChannel({ sheet: "os baseline", keys: ["Listen"], command: "ss -lnt", read: { whole: true } }));
    const it_ = { ...item("Listen", "80"), file: "/etc/app.conf" } as TestItem;
    const o: Observation = { environment: "stg", hosts: { web01: { files: { "/etc/app.conf": "Other 1\nListen 9999\n" }, commands: { "ss -lnt": "80\n" } } } };
    const got = judgeFiles(planOf([it_]), [o], { at: "X", lang: "en" });
    expect(got.results.length).toBe(1);
    expect(got.results[0].status).toBe("pass");
    expect(got.results[0].evidence?.command).toBe("ss -lnt");
  });
});

// What no route reached, and WHY — two different facts with two different fixes.
describe("what no route reached", () => {
  it("tells an environment nobody collected from one no channel can ask about", () => {
    const p = planOf([item("a", "1"), { ...item("b", "2"), target: { sheet: "os baseline", path: ["c"], key: "b", instance: "prod" } } as TestItem]);
    const rest = answerTheRest(p, [], [{ environment: "stg", hosts: { web01: { files: {} } } }], { lang: "en" });
    expect(rest.map((r) => [r.target.instance, r.reason])).toEqual([
      ["stg", "no deployed file, and no channel declared that answers it"],
      ["prod", "this environment has not been collected"],
    ]);
  });
});

// An item with no row behind it, where a COMMAND answers it. It gets what the
// value items get — one verdict per host, the line it was read at, and the
// three ways a host can fail to answer told apart — so a project writes the
// rule only for an item a command cannot settle, and never the loop.
describe("an item with no row behind it, answered by a command", () => {
  const fplan = (check?: { command: string; read: { pattern: string }; expect: string }): TestPlan =>
    ({
      metadata: { title: "t" },
      units: [{ name: "u", declaration: { method: { ja: "m" } }, sheets: [] }],
      items: [],
      functional: [{ unit: "u", id: "time", text: { en: "the clock is in step" }, intrusive: false, instance: "stg", ...(check === undefined ? {} : { check }) }],
    }) as TestPlan;
  const CHECK = { command: "chronyc tracking", read: { pattern: "^Leap status\\s*:\\s*(.+?)\\s*$" }, expect: "Normal" };
  const two = (a: string | null, b: string | null): Observation => ({
    environment: "stg",
    hosts: { web01: { files: {}, commands: { "chronyc tracking": a } }, web02: { files: {}, commands: { "chronyc tracking": b } } },
  });

  it("passes when every host says what was expected", () => {
    const out = judgeFunctional(fplan(CHECK), [two("Reference ID : x\nLeap status     : Normal\n", "Leap status     : Normal\n")], { at: "X", lang: "en" }).answers;
    expect(out[0].status).toBe("pass");
    expect(out[0].evidence?.command).toBe("chronyc tracking");
  });

  // A fleet is only as configured as its least configured node, and one item
  // holds one answer — so the failing host is the one it names.
  it("fails on the worst host, and names it", () => {
    const out = judgeFunctional(fplan(CHECK), [two("Leap status     : Normal\n", "Leap status     : Not synchronised\n")], { at: "X", lang: "en" }).answers;
    expect(out[0].status).toBe("fail");
    expect(out[0].evidence?.host).toBe("web02");
    expect(out[0].reason).toContain("Not synchronised");
  });

  it("says a host without the command does not apply the setting", () => {
    const out = judgeFunctional(fplan(CHECK), [two(null, null)], { at: "X", lang: "en" }).answers;
    expect(out[0].status).toBe("not_run");
    expect(out[0].reason).toContain("has no chronyc tracking");
  });

  // An item that declares no command is still an item of the plan, so it gets
  // an answer — "this run did not check it" — rather than being left out.
  // Leaving it out made the plan's own coverage check fail on an item nobody
  // had declined to answer, which is the opposite of what that check is for;
  // rows have worked this way (`answerTheRest`) from the beginning. A project
  // that answers it itself still wins: `-a` is merged over this.
  it("answers an item that declares no command rather than leaving it out", () => {
    const out = judgeFunctional(fplan(undefined), [two("x", "x")], { at: "X", lang: "en" }).answers;
    expect(out.length).toBe(1);
    expect(out[0]!.status).toBe("not_run");
    expect(out[0]!.reason).toBe("this run did not check it");
  });

  it("asks the collector for the command it declares", () => {
    expect(collectPlan(fplan(CHECK)).commands).toEqual(["chronyc tracking"]);
  });
});
