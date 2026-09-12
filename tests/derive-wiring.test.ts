// The `channels:` a project no longer writes.
//
// The thing under test is a claim about SCOPE: the rows a binding selects are
// exactly the rows a hand-written entry named. That was checked against a real
// spec before this file existed (three of its four entries, row for row, and
// 4,195 verdicts identical with the declarations deleted); what is pinned here
// is the reasoning that made it true, including the two cases where the build
// must refuse to guess rather than answer wrongly.

import { describe, it, expect } from "bun:test";
import { deriveChannels, deriveDocuments } from "../src/derive-wiring";
import type { BindReportRow } from "../src/assemble";
import type { ProductRead } from "../src/channel";

const bound = (sheet: string, key: string, product: string, dictKey: string): BindReportRow => ({
  sheet,
  key,
  method: "exact",
  dictKey,
  product,
  version: "1",
});

const recipes: Record<string, ProductRead> = {
  selinux: { product: "selinux", command: "getenforce", read: { whole: true, lower: true } },
  "selinux-boolean": {
    product: "selinux-boolean",
    command: "getsebool -a",
    read: { pattern: "^{key}\\s*-->\\s*(\\S+)", map: { on: "true", off: "false" } },
  },
  "firewalld-service": {
    product: "firewalld-service",
    command: "firewall-cmd --permanent --list-services",
    read: { member: true },
  },
};
const recipeFor = (p: string): ProductRead | undefined => recipes[p];

describe("deriving a channel from a binding", () => {
  it("answers exactly the rows bound to the product", () => {
    const out = deriveChannels(
      [bound("os baseline", "common_selinux_state", "selinux", "SELINUX"), bound("os baseline", "Unit.After", "systemd", "After")],
      undefined,
      recipeFor
    );
    expect(out.channels).toHaveLength(1);
    expect(out.channels[0]!.command).toBe("getenforce");
    // systemd has no recipe, so its row is untouched — never swept in because
    // it happens to share a sheet.
    expect(out.channels[0]!.keys).toEqual(["common_selinux_state"]);
  });

  // The sheet namespaces a row and the host has never heard of the prefix. It
  // is the difference between the row's key and the product's own name for it,
  // read off the rows rather than declared anywhere.
  it("reads the key prefix off the rows", () => {
    const out = deriveChannels(
      [bound("os baseline", "firewalld.ssh", "firewalld-service", "ssh"), bound("os baseline", "firewalld.http", "firewalld-service", "http")],
      undefined,
      recipeFor
    );
    expect(out.channels[0]!.key_prefix).toBe("firewalld.");
    expect(out.channels[0]!.keys).toEqual(["firewalld.http", "firewalld.ssh"]);
  });

  it("sets no prefix when the row already carries the product's own name", () => {
    const out = deriveChannels([bound("os baseline", "httpd_can_network_connect", "selinux-boolean", "httpd_can_network_connect")], undefined, recipeFor);
    expect(out.channels[0]!.key_prefix).toBeUndefined();
  });

  // A reading that never looks at the key cannot be harmed by not knowing it.
  it("derives a whole-output reading even when no prefix can be found", () => {
    const out = deriveChannels([bound("os baseline", "common_selinux_state", "selinux", "SELINUX")], undefined, recipeFor);
    expect(out.channels).toHaveLength(1);
    expect(out.skipped).toHaveLength(0);
  });

  // The opposite case, and the one that matters: asking the host about a name
  // it has never heard answers "not set", which is a wrong answer wearing a
  // right one's clothes.
  it("refuses, and says so, when a by-name reading has no single prefix", () => {
    const out = deriveChannels(
      [bound("os baseline", "fw.ssh", "firewalld-service", "ssh"), bound("os baseline", "services.http", "firewalld-service", "http")],
      undefined,
      recipeFor
    );
    expect(out.channels).toHaveLength(0);
    expect(out.skipped[0]!.reason).toContain("one key prefix");
  });

  it("leaves a row the project already claims to the project", () => {
    const declared = [
      { channel: "command" as const, sheet: "os baseline", keys: ["common_selinux_state"], command: "cat /etc/selinux/config", read: { whole: true as const } },
    ];
    const out = deriveChannels([bound("os baseline", "common_selinux_state", "selinux", "SELINUX")], declared, recipeFor);
    expect(out.channels).toHaveLength(0);
    expect(out.skipped[0]!.reason).toContain("already claimed");
  });

  it("honours a declared key_prefix as a claim over every row under it", () => {
    const declared = [
      { channel: "command" as const, sheet: "os baseline", key_prefix: "firewalld.", command: "mine", read: { member: true as const } },
    ];
    const out = deriveChannels([bound("os baseline", "firewalld.ssh", "firewalld-service", "ssh")], declared, recipeFor);
    expect(out.channels).toHaveLength(0);
  });

  it("ignores a row that bound to nothing", () => {
    const out = deriveChannels([{ sheet: "keycloak configuration", key: "keycloak_version", method: "none" }], undefined, recipeFor);
    expect(out.channels).toHaveLength(0);
    expect(out.skipped).toHaveLength(0);
  });

  // One spec must build one model, every time: a set iterated in insertion
  // order would reorder the moment a sheet's rows arrive differently.
  it("orders what it emits", () => {
    const rows = [
      bound("z sheet", "firewalld.ssh", "firewalld-service", "ssh"),
      bound("a sheet", "common_selinux_state", "selinux", "SELINUX"),
    ];
    const a = deriveChannels(rows, undefined, recipeFor);
    const b = deriveChannels([...rows].reverse(), undefined, recipeFor);
    expect(a.channels.map((c) => c.sheet)).toEqual(["a sheet", "z sheet"]);
    expect(JSON.stringify(a.channels)).toBe(JSON.stringify(b.channels));
  });
});

// The other passenger: WHERE a row sits in what the product's API returned.
// Getting this wrong by hand is not a build error — a wrong address still
// reports `pass`, it just loses the line it was read at (measured: 180 verdicts
// degraded that way when the recipe was broken on purpose) — which is exactly
// why it should not be hand-written.
describe("deriving a document address from a binding", () => {
  const addresses: Record<string, { address: string }> = {
    "keycloak-realm": { address: "{key}" },
    "keycloak-client": { address: "clients[clientId={component}].{key}" },
  };
  const addressFor = (p: string): { address: string } | undefined => addresses[p];

  it("fills in the address the sheet's bound product implies", () => {
    const out = deriveDocuments(
      [bound("keycloak realm", "loginTheme", "keycloak-realm", "loginTheme")],
      [{ sheet: "keycloak realm", document: "{component}" }],
      addressFor
    );
    expect(out.addresses).toEqual([{ sheet: "keycloak realm", address: "{key}" }]);
    expect(out.unresolved).toHaveLength(0);
  });

  it("leaves an address the spec states alone", () => {
    const out = deriveDocuments(
      [bound("keycloak realm", "loginTheme", "keycloak-realm", "loginTheme")],
      [{ sheet: "keycloak realm", document: "d", address: "mine" }],
      addressFor
    );
    expect(out.addresses).toHaveLength(0);
    expect(out.skipped[0]!.kind).toBe("declared");
  });

  // A router answers where a row sits by itself; an address would compete.
  it("does not touch an entry that names a router", () => {
    const out = deriveDocuments([bound("aws infrastructure", "x", "aws", "x")], [{ sheet: "aws infrastructure", router: "aws-rds" }], addressFor);
    expect(out.addresses).toHaveLength(0);
    expect(out.unresolved).toHaveLength(0);
  });

  // The gate the spec schema used to hold, moved to where it can tell "nobody
  // stated one" from "nobody had to".
  it("refuses an entry no binding can address", () => {
    const out = deriveDocuments([bound("os baseline", "x", "systemd", "x")], [{ sheet: "os baseline", document: "d" }], addressFor);
    expect(out.addresses).toHaveLength(0);
    expect(out.unresolved).toHaveLength(1);
    expect(out.unresolved[0]!.sheet).toBe("os baseline");
  });

  it("refuses a sheet whose bound products disagree about addressing", () => {
    const out = deriveDocuments(
      [bound("mixed", "a", "keycloak-realm", "a"), bound("mixed", "b", "keycloak-client", "b")],
      [{ sheet: "mixed", document: "d" }],
      addressFor
    );
    expect(out.addresses).toHaveLength(0);
    expect(out.unresolved[0]!.reason).toContain("address rows differently");
  });
});
