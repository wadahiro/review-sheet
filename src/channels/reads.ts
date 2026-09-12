// How each product reports its own settings, and where each row sits in what
// its API returns.
//
// One file rather than one per product, deliberately: each of these is three
// lines of DATA — a command and the shape of its output — with no logic to
// test in isolation, and a file each would be more import than recipe. The
// moment a product needs actual reading logic it gets its own module beside
// this one, the way `keycloak.ts` and `httpd.ts` already have.
//
// Each is keyed by the dictionary product a sheet binds. See `ProductRead` in
// channel.ts for why these live in code and not in the dictionary YAML.

import { registerProductRead, registerProductAddress, registerProductDefaults } from "../channel.js";

// `getenforce` prints the mode and nothing else — the output IS the value.
// Lowercased because the file states it lowercase (`SELINUX=enforcing`) and the
// command answers capitalised (`Enforcing`); comparing them raw makes a correct
// host look wrong.
registerProductRead({
  product: "selinux",
  command: "getenforce",
  read: { whole: true, lower: true },
});

// `getsebool -a` lists every boolean, one per line: `<name> --> on`. `{key}` is
// the row's own name put into the pattern, so one recipe covers every boolean a
// project sets rather than one entry each. The product says on/off and the
// sheet says true/false, so the map is part of the reading, not a policy.
registerProductRead({
  product: "selinux-boolean",
  command: "getsebool -a",
  read: { pattern: "^{key}\\s*-->\\s*(\\S+)", map: { on: "true", off: "false" } },
});

// `--permanent` is the configured set, which is what a sheet records; the
// running set is a separate question (`--reload` pending) and a different row.
// The output is a list of names, so a row's value is whether it is among them.
registerProductRead({
  product: "firewalld-service",
  command: "firewall-cmd --permanent --list-services",
  read: { member: true },
});

// ---------------------------------------------------------------------------
// Where a row sits in a product's own export. See `ProductAddress`.

// A realm's settings are the realm document's own top-level fields.
registerProductAddress({ product: "keycloak-realm", address: "{key}" });

// A client's are one element of the realm's `clients`, identified by the
// clientId the sheet already uses as the component.
registerProductAddress({ product: "keycloak-client", address: "clients[clientId={component}].{key}" });

// A user-federation row carries its own structural address, because a store and
// its mappers are nested and the row's key alone does not say which store.
registerProductAddress({ product: "keycloak-ldap", address: "{address}" });

// ---------------------------------------------------------------------------
// How a product is asked what it is actually using. See `ProductDefaults`.

// `httpd -V` prints the compiled-in defaults of the binary on PATH. The config
// file's location tells you nothing about where that binary is, so it is
// ignored — this is the case the signature exists to leave alone.
registerProductDefaults({ product: "httpd", command: () => "httpd -V" });

// Keycloak ships its own CLI inside the distribution, so where the config file
// is says where the tool is: `<home>/conf/keycloak.conf` -> `<home>/bin/kc.sh`.
// Derived from the path rather than assumed at /opt/keycloak, which is a
// convention rather than a rule.
registerProductDefaults({
  product: "keycloak",
  command: (configFile) => {
    const conf = configFile.slice(0, configFile.lastIndexOf("/"));
    const home = conf.slice(0, conf.lastIndexOf("/"));
    return `${home}/bin/kc.sh show-config`;
  },
});
