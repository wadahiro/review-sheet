// `group_by: file` names a category after the file its rows are written in.
// The file name alone is what a reader wants — until one sheet holds two files
// with the same name, at which point naming both by their last segment MERGES
// them: rows from different files under one heading, with nothing on the sheet
// saying so. That is the failure this project is built around.

import { describe, it, expect } from "bun:test";
import { shortestUniqueNames } from "../src/assemble";

describe("shortestUniqueNames", () => {
  it("uses the file name when nothing else claims it", () => {
    const names = shortestUniqueNames(["roles/sso/templates/keycloak.conf", "roles/sso/defaults/main.yml"]);
    expect(names.get("roles/sso/templates/keycloak.conf")).toBe("keycloak.conf");
    expect(names.get("roles/sso/defaults/main.yml")).toBe("main.yml");
  });

  // The reported case: several roles' defaults aggregated onto one sheet.
  it("grows the name only where two files would collide", () => {
    const names = shortestUniqueNames([
      "roles/common/defaults/main.yml",
      "roles/sso/defaults/main.yml",
      "roles/sso/templates/keycloak.conf",
    ]);
    expect(names.get("roles/common/defaults/main.yml")).toBe("common/defaults/main.yml");
    expect(names.get("roles/sso/defaults/main.yml")).toBe("sso/defaults/main.yml");
    // Untouched: it was never in conflict.
    expect(names.get("roles/sso/templates/keycloak.conf")).toBe("keycloak.conf");
  });

  it("keeps growing until the names actually differ", () => {
    const names = shortestUniqueNames(["a/x/defaults/main.yml", "b/x/defaults/main.yml"]);
    expect([...new Set(names.values())]).toHaveLength(2);
    expect(names.get("a/x/defaults/main.yml")).toBe("a/x/defaults/main.yml");
  });

  it("stops at the whole path rather than looping", () => {
    const names = shortestUniqueNames(["main.yml", "main.yml"]);
    expect(names.get("main.yml")).toBe("main.yml");
  });

  it("handles an absolute path and a relative one that end alike", () => {
    const names = shortestUniqueNames(["/etc/httpd/conf.d/ssl.conf", "conf.d/ssl.conf"]);
    expect([...new Set(names.values())]).toHaveLength(2);
  });

  it("is empty for no input", () => {
    expect(shortestUniqueNames([]).size).toBe(0);
  });
});
