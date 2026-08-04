// Normalizer: keycloak-defaults-<version>.json  ->  keycloak@<version>.yml
//
// The input JSON is produced by the `keycloak-defaults-extractor` skill, which
// runs Java reflection over `org.keycloak.config.*Options` inside the official
// container image (quay.io/keycloak/keycloak:<version>) and emits, per config
// key: { default, description, category, build_time }. This script reshapes that
// into a review-sheet dictionary — so every default and English description is
// the product's OWN (provenance: extracted), not hand-authored.
//
// Japanese descriptions for the operational subset this example reviews are
// overlaid from DESC_JA (the extractor emits English only; the skill's Step 3
// says to add ja). A translation is still the product's own statement, just in
// another language, so it belongs in the dictionary — and that is what makes the
// dictionary reusable: the next project to review this product inherits the
// translations instead of writing them again. Anything with no product wording
// behind it (DESC_EXTRA below) is marked `provenance: community` per entry, and
// a project that dislikes any of this overrides it in its own sheet.yml, which
// wins over every dictionary.
//
// Regenerate after a Keycloak upgrade:
//   /wadahiro-agent-skills:keycloak-defaults-extractor   (or run its
//     scripts/extract_defaults.sh 26.7.0) > keycloak-defaults-26.7.0.json
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

type Raw = { default: string; description: string; category: string; build_time: boolean };
const raw = JSON.parse(readFileSync(resolve(here, `keycloak-defaults-${VERSION}.json`), "utf8")) as Record<string, Raw>;

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
  CACHE: "Cache",
  DATABASE: "Database",
  DATABASE_DATASOURCES: "Database / Named datasources",
  FEATURE: "Features",
  HEALTH: "Health",
  HOSTNAME_V2: "Hostname",
  HTTP: "HTTP / TLS",
  HTTP_ACCESS_LOG: "HTTP access log",
  LOGGING: "Logging",
  METRICS: "Metrics",
  PROXY: "Reverse proxy",
  SECURITY: "Security",
  SERVER: "Server",
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

// Options Keycloak itself ships no description for (reflection returns an empty
// string). The dictionary carries the product's OWN words, so these cannot just
// be written into it as if they were — but leaving them out means every project
// using this dictionary hits the strict-metadata gate on the same six keys and
// writes the same sentence again. So they go in WITH `provenance: community` on
// the entry: shareable, and honest about not coming from the product.
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
};

// Keycloak renders multi-valued option defaults in Quarkus list form: `log`'s
// default is "[console]", not "console". keycloak.conf takes the bare value
// (comma-separated for lists), so unwrap the brackets — otherwise the sheet
// would compare a bare config value ("console") against "[console]" and flag it
// as changed-from-default when it is not.
function normalizeDefault(s: string): string {
  const m = s.match(/^\[(.*)\]$/s);
  return m ? m[1].trim() : s;
}

const params: Record<string, DictionaryParam> = {};
for (const [key, v] of Object.entries(raw)) {
  const en = (v.description ?? "").trim();
  const ja = DESC_JA[key];
  const extra = DESC_EXTRA[key];
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
  // Java reflection over every org.keycloak.config.*Options class enumerates
  // the product's whole build-time+runtime option space, not a hand-picked
  // subset — genuinely materializable (see build.yml's "materialize").
  coverage: "full",
  generated_by:
    "keycloak-defaults-extractor skill — Java reflection on org.keycloak.config.*Options in quay.io/keycloak/keycloak:" +
    VERSION,
  docs_url: "https://www.keycloak.org/server/all-config",
  parameters: params,
};

const yaml = renderDictionary(doc, {
  generator: `build-dict.ts from keycloak-defaults-${VERSION}.json`,
  notes: ["English is the product's own description; Japanese is overlaid for the reviewed subset."],
});
writeFileSync(resolve(here, `keycloak@${VERSION}.yml`), yaml);
console.log(
  `wrote keycloak@${VERSION}.yml (${Object.keys(params).length} params, ` +
    `${Object.keys(DESC_JA).length} translated, ${Object.keys(DESC_EXTRA).length} community-described)`
);
