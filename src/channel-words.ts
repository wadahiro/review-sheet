// The words a product plugin puts in front of a reader.
//
// A channel reads what a product said and says what it MEANS, and the second
// half is a sentence — in a document whose language is chosen at generate time
// (`--lang`). Written inline, those sentences were each baked in one language:
// the probe rules said their piece in English and the functional channels said
// theirs in Japanese, so every delivery carried wrong-language sentences in one
// direction or the other, and an `en` one carried Japanese.
//
// THE LINE IS BETWEEN WHAT THE PRODUCT SAID AND WHAT THE TOOL SAYS ABOUT IT.
// `Leap status: Normal`, `HTTP 500`, `b = disabled`, `rc=5`, an issuer URL, a
// node name, the name of a binding field — those are quoted, not written, and
// translating them would be translating evidence. Only the frame around them
// belongs here.
//
// This is `JUDGE_WORDS` (src/judge.ts) one layer down. It is a separate file
// because judge.ts imports the channels and a channel importing judge.ts back
// would be a cycle.

export type ChannelWords = {
  // chrony
  leapMissing: (said: string) => string;
  // systemd
  noLifecycleSteps: (said: string) => string;
  stepDidNotRun: (action: string) => string;
  stepLeftWrongState: (action: string, state: string, means: string) => string;
  restartDidNotRestart: () => string;
  // keycloak, as a probe rule
  noIssuerExpectation: () => string;
  confNotObserved: (path: string) => string;
  confSetsNoHostname: (path: string) => string;
  hostnameNotAUrl: (path: string, hostname: string) => string;
  noIssuerInResponse: (said: string) => string;
  issuerUnjudged: (issuer: string, why: string) => string;
  issuerNotExpected: (issuer: string, want: string) => string;
  noSessionCookie: (said: string) => string;
  cookieCarriesNoNode: () => string;
  cookieNamesNode: (node: string) => string;
  readyButDown: () => string;
  // keycloak, as a functional channel
  noLoginPage: () => string;
  loginPageBad: (name: string, status: string, missing: string[]) => string;
  noThemeDeclared: (served: string) => string;
  themeWrong: (name: string, served: string, declared: string) => string;
  loginDetail: (url: string, realms: number) => string;
  assetsDetail: (total: number, realms: number) => string;
  noFederationState: () => string;
  noLdapProvider: () => string;
  ldapDisabledHere: (names: string) => string;
  ldapDetail: (providers: number) => string;
  // logrotate
  logrotateAbsent: () => string;
  // aws-rds
  parametersUnreadable: () => string;
  parametersPaginated: () => string;
  awsNotCollected: () => string;
  authoredDetail: (total: number, changed: number) => string;
  authoredExtra: (names: string) => string;
  authoredMissing: (names: string) => string;
  // rpm
  packageIsNotTheBuild: (pkg: string, got: string, product: string, version: string) => string;
  productIsNotTheBuild: (product: string, got: string, version: string) => string;
};

export const CHANNEL_WORDS: Record<"ja" | "en", ChannelWords> = {
  ja: {
    leapMissing: (said) => `chronyc tracking が leap status について何も言っていない: ${said}`,
    noLifecycleSteps: (said) => `出力に起動・停止の手順が1つも無い: ${said}`,
    stepDidNotRun: (action) => `${action}: 実行されていない`,
    stepLeftWrongState: (action, state, means) => `${action}: is-active=${state}、${action} なら ${means} のはず`,
    restartDidNotRestart: () => "restart: ユニットが active に入り直していない（ActiveEnterTimestamp が動いていない）",
    noIssuerExpectation: () => "比較する相手が無い（issuer_base も issuer_conf も宣言されていない）",
    confNotObserved: (path) => `このホストで ${path} を観測していない`,
    confSetsNoHostname: (path) => `${path} が hostname を設定していない`,
    hostnameNotAUrl: (path, hostname) => `${path} の hostname=${hostname} は完全な URL ではない`,
    noIssuerInResponse: (said) => `応答に issuer が無い: ${said}`,
    issuerUnjudged: (issuer, why) => `issuer ${issuer} — ${why}`,
    issuerNotExpected: (issuer, want) => `issuer ${issuer}、期待は ${want}`,
    noSessionCookie: (said) => `応答が AUTH_SESSION_ID を設定していない: ${said}`,
    cookieCarriesNoNode: () => "AUTH_SESSION_ID にノード識別子は載っていない",
    cookieNamesNode: (node) => `AUTH_SESSION_ID がノード名を平文で載せている: .${node}`,
    readyButDown: () => "ready だが DOWN を報告している検査がある",
    noLoginPage: () => "ログイン画面を取得できていない",
    loginPageBad: (name, status, missing) =>
      `${name}: HTTP ${status}${missing.length === 0 ? "" : `、ログインフォームが無い（${missing.join(", ")}）`}`,
    noThemeDeclared: (served) => `どのレルムも loginTheme を指定していない（製品既定 ${served} が配信されている）`,
    themeWrong: (name, served, declared) => `${name}: ${served} が配信されている、指定は ${declared}`,
    loginDetail: (url, realms) => `GET ${url}（${realms} レルム）`,
    assetsDetail: (total, realms) => `ログイン画面が参照する ${total} 件（${realms} レルム）`,
    noFederationState: () => "ユーザフェデレーションの状態を読めていない",
    noLdapProvider: () => "LDAP プロバイダが無い",
    ldapDisabledHere: (names) => `この環境では無効: ${names}`,
    ldapDetail: (providers) => `POST /admin/realms/{realm}/testLDAPConnection（${providers} プロバイダ）`,
    logrotateAbsent: () => "logrotate がこのホストに無い",
    parametersUnreadable: () => "パラメータの一覧を読めなかった",
    parametersPaginated: () => "パラメータの一覧が途中までしか返っていない（ページングされている）",
    awsNotCollected: () => "この環境の AWS は収集していない",
    authoredDetail: (total, changed) => `${total} 項目のうち変更されているのは ${changed} 件`,
    authoredExtra: (names) => `設計にない変更: ${names}`,
    authoredMissing: (names) => `設計にあるが変更されていない: ${names}`,
    packageIsNotTheBuild: (pkg, got, product, version) => `${pkg} ${got}（シートは ${product} ${version} を記述）`,
    productIsNotTheBuild: (product, got, version) => `${product} ${got}（シートは ${version} を記述）`,
  },
  en: {
    leapMissing: (said) => `chronyc tracking said nothing about the leap status: ${said}`,
    noLifecycleSteps: (said) => `no lifecycle steps in the output: ${said}`,
    stepDidNotRun: (action) => `${action}: did not run`,
    stepLeftWrongState: (action, state, means) => `${action}: is-active=${state}, ${action} means ${means}`,
    restartDidNotRestart: () => "restart: the unit did not enter active again (ActiveEnterTimestamp did not move)",
    noIssuerExpectation: () => "no issuer_base or issuer_conf declared to compare it against",
    confNotObserved: (path) => `${path} was not observed on this host`,
    confSetsNoHostname: (path) => `${path} sets no hostname`,
    hostnameNotAUrl: (path, hostname) => `${path} says hostname=${hostname}, which is not a full URL`,
    noIssuerInResponse: (said) => `no issuer in the response: ${said}`,
    issuerUnjudged: (issuer, why) => `issuer ${issuer} — ${why}`,
    issuerNotExpected: (issuer, want) => `issuer ${issuer}, expected ${want}`,
    noSessionCookie: (said) => `the response set no AUTH_SESSION_ID: ${said}`,
    cookieCarriesNoNode: () => "AUTH_SESSION_ID carries no node identifier",
    cookieNamesNode: (node) => `AUTH_SESSION_ID names the node in plain text: .${node}`,
    readyButDown: () => "ready but a check reports DOWN",
    noLoginPage: () => "no login page was collected",
    loginPageBad: (name, status, missing) =>
      `${name}: HTTP ${status}${missing.length === 0 ? "" : `, no login form (${missing.join(", ")})`}`,
    noThemeDeclared: (served) => `no realm declares a loginTheme (the product's own ${served} is what is served)`,
    themeWrong: (name, served, declared) => `${name}: ${served} is served, ${declared} is declared`,
    loginDetail: (url, realms) => `GET ${url} (${realms} realm(s))`,
    assetsDetail: (total, realms) => `${total} resource(s) the login page references (${realms} realm(s))`,
    noFederationState: () => "the user federation state was not collected",
    noLdapProvider: () => "there is no LDAP provider",
    ldapDisabledHere: (names) => `disabled in this environment: ${names}`,
    ldapDetail: (providers) => `POST /admin/realms/{realm}/testLDAPConnection (${providers} provider(s))`,
    logrotateAbsent: () => "this host has no logrotate",
    parametersUnreadable: () => "the parameter list could not be read",
    parametersPaginated: () => "the parameter list came back only in part (it is paginated)",
    awsNotCollected: () => "AWS was not collected for this environment",
    authoredDetail: (total, changed) => `${changed} of ${total} parameter(s) are changed`,
    authoredExtra: (names) => `changed but not in the design: ${names}`,
    authoredMissing: (names) => `in the design but not changed: ${names}`,
    packageIsNotTheBuild: (pkg, got, product, version) => `${pkg} ${got} (the sheet describes ${product} ${version})`,
    productIsNotTheBuild: (product, got, version) => `${product} ${got} (the sheet describes ${version})`,
  },
};

// The table a channel should use when nothing told it which language to speak.
//
// English, and deliberately NOT the judge's default of Japanese: the judge
// always passes a language, so this only ever fires for a context built by
// hand — a test, or a caller outside the pipeline — and those read better in
// the language the code itself is written in.
export const wordsFor = (lang: "ja" | "en" | undefined): ChannelWords => CHANNEL_WORDS[lang ?? "en"];
