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
// Japanese descriptions for the operational subset this example reviews are
// overlaid from DESC_JA (Keycloak ships English only). A translation is still
// the product's own statement, just in
// another language, so it belongs in the dictionary — and that is what makes the
// dictionary reusable: the next project to review this product inherits the
// translations instead of writing them again. Anything with no product wording
// behind it (DESC_EXTRA below) is marked `provenance: community` per entry, and
// a project that dislikes any of this overrides it in its own sheet.yml, which
// wins over every dictionary.
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

// Japanese for the keys this example's sheet reviews. Technical terms (JDBC, PEM,
// TLS, HTTP…) and option values (dev-file, xforwarded…) are kept as-is.
const DESC_JA: Record<string, string> = {
  "db": "使用するデータベースベンダー。本番モードでは 'dev-file' 既定は使わず明示指定する（build 時に確定）。",
  "db-url": "データベースの完全な JDBC URL。未指定ならベンダー既定の URL（例: postgres なら jdbc:postgresql://localhost/keycloak）。",
  "db-username": "データベースユーザーのユーザー名。",
  "db-password": "データベースユーザーのパスワード。",
  "hostname": "サーバーを公開するアドレス。完全な URL、またはホスト名のみを指定する。",
  "hostname-strict": "リクエストヘッダーからのホスト名動的解決を無効化する。本番では true 推奨。",
  "http-enabled": "HTTP リスナーを有効化する。開発モードでは既定で有効。TLS 終端を前段のリバースプロキシに任せる場合に有効化する。",
  "http-port": "使用する HTTP ポート。",
  "https-port": "使用する HTTPS ポート。",
  "https-certificate-file": "PEM 形式のサーバー証明書（またはチェーン）のファイルパス。",
  "https-certificate-key-file": "PEM 形式の秘密鍵のファイルパス。",
  "proxy-headers": "サーバーが受け入れるプロキシヘッダー（xforwarded / forwarded）。誤設定はセキュリティリスクになりうる。",
  "log": "有効化するログハンドラーをカンマ区切りで指定する（console / file / syslog）。",
  "log-level": "ルートカテゴリのログレベル、または category:level のカンマ区切りリスト。",
  "health-enabled": "ヘルスチェックエンドポイントを公開するか（build 時に確定）。",
  "metrics-enabled": "メトリクスを公開するか（build 時に確定）。",
  "cache": "高可用性のためのキャッシュ機構。本番では既定で ispn（分散 Infinispan）。",
  "cache-stack": "クラスタ通信とノード検出に使う既定スタック。",
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

// Options Keycloak itself ships no description for (the extraction returns an
// empty string). The dictionary carries the product's OWN words, so these
// cannot just be written into it as if they were — but leaving them out means
// every project using this dictionary hits the strict-metadata gate on the same
// keys and writes the same sentence again. So they go in WITH
// `provenance: community` on the entry: shareable, and honest about not coming
// from the product.
//
// Only base keys are listed. A `<datasource>` variant of a described base
// (`db-dialect-<datasource>`) inherits the text below through the same
// "Used for named <datasource>." prefix Keycloak puts on the variants it does
// describe — see wildcardDescription().
const DESC_EXTRA: Record<string, { en: string; ja: string }> = {
  "db-dialect": {
    en: "JDBC dialect Hibernate uses for the chosen database; normally inferred from `db`.",
    ja: "選択したデータベースに対して Hibernate が使う JDBC ダイアレクト。通常は `db` から推論される。",
  },
  "db-pool-acquisition-timeout": {
    en: "How long a request waits for a free connection from the pool before failing.",
    ja: "コネクションプールから接続を取得できるまでの待機時間。超過するとリクエストは失敗する。",
  },
  "log-console-enabled": {
    en: "Whether the console log handler is enabled (also implied by listing `console` in `log`).",
    ja: "コンソールログハンドラーを有効にするか（`log` に `console` を列挙した場合も有効になる）。",
  },
  "log-file-enabled": {
    en: "Whether the file log handler is enabled (also implied by listing `file` in `log`).",
    ja: "ファイルログハンドラーを有効にするか（`log` に `file` を列挙した場合も有効になる）。",
  },
  "log-syslog-enabled": {
    en: "Whether the syslog handler is enabled (also implied by listing `syslog` in `log`).",
    ja: "syslog ハンドラーを有効にするか（`log` に `syslog` を列挙した場合も有効になる）。",
  },
  "tracing-headers": {
    en: "Extra headers attached to outgoing OpenTelemetry trace exports.",
    ja: "OpenTelemetry のトレース送信に付与する追加ヘッダー。",
  },
  "telemetry-logs-headers": {
    en: "Extra headers attached to outgoing OpenTelemetry log exports.",
    ja: "OpenTelemetry のログ送信に付与する追加ヘッダー。",
  },
  "telemetry-metrics-headers": {
    en: "Extra headers attached to outgoing OpenTelemetry metric exports.",
    ja: "OpenTelemetry のメトリクス送信に付与する追加ヘッダー。",
  },
};

// Keycloak describes a named-datasource variant by prefixing the base option's
// text ("Used for named <datasource>. The database vendor."). Two variants have
// no text only because their base has none; DESC_EXTRA supplies the base, so
// the variant is composed the same way the product composes the rest instead of
// being written out a second time by hand.
const WILDCARD_PREFIX = { en: "Used for named <datasource>. ", ja: "名前付き <datasource> 用。" };

function wildcardDescription(key: string): { en: string; ja: string } | undefined {
  const base = key.endsWith("-<datasource>") ? key.slice(0, -"-<datasource>".length) : undefined;
  const baseDesc = base ? DESC_EXTRA[base] : undefined;
  if (!baseDesc) return undefined;
  return { en: WILDCARD_PREFIX.en + baseDesc.en, ja: WILDCARD_PREFIX.ja + baseDesc.ja };
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

// A key that is written down here but no longer exists upstream is a silent
// no-op: the overlay simply never applies, and nobody notices until someone
// reads a sheet with a missing translation. Fail the build instead — the same
// reason build.yml rejects unknown fields.
const stale = [...Object.keys(DESC_JA), ...Object.keys(DESC_EXTRA), ...Object.keys(NOT_CONFIGURATION)].filter(
  (k) => !(k in raw)
);
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
  const en = (v.description ?? "").trim();
  const ja = DESC_JA[key];
  const extra = DESC_EXTRA[key] ?? wildcardDescription(key);
  const entry: DictionaryParam = {};
  if (extra) {
    // Not the product's words: say so on the entry, since the document-level
    // provenance ("extracted") would otherwise vouch for it.
    entry.description = extra;
    entry.provenance = "community";
  } else if (en || ja) {
    entry.description = ja ? { en, ja } : en;
  }
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
    "English is the product's own description; Japanese is overlaid for the reviewed subset.",
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
    `${Object.keys(DESC_JA).length} translated, ` +
    `${Object.keys(DESC_EXTRA).length} community-described, ` +
    `${hidden.length} hidden, ${deprecated.length} deprecated, ${excluded} excluded as non-configuration)`
);
