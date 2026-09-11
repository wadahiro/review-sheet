// Is the host running the BUILD the sheet describes?
//
// A row saying "the product's own default applies" is a claim about one build:
// its compiled-in defaults and the files its package ships. Judged against
// another build the row is answered by a product the sheet never described —
// and the answer looks exactly like a correct one.
//
// How a package is versioned, and that a dictionary's `selinux` is the package
// `selinux-policy`, is RPM's knowledge and the distribution's. Every project on
// that family needs the same thing.

import { describe, it, expect } from "bun:test";
import { rpmVersions, buildMismatch, packagesToQuery, packageOf } from "../src/channels/rpm";

const builds = [
  { sheet: "os", product: "httpd", version: "2.4.62" },
  { sheet: "os", product: "selinux", version: "38.1.45" },
  { sheet: "os", product: "keycloak", version: "26.7.0" },
];

describe("what rpm prints", () => {
  // A package that is NOT installed prints a sentence, and rpm still exits
  // non-zero for the whole batch — so the output is kept and only the lines
  // that parse are read.
  it("reads the lines that are versions and ignores the rest", () => {
    const got = rpmVersions("httpd 2.4.62-1.el9\npackage nosuch is not installed\nsystemd 252-67.el9_8.4\n");
    expect([...got]).toEqual([
      ["httpd", "2.4.62-1.el9"],
      ["systemd", "252-67.el9_8.4"],
    ]);
  });
});

describe("which package ships a product", () => {
  it("is a known list, not the product's own name", () => {
    expect(packageOf("selinux")).toBe("selinux-policy");
    expect(packageOf("httpd")).toBe("httpd");
  });

  // Most of what a sheet binds a dictionary to is not a package at all — a
  // cloud API, a product shipped as a tarball. Asking rpm about those gets
  // "not installed" for something never meant to be installed.
  it("says nothing about a product it does not know is a package", () => {
    expect(packageOf("keycloak")).toBeUndefined();
    expect(packagesToQuery(builds)).toEqual(["httpd", "selinux-policy"]);
    // …and it is not judged either, even when something of that name happens
    // to be installed: this tool does not know how that product is versioned,
    // and a package sharing its name is a coincidence.
    expect(buildMismatch(builds, "os", rpmVersions("keycloak 1.0-1.el9\n"))).toEqual([]);
  });

  it("takes a project's own mapping over its list", () => {
    expect(packageOf("keycloak", { keycloak: "keycloak-server" })).toBe("keycloak-server");
  });
});

describe("whether this host is that build", () => {
  it("says nothing when it is", () => {
    const have = rpmVersions("httpd 2.4.62-1.el9\nselinux-policy 38.1.45-3.el9\n");
    expect(buildMismatch(builds, "os", have)).toEqual([]);
  });

  // A pin is either a full VERSION-RELEASE or the upstream version alone, and a
  // pin that names no release cannot be held to one.
  it("compares at the granularity the pin was written at", () => {
    expect(buildMismatch([{ sheet: "os", product: "httpd", version: "2.4.62" }], "os", rpmVersions("httpd 2.4.62-9.el9\n"))).toEqual([]);
    expect(
      buildMismatch([{ sheet: "os", product: "httpd", version: "2.4.62-1.el9" }], "os", rpmVersions("httpd 2.4.62-9.el9\n"))
    ).toHaveLength(1);
  });

  it("names the version it found and the one the sheet describes", () => {
    const got = buildMismatch(builds, "os", rpmVersions("httpd 2.4.57-5.el9\n"));
    expect(got[0]).toContain("2.4.57-5.el9");
    expect(got[0]).toContain("2.4.62");
  });

  // A package the host does not have is not a wrong version: the sheet may
  // describe something this host legitimately does not carry.
  it("says nothing about a package the host does not have", () => {
    expect(buildMismatch(builds, "os", rpmVersions("package httpd is not installed\n"))).toEqual([]);
  });

  it("says nothing about another sheet's build", () => {
    expect(buildMismatch(builds, "other", rpmVersions("httpd 2.4.57-5.el9\n"))).toEqual([]);
  });
});
