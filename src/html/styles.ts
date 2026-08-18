// Fully custom CSS — no Pico CSS
// Design concept: technical document style, readability first

export const customStyles = `
/* ============================================================
   Font, reset & base
   ============================================================ */

@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

:root {
  --rs-font: 'Noto Sans JP', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --rs-mono: 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace;

  --rs-bg: #fafbfc;
  --rs-surface: #ffffff;
  --rs-subtle: #f8fafc;
  --rs-text: #1f2937;
  --rs-text-secondary: #4b5563;
  --rs-text-muted: #565f6b;
  --rs-border: #d1d5db;
  --rs-border-light: #e5e7eb;

  --rs-primary: #2563eb;
  --rs-primary-light: #dbeafe;
  --rs-primary-dark: #1d4ed8;

  --rs-accent: #f59e0b;
  --rs-accent-light: #fef3c7;
  --rs-accent-border: #fbbf24;

  /* Height of the sticky tab bar; measured and overwritten by JS at runtime so
     document-flow sticky table headers can stick just below it. */
  --rs-tabbar-h: 41px;
  /* The tab bar's own side gutter. Narrower than the content's (--rs-main's
     1.5rem) on purpose: the bar holds controls, not prose, and its two rows of
     tabs are the one strip in the document that actually runs out of width. The
     row that bleeds over it (see .rs-subtabs) does its arithmetic off this
     variable, so the two can never drift apart. */
  --rs-tabbar-x: 0.75rem;
  /* Uniform height of each sticky section header, used to stack nested headers
     and the table header at cumulative top offsets. */
  --rs-cat-h: 2.5rem;
  /* Width of the outline panel; reused as the content's left margin when open so
     the panel pushes the content instead of covering it. */
  --rs-outline-w: 16rem;

  --rs-success: #047857;
  --rs-success-bg: #ecfdf5;
  --rs-danger: #dc2626;
  --rs-danger-bg: #fef2f2;

  --rs-changed-bg: #fef3c7;
  --rs-changed-border: #d97706;

  /* Marks a common/inherited value (not a per-environment override) — a calm
     slate left-border layered on the value cell. */
  --rs-inherited-border: #94a3b8;

  --rs-header-bg: #1e293b;
  --rs-header-text: #f1f5f9;

  --rs-radius: 6px;
  --rs-radius-lg: 10px;
  --rs-shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --rs-shadow: 0 1px 3px rgba(0,0,0,0.1), 0 1px 2px rgba(0,0,0,0.06);
  --rs-shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05);
}

/* Dark theme — slate-based, not inverted; contrast verified (text ≥ 4.5:1). */
[data-theme="dark"] {
  --rs-bg: #0f172a;
  --rs-surface: #1e293b;
  --rs-subtle: #273449;
  --rs-text: #e2e8f0;
  --rs-text-secondary: #cbd5e1;
  --rs-text-muted: #94a3b8;
  --rs-border: #475569;
  --rs-border-light: #334155;
  --rs-primary: #60a5fa;
  --rs-primary-light: #1e3a5f;
  --rs-primary-dark: #93c5fd;
  --rs-accent: #fbbf24;
  --rs-accent-light: #3a2f17;
  --rs-accent-border: #b45309;
  --rs-success: #34d399;
  --rs-success-bg: #06281f;
  --rs-danger: #f87171;
  --rs-danger-bg: #2a1414;
  --rs-changed-bg: #3a2f17;
  --rs-changed-border: #fbbf24;
  --rs-inherited-border: #64748b;
  --rs-header-bg: #0f172a;
  --rs-header-text: #e2e8f0;
}

/* System dark preference fallback — same values, activated before JS runs. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --rs-bg: #0f172a;
    --rs-surface: #1e293b;
    --rs-subtle: #273449;
    --rs-text: #e2e8f0;
    --rs-text-secondary: #cbd5e1;
    --rs-text-muted: #94a3b8;
    --rs-border: #475569;
    --rs-border-light: #334155;
    --rs-primary: #60a5fa;
    --rs-primary-light: #1e3a5f;
    --rs-primary-dark: #93c5fd;
    --rs-accent: #fbbf24;
    --rs-accent-light: #3a2f17;
    --rs-accent-border: #b45309;
    --rs-success: #34d399;
    --rs-success-bg: #06281f;
    --rs-danger: #f87171;
    --rs-danger-bg: #2a1414;
    --rs-changed-bg: #3a2f17;
    --rs-changed-border: #fbbf24;
    --rs-inherited-border: #64748b;
    --rs-header-bg: #0f172a;
    --rs-header-text: #e2e8f0;
  }
}

/* ============================================================
   Dark mode overrides for remaining hardcoded light colors
   ============================================================ */

/* Category headers with hardcoded light grays */
[data-theme="dark"] .rs-category-header h3 {
  background: var(--rs-subtle);
  color: var(--rs-text);
}
[data-theme="dark"] .rs-category-header h4 {
  background: var(--rs-subtle);
  color: var(--rs-text-secondary);
}

/* Category tag (#e0e7ff / #3730a3) */
[data-theme="dark"] .rs-cat-tag {
  background: #1e3a5f;
  color: #93c5fd;
}

/* Toolbar danger hover (#fee2e2 / #fecaca) */
[data-theme="dark"] .rs-toolbar-btn-danger:hover {
  background: #2a1414;
  color: var(--rs-danger);
  border-color: #7f1d1d;
}

/* Transposed table attr row (#fbfcfe) */
[data-theme="dark"] .rs-param-table-transposed .rs-attr-row td,
[data-theme="dark"] .rs-param-table-transposed .rs-attr-row .rs-row-label {
  background: var(--rs-surface);
}

/* Freeze boundary gap line (white gap between the two blue lines) */
[data-theme="dark"] .rs-param-table-wide.rs-freeze-1 .rs-col-key,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-2 .rs-col-description,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-3 .rs-col-default {
  box-shadow:
    1px 0 0 0 var(--rs-primary),
    2px 0 0 0 var(--rs-surface),
    3px 0 0 0 var(--rs-primary),
    5px 0 8px -3px rgba(0, 0, 0, 0.5);
}

/* Frozen column tints (#f3f7fd / #e9f0fb) */
[data-theme="dark"] .rs-param-table-wide.rs-freeze-1 tbody .rs-col-key,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-2 tbody .rs-col-key,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-2 tbody .rs-col-description,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-3 tbody .rs-col-key,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-3 tbody .rs-col-description,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-3 tbody .rs-col-default {
  background: var(--rs-subtle);
}
[data-theme="dark"] .rs-param-table-wide.rs-freeze-1 thead .rs-col-key,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-2 thead .rs-col-key,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-2 thead .rs-col-description,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-3 thead .rs-col-key,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-3 thead .rs-col-description,
[data-theme="dark"] .rs-param-table-wide.rs-freeze-3 thead .rs-col-default {
  background: var(--rs-subtle);
}

/* Suggested value chip (#fef2f2 / #fecaca) */
[data-theme="dark"] .rs-suggested {
  background: var(--rs-danger-bg);
  border-color: #7f1d1d;
  color: var(--rs-danger);
}

/* Inline comment divider (#fde68a) */
[data-theme="dark"] .rs-inline-comment:not(:last-child) {
  border-bottom-color: #713f12;
}

/* Modal/outline head (#f8fafc → var(--rs-subtle)) */
[data-theme="dark"] .rs-modal header {
  background: var(--rs-subtle);
}
[data-theme="dark"] .rs-target-info {
  background: var(--rs-subtle);
}
[data-theme="dark"] .rs-target-info code {
  background: #334155;
}

/* Keyboard shortcut (#f1f5f9) */
[data-theme="dark"] .rs-modal-shortcuts kbd {
  background: var(--rs-subtle);
}

/* Danger button (#fee2e2 / #fecaca) */
[data-theme="dark"] .rs-btn-danger {
  background: var(--rs-danger-bg);
  border-color: #7f1d1d;
  color: var(--rs-danger);
}
[data-theme="dark"] .rs-btn-danger:hover {
  background: #3d1818;
}

/* Cancel button hover (#f8fafc) — base bg is already var(--rs-surface) */
[data-theme="dark"] .rs-btn-cancel:hover {
  background: var(--rs-subtle);
}

/* Overview item (#f8fafc) */
[data-theme="dark"] .rs-overview-item {
  background: var(--rs-subtle);
}

/* Version bar (#eef2f7) */
[data-theme="dark"] .rs-version-bar {
  background: var(--rs-subtle);
}

/* Diff badges (greens / reds) */
[data-theme="dark"] .rs-diff-badge-added { background: #059669; }
[data-theme="dark"] .rs-diff-badge-removed { background: #dc2626; }

/* Diff row inset shadows */
[data-theme="dark"] .rs-param-table .rs-diff-row-added .rs-col-key { box-shadow: inset 3px 0 0 0 #34d399; }
[data-theme="dark"] .rs-param-table .rs-diff-row-removed .rs-col-key { box-shadow: inset 3px 0 0 0 #f87171; }

/* Per-instance diff cells (#ecfdf5 / #6ee7b7, #fef2f2 / #fca5a5) */
[data-theme="dark"] .rs-param-table td.rs-diff-cell-added {
  background: #06281f !important;
  border-left-color: #065f46 !important;
}
[data-theme="dark"] .rs-param-table td.rs-diff-cell-removed {
  background: #2a1414 !important;
  border-left-color: #7f1d1d !important;
}

/* Absent cell stripe (#f8fafc / #eef2f7 → subtle/surface) */
[data-theme="dark"] .rs-param-table td.rs-diff-cell-absent {
  background: repeating-linear-gradient(45deg, var(--rs-surface), var(--rs-surface) 6px, var(--rs-subtle) 6px, var(--rs-subtle) 12px) !important;
}

/* Out-of-scope (#f8fafc / #f1f5f9 / #cbd5e1 / #64748b) */
[data-theme="dark"] .rs-out-of-scope {
  background: var(--rs-surface);
  border-left-color: #64748b;
}
/* Keep the diagonal "excluded" hatch in dark (a flat tint was indistinguishable
   from the surface). Covers both category-level and param-level out-of-scope. */
[data-theme="dark"] .rs-out-of-scope td,
[data-theme="dark"] .rs-row-excluded td,
[data-theme="dark"] .rs-out-of-scope .rs-changed,
[data-theme="dark"] .rs-row-excluded .rs-changed,
[data-theme="dark"] .rs-row-excluded.rs-changed {
  background: repeating-linear-gradient(45deg, var(--rs-surface), var(--rs-surface) 7px, #2e3c54 7px, #2e3c54 14px) !important;
  border-left-color: var(--rs-border) !important;
}

/* Out-of-scope badge (#e2e8f0 / #334155 / #cbd5e1) */
[data-theme="dark"] .rs-oos-badge {
  background: #334155;
  color: #cbd5e1;
  border-color: #475569;
}

/* Apply panel header (#f8fafc) */
[data-theme="dark"] .rs-apply-summary {
  background: var(--rs-subtle);
}
[data-theme="dark"] .rs-apply-footer {
  background: var(--rs-subtle);
}

/* Apply chips (#a7f3d0 border, #f3f4f6 bg) */
[data-theme="dark"] .rs-apply-chip-applied {
  border-color: #065f46;
}
[data-theme="dark"] .rs-apply-chip-skipped,
[data-theme="dark"] .rs-apply-chip-oos {
  background: var(--rs-subtle);
}

/* Apply chip held (#92400e text) */
[data-theme="dark"] .rs-apply-chip-held {
  color: #fbbf24;
}

/* Applied textarea (#f8fafc) */
[data-theme="dark"] .rs-apply-held-text {
  background: var(--rs-subtle);
  color: var(--rs-text);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .rs-category-header h3 { background: var(--rs-subtle); color: var(--rs-text); }
  :root:not([data-theme="light"]) .rs-category-header h4 { background: var(--rs-subtle); color: var(--rs-text-secondary); }
  :root:not([data-theme="light"]) .rs-cat-tag { background: #1e3a5f; color: #93c5fd; }
  :root:not([data-theme="light"]) .rs-toolbar-btn-danger:hover { background: #2a1414; color: var(--rs-danger); border-color: #7f1d1d; }
  :root:not([data-theme="light"]) .rs-param-table-transposed .rs-attr-row td,
  :root:not([data-theme="light"]) .rs-param-table-transposed .rs-attr-row .rs-row-label { background: var(--rs-surface); }
  :root:not([data-theme="light"]) .rs-suggested { background: var(--rs-danger-bg); border-color: #7f1d1d; color: var(--rs-danger); }
  :root:not([data-theme="light"]) .rs-inline-comment:not(:last-child) { border-bottom-color: #713f12; }
  :root:not([data-theme="light"]) .rs-modal header { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-target-info { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-target-info code { background: #334155; }
  :root:not([data-theme="light"]) .rs-modal-shortcuts kbd { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-btn-danger { background: var(--rs-danger-bg); border-color: #7f1d1d; color: var(--rs-danger); }
  :root:not([data-theme="light"]) .rs-btn-danger:hover { background: #3d1818; }
  :root:not([data-theme="light"]) .rs-btn-cancel:hover { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-overview-item { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-version-bar { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-diff-badge-added { background: #059669; }
  :root:not([data-theme="light"]) .rs-diff-badge-removed { background: #dc2626; }
  :root:not([data-theme="light"]) .rs-param-table .rs-diff-row-added .rs-col-key { box-shadow: inset 3px 0 0 0 #34d399; }
  :root:not([data-theme="light"]) .rs-param-table .rs-diff-row-removed .rs-col-key { box-shadow: inset 3px 0 0 0 #f87171; }
  :root:not([data-theme="light"]) .rs-param-table td.rs-diff-cell-added { background: #06281f !important; border-left-color: #065f46 !important; }
  :root:not([data-theme="light"]) .rs-param-table td.rs-diff-cell-removed { background: #2a1414 !important; border-left-color: #7f1d1d !important; }
  :root:not([data-theme="light"]) .rs-param-table td.rs-diff-cell-absent { background: repeating-linear-gradient(45deg, var(--rs-surface), var(--rs-surface) 6px, var(--rs-subtle) 6px, var(--rs-subtle) 12px) !important; }
  :root:not([data-theme="light"]) .rs-out-of-scope { background: var(--rs-surface); border-left-color: #64748b; }
  :root:not([data-theme="light"]) .rs-out-of-scope td,
  :root:not([data-theme="light"]) .rs-row-excluded td,
  :root:not([data-theme="light"]) .rs-out-of-scope .rs-changed,
  :root:not([data-theme="light"]) .rs-row-excluded .rs-changed,
  :root:not([data-theme="light"]) .rs-row-excluded.rs-changed { background: repeating-linear-gradient(45deg, var(--rs-surface), var(--rs-surface) 7px, #2e3c54 7px, #2e3c54 14px) !important; border-left-color: var(--rs-border) !important; }
  :root:not([data-theme="light"]) .rs-oos-badge { background: #334155; color: #cbd5e1; border-color: #475569; }
  :root:not([data-theme="light"]) .rs-apply-summary { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-apply-footer { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-apply-chip-applied { border-color: #065f46; }
  :root:not([data-theme="light"]) .rs-apply-chip-skipped,
  :root:not([data-theme="light"]) .rs-apply-chip-oos { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-apply-chip-held { color: #fbbf24; }
  :root:not([data-theme="light"]) .rs-apply-held-text { background: var(--rs-subtle); color: var(--rs-text); }
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-1 tbody .rs-col-key,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-2 tbody .rs-col-key,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-2 tbody .rs-col-description,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-3 tbody .rs-col-key,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-3 tbody .rs-col-description,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-3 tbody .rs-col-default { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-1 thead .rs-col-key,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-2 thead .rs-col-key,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-2 thead .rs-col-description,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-3 thead .rs-col-key,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-3 thead .rs-col-description,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-3 thead .rs-col-default { background: var(--rs-subtle); }
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-1 .rs-col-key,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-2 .rs-col-description,
  :root:not([data-theme="light"]) .rs-param-table-wide.rs-freeze-3 .rs-col-default {
    box-shadow:
      1px 0 0 0 var(--rs-primary),
      2px 0 0 0 var(--rs-surface),
      3px 0 0 0 var(--rs-primary),
      5px 0 8px -3px rgba(0, 0, 0, 0.5);
  }
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

html {
  font-size: 16px;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Disable swipe-to-navigate (back/forward) page-wide. A horizontal trackpad
   swipe over a non-scrolling area — e.g. the fixed cell hover toolbar — would
   otherwise reach the browser's navigation gesture. Must be on the viewport
   scroller (html) with none; the per-table containers also contain their own. */
html {
  overscroll-behavior-x: none;
}

body {
  font-family: var(--rs-font);
  color: var(--rs-text);
  background: var(--rs-bg);
  line-height: 1.6;
  overscroll-behavior-x: none;
}

code {
  font-family: var(--rs-mono);
  font-size: 0.875em;
  background: transparent;
  padding: 0;
  color: inherit;
}

/* ============================================================
   Layout
   ============================================================ */

.rs-app {
  min-height: 100vh;
}

.rs-main {
  max-width: 100%;
  /* Aligned with the tab bar's own 1.5rem rather than set by eye: the content's
     left edge and the tab above it are the same line, which is what keeps a
     narrow margin from reading as a mistake. Zero was tried and is worse to
     read than the width it buys is worth — a table running into the window edge
     gives the eye nothing to return to on the next line, and the cells' own
     0.75rem is padding inside a box, not a margin around the page. */
  padding: 2rem 1.5rem;
}

.rs-main h1 {
  font-size: 1.375rem;
  font-weight: 700;
  color: var(--rs-text);
  margin-bottom: 0.375rem;
  letter-spacing: -0.01em;
}

.rs-meta {
  font-size: 0.8rem;
  color: var(--rs-text-secondary);
  margin: 0.125rem 0;
  line-height: 1.5;
}

.rs-meta strong {
  color: var(--rs-text-secondary);
  font-weight: 600;
}

.rs-meta-extra {
  margin-bottom: 1.25rem;
}

/* ============================================================
   Scrollbars
   ============================================================ */

/* Windows draws a permanent, full-width scrollbar inside any scrolling box;
   macOS overlays a thin one that fades out. So a container that looks clean on
   a Mac — the tab strip's second row, a toolbar menu — comes out on Windows
   with a grey trough across it, and in the second row's case the trough is part
   of the sticky bar's measured height.
   Both engines are styleable, and neither is styled by default: Firefox takes
   scrollbar-width/-color, Chromium and WebKit take ::-webkit-scrollbar. Same
   thin, transparent-track treatment through both so the two platforms agree. */
.rs-scroll-thin {
  scrollbar-width: thin;
  scrollbar-color: var(--rs-border) transparent;
}

.rs-scroll-thin::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.rs-scroll-thin::-webkit-scrollbar-track {
  background: transparent;
}

.rs-scroll-thin::-webkit-scrollbar-thumb {
  background: var(--rs-border);
  border-radius: 4px;
}

.rs-scroll-thin::-webkit-scrollbar-thumb:hover {
  background: var(--rs-text-muted);
}

/* Chromium draws a corner square where two bars meet; transparent keeps it from
   reading as a broken cell. */
.rs-scroll-thin::-webkit-scrollbar-corner {
  background: transparent;
}

/* The horizontally-scrolling tables get the same treatment without the class:
   they are created by a measurement (rs-overflowing / rs-split-body), not by
   markup this file controls. */
.rs-table-wrapper.rs-overflowing::-webkit-scrollbar,
.rs-table-wrapper.rs-split-body::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.rs-table-wrapper.rs-overflowing::-webkit-scrollbar-track,
.rs-table-wrapper.rs-split-body::-webkit-scrollbar-track {
  background: transparent;
}

.rs-table-wrapper.rs-overflowing::-webkit-scrollbar-thumb,
.rs-table-wrapper.rs-split-body::-webkit-scrollbar-thumb {
  background: var(--rs-border);
  border-radius: 4px;
}

/* ============================================================
   Sheet tabs
   ============================================================ */

.rs-sheet-tabs {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  background: var(--rs-surface);
  border-bottom: 1px solid var(--rs-border);
  padding: 0 var(--rs-tabbar-x);
  box-shadow: var(--rs-shadow-sm);
}

/* Navigation controls (outline + search) pinned at the far left, next to where
   the outline panel slides in — so the control and its target are co-located. */
.rs-tabs-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding-right: 0.6rem;
  margin-right: 0.5rem;
  border-right: 1px solid var(--rs-border);
}

/* Grouped header: groups on the first line, the active group's sheets on a
   second. Done with flex-wrap and a full-width second row rather than a wrapper
   element, so the nav controls and the right-hand toolbar keep the exact
   positions they have in a flat document — the concern that decided this shape.
   The wrap is scoped to grouped documents: turning it on unconditionally would
   let the toolbar wrap at narrow widths in a flat one, which it never did. */
.rs-sheet-tabs-grouped {
  flex-wrap: wrap;
  padding-bottom: 0;
}

/* Second row. Its height must not change with the selected group — every sticky
   offset in the document is measured off this bar (--rs-tabbar-h), so a row that
   grows, shrinks or disappears drags every heading in the body with it. Hence
   one line always (nowrap), overflow scrolled rather than wrapped, and rendered
   even on the overview tab. */
.rs-subtabs {
  /* Full width, hence its own line. It is LAST in the DOM as well as visually
     (see SheetSubTabs) — placed before the toolbar it wrapped the toolbar onto
     a third line, and a CSS order property would have fixed the picture while
     leaving keyboard focus travelling through the sheets before the toolbar
     drawn above them. */
  /* Full-bleed, and the arithmetic has to be exact: with box-sizing: border-box
     a flex-basis of 100% is the BORDER box, so the negative margins that pull
     the row out over the bar's own padding also shorten it — the background and
     the top rule stopped two gutters short of the right edge. The basis has to
     carry both gutters for the outer box to come back to exactly the bar's
     width. */
  flex-basis: calc(100% + var(--rs-tabbar-x) * 2);
  display: flex;
  gap: 2px;
  align-items: center;
  flex-wrap: nowrap;
  /* auto, never scroll: a group whose sheets fit — most of them — gets no
     trough at all. On Windows that is the difference between a clean strip and
     a grey band across the header, since its scrollbar takes real space rather
     than overlaying. */
  overflow-x: auto;
  margin: 0 calc(-1 * var(--rs-tabbar-x));
  padding: 0.3rem var(--rs-tabbar-x);
  background: var(--rs-bg);
  border-top: 1px solid var(--rs-border);
}

.rs-subtab {
  padding: 0.25rem 0.75rem;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--rs-text-secondary);
  cursor: pointer;
  font-family: var(--rs-font);
  font-size: 0.78rem;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.rs-subtab:hover {
  color: var(--rs-primary);
}

.rs-subtab-active {
  background: var(--rs-surface);
  border-color: var(--rs-border);
  color: var(--rs-primary);
  font-weight: 600;
}

/* Outline: one heading per sheet group, matching the header's first row so the
   two navigations name the same things in the same order. */
.rs-outline-group {
  margin-bottom: 0.5rem;
}

.rs-outline-groupname {
  padding: 0.6rem 0.75rem 0.25rem;
  /* The group contains the sheets under it, so it is the largest thing in this
     panel — it was the smallest, an 0.7rem uppercase eyebrow, which put the
     ranking exactly upside down. No uppercase either: it does nothing to
     Japanese and shouts in English, which is not what a heading here is for. */
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--rs-text);
}

.rs-tabs-left {
  display: flex;
  gap: 2px;
  overflow: hidden;
  flex: 1;
  min-width: 0;
}

/* Tabs that don't fit are kept in layout (so widths stay measurable) but hidden;
   they live in the overflow menu instead. */
.rs-tab-clipped {
  visibility: hidden;
}

.rs-tabs-of {
  position: relative;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.rs-tab-overflow {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 14rem;
  height: 100%;
  padding: 0 0.6rem;
  border: none;
  background: transparent;
  color: var(--rs-text-secondary);
  cursor: pointer;
  font-size: 0.8rem;
}

.rs-tab-overflow:hover {
  color: var(--rs-text);
}

.rs-tab-overflow.rs-tab-active {
  color: var(--rs-primary);
}

.rs-of-active {
  max-width: 11rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rs-of-backdrop {
  position: fixed;
  inset: 0;
  z-index: 95;
}

/* Narrow windows: this is a desktop tool for wide tables, so the goal is a
   graceful minimum rather than a mobile layout. Collapse order is tabs (their
   own overflow menu, already) -> button labels -> the progress chip. */
@media (max-width: 960px) {
  .rs-btn-label {
    display: none;
  }
}
/* Toolbar menus reuse the sheet-tab overflow menu's surface. */
.rs-toolbar-menu-wrap {
  position: relative;
  display: inline-flex;
}
.rs-toolbar-menu {
  min-width: 14rem;
  padding: 0.3rem 0;
}
.rs-menu-check,
.rs-menu-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.4rem 0.7rem;
  font-size: 0.82rem;
  color: var(--rs-text);
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
}
.rs-menu-check:hover,
.rs-menu-item:hover {
  background: var(--rs-subtle);
}
.rs-menu-check input {
  margin: 0;
  accent-color: var(--rs-primary);
}
.rs-menu-item-danger {
  color: var(--rs-danger);
}
/* A heading inside a toolbar menu: the environment list needs saying what it
   is, since a bare list of names beside three checkboxes reads as three more
   filters of the same kind. */
.rs-menu-section {
  padding: 0.3rem 0.75rem 0.15rem;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--rs-text-muted);
}

.rs-menu-divider {
  height: 1px;
  margin: 0.3rem 0;
  background: var(--rs-border);
}
/* Labelled toolbar buttons: text + optional icon, and one filled primary. */
.rs-toolbar-btn-labelled {
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  width: auto;
}
.rs-btn-caret {
  opacity: 0.6;
}
.rs-toolbar-btn-primary {
  gap: 0.35rem;
  padding: 0.3rem 0.7rem;
  width: auto;
  color: #fff;
  background: var(--rs-primary);
  border-color: var(--rs-primary);
}
.rs-toolbar-btn-primary:hover {
  filter: brightness(1.08);
  color: #fff;
  background: var(--rs-primary);
}

.rs-of-menu {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 96;
  min-width: 13rem;
  max-height: 60vh;
  overflow: auto;
  padding: 0.25rem 0;
  background: var(--rs-surface);
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  box-shadow: var(--rs-shadow-lg);
}

.rs-of-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 0.4rem 0.85rem;
  cursor: pointer;
  white-space: nowrap;
  color: var(--rs-text);
  font-size: 0.8rem;
}

.rs-of-item:hover {
  background: var(--rs-primary-light);
  color: var(--rs-primary);
}

.rs-of-current {
  color: var(--rs-primary);
  font-weight: 600;
}

.rs-tabs-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding-left: 1rem;
}

.rs-tabs-sep {
  width: 1px;
  height: 1.25rem;
  background: var(--rs-border);
  margin: 0 2px;
}

.rs-tab {
  padding: 0.625rem 1.25rem;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--rs-text-secondary);
  cursor: pointer;
  font-family: var(--rs-font);
  font-size: 0.8rem;
  font-weight: 500;
  white-space: nowrap;
  transition: all 0.2s ease;
  margin: 0;
}

.rs-tab:hover {
  color: var(--rs-primary);
  background: var(--rs-primary-light);
}

.rs-tab-active {
  color: var(--rs-primary);
  border-bottom-color: var(--rs-primary);
  font-weight: 600;
}

/* Toolbar buttons in tab bar */
.rs-toolbar-btn {
  background: none;
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  cursor: pointer;
  color: var(--rs-text-secondary);
  padding: 0.3rem 0.45rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--rs-font);
  font-size: 0.7rem;
  font-weight: 600;
  line-height: 1;
  transition: all 0.15s;
}

.rs-toolbar-btn:hover {
  background: var(--rs-primary-light);
  color: var(--rs-primary);
  border-color: var(--rs-primary);
}

.rs-toolbar-btn-active {
  background: var(--rs-primary-light);
  color: var(--rs-primary);
  border-color: var(--rs-primary);
}

.rs-toolbar-btn-danger {
  color: var(--rs-text-muted);
}

.rs-toolbar-btn-danger:hover {
  background: #fee2e2;
  color: var(--rs-danger);
  border-color: #fecaca;
}

.rs-lang-switch {
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  min-width: 2rem;
  text-align: center;
}

/* ============================================================
   Sheet & category
   ============================================================ */

.rs-sheet {
  margin-bottom: 2.5rem;
}

.rs-sheet-header {
  /* A containing block for the jump flash's overlay (see rs-flash-overlay).
     Declared here rather than switched on during the animation: a position
     that appears for 1.6s and disappears is a layout change in the middle of
     the very moment the reader is looking. */
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  margin-bottom: 0.375rem;
  padding-bottom: 0.5rem;
  border-bottom: 2px solid var(--rs-text);
}

.rs-sheet-header h2 {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--rs-text);
  letter-spacing: -0.01em;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.rs-file-path {
  font-size: 0.775rem;
  color: var(--rs-text-muted);
  margin: 0.25rem 0 1rem;
}

.rs-file-path code {
  color: var(--rs-text-secondary);
}

.rs-category {
  /* Same as .rs-sheet-header: a containing block for the flash overlay, for the
     case the flash lands on the category box itself. */
  position: relative;
  margin-bottom: 0.375rem;
}

.rs-category-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1.5rem 0 0.375rem;
  /* Stacked sticky section header: each nesting level (--rs-depth) sticks below
     the tab bar plus the shallower levels, and releases when its category ends. */
  position: sticky;
  top: calc(var(--rs-tabbar-h, 41px) + (var(--rs-depth, 1) - 1) * var(--rs-cat-h));
  z-index: calc(60 - var(--rs-depth, 1));
  height: var(--rs-cat-h);
  background: var(--rs-bg);
  overflow: hidden;
}

.rs-category-header > * {
  min-width: 0;
}

.rs-category-header .rs-cat-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rs-category-header h3,
.rs-category-header h4,
.rs-category-header h5 {
  margin: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.rs-category-header h3 {
  font-size: 0.95rem;
  font-weight: 600;
  padding: 0.5rem 0.875rem;
  background: #f1f5f9;
  color: #1e293b;
  border-left: 4px solid var(--rs-primary);
  border-radius: 0 var(--rs-radius) var(--rs-radius) 0;
}

.rs-category-header h4 {
  font-size: 0.9rem;
  font-weight: 600;
  padding: 0.375rem 0.75rem;
  background: #f1f5f9;
  color: #334155;
  border-left: 3px solid var(--rs-primary);
  border-radius: 0 var(--rs-radius) var(--rs-radius) 0;
}

.rs-category-header h5 {
  font-size: 0.825rem;
  font-weight: 600;
  padding: 0.3rem 0.625rem;
  color: var(--rs-text-secondary);
  border-left: 2px solid var(--rs-border);
}

.rs-cat-tag {
  font-size: 0.7rem;
  font-weight: 600;
  font-family: var(--rs-mono);
  background: #e0e7ff;
  color: #3730a3;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  white-space: nowrap;
  flex-shrink: 0;
}

.rs-cat-filepath {
  font-size: 0.725rem;
  font-weight: 400;
  color: var(--rs-text-muted);
  font-family: var(--rs-mono);
}

/* Nesting is NOT indented. A parameter sheet is wide by nature — key, value,
   one column per environment, description, default, remarks — so every
   millimetre spent on indentation is taken from the content it is meant to
   organise, and at depth 3 that was 2.5rem gone before the table starts.
   Nothing is lost by dropping it: depth is already carried by the heading
   itself (h3/h4/h5 differ in size, weight, background and the width of their
   left rule) and by the stacked sticky headers, which show the whole path
   above the rows at all times. The classes stay — the viewer sets them
   alongside the --rs-depth custom property the sticky offsets are computed
   from. */
.rs-depth-2,
.rs-depth-3 {
  margin-left: 0;
}

/* ============================================================
   Parameter table
   ============================================================ */

.rs-table-wrapper {
  overflow: visible;
  margin-bottom: 0.25rem;
  border-radius: var(--rs-radius);
  border: 1px solid var(--rs-border);
  box-shadow: var(--rs-shadow-sm);
}

/* Tables wider than the viewport get an internal horizontal scrollbar (toggled
   by JS). Tables that fit stay in normal document flow so their header can stick
   to the page and release once the table has fully scrolled past. */
.rs-table-wrapper.rs-overflowing {
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--rs-border) transparent;
  /* Don't chain the horizontal scroll to the page once the table hits its edge,
     so a trackpad swipe past the end never triggers the browser back gesture. */
  overscroll-behavior-x: contain;
}

.rs-param-table {
  width: 100%;
  min-width: 680px;
  border-collapse: collapse;
  font-size: 0.9rem;
  margin: 0;
}

.rs-param-table th {
  font-size: 0.8rem;
  font-weight: 600;
  text-align: left;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.5rem 0.75rem;
  background: var(--rs-subtle);
  color: var(--rs-text-secondary);
  border-bottom: 2px solid var(--rs-border);
  white-space: nowrap;
}

.rs-param-table th:not(:last-child) {
  border-right: 1px solid var(--rs-border-light);
}

.rs-param-table td {
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--rs-border-light);
  vertical-align: top;
  /* Break only long unbreakable tokens (URLs, JDBC strings); keep prose words intact */
  overflow-wrap: anywhere;
  word-break: normal;
  white-space: pre-wrap;
  background: var(--rs-surface);
}

.rs-param-table td:not(:last-child) {
  border-right: 1px solid var(--rs-border-light);
}

.rs-param-table tbody tr:hover td {
  background: var(--rs-subtle);
}

.rs-col-key {
  white-space: nowrap;
  font-weight: 500;
}

.rs-col-key code {
  color: var(--rs-text);
  font-weight: 500;
}

.rs-col-default {
  color: var(--rs-text-secondary);
}

.rs-col-default code {
  color: var(--rs-text-secondary);
}

.rs-changed {
  background: var(--rs-changed-bg) !important;
  border-left: 3px solid var(--rs-changed-border) !important;
}

.rs-same-as-default code {
  color: var(--rs-text-muted);
}

/* Unset: the value equals the product default and this environment does not set
   it, so the default applies. No background (it is not a change); rendered "—". */
/* "Nothing is set here, so the product's default applies." An em dash would say
   "empty", which is not the same statement — and on a materialized sheet most
   rows are this, so the cell has to say what it means. Rendered as a tag, not as
   code: it is a label about the cell, not a value in it. */
/* The scope choice is not a label+field row, so it deliberately does not use
   .rs-form-row, whose block-level label rule would stack the radios and
   uppercase them. Hint on its own line, options side by side under it. */
.rs-scope-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 1rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.6rem;
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
}
.rs-scope-hint {
  flex-basis: 100%;
  font-size: 0.75rem;
  color: var(--rs-text-muted);
}
.rs-scope-opt {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.rs-scope-opt input {
  margin: 0;
  accent-color: var(--rs-primary);
}

/* What the product's own UI calls this value, beside the value and never in
   it. Muted and parenthesised so it reads as an annotation: the value is the
   reviewable fact, this is the vocabulary a reviewer met in the console. */
.rs-option-label {
  color: var(--rs-text-muted);
  font-size: 0.85em;
  white-space: nowrap;
}
.rs-option-label::before { content: "("; }
.rs-option-label::after { content: ")"; }

.rs-unset-label {
  display: inline-block;
  font-size: 0.7rem;
  letter-spacing: 0.02em;
  padding: 0.05rem 0.4rem;
  color: var(--rs-text-muted);
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border);
  border-radius: 4px;
}

/* Provenance sub-line under the key (e.g. the backing Ansible variable). Muted
   and smaller so the product key stays the primary identity; costs no column.
   .rs-value-cell is a flex row by default; stack the key cell vertically so the
   sub-line sits on its own line beneath the key. */
.rs-col-key .rs-value-cell {
  flex-direction: column;
  align-items: flex-start;
  gap: 0;
}



/* Side-by-side view */

/* At the right-hand end of a component's heading, past the badges: the reader
   asking whether these can be compared is looking at them, not at the sheet
   header. A margin-left of auto pushes it there without a spacer element. */
.rs-compare-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
  padding-left: 0.75rem;
  font-family: var(--rs-font);
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--rs-text-secondary);
  white-space: nowrap;
  cursor: pointer;
}

.rs-compare-toggle input {
  cursor: pointer;
}

.rs-compare-toggle:hover {
  color: var(--rs-primary);
}




.rs-pivot-vs {
  color: var(--rs-text-muted);
}



/* The row where the components disagree — the finding this view exists to
   surface, so it is marked rather than left to be spotted by eye. */
.rs-pivot-differs > .rs-col-key {
  box-shadow: inset 3px 0 0 var(--rs-warning, #f59e0b);
}

/* The side-by-side table scrolls INSIDE itself. Without a scroller of its own
   a table this wide overflows the page, so the whole document scrolls
   sideways — carrying the sheet header, the headings and the sticky bar with
   it. The stacked view gets this from a measurement in the viewer; here the
   table is always the widest thing on the page, so it is declared. */
.rs-pivot-scroll {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}


/* And the key column stays put while it scrolls: reading a value in the fourth
   component means nothing without the row it belongs to. */
.rs-pivot-table .rs-col-key {
  position: sticky;
  left: 0;
  z-index: 2;
  background: var(--rs-surface);
}

/* The frozen column's own header, in the split header table. */
.rs-pivot-table thead .rs-col-key {
  z-index: 3;
}

/* Both halves must agree on column widths, or the header sits over the wrong
   cells — and they cannot agree by filling their containers, because the header
   sits in a hidden box the width of the viewport while the body sits in a
   scroller as wide as its content. Given the same explicit geometry they come
   out identical at any window size: a fixed key column, a fixed width per
   component, and a total that only grows past the viewport when the components
   need it to. */
.rs-pivot-table {
  table-layout: fixed;
  width: max(100%, calc(22rem + var(--rs-pivot-cols, 2) * 16rem));
  min-width: 0;
}

.rs-pivot-table .rs-col-key {
  width: 22rem;
}

.rs-pivot-table .rs-col-value {
  width: 16rem;
}

/* The edge of the frozen column, so a value scrolled underneath it does not
   look like part of the key. Drawn as a pseudo-element because the table
   collapses its borders, and a collapsed border does not travel with the cell
   it was declared on once that cell is sticky. */
.rs-pivot-table .rs-col-key::after {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 1px;
  background: var(--rs-border);
}

/* A component that has no such parameter at all. Distinct from one that leaves
   it at the product default: that is a value, this is an absence. */
.rs-pivot-absent {
  color: var(--rs-text-muted);
  text-align: center;
}

/* The product default, printed under the value in the same column. Muted by
   default because on an unset row it appears on EVERY row and is reference
   material, not a finding. */
.rs-pivot-default {
  color: var(--rs-text-muted);
}

/* Unless the columns disagree about it, which is the one thing this table is
   read to find: the value held still and the ground under it moved. Marked on
   the default line itself rather than on the row, so it cannot be mistaken for
   a value that changed. */
.rs-pivot-default-differs {
  color: var(--rs-text);
  font-weight: 600;
  box-shadow: inset 2px 0 0 var(--rs-warning, #f59e0b);
  padding-left: 4px;
}

/* Block, not inline. These stack under a value — a row's provenance line, an
   origin marker, or one line per environment in the side-by-side view — and as
   spans they ran together on one line the moment a cell had more than one.
   The key cell hid that: its own contents happened to break anyway. */
.rs-key-subline {
  display: block;
  margin-top: 2px;
}

/* What this sub-line IS. The key and the backing variable are both bare
   identifiers in the same type at the same size, so without a heading the two
   lines under a row's name are indistinguishable — and they answer different
   questions: one is what the row is called, the other is where its value comes
   from. Quiet enough not to compete with the identifier it introduces. */
.rs-subline-head {
  margin-right: 0.35rem;
  font-family: var(--rs-font);
  font-size: 0.68rem;
  color: var(--rs-text-muted);
}
.rs-key-subline code {
  font-size: 0.8em;
  color: var(--rs-text-muted);
}
/* Common (Pattern A) value that differs from the default: layered on the yellow
   "changed" background (it IS non-default) with a left border + muted text to
   mark it as a common/inherited value, not a per-environment edit. */
.rs-cell-common {
  border-left: 3px solid var(--rs-inherited-border) !important;
}
.rs-cell-common code {
  color: var(--rs-text-muted);
}

/* ---- Transposed Pattern B table (rows = instances, columns = parameters) ---- */

/* Sticky first column keeps the instance / attribute labels visible while
   scrolling horizontally across many parameter columns. */
.rs-param-table .rs-row-label {
  position: sticky;
  left: 0;
  z-index: 1;
  background: var(--rs-subtle);
  vertical-align: top;
  text-align: left;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--rs-text-secondary);
  white-space: nowrap;
  padding: 0.5rem 0.75rem;
  border-right: 2px solid var(--rs-border);
  border-bottom: 1px solid var(--rs-border-light);
}

.rs-param-table-transposed thead .rs-corner {
  z-index: 4;
  border-bottom: 2px solid var(--rs-border);
}

/* The parameter key is a column header here: render it as a plain code
   identifier (no uppercase / letter-spacing). */
.rs-param-table-transposed th.rs-col-key {
  text-transform: none;
  letter-spacing: 0;
  white-space: normal;
  min-width: 12rem;
}

.rs-param-table-transposed th.rs-col-key code {
  font-weight: 600;
  color: var(--rs-text);
}

/* Per-parameter attribute rows: description, default, custom columns. */
.rs-param-table-transposed .rs-attr-row td,
.rs-param-table-transposed .rs-attr-row .rs-row-label {
  background: #fbfcfe;
}

.rs-param-table-transposed .rs-col-description {
  color: var(--rs-text-secondary);
  font-size: 0.85rem;
}

.rs-row-label-instance {
  text-transform: none;
}

.rs-row-label-instance code {
  color: var(--rs-text);
  font-weight: 600;
}

/* Give value columns a comfortable width so they don't collapse. */
.rs-param-table-transposed tbody td {
  min-width: 11rem;
}

/* ---- Pattern B view toggle (normal / transposed) ---- */
.rs-table-block {
  margin-bottom: 0.25rem;
}

.rs-table-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 0.4rem;
}

.rs-view-toggle {
  display: inline-flex;
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  overflow: hidden;
  background: var(--rs-surface);
}

.rs-view-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.6rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--rs-text-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
  line-height: 1;
}

.rs-view-btn + .rs-view-btn {
  border-left: 1px solid var(--rs-border);
}

.rs-view-btn:hover {
  background: var(--rs-primary-light);
  color: var(--rs-primary);
}

.rs-view-btn-active,
.rs-view-btn-active:hover {
  background: var(--rs-primary);
  color: #fff;
}

.rs-view-btn svg {
  flex-shrink: 0;
}

/* Instance/value columns keep a floor so auto layout cannot crush them. */
.rs-param-table-wide th,
.rs-param-table-wide td {
  min-width: 8rem;
}

/* Leading metadata columns are fixed-width so the freeze (sticky) offsets are
   exact. Widths are exposed as variables and reused for the cumulative offsets.
   Kept modest so ordinary tables fit the viewport (and stay in document flow,
   keeping their sticky header) instead of overflowing horizontally. */
.rs-param-table-wide {
  --rs-w-key: 16rem;
  --rs-w-desc: 24rem;
  --rs-w-default: 8rem;
  --rs-w-value: 10rem;
  --rs-w-check: 7rem;
}

/* Fill the wrapper (no trailing empty band at wide windows) and share the spare
   width so the value column (the review / apply target) gets the largest slice,
   not the description. Percentage widths in an auto-layout table distribute the
   spare width in proportion to these values, while the other columns stay sized
   to their content. Giving the value the biggest share keeps it wide and stops a
   long description from squeezing the value into its min-width. The percentages
   scale with the window, so a half-screen view just shrinks every column (no
   fixed floor added); below the table min-width the horizontal-scroll wrapper
   takes over. (Fixed/split tables keep their own width rules.) */
.rs-param-table-wide:not(.rs-param-table-fixed) .rs-col-key {
  width: 22%;
  max-width: none;
}

.rs-param-table-wide:not(.rs-param-table-fixed) .rs-col-description {
  width: 30%;
  max-width: none;
}

.rs-param-table-wide:not(.rs-param-table-fixed) .rs-col-value {
  width: 48%;
}

/* Content-based sizing by default (auto table layout): columns fit their data,
   with a floor (no collapsing) and a cap (no runaway). */
.rs-param-table-wide .rs-col-key {
  min-width: 9rem;
  max-width: 26rem;
}

/* Floors are ordered by importance: the value (the review/apply target) must
   stay readable, so it gets the highest min-width; the description is prose that
   wraps gracefully, so it yields first (lowest floor). When the window is too
   narrow for both, the description gives way and the value keeps a readable
   width — and below the table min-width the horizontal-scroll wrapper takes over
   (with the key column frozen, so context stays pinned) rather than squeezing
   the value into an unreadable ribbon. */
.rs-param-table-wide .rs-col-description {
  min-width: 9rem;
  max-width: 38rem;
}

.rs-param-table-wide .rs-col-default {
  min-width: 6rem;
  max-width: 16rem;
}

.rs-param-table-wide .rs-col-value {
  min-width: 15rem;
  max-width: 52rem;
}

/* Split (Pattern B) tables use a fixed layout, so the header overlay and body
   line up; there the columns need exact widths (from the --rs-w-* variables). */
.rs-param-table-fixed.rs-param-table-wide .rs-col-key {
  width: var(--rs-w-key);
  min-width: var(--rs-w-key);
  max-width: var(--rs-w-key);
}

.rs-param-table-fixed.rs-param-table-wide .rs-col-description {
  width: var(--rs-w-desc);
  min-width: var(--rs-w-desc);
  max-width: var(--rs-w-desc);
}

.rs-param-table-fixed.rs-param-table-wide .rs-col-default {
  width: var(--rs-w-default);
  min-width: var(--rs-w-default);
  max-width: var(--rs-w-default);
}

.rs-param-table-fixed.rs-param-table-wide .rs-col-value {
  width: var(--rs-w-value);
  min-width: var(--rs-w-value);
  max-width: var(--rs-w-value);
}


/* Opaque backgrounds so frozen (sticky) cells cover scrolled content. */
.rs-param-table-wide .rs-col-key,
.rs-param-table-wide .rs-col-description,
.rs-param-table-wide .rs-col-default {
  background: var(--rs-surface);
}

.rs-param-table-wide thead .rs-col-key,
.rs-param-table-wide thead .rs-col-description,
.rs-param-table-wide thead .rs-col-default {
  background: var(--rs-subtle);
}

.rs-param-table-wide tbody tr:hover .rs-col-key,
.rs-param-table-wide tbody tr:hover .rs-col-description,
.rs-param-table-wide tbody tr:hover .rs-col-default {
  background: var(--rs-subtle);
}

/* Freeze depth: rs-freeze-N pins the first N leading columns with cumulative
   left offsets so the reviewer chooses how much context stays in view. */
.rs-param-table-wide.rs-freeze-1 .rs-col-key,
.rs-param-table-wide.rs-freeze-2 .rs-col-key,
.rs-param-table-wide.rs-freeze-3 .rs-col-key,
.rs-param-table-wide.rs-freeze-2 .rs-col-description,
.rs-param-table-wide.rs-freeze-3 .rs-col-description,
.rs-param-table-wide.rs-freeze-3 .rs-col-default {
  position: sticky;
}

.rs-param-table-wide.rs-freeze-1 .rs-col-key,
.rs-param-table-wide.rs-freeze-2 .rs-col-key,
.rs-param-table-wide.rs-freeze-3 .rs-col-key {
  left: 0;
}

.rs-param-table-wide.rs-freeze-2 .rs-col-description,
.rs-param-table-wide.rs-freeze-3 .rs-col-description {
  left: var(--rs-w-key);
}

.rs-param-table-wide.rs-freeze-3 .rs-col-default {
  left: calc(var(--rs-w-key) + var(--rs-w-desc));
}

/* Frozen body cells sit below the sticky header row; z-index on a static cell is
   ignored, so leaving it on all leading body cells is harmless. */
.rs-param-table-wide tbody .rs-col-key,
.rs-param-table-wide tbody .rs-col-description,
.rs-param-table-wide tbody .rs-col-default {
  z-index: 1;
}

/* Frozen header cells sit above both the sticky header row and the frozen body
   column (the corner). Scoped to the frozen state only, so non-frozen leading
   headers do not paint over the frozen column while scrolling horizontally. */
.rs-param-table-wide.rs-freeze-1 thead .rs-col-key,
.rs-param-table-wide.rs-freeze-2 thead .rs-col-key,
.rs-param-table-wide.rs-freeze-3 thead .rs-col-key,
.rs-param-table-wide.rs-freeze-2 thead .rs-col-description,
.rs-param-table-wide.rs-freeze-3 thead .rs-col-description,
.rs-param-table-wide.rs-freeze-3 thead .rs-col-default {
  z-index: 5;
}

/* Frozen region tint: the pinned columns read as one grouped block, in the same
   accent family as the active pins. */
.rs-param-table-wide.rs-freeze-1 tbody .rs-col-key,
.rs-param-table-wide.rs-freeze-2 tbody .rs-col-key,
.rs-param-table-wide.rs-freeze-2 tbody .rs-col-description,
.rs-param-table-wide.rs-freeze-3 tbody .rs-col-key,
.rs-param-table-wide.rs-freeze-3 tbody .rs-col-description,
.rs-param-table-wide.rs-freeze-3 tbody .rs-col-default {
  background: #f3f7fd;
}

.rs-param-table-wide.rs-freeze-1 thead .rs-col-key,
.rs-param-table-wide.rs-freeze-2 thead .rs-col-key,
.rs-param-table-wide.rs-freeze-2 thead .rs-col-description,
.rs-param-table-wide.rs-freeze-3 thead .rs-col-key,
.rs-param-table-wide.rs-freeze-3 thead .rs-col-description,
.rs-param-table-wide.rs-freeze-3 thead .rs-col-default {
  background: #e9f0fb;
}

/* Freeze boundary: a crisp accent double line drawn with stacked box-shadows
   (blue | gap | blue) plus a soft drop shadow for depth. box-shadow is painted
   by the sticky cell itself, so the divider stays glued to the frozen column
   while the rest scrolls under it (a collapsed border would not). */
.rs-param-table-wide.rs-freeze-1 .rs-col-key,
.rs-param-table-wide.rs-freeze-2 .rs-col-description,
.rs-param-table-wide.rs-freeze-3 .rs-col-default {
  box-shadow:
    1px 0 0 0 var(--rs-primary),
    2px 0 0 0 #ffffff,
    3px 0 0 0 var(--rs-primary),
    5px 0 8px -3px rgba(15, 23, 42, 0.22);
}

/* Column-header pin control for choosing the freeze boundary. */
.rs-th-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
}

.rs-pin {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 2px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--rs-text-muted);
  opacity: 0.45;
  cursor: pointer;
}

.rs-pin:hover {
  opacity: 1;
  background: var(--rs-primary-light);
  color: var(--rs-primary);
}

.rs-pin-on {
  opacity: 1;
  color: var(--rs-primary);
}

/* ---- Split header for instance (Pattern B) tables ----
   The header lives in a sticky overlay above the scrolling body so it stays put
   during vertical scroll; JS syncs its horizontal offset to the body. Both
   halves use table-layout: fixed with identical widths so they line up. */
.rs-table-split {
  position: relative;
  margin-bottom: 0.25rem;
}

.rs-sticky-head {
  position: sticky;
  top: calc(var(--rs-tabbar-h, 41px) + var(--rs-depth, 0) * var(--rs-cat-h));
  z-index: 4;
  overflow: hidden;
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius) var(--rs-radius) 0 0;
}

.rs-sticky-head table {
  margin: 0;
}

.rs-table-wrapper.rs-split-body {
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--rs-border) transparent;
  /* Keep the horizontal scroll contained (no back-gesture chaining at the edge). */
  overscroll-behavior-x: contain;
  border-top: none;
  border-radius: 0 0 var(--rs-radius) var(--rs-radius);
  margin-bottom: 0;
}

/* Fixed layout so the overlay header and the body share exact column widths.
   Every column gets a width; the leading metadata columns override via their
   own (higher-specificity) rules above. */
.rs-param-table-fixed {
  table-layout: fixed;
  width: max-content;
  min-width: 100%;
}

.rs-param-table-fixed th,
.rs-param-table-fixed td {
  width: var(--rs-w-value, 9rem);
}

/* Document-flow sticky header: while a table that fits the viewport is scrolled
   through, its column header sticks just below the tab bar and releases once the
   table has fully passed (native position: sticky). Horizontally-overflowing
   tables are scroll containers, which breaks page-level sticky, so they are
   handled by a JS following header instead. */
.rs-table-wrapper:not(.rs-overflowing) thead th {
  position: sticky;
  top: calc(var(--rs-tabbar-h, 41px) + var(--rs-depth, 0) * var(--rs-cat-h));
  z-index: 3;
}

@media print {
  thead th { position: static; }
}

.rs-col-review {
  width: 2.25rem;
  text-align: center;
  padding: 0.25rem !important;
}

/* Status column */
.rs-status-ok {
  background: var(--rs-success-bg) !important;
  color: var(--rs-success);
  font-weight: 600;
  text-align: center;
}

.rs-status-ng {
  background: var(--rs-danger-bg) !important;
  color: var(--rs-danger);
  font-weight: 600;
  text-align: center;
}

.rs-status-na {
  color: var(--rs-text-muted);
  text-align: center;
}

/* Strikethrough for changes & suggested value display */
.rs-strikethrough {
  text-decoration: line-through;
  color: var(--rs-text-muted);
  opacity: 0.7;
}

.rs-suggested {
  color: var(--rs-danger);
  font-weight: 600;
  background: #fef2f2;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  border: 1px solid #fecaca;
}

/* Inline comment row */
.rs-inline-comment-row td {
  background: #fffbeb !important;
  border-left: 3px solid var(--rs-accent) !important;
  padding: 0.375rem 0.75rem !important;
}

.rs-inline-comments {
  font-size: 0.8rem;
  color: var(--rs-text-secondary);
}

.rs-inline-comment {
  padding: 0.25rem 0;
}

.rs-inline-comment:not(:last-child) {
  border-bottom: 1px dashed #fde68a;
}

.rs-ic-badge {
  font-size: 0.65rem;
  font-weight: 600;
  background: var(--rs-accent);
  color: #fff;
  border-radius: 3px;
  padding: 0.05rem 0.35rem;
  margin-right: 0.35rem;
  font-family: var(--rs-mono);
}

.rs-ic-badge.rs-ic-note {
  background: var(--rs-text-muted);
}

/* Instance label on a Pattern B comment, so a per-instance remark is clearly
   attributed to its column. */
.rs-ic-inst {
  font-size: 0.65rem;
  font-weight: 600;
  background: var(--rs-primary);
  color: #fff;
  border-radius: 3px;
  padding: 0.05rem 0.35rem;
  margin-right: 0.35rem;
  font-family: var(--rs-mono);
}

.rs-ic-text {
  color: var(--rs-text);
}

/* Floating cell action toolbar (Notion/Linear idiom). The cell is the target —
   double-click opens the review dialog, hovering surfaces this toolbar as a
   shortcut. It is portaled to body and positioned fixed (top/right set inline
   from the hovered cell, clamped to the viewport), so the table's
   horizontal-scroll wrapper can never clip it. The primary "Suggest" is an
   accent pill with a label; copy is a quiet neutral pill. */
.rs-cell-toolbar {
  position: fixed;
  z-index: 40;
  width: max-content;
  white-space: nowrap;
  display: inline-flex;
  align-items: stretch;
  gap: 1px;
  padding: 2px;
  background: var(--rs-surface);
  border: 1px solid var(--rs-border);
  border-radius: 8px;
  box-shadow: var(--rs-shadow);
}

.rs-tool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  border-radius: 6px;
  cursor: pointer;
  padding: 3px 7px;
  font-family: inherit;
  font-size: 0.72rem;
  line-height: 1;
  color: var(--rs-text-muted);
  transition: background 0.12s, color 0.12s;
}

.rs-tool:focus-visible {
  outline: 2px solid var(--rs-primary);
  outline-offset: 1px;
}

.rs-tool-label {
  font-weight: 600;
  letter-spacing: 0.01em;
}

.rs-tool-sep {
  width: 1px;
  margin: 3px 1px;
  background: var(--rs-border);
}

/* Primary: Suggest = accent blue, a filled pill once a review exists. */
.rs-tool-suggest { color: var(--rs-primary); }
.rs-tool-suggest:hover { background: var(--rs-primary-light); color: var(--rs-primary-dark); }
.rs-tool-suggest.rs-tool-on { background: var(--rs-primary); color: #ffffff; }
.rs-tool-suggest.rs-tool-on:hover { background: var(--rs-primary-dark); color: #ffffff; }

/* Secondary: Copy = quiet neutral ghost. */
.rs-tool-copy { color: var(--rs-text-muted); padding: 3px 6px; }
.rs-tool-copy:hover { background: var(--rs-border-light); color: var(--rs-text); }
.rs-tool.rs-copied { color: var(--rs-success); }


/* Heading comment pill (sheet / category headers). Same visual language as the
   cell toolbar — an accent-blue labeled pill that fills once a comment exists —
   so "comment on this section" reads consistently with "suggest on this value".
   A speech bubble (not a pencil): a header has no value to edit, only notes. */
.rs-head-tool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--rs-border);
  background: var(--rs-surface);
  border-radius: 6px;
  cursor: pointer;
  padding: 3px 8px;
  font-family: inherit;
  font-size: 0.72rem;
  line-height: 1;
  color: var(--rs-primary);
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}

.rs-head-tool:hover {
  background: var(--rs-primary-light);
  border-color: var(--rs-primary-light);
  color: var(--rs-primary-dark);
}

.rs-head-tool:focus-visible {
  outline: 2px solid var(--rs-primary);
  outline-offset: 1px;
}

.rs-head-tool-on {
  background: var(--rs-primary);
  border-color: var(--rs-primary);
  color: #ffffff;
}

.rs-head-tool-on:hover {
  background: var(--rs-primary-dark);
  border-color: var(--rs-primary-dark);
  color: #ffffff;
}

/* Header action bar (visible on hover) */
.rs-header-actions {
  opacity: 0;
  transition: opacity 0.15s;
  flex-shrink: 0;
}

.rs-header-actions.rs-has-comment {
  opacity: 1;
}

.rs-sheet-header:hover .rs-header-actions,
.rs-category-header:hover .rs-header-actions {
  opacity: 1;
}

/* Header inline comment */
.rs-header-comment {
  margin: 0.25rem 0 0.5rem 0.75rem;
  padding: 0.4rem 0.75rem;
  background: var(--rs-accent-light);
  border-left: 3px solid var(--rs-accent);
  border-radius: 0 var(--rs-radius) var(--rs-radius) 0;
  font-size: 0.8rem;
}

.rs-badge {
  position: absolute;
  top: -0.375rem;
  right: -0.375rem;
  background: var(--rs-accent);
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  border-radius: 50%;
  min-width: 0.9rem;
  height: 0.9rem;
  line-height: 0.9rem;
  text-align: center;
  padding: 0 0.15rem;
}

.rs-has-review {
  border-left: 3px solid var(--rs-accent) !important;
}

.rs-cell-has-review {
  border-left: 2px solid var(--rs-accent);
}

/* A value someone changed after the document was generated. Marked in
   a different colour from a review finding on purpose: a finding is somebody's
   proposal about the value, this IS the value, and only one of the two still
   matches the config file the source map points at. */
.rs-cell-edited {
  border-left: 2px solid var(--rs-success);
}

.rs-edited-mark {
  margin-left: 0.3rem;
  font-size: 0.8em;
  color: var(--rs-success);
  cursor: help;
  user-select: none;
}

.rs-tool-edit { color: var(--rs-success); }
.rs-tool-edit:hover { background: var(--rs-success-bg); }
.rs-tool-edit.rs-tool-on { background: var(--rs-success); color: #ffffff; }

/* The chain in the edit dialog: the original value first, then every step, so the
   sequence reads top to bottom. */
.rs-edit-history {
  margin-bottom: 0.85rem;
  padding: 0.6rem 0.75rem;
  background: var(--rs-subtle, #f8fafc);
  border: 1px solid var(--rs-border-light);
  border-radius: 4px;
}

.rs-edit-history-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--rs-text-muted);
  margin-bottom: 0.4rem;
}

.rs-edit-chain {
  margin: 0;
  padding: 0;
  list-style: none;
}

/* One flex line per step, so the arrow column, the value and the stamp line up
   down the list and nothing can overlap what follows the box. */
.rs-edit-chain li {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  padding: 0.15rem 0;
  font-size: 0.82rem;
  line-height: 1.5;
}

.rs-edit-step {
  flex: 0 0 1em;
  color: var(--rs-text-muted);
}

.rs-edit-chain code {
  font-size: 0.85em;
  padding: 0.05rem 0.3rem;
  background: var(--rs-bg, #ffffff);
  border: 1px solid var(--rs-border-light);
  border-radius: 3px;
}

.rs-edit-when {
  font-size: 0.72rem;
  color: var(--rs-text-muted);
}

/* An added row with nowhere to go. Loud on purpose: it is the one case where
   the document holds a value it is not showing. */
.rs-orphan-notice {
  margin: 0.75rem 0;
  padding: 0.6rem 0.8rem;
  font-size: 0.85rem;
  background: var(--rs-danger-bg);
  border-left: 3px solid var(--rs-danger);
  border-radius: 3px;
}

.rs-orphan-keys {
  display: block;
  margin-top: 0.25rem;
  font-family: var(--rs-mono, monospace);
  font-size: 0.8rem;
  color: var(--rs-text-muted);
}

.rs-head-tool-add { color: var(--rs-success); }

/* A row written into the document rather than extracted from a config file.
   The tag says so; this keeps the whole row from reading as a checked one. */
.rs-row-added .rs-col-key code {
  border-bottom: 1px dashed var(--rs-success);
}

/* Struck through, not removed. Muted rather than hidden: the row is still a
   record of what used to be set, and its history is still readable. */
.rs-row-deleted .rs-col-key code,
.rs-row-deleted .rs-col-value,
.rs-row-deleted .rs-col-default {
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

.rs-row-deleted {
  opacity: 0.6;
}

.rs-tool-delete { color: var(--rs-danger); }
.rs-tool-delete:hover { background: var(--rs-danger-bg); }
.rs-tool-delete.rs-tool-on { background: var(--rs-danger); color: #ffffff; }

.rs-save-busy {
  color: var(--rs-text-muted);
  font-style: italic;
}

.rs-edit-note {
  margin: 0 0 0.75rem;
  padding: 0.5rem 0.65rem;
  font-size: 0.8rem;
  background: var(--rs-accent-light);
  border-left: 3px solid var(--rs-accent-border);
  border-radius: 3px;
}

.rs-value-cell {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

/* A cell with something stacked under its value switches to a column: the row
   layout above puts block children side by side, which is what kept the
   per-environment lines on one line. */
.rs-value-cell-stacked {
  flex-direction: column;
  align-items: flex-start;
}

.rs-cell-content {
  flex: 1;
  min-width: 0;
}

.rs-cell-content code {
  display: inline;
}

/* ============================================================
   Review modal
   ============================================================ */

.rs-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.5);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: rs-fade-in 0.15s ease;
}

@keyframes rs-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes rs-slide-up {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}

.rs-modal {
  background: var(--rs-surface);
  border-radius: var(--rs-radius-lg);
  box-shadow: var(--rs-shadow-lg);
  width: 34rem;
  max-width: 92vw;
  max-height: 85vh;
  overflow-y: auto;
  padding: 0;
  animation: rs-slide-up 0.2s ease;
}

.rs-modal header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--rs-border);
  background: var(--rs-subtle);
  border-radius: var(--rs-radius-lg) var(--rs-radius-lg) 0 0;
}

.rs-modal header h4 {
  margin: 0;
  font-size: 0.925rem;
  font-weight: 600;
  color: var(--rs-text);
}

.rs-modal-path {
  font-size: 0.7rem;
  color: var(--rs-text-muted);
  margin-top: 0.15rem;
  font-family: var(--rs-mono);
}

.rs-modal-close {
  background: none;
  border: none;
  font-size: 1.375rem;
  cursor: pointer;
  color: var(--rs-text-muted);
  padding: 0;
  line-height: 1;
  transition: color 0.15s;
}

.rs-modal-close:hover {
  color: var(--rs-text);
}

.rs-target-info {
  margin: 0.875rem 1.25rem;
  padding: 0.625rem 0.875rem;
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border-light);
  border-radius: var(--rs-radius);
  font-size: 0.8rem;
}

.rs-target-info div {
  margin: 0.2rem 0;
}

.rs-target-info code {
  background: #e2e8f0;
  padding: 0.1rem 0.375rem;
  border-radius: 3px;
  font-size: 0.8rem;
}

.rs-label {
  font-weight: 600;
  color: var(--rs-text-muted);
  margin-right: 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.rs-existing-reviews {
  padding: 0 1.25rem;
}

.rs-existing-reviews h5 {
  font-size: 0.775rem;
  color: var(--rs-text-muted);
  margin: 0.75rem 0 0.5rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.rs-review-item {
  background: var(--rs-accent-light);
  border: 1px solid var(--rs-changed-border);
  border-radius: var(--rs-radius);
  padding: 0.625rem 0.75rem;
  margin-bottom: 0.5rem;
}

.rs-review-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.rs-change-badge {
  font-size: 0.675rem;
  font-weight: 600;
  background: var(--rs-primary);
  color: #fff;
  border-radius: 3px;
  padding: 0.1rem 0.4rem;
  display: inline-block;
  margin-right: 0.2rem;
  font-family: var(--rs-mono);
}

.rs-change-badge.rs-note {
  background: var(--rs-text-muted);
}

.rs-review-comment {
  font-size: 0.8rem;
  margin: 0.375rem 0 0;
  color: var(--rs-text);
  line-height: 1.5;
}

.rs-review-actions {
  display: flex;
  gap: 0.25rem;
}

.rs-review-actions button {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.825rem;
  color: var(--rs-text-muted);
  padding: 0.125rem;
  transition: color 0.15s;
}

.rs-review-actions button:hover {
  color: var(--rs-text);
}

.rs-new-review {
  padding: 0.875rem 1.25rem 1.25rem;
  border-top: 1px solid var(--rs-border);
}

.rs-new-review h5 {
  font-size: 0.825rem;
  font-weight: 600;
  margin: 0 0 0.75rem;
  color: var(--rs-primary);
}

.rs-form-row {
  margin-bottom: 0.75rem;
}

.rs-form-row label {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  margin-bottom: 0.25rem;
  color: var(--rs-text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.rs-hint {
  font-weight: 400;
  font-size: 0.7rem;
  color: var(--rs-text-muted);
  text-transform: none;
  letter-spacing: 0;
}

.rs-form-row input,
.rs-form-row textarea {
  width: 100%;
  padding: 0.5rem 0.625rem;
  font-size: 0.85rem;
  font-family: var(--rs-font);
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  background: var(--rs-surface);
  color: var(--rs-text);
  transition: border-color 0.15s, box-shadow 0.15s;
  outline: none;
}

.rs-form-row input:focus,
.rs-form-row textarea:focus {
  border-color: var(--rs-primary);
  box-shadow: 0 0 0 3px var(--rs-primary-light);
}

.rs-form-row textarea {
  resize: vertical;
}

.rs-modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 1rem;
}

.rs-modal-shortcuts {
  font-size: 0.7rem;
  color: var(--rs-text-muted);
}

.rs-modal-shortcuts kbd {
  display: inline-block;
  padding: 0.1rem 0.35rem;
  font-size: 0.65rem;
  font-family: var(--rs-mono);
  background: #f1f5f9;
  border: 1px solid var(--rs-border);
  border-radius: 3px;
  box-shadow: 0 1px 0 var(--rs-border);
}

.rs-modal-actions {
  display: flex;
  gap: 0.5rem;
}

.rs-btn-primary {
  background: var(--rs-primary);
  color: #fff;
  border: none;
  border-radius: var(--rs-radius);
  padding: 0.5rem 1.25rem;
  cursor: pointer;
  font-size: 0.825rem;
  font-weight: 600;
  font-family: var(--rs-font);
  transition: background 0.15s;
}

.rs-btn-primary:hover {
  background: var(--rs-primary-dark);
}

.rs-btn-danger {
  background: #fee2e2;
  color: var(--rs-danger);
  border: 1px solid #fecaca;
  border-radius: var(--rs-radius);
  padding: 0.5rem 1.25rem;
  cursor: pointer;
  font-size: 0.825rem;
  font-weight: 500;
  font-family: var(--rs-font);
  transition: background 0.15s;
}

.rs-btn-danger:hover {
  background: #fecaca;
}

.rs-btn-cancel {
  background: var(--rs-surface);
  color: var(--rs-text-secondary);
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  padding: 0.5rem 1.25rem;
  cursor: pointer;
  font-size: 0.825rem;
  font-weight: 500;
  font-family: var(--rs-font);
  transition: background 0.15s;
}

.rs-btn-cancel:hover {
  background: var(--rs-subtle);
}


/* ============================================================
   Changelog
   ============================================================ */

.rs-changelog {
  margin: 0.75rem 0 1.5rem;
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  padding: 0;
}

.rs-changelog summary {
  cursor: pointer;
  font-size: 0.825rem;
  font-weight: 600;
  color: var(--rs-text-secondary);
  padding: 0.5rem 0.875rem;
  list-style: none;
}

.rs-changelog summary::before {
  content: "\\25B8 ";
}

.rs-changelog[open] summary::before {
  content: "\\25BE ";
}

.rs-changelog-table {
  width: 100%;
  font-size: 0.775rem;
  border-collapse: collapse;
  margin: 0;
}

.rs-changelog-table th {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.4rem 0.75rem;
  background: var(--rs-subtle);
  color: var(--rs-text-secondary);
  border-bottom: 1px solid var(--rs-border);
  text-align: left;
}

.rs-changelog-table td {
  padding: 0.375rem 0.75rem;
  border-bottom: 1px solid var(--rs-border-light);
}

/* ============================================================
   Overview tab
   ============================================================ */

.rs-overview h1 {
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
  padding-bottom: 0.75rem;
  border-bottom: 2px solid var(--rs-text);
}

.rs-overview-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}

.rs-overview-item {
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  padding: 0.75rem 1rem;
}

.rs-overview-item dt {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--rs-text-muted);
  margin-bottom: 0.25rem;
}

.rs-overview-item dd {
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--rs-text);
  margin: 0;
}

.rs-changelog-section {
  margin-bottom: 2rem;
}

.rs-changelog-section h2 {
  font-size: 1.1rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: var(--rs-text);
}

.rs-overview-sheets {
  margin-bottom: 2rem;
}

.rs-overview-sheets h2 {
  /* Kept above the sheet names it introduces (1.1rem). */
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
  color: var(--rs-text);
}

/* The group heading in the overview's sheet list. Its own rule rather than the
   outline's: the same rank, but this list has room and the panel does not. */
.rs-overview-groupname {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--rs-text);
  margin: 1rem 0 0.25rem;
}

.rs-overview-group:first-child .rs-overview-groupname {
  margin-top: 0;
}

.rs-overview-sheets ul {
  list-style: none;
  padding: 0;
}

.rs-overview-sheets li {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--rs-border-light);
}

.rs-overview-sheet-link {
  background: none;
  border: none;
  color: var(--rs-primary);
  /* Was 0.95rem — the same size as a category heading in the body, for the
     thing that CONTAINS every category. Under its group heading (1.15rem). */
  font-size: 1rem;
  font-weight: 600;
  font-family: var(--rs-font);
  cursor: pointer;
  padding: 0;
  text-decoration: none;
}

.rs-overview-sheet-link:hover {
  text-decoration: underline;
}







/* ============================================================
   Print
   ============================================================ */

/* ============================================================
   Heading navigation (outline panel + command palette)
   ============================================================ */

/* Jump offsets: land a category/sheet just below the sticky header stack. */
.rs-category {
  scroll-margin-top: calc(var(--rs-tabbar-h, 41px) + (var(--rs-depth, 1) - 1) * var(--rs-cat-h) + 0.4rem);
}
.rs-sheet {
  scroll-margin-top: calc(var(--rs-tabbar-h, 41px) + 0.4rem);
}

/* Flash the navigation target after a jump. Uses an inset box-shadow fill so it
   tints even cells whose background is set with !important (changed values). */
@keyframes rs-flash {
  0%, 45% { box-shadow: inset 0 0 0 9999px rgba(245, 158, 11, 0.3); }
  100% { box-shadow: inset 0 0 0 9999px rgba(245, 158, 11, 0); }
}

/* An OVERLAY, not a background.
   Two attempts failed the same way and both are worth writing down. Filling the
   flashed element's own background loses to any child that paints its own — a
   category heading at depth 1 or 2 is a tinted panel, so the flash landed
   behind it and the jump looked like nothing happened. Animating the children
   as well put two translucent fills on top of one another (doubled), and
   flashing the heading INSTEAD of the row shrank the mark to the width of the
   words. A pseudo-element paints above every child, so it is one fill, at the
   element's full width, whatever the children are made of. */
/* NOT set here. A position: relative on the flashed element outranks
   .rs-category-header's own position: sticky (a class plus an element beats a
   class), so the heading came unstuck for the length of the animation and the
   highlight appeared somewhere other than where the reader had landed. The
   elements that need a containing block declare it in their own rules below;
   the sticky one already is one. */
.rs-jump-flash::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  z-index: 5;
  animation: rs-flash-overlay 1.6s ease-out;
}

@keyframes rs-flash-overlay {
  0%, 45% { background: rgba(245, 158, 11, 0.3); }
  100% { background: rgba(245, 158, 11, 0); }
}

/* A table ROW cannot carry a pseudo-element reliably (display: table-row), so
   its cells keep the inset-shadow fill — they are the elements with the
   backgrounds there anyway. */
tr.rs-jump-flash::after {
  content: none;
}

tr.rs-jump-flash td,
tr.rs-jump-flash th {
  animation: rs-flash 1.6s ease-out;
}

/* A jumped-to parameter row lands below the sticky section headers plus the
   table's own column header (~one header height). */
.rs-param-row {
  scroll-margin-top: calc(var(--rs-tabbar-h, 41px) + (var(--rs-depth, 0) + 1) * var(--rs-cat-h) + 0.3rem);
}

/* Push the content aside (rather than covering it) while the outline is open,
   so no headings are hidden behind the panel. */
.rs-main {
  transition: margin-left 0.18s ease;
}

.rs-app.rs-outline-open .rs-main {
  margin-left: var(--rs-outline-w);
}

.rs-outline {
  position: fixed;
  top: var(--rs-tabbar-h, 41px);
  left: 0;
  width: var(--rs-outline-w);
  height: calc(100vh - var(--rs-tabbar-h, 41px));
  background: var(--rs-surface);
  border-right: 1px solid var(--rs-border);
  box-shadow: var(--rs-shadow-lg);
  z-index: 90;
  display: flex;
  flex-direction: column;
  font-size: 0.8rem;
}

.rs-outline-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  font-weight: 600;
  background: var(--rs-subtle);
  border-bottom: 1px solid var(--rs-border);
}

.rs-outline-close {
  border: none;
  background: transparent;
  font-size: 1.15rem;
  line-height: 1;
  cursor: pointer;
  color: var(--rs-text-secondary);
}

.rs-outline-body {
  flex: 1;
  overflow: auto;
  padding: 0.4rem 0;
}

.rs-outline-sheet {
  margin-bottom: 0.5rem;
}

/* The sheet the header is on. Without it the panel scrolls somewhere and the
   reader has to work out why that place. */
.rs-outline-sheet-current {
  color: var(--rs-primary);
  background: var(--rs-subtle);
  box-shadow: inset 2px 0 0 var(--rs-primary);
}


.rs-outline-sheetname {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  font-weight: 700;
  color: var(--rs-text);
  padding: 0.3rem 0.75rem;
  cursor: pointer;
  /* A sheet is the outline's largest unit and inherited the panel's 0.8rem, so
     it came out the same size as a category three levels below it — told apart
     by weight alone. Weight is what separates it from the categories under it
     here; the group above it (0.9rem) is the one that carries size. */
  font-size: 0.8rem;
}

/* The caret and the label are siblings, not nested: the caret toggles, the
   label navigates. The ROW carries the indentation, the hover and the
   current-item accent, so the highlight spans the full width including the
   caret gutter — putting them on the label instead left the accent floating
   past the caret and the hover stopping short of the row's left edge. */
.rs-outline-row {
  display: flex;
  align-items: center;
  border-left: 2px solid transparent;
}

.rs-outline-row:hover {
  background: var(--rs-primary-light);
}

.rs-outline-row:hover .rs-outline-item,
.rs-palette-inputrow {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-bottom: 1px solid var(--rs-border);
}
.rs-palette-inputrow .rs-palette-input {
  flex: 1;
  border-bottom: none;
}
/* The scope is a control, not a status line: it says which rows are being
   searched AND changes them, so it reads as a button even at rest. */
.rs-palette-scope {
  flex: none;
  margin-right: 0.6rem;
  padding: 0.15rem 0.5rem;
  font-size: 0.72rem;
  line-height: 1.6;
  white-space: nowrap;
  color: var(--rs-text-muted);
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border);
  border-radius: 999px;
  cursor: pointer;
}
.rs-palette-scope:hover { color: var(--rs-text); }
.rs-palette-scope-all {
  color: var(--rs-accent);
  border-color: var(--rs-accent);
  background: transparent;
}




.rs-outline-item {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--rs-text-secondary);
  padding: 0.25rem 0.5rem 0.25rem 0.15rem;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rs-outline-current {
  background: var(--rs-primary-light);
  border-left-color: var(--rs-primary);
}

.rs-outline-current .rs-outline-item {
  color: var(--rs-primary);
  font-weight: 600;
}

.rs-palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  z-index: 1100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
}

.rs-palette {
  width: min(40rem, 92vw);
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--rs-surface);
  border-radius: var(--rs-radius-lg);
  box-shadow: var(--rs-shadow-lg);
}

.rs-palette-input {
  border: none;
  border-bottom: 1px solid var(--rs-border);
  padding: 0.9rem 1rem;
  font-size: 1rem;
  outline: none;
  background: transparent;
  color: var(--rs-text);
}

.rs-palette-list {
  overflow: auto;
}

.rs-palette-empty {
  padding: 1rem;
  text-align: center;
  color: var(--rs-text-muted);
}

.rs-palette-item {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 0.5rem 1rem;
  cursor: pointer;
}

.rs-palette-sel {
  background: var(--rs-primary-light);
}

.rs-palette-name {
  color: var(--rs-text);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rs-palette-ctx {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rs-palette-snippet {
  font-size: 0.78rem;
  color: var(--rs-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.rs-hl {
  background: var(--rs-accent-light);
  color: inherit;
  font-weight: 700;
  border-radius: 2px;
  padding: 0 1px;
}

.rs-palette-kind {
  display: inline-block;
  font-size: 0.6rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--rs-text-muted);
  border: 1px solid var(--rs-border);
  border-radius: 3px;
  padding: 0 0.25rem;
  margin-right: 0.35rem;
  vertical-align: middle;
}

.rs-palette-ctx {
  font-size: 0.75rem;
  color: var(--rs-text-muted);
}

@media print {
  .rs-sheet-tabs,
  .rs-col-review,
  .rs-header-actions,
  .rs-cell-toolbar,
  .rs-overlay,
  .rs-outline,
  .rs-palette-overlay {
    display: none !important;
  }

  .rs-main { padding: 0; }

  .rs-sheet { page-break-before: always; }
  .rs-sheet:first-child { page-break-before: avoid; }
  .rs-param-table { page-break-inside: auto; }
  .rs-param-table tr { page-break-inside: avoid; }
}

/* ---- Versions & diff ---- */
.rs-version-bar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.45rem 1rem;
  background: #eef2f7;
  border-bottom: 1px solid var(--rs-border);
  font-size: 0.85rem;
}
.rs-version-pick {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--rs-text-secondary);
}
.rs-version-pick select {
  font: inherit;
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--rs-border);
  border-radius: 4px;
  background: var(--rs-surface);
}
.rs-version-arrow { color: var(--rs-text-muted); }
.rs-version-btn {
  font: inherit;
  padding: 0.2rem 0.7rem;
  border: 1px solid var(--rs-primary);
  border-radius: 4px;
  background: var(--rs-primary);
  color: #fff;
  cursor: pointer;
}
.rs-version-btn:hover { filter: brightness(1.05); }

/* Diff toolbar bits (live in the normal tab bar's right side). */
.rs-diff-summary { font-weight: 600; font-size: 0.85rem; white-space: nowrap; }
.rs-diff-changed-only { display: inline-flex; align-items: center; gap: 0.3rem; color: var(--rs-text-secondary); font-size: 0.85rem; white-space: nowrap; }

/* Diff overlay on the normal sheet view. Changed values render old -> new via
   the existing strikethrough/suggested styling; these rules add the row/cell
   tints, the left accent bar on the key cell, and the +/-/~ badges. */
.rs-diff-badge {
  display: inline-block;
  margin-left: 0.4rem;
  font-family: var(--rs-mono);
  font-weight: 700;
  font-size: 0.7rem;
  line-height: 1.4;
  padding: 0 0.3rem;
  border-radius: 3px;
  color: #fff;
  vertical-align: middle;
}
.rs-diff-badge-added { background: #10b981; }
.rs-diff-badge-removed { background: #ef4444; }
.rs-diff-badge-changed { background: var(--rs-accent); }

/* A removed heading (sheet / category) or outline entry is struck through. */
.rs-diff-strike { text-decoration: line-through; color: var(--rs-text-muted); }

/* Added / removed parameter rows: a left accent bar on the key cell + badge
   carry the status; the row background is left untinted (tinting the frozen
   key/description/default columns reads as noise). */
.rs-param-table .rs-diff-row-added .rs-col-key { box-shadow: inset 3px 0 0 0 #10b981; }
.rs-param-table .rs-diff-row-removed .rs-col-key { box-shadow: inset 3px 0 0 0 #ef4444; }
.rs-param-table .rs-diff-row-changed .rs-col-key { box-shadow: inset 3px 0 0 0 var(--rs-accent); }
/* A removed row's values are struck through (its key stays legible). */
.rs-param-table .rs-diff-row-removed td:not(.rs-col-key) .rs-cell-content { text-decoration: line-through; color: var(--rs-text-muted); }

/* Per-instance (Pattern B) cell deltas. Use !important so the diff intent wins
   over the "differs from default" yellow highlight (which is also !important). */
.rs-param-table td.rs-diff-cell-added { background: #ecfdf5 !important; border-left: 2px solid #6ee7b7 !important; }
.rs-param-table td.rs-diff-cell-removed { background: #fef2f2 !important; border-left: 2px solid #fca5a5 !important; }
.rs-param-table td.rs-diff-cell-removed .rs-cell-content { text-decoration: line-through; color: var(--rs-text-muted); }
/* An instance column absent from this row (no value on either side here). */
.rs-param-table td.rs-diff-cell-absent {
  background: repeating-linear-gradient(45deg, var(--rs-subtle), var(--rs-subtle) 6px, #eef2f7 6px, #eef2f7 12px) !important;
  border-left: none !important;
}

/* ============================================================
   Out-of-scope: category containers and parameter rows
   ============================================================ */

/* Category container greyed out; cascades visually to nested content. */
/* Out of scope = documented but excluded from review. It must stay READABLE
   (it is not "disabled"), so it is marked with a clear label + a neutral zone
   tint and a slate boundary bar — not a blanket opacity fade that hurts text. */
.rs-out-of-scope {
  border-left: 3px solid #64748b;
  background: var(--rs-surface);
  padding-left: 0.5rem;
}

/* Out-of-scope cells carry a diagonal "excluded" hatch (clearly visible, theme-
   independent) on both category-level and param-level rows; text stays readable.
   The same rule neutralises the "changed" amber inside out-of-scope areas so
   excluded items don't draw review attention. .rs-row-excluded is the
   row-level treatment for a param that is itself excluded, or that inherits
   exclusion from its enclosing category (nearest-wins is resolved in app.ts;
   this class only ever reflects the *effective* out-of-scope for the row). */
.rs-out-of-scope td,
.rs-row-excluded td,
.rs-out-of-scope .rs-changed,
.rs-row-excluded .rs-changed,
.rs-row-excluded.rs-changed {
  background: repeating-linear-gradient(45deg, var(--rs-surface), var(--rs-surface) 7px, #e2e8f0 7px, #e2e8f0 14px) !important;
  border-left-color: #cbd5e1 !important;
}

/* "Out of scope" badge — a clear, readable slate status chip (text 8.4:1). Used
   only at the category header; param rows show no badge (legibility budget of
   one badge-style marker per row is spent on the diff badge, if any) — instead
   they get .rs-row-excluded row muting plus the .rs-oos-reason line below. */
.rs-oos-badge {
  display: inline-block;
  font-size: 0.65rem;
  font-weight: 700;
  font-family: var(--rs-mono);
  letter-spacing: 0.02em;
  background: #e2e8f0;
  color: #334155;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  white-space: nowrap;
  flex-shrink: 0;
  border: 1px solid #cbd5e1;
  margin-left: 0.3rem;
  vertical-align: middle;
}

/* Out-of-scope reason — always visible (this is the audit artifact, not a
   tooltip): the reason + optional owner, shown inline under the category
   heading or inside an excluded param row's key cell. */
.rs-oos-reason {
  display: block;
  font-size: 0.78rem;
  color: var(--rs-text-muted);
  margin-top: 2px;
}

/* Origin tag — a small muted marker for a param whose value is "embedded"
   (baked into the deployable source, never per-environment). Overlay/common
   params render no marker at all. Reuses the key-subline's muted/monospace
   look so it composes with an excluded row without adding a second badge. */
/* --- Review decisions (判定) -------------------------------------------- */

/* The sheet header states where the configuration LANDS; the file it is
   generated from is secondary — both readers of a sheet get their path. */
.rs-source-path {
  margin-left: 0.6rem;
  font-size: 0.8rem;
  color: var(--rs-text-muted);
}

.rs-origin-tag {
  display: inline-block;
  font-size: 0.7rem;
  font-family: var(--rs-mono);
  color: var(--rs-text-muted);
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border);
  border-radius: 4px;
  padding: 0.05rem 0.4rem;
  letter-spacing: 0.02em;
}





.rs-outline-count {
  font-size: 0.68rem;
  color: var(--rs-text-muted);
}

/* Printing must produce the complete ledger regardless of what is collapsed
   on screen (see App's beforeprint/afterprint handling in app.ts, which
   mounts every collapsed category's content for the duration of the print) —
   the toggle itself is the one thing to hide, since it is inert on paper. */
@media print {
}

/* ============================================================
   Apply panel (server mode: "Apply to files" modal)
   ============================================================ */

.rs-apply-modal {
  width: 48rem;
  max-width: 96vw;
}

.rs-apply-summary {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.75rem 1.25rem;
  background: var(--rs-subtle);
  border-bottom: 1px solid var(--rs-border);
  font-size: 0.8rem;
}

.rs-apply-summary-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-weight: 600;
  font-family: var(--rs-mono);
  padding: 0.15rem 0.55rem;
  border-radius: 3px;
  font-size: 0.75rem;
}

.rs-apply-chip-applied {
  background: var(--rs-success-bg);
  color: var(--rs-success);
  border: 1px solid #a7f3d0;
}

.rs-apply-chip-skipped {
  background: #f3f4f6;
  color: var(--rs-text-muted);
  border: 1px solid var(--rs-border);
}

.rs-apply-chip-held {
  background: var(--rs-accent-light);
  color: #92400e;
  border: 1px solid var(--rs-accent-border);
}

.rs-apply-chip-oos {
  background: #f3f4f6;
  color: var(--rs-text-muted);
  border: 1px solid var(--rs-border);
}

.rs-apply-body {
  padding: 0.875rem 1.25rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow-y: auto;
  max-height: 55vh;
}

.rs-apply-loading {
  padding: 2rem 1.25rem;
  text-align: center;
  color: var(--rs-text-muted);
  font-size: 0.875rem;
}

.rs-apply-error {
  padding: 1rem 1.25rem;
  color: var(--rs-danger);
  background: var(--rs-danger-bg);
  border-radius: var(--rs-radius);
  font-size: 0.85rem;
}

.rs-apply-done {
  padding: 1rem 1.25rem;
  color: var(--rs-success);
  background: var(--rs-success-bg);
  border-radius: var(--rs-radius);
  font-size: 0.85rem;
  font-weight: 600;
}

.rs-apply-file {
  font-size: 0.8rem;
  font-weight: 700;
  font-family: var(--rs-mono);
  color: var(--rs-text);
  margin-bottom: 0.4rem;
  padding: 0.25rem 0;
  border-bottom: 1px solid var(--rs-border-light);
}

.rs-apply-group {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.rs-apply-row {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--rs-radius);
  border: 1px solid var(--rs-border-light);
  background: var(--rs-surface);
  font-size: 0.8rem;
}

.rs-apply-row-applied {
  border-left: 3px solid var(--rs-success);
}

.rs-apply-row-skipped,
.rs-apply-row-held,
.rs-apply-row-out_of_scope {
  border-left: 3px solid var(--rs-border);
  opacity: 0.8;
}

/* A held value whose source is a generated build artifact: the apply
   affordance is permanently unavailable for it (not just this run), so it
   gets a dashed border rather than the plain "held" solid one. */
.rs-apply-row-generated {
  border-left-style: dashed;
  cursor: help;
}

.rs-apply-target {
  font-weight: 600;
  color: var(--rs-text-secondary);
  font-size: 0.75rem;
  font-family: var(--rs-mono);
}

.rs-apply-diff {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.rs-apply-reason {
  font-size: 0.75rem;
  color: var(--rs-text-muted);
  font-style: italic;
}

.rs-apply-held {
  margin-top: 1rem;
  padding-top: 0.875rem;
  border-top: 1px dashed var(--rs-border);
}

.rs-apply-held-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.rs-apply-held-title {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--rs-text);
}

.rs-apply-held-hint {
  margin: 0.35rem 0 0.5rem;
  font-size: 0.72rem;
  color: var(--rs-text-muted);
}

.rs-apply-held-text {
  width: 100%;
  min-height: 9rem;
  box-sizing: border-box;
  padding: 0.6rem 0.7rem;
  font-family: var(--rs-mono);
  font-size: 0.72rem;
  line-height: 1.5;
  color: var(--rs-text);
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border);
  border-radius: var(--rs-radius);
  resize: vertical;
}

.rs-apply-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.875rem 1.25rem;
  border-top: 1px solid var(--rs-border);
  background: var(--rs-subtle);
  border-radius: 0 0 var(--rs-radius-lg) var(--rs-radius-lg);
}

.rs-apply-footer-actions {
  display: flex;
  gap: 0.5rem;
}

.rs-btn-primary:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* ---- Artifact preview panel -------------------------------------------
   The deployed file, beside the sheet. A pinned right-hand panel and not a
   modal on purpose: the request was to review a setting WHILE seeing its
   surrounding context, and a full-screen overlay shows the context INSTEAD of
   the row, which is the problem it was meant to solve. */
/* The class is on .rs-app (App's own root), not .rs-root — an earlier
   selector named the wrong one, so none of this matched and the fixed panel
   simply covered the sheet. Padding on the app rather than a margin on the
   main region, so the sticky tab bar is inset too instead of running under
   the panel. */
.rs-app.rs-with-artifact {
  padding-right: var(--rs-artifact-w, 34rem);
}

.rs-artifact-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--rs-artifact-w, 34rem);
  max-width: 92vw;
  display: flex;
  flex-direction: column;
  background: var(--rs-surface);
  border-left: 1px solid var(--rs-border);
  box-shadow: -2px 0 12px rgba(0, 0, 0, 0.06);
  z-index: 150;
}

.rs-artifact-head {
  position: relative;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--rs-border);
  background: var(--rs-subtle);
}

.rs-artifact-title {
  /* Room for the close button, which is pinned to the corner (see app.ts). */
  padding-right: 1.75rem;
}

.rs-artifact-close {
  position: absolute;
  top: 0.35rem;
  right: 0.5rem;
}

.rs-artifact-path {
  font-family: var(--rs-mono);
  font-size: 0.9rem;
  font-weight: 600;
  word-break: break-all;
}

.rs-artifact-meta {
  margin-top: 0.3rem;
  font-size: 0.72rem;
  color: var(--rs-text-muted);
  line-height: 1.5;
}

.rs-artifact-meta code {
  font-size: 0.72rem;
}

.rs-artifact-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.4rem;
}

.rs-artifact-tab {
  font: inherit;
  font-size: 0.72rem;
  padding: 0.12rem 0.5rem;
  border: 1px solid var(--rs-border);
  border-radius: 999px;
  background: var(--rs-surface);
  color: var(--rs-text-muted);
  cursor: pointer;
}

.rs-artifact-tab.rs-on {
  background: var(--rs-primary);
  border-color: var(--rs-primary);
  color: var(--rs-surface);
}

.rs-artifact-body {
  flex: 1;
  overflow: auto;
  padding: 0.5rem 0 1.5rem;
}

.rs-artifact-line {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0 0.9rem;
  font-family: var(--rs-mono);
  font-size: 0.76rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.rs-artifact-no {
  flex: 0 0 2.4rem;
  text-align: right;
  color: var(--rs-text-muted);
  opacity: 0.6;
  user-select: none;
}

.rs-artifact-text {
  flex: 1;
}

/* A line that IS a row: clickable, and it says so only on hover so the file
   still reads as a file. */
.rs-artifact-line.rs-has-row {
  cursor: pointer;
}

.rs-artifact-line.rs-has-row:hover {
  background: var(--rs-subtle);
}

.rs-artifact-line.rs-here {
  background: var(--rs-primary-light);
  box-shadow: inset 3px 0 0 var(--rs-primary);
}

/* A line this instance does not render. Kept and greyed rather than removed:
   "this line exists only in local" is review information. */
.rs-artifact-line.rs-kind-absent .rs-artifact-text {
  opacity: 0.42;
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

/* A line the tool could not compute. Marked, never guessed at. */
.rs-artifact-line.rs-kind-unrendered .rs-artifact-text {
  background: var(--rs-accent-light);
  border-bottom: 1px dashed var(--rs-accent-border);
}

.rs-artifact-warn {
  color: var(--rs-accent-border);
}

/* The affordance on a row: a chip in the key cell. */
.rs-artifact-chip {
  font: inherit;
  font-size: 0.68rem;
  padding: 0 0.4rem;
  border: 1px solid var(--rs-border);
  border-radius: 999px;
  background: transparent;
  color: var(--rs-text-muted);
  cursor: pointer;
}

.rs-artifact-chip:hover {
  border-color: var(--rs-primary);
  color: var(--rs-primary);
}

@media (max-width: 60rem) {
  .rs-app.rs-with-artifact {
    padding-right: 0;
  }
}


/* A document sheet: prose, not a table.
 *
 * Deliberately narrow. The parameter views are as wide as the screen because a
 * row has to be read across; a paragraph read across 200 characters is a
 * paragraph nobody reads, and this is the part of the file someone is meant to
 * read rather than scan.
 *
 * It borrows the sheet's OWN type scale and heading device rather than a
 * document one. The two sit a tab apart and are read in one sitting, so a
 * document set in the proportions a document would normally use — a 1.5rem h1
 * over a 0.9rem table, an h1 larger than the sheet title above it — reads as a
 * page from a different tool. A heading here plays the part a category heading
 * plays there, so it is given that part's size and that part's tinted panel:
 * h1/h2/h3 answer to .rs-sheet-header h2 / .rs-category-header h3 / h4.
 *
 * Everything is scoped under .rs-doc. The markdown was written by a project,
 * not by this tool, and an unscoped h2/table/code rule would reach the sheets
 * as well — the one way a document could change how the parameters look.
 */
.rs-doc {
  padding: 0.75rem 0 3rem;
  color: var(--rs-text);
  /* The table's size, because the table is the text this file is mostly made
     of and the document has to look like it belongs beside one. */
  font-size: 0.9rem;
  /* Looser than the app's 1.6 — that is set for cells, and this is prose — but
     nowhere near a document default. */
  line-height: 1.75;
}
.rs-doc > *:first-child { margin-top: 0; }
/* No measure. The column is as wide as every other sheet's.
 *
 * A narrow one was tried, on the usual typographic ground that a paragraph read
 * across 200 characters is a paragraph nobody reads. Two things decided against
 * it. A heading here carries a rule (border-bottom), and a capped heading stops
 * its rule partway across the column, which reads as broken rather than as
 * restrained. And the author controls where a line ends already: a blank line
 * starts a new paragraph, which is the markdown way of saying "break here" and
 * is a decision the document makes rather than one the stylesheet imposes.
 *
 * So the document sheet is as wide as the parameter sheets beside it, which is
 * also the thing a reader switching tabs expects. Wide content — a table, a
 * fenced directory tree, a diagram — keeps its own scroller past the column, so
 * the page never gains one.
 */
.rs-doc h1, .rs-doc h2, .rs-doc h3, .rs-doc h4, .rs-doc h5, .rs-doc h6 {
  font-weight: 600;
  line-height: 1.5;
  /* The jump flash paints an ::after with inset: 0, which resolves against
     the nearest POSITIONED ancestor. Without this a heading landed on from the
     outline lit the whole sheet panel instead of the heading — the flash exists
     to say "here", and one covering everything says nothing. */
  position: relative;
  /* Cleared by the sticky tab bar: a heading jumped to from the outline would
     otherwise land underneath it, which reads as the jump having missed. */
  scroll-margin-top: calc(var(--rs-tabbar-h) + 1rem);
}
.rs-doc h1 {
  font-size: 1.05rem;
  font-weight: 700;
  margin: 1.75rem 0 0.75rem;
  padding-bottom: 0.4rem;
  border-bottom: 2px solid var(--rs-border);
}
.rs-doc h2 {
  font-size: 0.95rem;
  margin: 1.75rem 0 0.5rem;
  padding: 0.5rem 0.875rem;
  background: #f1f5f9;
  color: #1e293b;
  border-left: 4px solid var(--rs-primary);
  border-radius: 0 var(--rs-radius) var(--rs-radius) 0;
}
.rs-doc h3 {
  font-size: 0.9rem;
  margin: 1.25rem 0 0.4rem;
  padding: 0.375rem 0.75rem;
  background: #f1f5f9;
  color: #334155;
  border-left: 3px solid var(--rs-primary);
  border-radius: 0 var(--rs-radius) var(--rs-radius) 0;
}
.rs-doc h4, .rs-doc h5, .rs-doc h6 {
  font-size: 0.825rem;
  margin: 1rem 0 0.3rem;
  padding: 0.3rem 0.625rem;
  color: var(--rs-text-secondary);
  border-left: 2px solid var(--rs-border);
}
.rs-doc p { margin: 0.6rem 0; }
.rs-doc ul, .rs-doc ol { margin: 0.6rem 0; padding-left: 1.4rem; }
.rs-doc li { margin: 0.2rem 0; }
.rs-doc li > input[type="checkbox"] { margin-right: 0.4rem; }
.rs-doc a { color: var(--rs-primary); }
.rs-doc code {
  font-family: var(--rs-mono);
  font-size: 0.875em;
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border-light);
  border-radius: 3px;
  padding: 0.05em 0.3em;
}
.rs-doc pre {
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border-light);
  border-radius: var(--rs-radius);
  padding: 0.7rem 0.9rem;
  /* Its own scroller: a wide code block must not widen the page. A directory
     tree is the common case and is wider than the measure by design. */
  overflow-x: auto;
}
.rs-doc pre code {
  background: none;
  border: 0;
  padding: 0;
  font-size: 0.8rem;
  line-height: 1.55;
}
.rs-doc blockquote {
  margin: 0.8rem 0;
  padding: 0.1rem 0.9rem;
  border-left: 3px solid var(--rs-border);
  color: var(--rs-text-secondary);
}
.rs-doc hr { border: 0; border-top: 1px solid var(--rs-border-light); margin: 1.75rem 0; }
/* The parameter table's proportions, for the same reason the body text has
   them: a table here and a table one tab over should not be two designs. */
/* Wide by nature: as wide as its content needs, up to the column, and its own
   scroller past that — never the page's. */
.rs-doc table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 0.8rem 0;
  font-size: 0.85rem;
}
.rs-doc th, .rs-doc td {
  border: 1px solid var(--rs-border-light);
  padding: 0.4rem 0.7rem;
  text-align: left;
  vertical-align: top;
}
.rs-doc th {
  background: var(--rs-subtle);
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--rs-text-secondary);
}
/* Embedded at build time, so this only has to keep one from overflowing. */
.rs-doc img { max-width: 100%; height: auto; }
.rs-doc details {
  margin: 0.6rem 0;
  padding: 0.45rem 0.7rem;
  background: var(--rs-subtle);
  border: 1px solid var(--rs-border-light);
  border-radius: var(--rs-radius);
}
.rs-doc summary { cursor: pointer; font-weight: 600; }
.rs-doc kbd {
  font-family: var(--rs-mono);
  font-size: 0.85em;
  border: 1px solid var(--rs-border);
  border-bottom-width: 2px;
  border-radius: 3px;
  padding: 0.05em 0.35em;
}

/* The two headings above name their colours literally, as .rs-category-header
   does, so the dark theme has to answer them the same way it answers those. */
[data-theme="dark"] .rs-doc h2,
[data-theme="dark"] .rs-doc h3 {
  background: var(--rs-subtle);
  color: var(--rs-text);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .rs-doc h2,
  :root:not([data-theme="light"]) .rs-doc h3 {
    background: var(--rs-subtle);
    color: var(--rs-text);
  }
}

@media (max-width: 60rem) {
  .rs-doc { padding: 0.5rem 0 2.5rem; }
}

/* Print is the sheet, full stop. */
@media print {
  .rs-artifact-panel,
  .rs-artifact-chip {
    display: none !important;
  }
  .rs-app.rs-with-artifact {
    padding-right: 0;
  }
}
`;
