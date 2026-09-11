// Is the host running the BUILD the sheet describes?
//
// A row saying "the product's own default applies" is a claim about one build:
// its compiled-in defaults, and the files its package ships. Judged against
// another build the row is answered by a product the sheet does not describe —
// and the answer looks exactly like a correct one, which is why this is a check
// and not a note.
//
// The knowledge here is RPM's and the distribution's, not one project's: how
// `rpm -q` prints a version, and that a dictionary's `selinux` is the package
// `selinux-policy`. Every project on this family of distributions needs the
// same thing, and written into each one's judging script it is copied per
// project and tested in none.

// Dictionary product -> the package that ships it.
//
// A KNOWN LIST rather than "the product's own name": most of what a sheet binds
// a dictionary to is not a package at all. A cloud provider's API, a product
// shipped as a tarball, a framework inside one — asking `rpm -q` about those
// gets "not installed" for something that was never meant to be installed, and
// a check that reports nothing is indistinguishable from one that cannot.
//
// A product not in this list and not declared by the project is SKIPPED, which
// is the honest answer: this tool does not know how that one is versioned.
const PACKAGE_OF: Record<string, string> = {
  httpd: "httpd",
  systemd: "systemd",
  logrotate: "logrotate",
  chrony: "chrony",
  "firewalld-service": "firewalld",
  selinux: "selinux-policy",
  "selinux-boolean": "selinux-policy",
  openssh: "openssh-server",
  postfix: "postfix",
  nginx: "nginx",
  sysctl: "systemd",
};

export const packageOf = (product: string, overrides: Record<string, string> = {}): string | undefined =>
  overrides[product] ?? PACKAGE_OF[product];

// `rpm -q --qf '%{NAME} %{VERSION}-%{RELEASE}\n'` — one package per line. A
// package that is NOT installed prints a sentence instead ("package X is not
// installed") and rpm still exits non-zero for the batch, so the whole output
// is kept and only the lines that parse are read.
export function rpmVersions(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const m = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (m !== null) out.set(m[1]!, m[2]!);
  }
  return out;
}

// A pin is either a full VERSION-RELEASE (`239-51.el8_5.5`) or the upstream
// version alone (`2.4.62`), and a dictionary is extracted from one or stated
// from the other. Compared at the granularity the pin was written at: a pin
// that names no release cannot be held to one.
export function buildMismatch(
  builds: { sheet: string; product: string; version: string }[],
  sheet: string,
  installed: Map<string, string>,
  overrides: Record<string, string> = {}
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const b of builds) {
    if (b.sheet !== sheet || seen.has(b.product)) continue;
    seen.add(b.product);
    const pkg = packageOf(b.product, overrides);
    // A TYPE guard, not a behavioural one: a product with no package looks up
    // nothing, and the next line would skip it anyway. Kept so the lookup takes
    // a string, and said plainly so nobody writes a test that cannot fail.
    if (pkg === undefined) continue;
    const got = installed.get(pkg);
    // A package the host does not have says nothing about the build: the sheet
    // may describe something this host legitimately does not carry, and a
    // missing package is not a wrong version.
    if (got === undefined) continue;
    const ok = b.version.includes("-") ? got === b.version : got.split("-")[0] === b.version;
    if (!ok) out.push(`${pkg} ${got}（シートは ${b.product} ${b.version} を記述）`);
  }
  return out;
}

// Which packages a run has to ask about, derived from what the sheets describe.
export function packagesToQuery(
  builds: { sheet: string; product: string; version: string }[],
  overrides: Record<string, string> = {}
): string[] {
  return [...new Set(builds.map((b) => packageOf(b.product, overrides)).filter((x): x is string => x !== undefined))].sort();
}
