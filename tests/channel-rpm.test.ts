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
import { rpmVersions, buildMismatch, packagesToQuery, packageOf, buildMismatchReported } from "../src/channels/rpm";

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

// The same held-to-its-pin check, for the products `rpm -q` cannot answer for.
//
// Measured on one real project: six of fourteen pinned products resolved to an
// RPM package and eight did not — everything from a tarball, an image or a
// cloud API — so a Keycloak upgrade left five sheets reviewing the previous
// version's attack surface and nothing said so. With this, the same doctored
// observation blocks 932 rows across those five sheets; with the version
// matching, none.
describe("holding a non-package product to its pin", () => {
  const recipe = { from: "keycloak", version: (out: string) => /^\s*kc\.version\s*=\s*(\S+)/m.exec(out)?.[1] };
  const versionFor = (p: string): typeof recipe | undefined =>
    ["keycloak", "keycloak-client"].includes(p) ? recipe : undefined;
  const builds = [
    { sheet: "s", product: "keycloak", version: "26.7.0" },
    { sheet: "s", product: "keycloak-client", version: "26.7.0" },
  ];
  // The real shape: a leading tab, two spaces after `=`, and every option
  // annotated with where it came from — so the value is not the rest of the line.
  const shown = (v: string): Map<string, string> =>
    new Map([["keycloak", `Current Configuration:\n\tkc.db =  postgres (keycloak.conf)\n\tkc.version =  ${v} (SysPropConfigSource)\n`]]);

  it("says nothing when the host runs the build the sheet describes", () => {
    expect(buildMismatchReported(builds, "s", shown("26.7.0"), versionFor).mismatch).toEqual([]);
  });

  it("names the product and both versions when it does not", () => {
    const { mismatch } = buildMismatchReported(builds, "s", shown("26.9.9"), versionFor);
    expect(mismatch).toHaveLength(2);
    expect(mismatch[0]).toContain("26.9.9");
    expect(mismatch[0]).toContain("26.7.0");
  });

  // Four dictionary products describe one install, and one of them is enough to
  // find the command that answers — the pin is per product, the reading is not.
  it("answers for a dictionary product through the install it belongs to", () => {
    const { mismatch } = buildMismatchReported(
      [{ sheet: "s", product: "keycloak-client", version: "26.7.0" }],
      "s",
      shown("26.9.9"),
      versionFor
    );
    expect(mismatch).toHaveLength(1);
  });

  // Not a mismatch, and not silence either: the product answered and did not
  // say, which the caller reports as unverified rather than as wrong.
  it("separates 'did not say' from 'said something else'", () => {
    const { mismatch, unverified } = buildMismatchReported(builds, "s", new Map([["keycloak", "Current Mode: production\n"]]), versionFor);
    expect(mismatch).toEqual([]);
    expect(unverified).toHaveLength(2);
  });

  // Whatever rpm answers for is the other function's business; checking it in
  // both would report one host's one mismatch twice.
  it("leaves a packaged product alone", () => {
    const { mismatch, unverified } = buildMismatchReported(
      [{ sheet: "s", product: "httpd", version: "2.4.62" }],
      "s",
      shown("26.9.9"),
      () => recipe
    );
    expect(mismatch).toEqual([]);
    expect(unverified).toEqual([]);
  });

  // A pin naming no release cannot be held to one — the same granularity rule
  // the package check follows.
  it("compares at the granularity the pin was written at", () => {
    expect(buildMismatchReported(builds, "s", shown("26.7.0-1"), versionFor).mismatch).toEqual([]);
  });
});
