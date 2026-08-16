// i18n message definitions for browser-side UI

export type Lang = "ja" | "en";

type Messages = {
  // Default title
  defaultTitle: string;
  // Overview tab
  overview: string;
  project: string;
  version: string;
  generatedAt: string;
  changelog: string;
  changelogVersion: string;
  changelogDate: string;
  changelogAuthor: string;
  changelogDescription: string;
  sheetList: string;
  // Table headers
  paramName: string;
  defaultValue: string;
  usesDefault: string;
  scopeSharedHint: string;
  scopeThisEnv: (env: string) => string;
  scopeAllEnvs: string;
  setValue: string;
  descriptionHeader: string;
  remarksHeader: string;
  instanceHeader: string;
  // View toggle (Pattern B table orientation)
  viewToggleLabel: string;
  viewNormal: string;
  viewNormalTip: string;
  viewTranspose: string;
  viewTransposeTip: string;
  freezeColumnTip: string;
  unfreezeColumnTip: string;
  navOutline: string;
  navOutlineTip: string;
  navSearchTip: string;
  navSearchPlaceholder: string;
  navNoResults: string;
  moreSheets: string;
  // Versions & diff
  versionLabel: string;
  compareVersions: string;
  exitCompare: string;
  diffChangedOnly: string;
  diffNoChanges: string;
  // `unchanged` is the sentence an upgrade sign-off is actually made of ("3
  // moved, 1013 did not"), and `docOnly` is the share of `changed` that is
  // nothing but reworded prose — across two product versions that is most of
  // it, so leaving it folded in makes the headline read as a system that moved.
  diffSummary: (changed: number, docOnly: number, added: number, removed: number, unchanged: number) => string;
  diffFrom: string;
  diffTo: string;
  // Field labels (review modal)
  fieldKey: string;
  fieldValue: string;
  fieldDefault: string;
  fieldDescription: string;
  fieldRemarks: string;
  fieldComment: string;
  // Review modal
  valueLabelHint: string;
  commentLabel: string;
  commentPlaceholder: string;
  shortcutSave: string;
  shortcutClose: string;
  // Artifact preview panel (the file a row lives in, beside the sheet).
  // `artifactTitle` labels the affordance and the panel, and stays neutral
  // on purpose: the panel shows a rendered artifact, a committed config file
  // OR an authored source (see ArtifactPreview.nature), and "what gets
  // deployed" was a false claim over the third.
  artifactOpen: string;
  artifactTitle: string;
  artifactRenderedFrom: string;
  artifactSourceFile: string;
  artifactInstance: string;
  artifactKindAbsent: string;
  artifactKindUnrendered: string;
  artifactKindDeployTime: string;
  artifactUnrendered: string;
  artifactJumpRow: string;
  save: string;
  update: string;
  delete: string;
  // Review actions
  validationEmpty: string;
  confirmDelete: string;
  // Toolbar
  filterMenu: string;
  filterMenuCount: (n: number) => string;
  reviewMenu: (n: number) => string;
  showCommentsToggle: string;
  importReviewMenu: string;
  clearAllMenu: string;
  showComments: string;
  showCommentedOnly: string;
  exportReview: string;
  importReview: string;
  aiPromptCopy: string;
  clearAll: string;
  // Alerts
  unsupportedSchema: string;
  noNewReviews: string;
  importedReviews: (count: number) => string;
  jsonParseError: string;
  noPendingReviews: string;
  aiPromptCopied: string;
  aiPromptTitle: string;
  aiPromptHint: string;
  confirmClearAll: (count: number) => string;
  // Tooltips
  copyTooltip: string;
  reviewTooltip: string;
  cellActions: string;
  suggest: string;
  suggestEdit: string;
  comment: string;
  copyLabel: string;
  commentOnCategory: string;
  commentOnSheet: string;
  // Inline comments
  memo: string;
  // Out of scope
  outOfScope: string;
  outOfScopeOwner: string;
  hideOutOfScope: string;
  columnsShown: string;
  pivotAbsent: string;
  compareComponents: string;
  showDefaults: (n: number) => string;
  // Origin (viewer-only marker in the key cell). An `embedded` row is tagged
  // with the FILE its literal lives in (originEmbedded is only the fallback when
  // it has no source); a `default` row says "not set here" — deliberately not
  // "default", which would collide with the sheet's own デフォルト値/Default
  // column and states the consequence rather than the reviewable fact.
  // overlay/common render no marker.
  originEmbedded: string;
  originDefault: string;
  originDefaultTip: string;
  originEmbeddedTip: string;
  // `asInstalled` is the default column's heading on a sheet that has a
  // baseline (ansible recipe's `baseline:`). ONE column, not two: the vendor's
  // shipped file and the product's documented default are two SOURCES for a
  // single question the reader has — "what does a freshly installed host do
  // here?" — and a column each put the tool's own plumbing on screen instead of
  // the answer. The shipped value wins, because it is what the host has.
  //
  // `originBaselineDisabled` is the value cell's own text for an `origin:
  // "baseline"` row: nothing is in effect at all, a different fact from
  // `originDefault` ("not set here, the product default applies"), so it gets
  // its own word. That row's as-installed cell shows what the VENDOR had, and
  // deliberately not what applies instead — the container may have been removed
  // along with the directive, and answering that needs the product's own merge
  // semantics, which this tool does not model.
  asInstalled: string;
  originBaselineDisabled: string;
  sheetSourceLabel: string;
  applyToFiles: string;
  applyPreviewTitle: string;
  applyWriteN: (n: number) => string;
  wroteFiles: (n: number) => string;
  applyError: string;
  applyEmpty: string;
  statusApplied: string;
  statusSkipped: string;
  statusHeld: string;
  statusOutOfScope: string;
  applyLoading: string;
  applyNoFile: string;
  applyHeldPromptCopy: string;
  applyHeldTitle: string;
  applyHeldHint: string;
  // Shown for a value held because its source is a generated build artifact
  // (never edited directly) — replaces the raw held reason in the apply
  // preview, and doubles as the disabled-affordance tooltip.
  applySkippedGenerated: string;
  themeToggle: string;
  // Collapsed-by-default materialize categories (a category where every row,
  // recursively, sits at the product default — see app.ts's
  // categoryDefaultSummary). The count is shown whether the category is open
  // or closed, so the ledger never looks smaller than it is.
  searchScopeAll: string;
  searchScopeSet: string;
  searchScopeHint: string;
};

const ja: Messages = {
  defaultTitle: "パラメータシート",
  overview: "概要",
  project: "プロジェクト",
  version: "バージョン",
  generatedAt: "作成日時",
  changelog: "改版履歴",
  changelogVersion: "版数",
  changelogDate: "日付",
  changelogAuthor: "変更者",
  changelogDescription: "変更内容",
  sheetList: "シート一覧",
  paramName: "設定項目",
  defaultValue: "デフォルト値",
  usesDefault: "デフォルト値を利用",
  scopeSharedHint: "この値は全環境で 1 箇所に定義されています。指摘の範囲を選んでください。",
  scopeThisEnv: (env) => `${env} のみ（この環境にオーバーライドを追加）`,
  scopeAllEnvs: "全環境（共有値そのものを変更）",
  setValue: "設定値",
  descriptionHeader: "説明",
  remarksHeader: "備考",
  instanceHeader: "インスタンス",
  viewToggleLabel: "比較ビューの向き",
  viewNormal: "通常",
  viewNormalTip: "通常表示（行=項目 / 列=インスタンス）",
  viewTranspose: "転置",
  viewTransposeTip: "転置表示（行=インスタンス / 列=項目）",
  freezeColumnTip: "この列まで固定する",
  unfreezeColumnTip: "この列の固定を解除",
  navOutline: "目次",
  navOutlineTip: "目次を表示/非表示",
  navSearchTip: "見出しを検索 (Cmd/Ctrl+K)",
  navSearchPlaceholder: "見出しを検索…",
  navNoResults: "該当する見出しがありません",
  moreSheets: "他のシート",
  versionLabel: "バージョン",
  compareVersions: "差分を比較",
  exitCompare: "比較を終了",
  diffChangedOnly: "変更のみ",
  diffNoChanges: "差分はありません",
  diffSummary: (changed, docOnly, added, removed, unchanged) =>
    `${changed} 変更${docOnly > 0 ? `（うち ${docOnly} は説明文のみ）` : ""} · ${added} 追加 · ${removed} 削除 · ${unchanged} 変更なし`,
  diffFrom: "比較元",
  diffTo: "比較先",
  fieldKey: "設定項目",
  fieldValue: "設定値",
  fieldDefault: "デフォルト値",
  fieldDescription: "説明",
  fieldRemarks: "備考",
  fieldComment: "全体",
  valueLabelHint: "（編集して変更を提案）",
  commentLabel: "コメント",
  commentPlaceholder: "レビューコメントを入力",
  shortcutSave: "保存",
  shortcutClose: "閉じる",
  artifactOpen: "設定ファイルの該当箇所を見る",
  artifactTitle: "プレビュー",
  artifactRenderedFrom: "生成元",
  artifactSourceFile: "ソースファイル",
  artifactInstance: "環境",
  artifactKindAbsent: "この環境では出力されない（条件: {reason}）",
  artifactKindUnrendered: "review-sheet では計算できない箇所（{reason}）— テンプレートの記述をそのまま表示",
  artifactKindDeployTime: "Ansible が配置時に埋める値（{reason}）— どの変数ファイルにも無く、欠落ではない",
  artifactUnrendered: "{n} 行は review-sheet では計算できていません（該当行に印）",
  artifactJumpRow: "この行の設定項目へ",
  save: "保存",
  update: "更新",
  delete: "削除",
  validationEmpty: "値を変更するかコメントを入力してください",
  confirmDelete: "レビューを削除しますか？",
  filterMenu: "絞り込み",
  filterMenuCount: (n) => `絞り込み (${n})`,
  reviewMenu: (n) => (n > 0 ? `レビュー (${n})` : "レビュー"),
  showCommentsToggle: "コメントを表示",
  importReviewMenu: "インポート…",
  clearAllMenu: "全レビューを削除…",
  showComments: "コメント表示",
  showCommentedOnly: "コメント有りのみ",
  exportReview: "エクスポート",
  importReview: "インポート",
  aiPromptCopy: "AIプロンプトコピー",
  clearAll: "全クリア",
  unsupportedSchema: "サポートされていないスキーマバージョンです",
  noNewReviews: "新しいレビューはありませんでした",
  importedReviews: (count) => `${count}件のレビューをインポートしました`,
  jsonParseError: "JSONの解析に失敗しました",
  noPendingReviews: "pending状態のレビューがありません",
  aiPromptCopied: "AIプロンプトをコピーしました",
  aiPromptTitle: "AIプロンプト",
  aiPromptHint: "未反映のレビューから生成したプロンプトです。必要なら編集してコピーし、AIに渡してください。",
  confirmClearAll: (count) => `全${count}件のレビューを削除しますか？`,
  copyTooltip: "値をコピー",
  reviewTooltip: "値を提案・コメント（ダブルクリックでも開く）",
  cellActions: "セル操作",
  suggest: "提案",
  suggestEdit: "提案を編集",
  comment: "コメント",
  copyLabel: "コピー",
  commentOnCategory: "カテゴリにコメント",
  commentOnSheet: "シートにコメント",
  memo: "メモ",
  outOfScope: "レビュー対象外",
  outOfScopeOwner: "所管: ",
  hideOutOfScope: "対象外を隠す",
  columnsShown: "表示する列",
  pivotAbsent: "このコンポーネントには存在しない項目",
  compareComponents: "横並びで比較",
  // 「未設定」であって「未使用」ではない — 製品の既定値はいま実際に効いている。
  // 欠けているのはこのプロジェクトからの表明のほう。
  showDefaults: (n: number) => `未設定の行を表示（製品既定値 ${n} 件）`,
  originEmbedded: "組み込み",
  originDefault: "未設定",
  originDefaultTip: "この構成では設定していない（効いている値は製品のデフォルト値）",
  originEmbeddedTip: "変数を介さずファイルに直接書かれた値。環境ごとに変えることはできず、変更するにはそのファイル自体を編集する",
  asInstalled: "インストール時",
  originBaselineDisabled: "無効化",
  sheetSourceLabel: "生成元",
  applyToFiles: "ファイルに反映",
  applyPreviewTitle: "変更のプレビュー",
  applyWriteN: (n) => `${n} 件のファイルに書き込む`,
  wroteFiles: (n) => `${n} 件のファイルに書き込みました`,
  applyError: "サーバに接続できませんでした",
  applyEmpty: "反映できる変更がありません",
  statusApplied: "適用",
  statusSkipped: "スキップ",
  statusHeld: "保留",
  statusOutOfScope: "対象外",
  applyLoading: "プレビューを読み込み中…",
  applyHeldTitle: "残りの変更（AIに渡す）",
  applyHeldHint: "決定的に反映できなかった変更です。必要なら編集してコピーし、AIに渡してください。",
  applyNoFile:"（ファイル未特定）",
  applyHeldPromptCopy: "AIプロンプトをコピー",
  applySkippedGenerated: "生成ファイルのため直接適用できません",
  themeToggle: "テーマ切り替え",
  searchScopeAll: "未設定を含む",
  searchScopeSet: "設定済みのみ",
  searchScopeHint: "Ctrl/⌘+K で切替",
};

const en: Messages = {
  defaultTitle: "Parameter Sheet",
  overview: "Overview",
  project: "Project",
  version: "Version",
  generatedAt: "Created at",
  changelog: "Changelog",
  changelogVersion: "Version",
  changelogDate: "Date",
  changelogAuthor: "Author",
  changelogDescription: "Description",
  sheetList: "Sheets",
  paramName: "Parameter",
  defaultValue: "Default",
  usesDefault: "Uses default",
  scopeSharedHint: "This value is defined once for every environment. Choose the scope of your finding.",
  scopeThisEnv: (env) => `${env} only (add an override for this environment)`,
  scopeAllEnvs: "All environments (change the shared value)",
  setValue: "Value",
  descriptionHeader: "Description",
  remarksHeader: "Remarks",
  instanceHeader: "Instance",
  viewToggleLabel: "Comparison view orientation",
  viewNormal: "Normal",
  viewNormalTip: "Normal view (rows = parameters / columns = instances)",
  viewTranspose: "Transpose",
  viewTransposeTip: "Transposed view (rows = instances / columns = parameters)",
  freezeColumnTip: "Freeze up to this column",
  unfreezeColumnTip: "Unfreeze this column",
  navOutline: "Outline",
  navOutlineTip: "Toggle outline",
  navSearchTip: "Search headings (Cmd/Ctrl+K)",
  navSearchPlaceholder: "Search headings…",
  navNoResults: "No matching headings",
  moreSheets: "More sheets",
  versionLabel: "Version",
  compareVersions: "Compare",
  exitCompare: "Exit compare",
  diffChangedOnly: "Changed only",
  diffNoChanges: "No differences",
  diffSummary: (changed, docOnly, added, removed, unchanged) =>
    `${changed} changed${docOnly > 0 ? ` (${docOnly} description only)` : ""} · ${added} added · ${removed} removed · ${unchanged} unchanged`,
  diffFrom: "From",
  diffTo: "To",
  fieldKey: "Parameter",
  fieldValue: "Value",
  fieldDefault: "Default",
  fieldDescription: "Description",
  fieldRemarks: "Remarks",
  fieldComment: "General",
  valueLabelHint: "(edit to suggest a change)",
  commentLabel: "Comment",
  commentPlaceholder: "Enter review comment",
  shortcutSave: "Save",
  shortcutClose: "Close",
  artifactOpen: "Show this line in the file",
  artifactTitle: "Preview",
  artifactRenderedFrom: "Rendered from",
  artifactSourceFile: "Source file",
  artifactInstance: "Instance",
  artifactKindAbsent: "not rendered for this instance (condition: {reason})",
  artifactKindUnrendered: "review-sheet cannot compute this ({reason}) — the template text is shown as written",
  artifactKindDeployTime: "filled in by Ansible when it writes the file ({reason}) — in no vars file, and not a gap",
  artifactUnrendered: "{n} line(s) review-sheet could not compute — marked in place",
  artifactJumpRow: "Go to this line's row",
  save: "Save",
  update: "Update",
  delete: "Delete",
  validationEmpty: "Please change the value or enter a comment",
  confirmDelete: "Delete this review?",
  filterMenu: "Filter",
  filterMenuCount: (n) => `Filter (${n})`,
  reviewMenu: (n) => (n > 0 ? `Review (${n})` : "Review"),
  showCommentsToggle: "Show comments",
  importReviewMenu: "Import…",
  clearAllMenu: "Clear all reviews…",
  showComments: "Show comments",
  showCommentedOnly: "Commented only",
  exportReview: "Export",
  importReview: "Import",
  aiPromptCopy: "Copy AI prompt",
  clearAll: "Clear all",
  unsupportedSchema: "Unsupported schema version",
  noNewReviews: "No new reviews found",
  importedReviews: (count) => `Imported ${count} review(s)`,
  jsonParseError: "Failed to parse JSON",
  noPendingReviews: "No pending reviews",
  aiPromptCopied: "AI prompt copied to clipboard",
  aiPromptTitle: "AI prompt",
  aiPromptHint: "Generated from the pending reviews. Edit if needed, then copy and hand to an AI.",
  confirmClearAll: (count) => `Delete all ${count} review(s)?`,
  copyTooltip: "Copy value",
  reviewTooltip: "Suggest a value · comment (or double-click)",
  cellActions: "Cell actions",
  suggest: "Suggest",
  suggestEdit: "Edit suggestion",
  comment: "Comment",
  copyLabel: "Copy",
  commentOnCategory: "Comment on category",
  commentOnSheet: "Comment on sheet",
  memo: "Note",
  outOfScope: "Out of review scope",
  outOfScopeOwner: "Owned by: ",
  hideOutOfScope: "Hide out-of-scope",
  columnsShown: "Columns shown",
  pivotAbsent: "this component has no such parameter",
  compareComponents: "Compare side by side",
  // "not set", not "unused": the product's default is in force on these rows.
  // What is absent is any statement from THIS project.
  showDefaults: (n: number) => `Show unset rows (${n} product defaults)`,
  originEmbedded: "hardcoded",
  originDefault: "not set",
  originDefaultTip: "Not set here — the value in effect is the product's own default",
  originEmbeddedTip: "Written straight into the file rather than through a variable: the same in every environment, and changed by editing that file",
  asInstalled: "As installed",
  originBaselineDisabled: "not present",
  sheetSourceLabel: "Source",
  applyToFiles: "Apply to files",
  applyPreviewTitle: "Preview changes",
  applyWriteN: (n) => `Write ${n} file(s)`,
  wroteFiles: (n) => `Wrote ${n} file(s)`,
  applyError: "Could not reach the server",
  applyEmpty: "No changes to apply",
  statusApplied: "applied",
  statusSkipped: "skipped",
  statusHeld: "held",
  statusOutOfScope: "out of scope",
  applyLoading: "Loading preview…",
  applyHeldTitle: "Remaining changes (hand to an AI)",
  applyHeldHint: "Changes that could not be applied deterministically. Edit if needed, copy, and hand to an AI.",
  applyNoFile: "(file unknown)",
  applyHeldPromptCopy: "Copy AI prompt",
  applySkippedGenerated: "Cannot apply directly: source file is generated",
  themeToggle: "Toggle theme",
  searchScopeAll: "including unset",
  searchScopeSet: "set rows only",
  searchScopeHint: "Ctrl/⌘+K to switch",
};

const messages: Record<Lang, Messages> = { ja, en };

export function getMessages(lang: Lang): Messages {
  return messages[lang];
}

export type { Messages };
