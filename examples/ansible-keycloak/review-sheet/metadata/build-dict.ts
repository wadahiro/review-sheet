// Normalizer: keycloak-defaults-<version>.json  ->  keycloak@<version>.yml
//
// The input JSON is produced by the `keycloak-config-extractor` skill
// (github.com/wadahiro/agent-skills), which reads Keycloak's own
// `PropertyMappers` registry inside the official container image
// (quay.io/keycloak/keycloak:<version>) and emits, per config key:
// { default, description, category, build_time, hidden, deprecated, wildcard }.
// This script reshapes that into a review-sheet dictionary — so every default
// and English description is the product's OWN (provenance: extracted), not
// hand-authored.
//
// The extraction used to reflect over `org.keycloak.config.*Options` instead,
// against a hardcoded list of those classes. It reported 170 keys and declared
// `coverage: full` — while missing every option of eight whole Options classes
// (management-*, bootstrap-admin-*, config-keystore-*, telemetry-*, event-*,
// openapi-*, export/import) and every wildcard key (`db-username-<datasource>`,
// `log-level-<category>`, …), which exist only as mappers. A full-inventory
// ledger that quietly omits 91 of the product's 261 options is the exact
// failure `coverage: full` is supposed to rule out, so the source of truth
// moved to the registry the server itself resolves keys against. The skill's
// own SKILL.md carries the full reasoning and the `--help-all` cross-check.
//
// Japanese descriptions and gap-filling English (for options Keycloak itself
// ships no description for) live in the hand-authored overlay next to this
// file, `keycloak@26.7.0.overlay.yml` — NOT in this script. Keycloak ships no
// Japanese, so a translation is not the product's own statement in the way an
// extracted English description is; keeping it in a file this script never
// writes is what lets a translation be ADDED without touching this generator,
// and what stops regeneration from ever clobbering one (see
// src/providers/dictionary.ts's overlay merge — findDictionary() loads the
// base this script writes plus every readable `.overlay.yml` next to it, and
// fails the build if the base ever starts supplying a language the overlay
// already fills). A project that dislikes any of this overrides it in its own
// sheet.yml, which wins over the dictionary either way.
//
// Regenerate after a Keycloak upgrade:
//   /wadahiro-agent-skills:keycloak-config-extractor   (or run its
//     scripts/extract.sh 26.7.0 --server) > keycloak-defaults-26.7.0.json
//   bun run review-sheet/metadata/build-dict.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The dictionary SHAPE belongs to review-sheet; only the reshaping below is
// Keycloak-specific. Building a typed DictionaryDoc means a wrong field is a
// compile error rather than a key the loader silently ignores.
import { renderDictionary, type DictionaryDoc, type DictionaryParam } from "../../../../src/index.js";

const VERSION = "26.7.0";
const here = dirname(fileURLToPath(import.meta.url));

type Raw = {
  default: string;
  description: string;
  category: string;
  build_time: boolean;
  // Not shown by `--help-all`, but a real key the server accepts (db-dialect,
  // log-console-enabled, …). Kept: a ledger of what the product CAN be
  // configured with does not get to leave out the parts help is shy about.
  hidden: boolean;
  // Carried through the extraction so an upgrade cannot lose it silently.
  // Nothing consumes it yet — DictionaryParam has no field for "the product
  // says stop using this" — so build-dict only counts them (below) rather than
  // inventing a place to put it.
  deprecated: boolean;
  wildcard: boolean;
};
const raw = JSON.parse(readFileSync(resolve(here, `keycloak-defaults-${VERSION}.json`), "utf8")) as Record<string, Raw>;

// The four keys the registry exposes that are not configuration: two internal
// switches the build uses to toggle a Quarkus extension, and the two
// placeholders `kc.sh export`/`import` set to signal their own mode. Listing
// them by name (rather than filtering on `hidden`, which would also drop real
// options like db-dialect) keeps the exclusion visible AND checkable: if an
// upgrade renames one, the assertion below fails instead of the sheet quietly
// growing a nonsense row.
const NOT_CONFIGURATION: Record<string, string> = {
  "http-optimized-serializers-hidden-mapper": "internal build switch, not a user-settable option",
  "opentelemetry-hidden-mapper": "internal build switch, not a user-settable option",
  exporter: "placeholder the export command sets to signal its own mode",
  importer: "placeholder the import command sets to signal its own mode",
};

// The extractor reports each option's own category (DATABASE, HTTP_ACCESS_LOG,
// HOSTNAME_V2 …) — Keycloak's own grouping of its options. It becomes the
// dictionary's `group`, which the assembler uses to file the parameters this
// project does not set (see `materialize` in build.yml). Rendered for a human
// reading a sheet heading rather than left as a Java-ish SCREAMING_CASE token.
const GROUP_LABEL: Record<string, string> = {
  BOOTSTRAP_ADMIN: "Bootstrap admin",
  CACHE: "Cache",
  CONFIG: "Config keystore",
  DATABASE: "Database",
  DATABASE_DATASOURCES: "Database / Named datasources",
  EVENTS: "Events",
  // Command-scoped: these are read by `kc.sh export` / `kc.sh import`, not by a
  // running server. They are still kc.* keys keycloak.conf can carry, so they
  // stay in the dictionary — the group label is what tells a reviewer that a
  // row named `dir` or `users` is not a server setting.
  EXPORT: "Export (kc.sh export)",
  IMPORT: "Import (kc.sh import)",
  FEATURE: "Features",
  HEALTH: "Health",
  HOSTNAME_V2: "Hostname",
  HTTP: "HTTP / TLS",
  HTTP_ACCESS_LOG: "HTTP access log",
  LOGGING: "Logging",
  MANAGEMENT: "Management interface",
  METRICS: "Metrics",
  OPENAPI: "OpenAPI",
  PROXY: "Reverse proxy",
  SECURITY: "Security",
  SERVER: "Server",
  TELEMETRY: "Telemetry (OpenTelemetry)",
  TRACING: "Tracing",
  TRANSACTION: "Transactions",
  TRUSTSTORE: "Truststore",
  VAULT: "Vault",
};

function groupLabel(category: string | undefined): string | undefined {
  if (!category) return undefined;
  // An unmapped category (a new Options class in a later release) still gets a
  // readable label rather than being dropped silently.
  return GROUP_LABEL[category] ?? category.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// Keycloak renders multi-valued option defaults in Quarkus list form: `log`'s
// default is "[console]", not "console". keycloak.conf takes the bare value
// (comma-separated for lists), so unwrap the brackets — otherwise the sheet
// would compare a bare config value ("console") against "[console]" and flag it
// as changed-from-default when it is not.
function normalizeDefault(s: string): string {
  const m = s.match(/^\[(.*)\]$/s);
  return m ? m[1].trim() : s;
}

// A NOT_CONFIGURATION key that is written down here but no longer exists
// upstream is a silent no-op: the exclusion simply never applies, and the
// sheet quietly grows a row this script meant to drop. Fail the build instead
// — the same reason build.yml rejects unknown fields. (The equivalent guard
// for the overlay's translation keys is no longer this script's job — see
// findDictionary()'s "no longer has" error in src/providers/dictionary.ts,
// which runs the same check for every dictionary on every build, not just
// this one at generation time.)
const stale = Object.keys(NOT_CONFIGURATION).filter((k) => !(k in raw));
if (stale.length > 0) {
  throw new Error(
    `build-dict: ${stale.length} key(s) in this script no longer exist in keycloak-defaults-${VERSION}.json ` +
      `(renamed or removed upstream): ${stale.join(", ")}`
  );
}

const params: Record<string, DictionaryParam> = {};
let excluded = 0;
for (const [key, v] of Object.entries(raw)) {
  if (key in NOT_CONFIGURATION) {
    excluded++;
    continue;
  }
  // English only — this base carries just what the product itself says.
  // Japanese, and English for options Keycloak ships no description for, are
  // the overlay's job (keycloak@26.7.0.overlay.yml, gap-filled onto this file
  // by findDictionary()'s loader merge; see this script's header comment).
  const en = (v.description ?? "").trim();
  const entry: DictionaryParam = {};
  if (en) entry.description = en;
  if (v.default !== "") entry.default = normalizeDefault(v.default);
  // Keycloak's build-time vs runtime distinction is operationally important:
  // build-time options are baked by `kc.sh build` and cannot change at start.
  entry.scope = v.build_time ? "build-time" : "runtime";
  const group = groupLabel(v.category);
  if (group) entry.group = group;
  entry.docs_url = "https://www.keycloak.org/server/all-config";
  params[key] = entry;
}

const doc: DictionaryDoc = {
  product: "keycloak",
  version: VERSION,
  provenance: "extracted",
  // PropertyMappers IS the server's key space — every kc.* key it accepts,
  // build-time and runtime, hidden and documented, including the wildcard
  // families. Not a hand-picked subset, so genuinely materializable (see
  // build.yml's "materialize"). The one thing outside it is spi-*, and that is
  // stated in the header notes rather than left for a reader to discover.
  coverage: "full",
  generated_by:
    "keycloak-config-extractor skill (scripts/extract.sh --server) — PropertyMappers registry in " +
    "quay.io/keycloak/keycloak:" +
    VERSION,
  docs_url: "https://www.keycloak.org/server/all-config",
  parameters: params,
};

const deprecated = Object.entries(raw).filter(([k, v]) => v.deprecated && !(k in NOT_CONFIGURATION));
const hidden = Object.entries(raw).filter(([k, v]) => v.hidden && !(k in NOT_CONFIGURATION));

const yaml = renderDictionary(doc, {
  generator: `build-dict.ts from keycloak-defaults-${VERSION}.json`,
  notes: [
    "English is the product's own description. Japanese, and English for keys " +
      "Keycloak ships no description for, are gap-filled by the hand-authored " +
      "keycloak@" + VERSION + ".overlay.yml next to this file — never by this script.",
    `Covers every kc.* key the server's PropertyMappers registry accepts (${Object.keys(params).length}), ` +
      `including ${hidden.length} options --help-all hides.`,
    `NOT covered: spi-<spi>-<provider>-<property>. Those are open-ended — each deployed provider defines its ` +
      `own — so the product has no finite list of them to extract.`,
    `Excluded as non-configuration (${excluded}): ${Object.entries(NOT_CONFIGURATION)
      .map(([k, why]) => `${k} (${why})`)
      .join("; ")}.`,
    `Keycloak marks ${deprecated.length} of these deprecated (${deprecated.map(([k]) => k).join(", ")}); ` +
      `the dictionary has no field for that yet, so it is recorded here.`,
  ],
});
writeFileSync(resolve(here, `keycloak@${VERSION}.yml`), yaml);
console.log(
  `wrote keycloak@${VERSION}.yml (${Object.keys(params).length} params, ` +
    `${hidden.length} hidden, ${deprecated.length} deprecated, ${excluded} excluded as non-configuration; ` +
    `translations live in keycloak@${VERSION}.overlay.yml, not this script)`
);
