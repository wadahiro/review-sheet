// What the operating system reports about a running service — formats, not
// policies. Every project running systemd on Linux reads these the same way,
// and each one that re-derives them gets one column right and the next wrong.

import { describe, it, expect } from "bun:test";
import { unitStates, isEnabled, isAbsent, AFTER } from "../src/channels/systemd";
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
