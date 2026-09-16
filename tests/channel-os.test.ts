// What the operating system reports about a running service — formats, not
// policies. Every project running systemd on Linux reads these the same way,
// and each one that re-derives them gets one column right and the next wrong.

import { describe, it, expect } from "bun:test";
import { unitStates, isEnabled, isAbsent, AFTER, lifecycleSteps, lifecycleFaults, registerSystemdRules } from "../src/channels/systemd";
import { listProbeRules } from "../src/channel";
import { maxOpenFiles, listeningPorts } from "../src/channels/linux";
import { configErrors } from "../src/channels/logrotate";

describe("what systemctl says about a unit", () => {
  const OUT = [
    "keycloak enabled",
    "httpd enabled-runtime",
    "chronyd disabled",
    "firewalld Failed to get unit file state for firewalld.service: No such file or directory",
    "",
  ].join("\n");

  it("reads one word per unit, in the order asked", () => {
    expect([...unitStates(OUT).keys()]).toEqual(["keycloak", "httpd", "chronyd", "firewalld"]);
    expect(unitStates(OUT).get("chronyd")).toBe("disabled");
  });

  // `enabled-runtime` is still enabled; `disabled` is not.
  it("counts every form of enabled as enabled", () => {
    const s = unitStates(OUT);
    expect(isEnabled(s.get("keycloak"))).toBe(true);
    expect(isEnabled(s.get("httpd"))).toBe(true);
    expect(isEnabled(s.get("chronyd"))).toBe(false);
  });

  // A unit the host does not have is not a finding — an image without firewalld
  // is not a misconfigured one, and only the project knows whether it expected
  // the unit at all.
  it("tells a unit that is not there from one that is switched off", () => {
    const s = unitStates(OUT);
    expect(isAbsent(s.get("firewalld"))).toBe(true);
    expect(isAbsent(s.get("chronyd"))).toBe(false);
    expect(isAbsent("not-found")).toBe(true);
  });

  it("says what state each action means", () => {
    expect(AFTER).toEqual({ stop: "inactive", start: "active", restart: "active" });
  });
});

describe("what the kernel and the usual userland report", () => {
  it("reads both limits a process actually got", () => {
    const limits = [
      "Limit                     Soft Limit           Hard Limit           Units",
      "Max processes             62987                62987                processes",
      "Max open files            65536                65536                files",
      "",
    ].join("\n");
    expect(maxOpenFiles(limits)).toEqual({ soft: "65536", hard: "65536" });
    expect(maxOpenFiles("Max processes  1  1  processes")).toBeUndefined();
  });

  // The address column carries the interface too, and the PORT is what a design
  // states — so a caller never has to know which half is which.
  it("reads the port out of every shape of address ss prints", () => {
    const ss = [
      "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
      "LISTEN 0      4096         127.0.0.1:8080       0.0.0.0:*     users:((\"java\",pid=1,fd=1))",
      "LISTEN 0      511                  *:443             *:*     users:((\"httpd\",pid=2,fd=2))",
      "LISTEN 0      4096              [::]:80           [::]:*",
      "",
    ].join("\n");
    expect([...listeningPorts(ss)].sort()).toEqual(["443", "80", "8080"]);
    expect(listeningPorts("").size).toBe(0);
  });
});

describe("what logrotate says about a configuration", () => {
  it("picks out its complaints and nothing else", () => {
    const dry = [
      "reading config file /etc/logrotate.d/app",
      "error: /etc/logrotate.d/app:3 unknown option 'rotatee' -- ignoring line",
      "rotating pattern: /var/log/app/*.log  after 1 days (7 rotations)",
      "",
    ].join("\n");
    expect(configErrors(dry).length).toBe(1);
    expect(configErrors(dry)[0]).toContain("unknown option");
    expect(configErrors("rotating pattern: /var/log/app/*.log")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A lifecycle run: stop, start, restart, and what each one MEANS.

describe("what a lifecycle run left behind", () => {
  const RUN = [
    "stop rc=0 is-active=inactive",
    "start rc=0 is-active=active ActiveEnterTimestamp=Mon 2025-01-06 11:22:33 UTC",
    "restart rc=0 is-active=active ActiveEnterTimestamp=Mon 2025-01-06 11:22:41 UTC",
    "",
  ].join("\n");

  it("reads the three facts off each step", () => {
    const steps = lifecycleSteps(RUN);
    expect([...steps.keys()]).toEqual(["stop", "start", "restart"]);
    expect(steps.get("stop")).toMatchObject({ rc: 0, active: "inactive" });
    expect(steps.get("restart")?.enteredAt).toBeGreaterThan(steps.get("start")!.enteredAt!);
  });

  // A timestamp systemd could not give is printed `n/a`. It is not a moment,
  // and turning it into one (NaN, or epoch zero) makes the restart comparison
  // answer a question nothing asked.
  it("does not turn n/a into a moment", () => {
    const steps = lifecycleSteps("start rc=0 is-active=active ActiveEnterTimestamp=n/a");
    expect(steps.get("start")?.enteredAt).toBeUndefined();
  });

  it("passes a run where every step did what it means", () => {
    expect(lifecycleFaults(lifecycleSteps(RUN))).toEqual([]);
  });

  // rc=0 is not the finding. systemd returning success while the unit sits in
  // the state the action was supposed to leave behind is.
  it("fails a start that returned 0 and left the unit inactive", () => {
    const out = RUN.replace("start rc=0 is-active=active", "start rc=0 is-active=inactive");
    expect(lifecycleFaults(lifecycleSteps(out)).join()).toContain("start: is-active=inactive");
  });

  it("fails a step the command itself rejected", () => {
    const out = RUN.replace("stop rc=0", "stop rc=5");
    expect(lifecycleFaults(lifecycleSteps(out)).join()).toContain("stop: rc=5");
  });

  // A step with no line did not run, which is a different thing from one that
  // ran and failed — and the reason has to say which.
  it("tells a step that never ran from one that failed", () => {
    const out = RUN.split("\n").filter((l) => !l.startsWith("restart")).join("\n");
    expect(lifecycleFaults(lifecycleSteps(out))).toEqual(["restart: did not run"]);
  });

  // The whole reason the timestamp is read: a restart that silently did nothing
  // is `rc=0 is-active=active`, exactly like one that worked.
  it("catches a restart that left the unit where it already was", () => {
    const out = RUN.replace("11:22:41", "11:22:33");
    expect(lifecycleFaults(lifecycleSteps(out)).join()).toContain("did not enter active again");
  });

  // …but a collector that does not take the stamp is not reporting a defect.
  it("says nothing about the restart when the stamps were not taken", () => {
    const out = RUN.replace(/ ActiveEnterTimestamp=[^\n]*/g, "");
    expect(lifecycleFaults(lifecycleSteps(out))).toEqual([]);
  });
});

describe("the lifecycle rule a project binds", () => {
  const ctx = { host: "h1", held: {}, observedHosts: 1 };
  const ruleFor = (id: string) => {
    registerSystemdRules({ lifecycle: id, sheet: "os" });
    const r = listProbeRules().find((x) => x.covers(id));
    if (r === undefined) throw new Error("no rule covers " + id);
    return r;
  };

  it("passes a clean run", () => {
    const v = ruleFor("svc.lifecycle.1").verdict(
      { text: "stop rc=0 is-active=inactive\nstart rc=0 is-active=active\nrestart rc=0 is-active=active" },
      ctx
    );
    expect(v.ok).toBe(true);
  });

  // Output this cannot read at all is one finding about the collector, not
  // three about the unit — a reader sent to the unit would find nothing wrong
  // with it.
  it("reports unreadable output as unreadable, not as three failed steps", () => {
    const v = ruleFor("svc.lifecycle.2").verdict({ text: "Failed to connect to bus" }, ctx);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("no lifecycle steps");
    expect(v.why).not.toContain("did not run");
  });

  it("leaves a bound rule alone when a later binding names no item", () => {
    ruleFor("svc.lifecycle.3");
    registerSystemdRules({});
    expect(listProbeRules().find((x) => x.covers("svc.lifecycle.3"))).toBeDefined();
  });
});
