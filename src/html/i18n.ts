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
  notInThisFile: string;
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
  // The heading on a row's file sub-line. Shown only where one group holds
  // rows from more than one file (`layout: categories`), so a reader can see
  // the mixture instead of reading two files' settings as one file's.
  rowFile: string;
  // What a row whose value is PRESENCE shows in the value cell when the product
  // has no word of its own for it. Neutral on purpose: a dictionary must never
  // have to invent wording, and this tool's spelling of presence (`true`) is an
  // internal a reviewer has no reason to meet.
  present: string;
  presentWhen: string;
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
  aiPromptHintEdits: string;
  noEditsToApply: string;
  confirmClearAll: (count: number) => string;
  // Tooltips
  copyTooltip: string;
  reviewTooltip: string;
  cellActions: string;
  suggest: string;
  suggestEdit: string;
  // Editing a delivered document (`--allow edit`)
  editValue: string;
  editTooltip: string;
  editTitle: string;
  editOriginal: string;
  editHistory: string;
  editNewValue: string;
  editSave: string;
  editUnchanged: string;
  editedBadge: string;
  editAnonymous: string;
  editSharedNote: string;
  editSplitNote: string;
  editUndo: string;
  editConfirmUndo: string;
  docEdit: string;
  docEditShort: string;
  docRevert: string;
  docImagesNote: string;
  docTitleNote: string;
  docPasting: string;
  docNoSource: string;
  editMenu: (n: number) => string;
  restoredToast: (n: number) => string;
  saveDocument: string;
  saveTooltip: string;
  saveUnsaved: (n: number) => string;
  saveBy: string;
  saveComment: string;
  saveCommentPlaceholder: string;
  saveOptional: string;
  saveCount: (n: number) => string;
  saveInProgress: string;
  editLog: string;
  editLogWhen: string;
  editLogWho: string;
  editLogWhat: string;
  editLogChanges: (n: number) => string;
  saveNamePrompt: string;
  saveNoChanges: string;
  saveFailed: (message: string) => string;
  saveOverwrite: string;
  saveDownload: string;
  addRow: string;
  addRowTooltip: string;
  addRowTitle: string;
  addRowKey: string;
  addRowKeyRequired: string;
  addRowDuplicate: (key: string) => string;
  addRowSave: string;
  rowDelete: string;
  rowRestore: string;
  rowDeleteTooltip: string;
  rowRestoreTooltip: string;
  rowDeletedTip: string;
  originAdded: string;
  originAddedTip: string;
  orphanedRows: (n: number) => string;
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
  notInThisFile: "この環境のファイルにはない",
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
  rowFile: "ファイル",
  present: "あり",
  presentWhen: "この行がある条件",
  artifactRenderedFrom: "生成元",
  artifactSourceFile: "ソースファイル",
  artifactInstance: "環境",
  artifactKindAbsent: "この環境では出力されない（条件: {reason}）",
  artifactKindUnrendered: "この箇所は評価されていません（{reason}）— テンプレートの記述をそのまま表示",
  artifactKindDeployTime: "Ansible が配置時に埋める値（{reason}）— どの変数ファイルにも無く、欠落ではない",
  artifactUnrendered: "{n} 行は未評価です（該当行に印）",
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
  aiPromptHintEdits: "このシート上での変更を、設定ファイルに反映するためのプロンプトです。必要なら編集してコピーし、AIに渡してください。",
  noEditsToApply: "設定ファイルに反映する変更がありません",
  confirmClearAll: (count) => `全${count}件のレビューを削除しますか？`,
  copyTooltip: "値をコピー",
  reviewTooltip: "値を提案・コメント（ダブルクリックでも開く）",
  cellActions: "セル操作",
  suggest: "提案",
  suggestEdit: "提案を編集",
  editValue: "編集",
  editTooltip: "値を変更する（履歴に残ります）",
  editTitle: "値の変更",
  editOriginal: "元の値",
  editHistory: "変更履歴",
  editNewValue: "新しい値",
  editSave: "変更する",
  editUnchanged: "値が変わっていません",
  editedBadge: "元の値から変更されています",
  editAnonymous: "記入者未設定",
  editSharedNote: "この値は全環境で共有されています。変更はすべての環境に及びます。",
  editSplitNote: "この環境だけ変更すると、行が環境ごとに分かれます。変更しなかった環境は共通の定義のままです（この環境には対応する設定行がまだありません）。",
  editUndo: "この変更を取り消す",
  editConfirmUndo: "直近の変更を取り消しますか？（履歴からも消えます）",
  docEdit: "この文書を編集",
  docEditShort: "編集",
  docRevert: "元の内容に戻す",
  docImagesNote: "Markdown で編集します。画像はクリップボードから貼り付けると、その場で文書に埋め込まれます。",
  docTitleNote: "先頭の見出し（h1）はこのファイル自身のタイトルです。Markdown を単体で読む人のために残りますが、シートではこのページの見出しが使われるため本文には表示されません（見出しの文言は sheet.yml の label）。",
  docPasting: "画像を埋め込んでいます…",
  docNoSource: "この文書は Markdown の原文を持っていません（編集を有効にする前に生成されたものです）。編集するには生成し直してください。",
  editMenu: (n) => `変更 (${n})`,
  restoredToast: (n) => `前回このブラウザで作業した、保存されていない変更 ${n} 件を読み込みました`,
  saveDocument: "保存",
  saveTooltip: "編集を含めてこのHTMLを書き出す",
  saveUnsaved: (n) => `未保存の変更が ${n} 件あります。閉じると失われます。`,
  saveBy: "記入者",
  saveComment: "変更の理由",
  saveCommentPlaceholder: "例: 接続数の上限に達したため引き上げ（案件 #123）",
  saveOptional: "任意",
  saveCount: (n) => `未保存の変更 ${n} 件`,
  saveInProgress: "保存中…",
  editLog: "変更の記録",
  editLogWhen: "日時",
  editLogWho: "記入者",
  editLogWhat: "理由",
  editLogChanges: (n) => `${n} 件`,
  saveNamePrompt: "変更の記入者名（履歴に残ります。空欄でも保存できます）",
  saveNoChanges: "保存していない変更はありません",
  saveFailed: (message) => `保存できませんでした: ${message}`,
  saveOverwrite: "上書き保存",
  saveDownload: "別名で保存（ダウンロード）",
  addRow: "行を追加",
  addRowTooltip: "このカテゴリに行を追加する（設定ファイルには反映されません）",
  addRowTitle: "行の追加",
  addRowKey: "パラメータ名",
  addRowKeyRequired: "パラメータ名を入力してください",
  addRowDuplicate: (key) => `${key} はこのカテゴリに既にあります`,
  addRowSave: "追加する",
  rowDelete: "行を消す",
  rowRestore: "行を戻す",
  rowDeleteTooltip: "この行に取り消し線を引く（行は残り、いつでも戻せます）",
  rowRestoreTooltip: "取り消し線を外して元に戻す",
  rowDeletedTip: "この設定はもう使われていないとされた行です。記録として残しています。",
  originAdded: "追加",
  originAddedTip: "この文書で追加された行です。設定ファイルには対応する記述がありません。",
  orphanedRows: (n) => `追加した行 ${n} 件の置き場所（カテゴリ）が、この版には存在しません。表示されていません。`,
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
  notInThisFile: "Not in this file",
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
  rowFile: "File",
  present: "present",
  presentWhen: "in the file when",
  artifactRenderedFrom: "Rendered from",
  artifactSourceFile: "Source file",
  artifactInstance: "Instance",
  artifactKindAbsent: "not rendered for this instance (condition: {reason})",
  artifactKindUnrendered: "not evaluated here ({reason}) — the template text is shown as written",
  artifactKindDeployTime: "filled in by Ansible when it writes the file ({reason}) — in no vars file, and not a gap",
  artifactUnrendered: "{n} line(s) not evaluated — marked in place",
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
  aiPromptHintEdits: "For putting the changes made in this sheet into the config files. Edit if needed, then copy and hand to an AI.",
  noEditsToApply: "No changes to put into the config files",
  confirmClearAll: (count) => `Delete all ${count} review(s)?`,
  copyTooltip: "Copy value",
  reviewTooltip: "Suggest a value · comment (or double-click)",
  cellActions: "Cell actions",
  suggest: "Suggest",
  suggestEdit: "Edit suggestion",
  editValue: "Edit",
  editTooltip: "Change this value (kept in the history)",
  editTitle: "Change value",
  editOriginal: "Original",
  editHistory: "History",
  editNewValue: "New value",
  editSave: "Change",
  editUnchanged: "The value has not changed",
  editedBadge: "Changed from the original",
  editAnonymous: "no name recorded",
  editSharedNote: "This value is shared by every environment; changing it changes all of them.",
  editSplitNote: "Changing only this environment splits the row: the others keep the shared definition, and this one has no config line behind it yet.",
  editUndo: "Undo this change",
  editConfirmUndo: "Undo the most recent change? It is removed from the history too.",
  docEdit: "Edit this document",
  docEditShort: "Edit",
  docRevert: "Restore the original",
  docImagesNote: "Edited as markdown. Paste an image from the clipboard and it is embedded into the document where the cursor is.",
  docTitleNote: "The leading h1 is this FILE's own title. It stays for anyone reading the markdown on its own, and is not shown in the body here — the sheet's heading names the page (its wording comes from sheet.yml's label).",
  docPasting: "Embedding the image…",
  docNoSource: "This document carries no markdown source (it was built before editing was enabled). Regenerate it to edit.",
  editMenu: (n) => `Changes (${n})`,
  restoredToast: (n) => `Loaded ${n} unsaved change${n === 1 ? "" : "s"} from a previous session in this browser`,
  saveDocument: "Save",
  saveTooltip: "Write this HTML back out, edits included",
  saveUnsaved: (n) => `${n} unsaved change${n === 1 ? "" : "s"}. Closing now loses them.`,
  saveBy: "Your name",
  saveComment: "Why",
  saveCommentPlaceholder: "e.g. raised after hitting the connection limit (ticket #123)",
  saveOptional: "optional",
  saveCount: (n) => `${n} unsaved change${n === 1 ? "" : "s"}`,
  saveInProgress: "Saving…",
  editLog: "Change log",
  editLogWhen: "When",
  editLogWho: "By",
  editLogWhat: "Why",
  editLogChanges: (n) => `${n}`,
  saveNamePrompt: "Your name, for the history (you can leave this blank)",
  saveNoChanges: "Nothing to save",
  saveFailed: (message) => `Could not save: ${message}`,
  saveOverwrite: "Save over this file",
  saveDownload: "Save a copy (download)",
  addRow: "Add row",
  addRowTooltip: "Add a row to this category (nothing is written to the config files)",
  addRowTitle: "Add a row",
  addRowKey: "Parameter name",
  addRowKeyRequired: "Enter a parameter name",
  addRowDuplicate: (key) => `${key} is already in this category`,
  addRowSave: "Add",
  rowDelete: "Strike out",
  rowRestore: "Restore",
  rowDeleteTooltip: "Strike this row through (it stays, and can be restored)",
  rowRestoreTooltip: "Remove the strike-through and restore the row",
  rowDeletedTip: "Marked as no longer set. Kept on the sheet as a record.",
  originAdded: "Added",
  originAddedTip: "Written in this document. No config file has a line for it.",
  orphanedRows: (n) => `${n} added row${n === 1 ? " has" : "s have"} no category in this version and ${n === 1 ? "is" : "are"} not shown.`,
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
