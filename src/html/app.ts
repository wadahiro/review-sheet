// Browser-side JS: Renders parameter sheet + review UI with Preact + htm
// This file is bundled by bun build and inlined into the HTML

import { h, render, type VNode } from "preact";
import { createPortal } from "preact/compat";
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "preact/hooks";
import htm from "htm";
import { getMessages, type Lang, type Messages } from "./i18n.js";
import {
  buildPromptText,
  effectiveOrigin,
  HELD_REASON_GENERATED,
  type SheetData,
  type CategoryData,
  type ParamData,
  type ReviewItem,
} from "../prompt.js";
import { buildDiffModel, rowKey, instKey, catKey, sheetKey, type DiffStatusMap } from "../diffview.js";
import type { DiffStatus } from "../diff.js";
import { pickLang, type OutOfScope, type Capabilities } from "../types.js";

const html = htm.bind(h);

// The one small muted tag a key cell may carry for its origin.
//
// For "embedded" (a literal baked into the deployable source, no variable
// behind it) the tag names the FILE the literal lives in — more useful than the
// word "embedded", and it separates populations the word collapsed: in one
// sheet, template literals and a static drop-in's directives are different
// things to change. The tag chrome itself still signals "not a normal tunable",
// and the tooltip carries the full path plus the explanation.
//
// For "default" there is no file — that IS the point — so it keeps a word.
// overlay/common render no marker: the value columns already convey those.
function originTag(param: ParamData, t: Messages): { label: string; title: string } | null {
  const origin = effectiveOrigin(param);
  if (origin === "embedded") {
    const file = param.source?.file;
    const base = file ? file.split("/").pop() : undefined;
    return { label: base ?? t.originEmbedded, title: file ? `${t.originEmbedded}: ${file}` : t.originEmbedded };
  }
  if (origin === "default") return { label: t.originDefault, title: t.originDefaultTip };
  return null;
}

// Resolve every LangText prose field (description / remarks) in a sheet tree to
// the active display language. Done once per (data, lang) at the top of Root so
// the whole downstream pipeline — rendering, search, and diff — sees plain
// strings, and flipping the language toggle re-resolves them live.
// An out-of-scope reason is prose written by the project (often in Japanese),
// so it is resolved for the active language exactly like description/remarks —
// otherwise the English UI shows a translated label in front of untranslated
// text. The owner is a team name and stays as authored.
function localizeOutOfScope(oos: OutOfScope | undefined, lang: Lang): OutOfScope | undefined {
  return oos === undefined ? undefined : { ...oos, reason: pickLang(oos.reason, lang) ?? "" };
}
function localizeParam(p: ParamData, lang: Lang): ParamData {
  if (p.label === undefined && p.description === undefined && p.remarks === undefined && p.out_of_scope === undefined) return p;
  return {
    ...p,
    label: pickLang(p.label, lang),
    description: pickLang(p.description, lang),
    remarks: pickLang(p.remarks, lang),
    out_of_scope: localizeOutOfScope(p.out_of_scope, lang),
  };
}
function localizeCategory(c: CategoryData, lang: Lang): CategoryData {
  return {
    ...c,
    // `name` is identity and is never touched; `display` is what the reader
    // sees, resolved here alongside every other LangText so the language
    // toggle switches a component's heading live — see types.ts's Category.
    display: (c.label ? pickLang(c.label, lang) : undefined) ?? c.name,
    out_of_scope: localizeOutOfScope(c.out_of_scope, lang),
    params: c.params?.map((p) => localizeParam(p, lang)),
    categories: c.categories?.map((sc) => localizeCategory(sc, lang)),
  };
}
function localizeSheets(sheets: SheetData["sheets"], lang: Lang): SheetData["sheets"] {
  return sheets.map((s) => ({ ...s, categories: s.categories.map((c) => localizeCategory(c, lang)) }));
}

// ============================================================
// Type definitions (minimal set for browser-side use)
// ============================================================

type ReviewDocument = {
  schema_version: "2.0";
  created_at: string;
  reviews: ReviewItem[];
};

type ApplyResultTarget = {
  sheet: string;
  category?: string;
  param?: string;
  instance?: string;
  field?: string;
};

type ApplyResult = {
  target: ApplyResultTarget;
  file?: string;
  status: "applied" | "skipped" | "held" | "out_of_scope";
  reason?: string;
  before?: string;
  after?: string;
  current: string;
  suggested: string;
};

type ApplyResponse = {
  results: ApplyResult[];
  applied: number;
  skipped: number;
  held: number;
  out_of_scope: number;
  heldPrompt: string;
  files: string[];
  wrote: boolean;
};

// ============================================================
// Utilities
// ============================================================

function genId(): string {
  return "rev_" + Math.random().toString(36).substring(2, 14);
}

function targetKey(t: ReviewItem["target"]): string {
  let key = t.sheet;
  if (t.category) key += "::" + t.category;
  if (t.param) key += "::" + t.param;
  if (t.instance) key += "::" + t.instance;
  // Exclude field from targetKey (cell-level lookup uses target.field separately)
  return key;
}


function copyToClipboard(value: string, btn: HTMLElement): void {
  navigator.clipboard.writeText(value).then(() => {
    const origHtml = btn.innerHTML;
    btn.classList.add("rs-copied");
    btn.innerHTML = "\u2713";
    setTimeout(() => {
      btn.classList.remove("rs-copied");
      btn.innerHTML = origHtml;
    }, 1500);
  });
}

// ============================================================
// Shared cell action toolbar
// ============================================================
// One floating toolbar for the whole table \u2014 not one per cell. Cells report the
// hovered cell into this tiny module-level store; a single CellToolbarHost reads
// it and renders the toolbar. This avoids the "afterimage" of several per-cell
// toolbars overlapping while one fades out as the next appears.

type CellToolCtx = {
  rect: DOMRect;
  target: ReviewItem["target"];
  field: string;
  effectiveValue: string;
  // See ReviewModal: the clicked cell's row stores one value for every
  // environment, so the finding's scope has to be asked rather than assumed.
  sharedRow?: boolean;
  hasReview: boolean;
  canCopy: boolean;
  reviewEnabled: boolean;
  // The cell's horizontal scroll container, so wheel/swipe over the (fixed,
  // overlaying) toolbar can be forwarded to the table beneath it.
  scroller: HTMLElement | null;
};

let cellToolSetter: ((c: CellToolCtx | null) => void) | null = null;
let cellToolTimer: ReturnType<typeof setTimeout> | undefined;
// While scrolling, cells slide under a stationary cursor and each fires
// mouseenter — which would re-show the toolbar on every frame (flicker). Suppress
// re-showing until scrolling has settled for this long.
let cellToolSuppressedUntil = 0;

function suppressCellToolWhileScrolling(): void {
  cellToolSuppressedUntil = Date.now() + 250;
  hideCellToolNow();
}

function showCellTool(c: CellToolCtx): void {
  if (Date.now() < cellToolSuppressedUntil) return;
  if (cellToolTimer) clearTimeout(cellToolTimer);
  cellToolSetter?.(c);
}
function keepCellTool(): void {
  if (cellToolTimer) clearTimeout(cellToolTimer);
}
function hideCellToolSoon(): void {
  if (cellToolTimer) clearTimeout(cellToolTimer);
  cellToolTimer = setTimeout(() => cellToolSetter?.(null), 110);
}
function hideCellToolNow(): void {
  if (cellToolTimer) clearTimeout(cellToolTimer);
  cellToolSetter?.(null);
}

// ============================================================
// localStorage persistence
// ============================================================

function getStorageKey(data: SheetData): string {
  const parts = [
    data.metadata?.project ?? "",
    data.metadata?.version ?? "",
    data.metadata?.generated_at ?? "",
  ];
  return "review-sheet:" + parts.join(":");
}

// Rows ticked off in this browser session live beside the reviews, under the
// same storage key. Working state for one reader in one browser: never
// exported, never committed. What the review produces is recorded elsewhere.
function loadSessionChecks(storageKey: string): Record<string, SessionCheck> {
  try {
    const raw = localStorage.getItem(`${storageKey}:checks`);
    return raw ? (JSON.parse(raw) as Record<string, SessionCheck>) : {};
  } catch {
    return {};
  }
}

function saveSessionChecks(storageKey: string, checks: Record<string, SessionCheck>): void {
  try {
    localStorage.setItem(`${storageKey}:checks`, JSON.stringify(checks));
  } catch {
    // storage full / disabled — the marks still work for this session
  }
}

// What a row looks like in the check column. "checked" is the reader's own
// session mark; "change_requested" is DERIVED from a pending review item, so
// the two can never disagree, and it counts as dealt-with (a reader who filed
// twenty change requests has not left twenty rows waiting).
//
// Being out of review scope is deliberately NOT one of these states. It is a
// fact about the project on another axis — and the exclusion is itself
// reviewable: "this should not be out of scope" is exactly the kind of thing a
// reviewer says. So those rows are checkable and countable like any other; the
// row stays greyed with its reason, which is what marks it as excluded.
//
// None of this is durable: the marks live in this browser, for this reader,
// while working through a long sheet. What the review actually produces is
// recorded elsewhere — review items, sheet.yml, and the commit itself.
type RowState = "undecided" | "ok" | "change_requested";

// A row ticked (or un-ticked) this session. "none" clears the tick.
type SessionCheck = { status: "ok" | "none" };

// Session marks are keyed the way a row is identified everywhere: sheet + param.
function checkKey(sheet: string, param: string): string {
  return `${sheet}::${param}`;
}

// Does this row carry a pending value change? That is what makes it
// "change requested", derived from the review layer rather than stored, so the
// two can never disagree. Matched by sheet + param, including a change filed
// against one instance of a Pattern B row.
function hasPendingValueChange(reviews: ReviewItem[], sheetName: string, paramKey: string): boolean {
  return reviews.some(
    (r) =>
      r.status === "pending" &&
      r.target.sheet === sheetName &&
      r.target.param === paramKey &&
      (r.changes ?? []).some((c) => c.field === "value")
  );
}

function rowStateOf(
  param: ParamData,
  sheetName: string,
  sessions: Record<string, SessionCheck>,
  reviews: ReviewItem[]
): RowState {
  // A change request is newer information than "I have looked at this".
  if (hasPendingValueChange(reviews, sheetName, param.key)) return "change_requested";
  return sessions[checkKey(sheetName, param.key)]?.status === "ok" ? "ok" : "undecided";
}

// Everything except "undecided" counts as dealt with.
function checkProgress(states: RowState[]): { decided: number; total: number } {
  return { decided: states.filter((s) => s !== "undecided").length, total: states.length };
}

function forEachParam(
  categories: CategoryData[] | undefined,
  visit: (param: ParamData, inheritedOutOfScope?: OutOfScope) => void,
  inherited?: OutOfScope
): void {
  for (const cat of categories ?? []) {
    const oos = cat.out_of_scope ?? inherited;
    for (const p of cat.params ?? []) visit(p, oos);
    forEachParam(cat.categories, visit, oos);
  }
}

// Every row's state in one sheet, for the progress counter: an exhaustive
// ledger is only useful if you can see how much of it is still unlooked-at.
// Only the rows the sheet is currently SHOWING. A denominator counting rows the
// reader cannot see is one they cannot reach: "0 / 6" beside five tickable rows
// never completes, and the missing one is invisible by construction. The unset
// toggle defines the document's scope, and everything follows it — body,
// outline, search, print, and this.
function sheetRowStates(
  sheet: SheetData["sheets"][number],
  sessions: Record<string, SessionCheck>,
  reviews: ReviewItem[],
  showDefaults: boolean
): RowState[] {
  const out: RowState[] = [];
  forEachParam(sheet.categories, (p) => {
    if (!showDefaults && effectiveOrigin(p) === "default") return;
    out.push(rowStateOf(p, sheet.name, sessions, reviews));
  });
  return out;
}

function loadReviews(storageKey: string): ReviewItem[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return JSON.parse(raw);
  } catch { /* empty */ }
  return [];
}

function saveReviews(storageKey: string, reviews: ReviewItem[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(reviews));
  } catch { /* empty */ }
}

// ============================================================
// Apply panel component (server mode)
// ============================================================

function ApplyPanel({ reviews, onClose, onApplied, t }: {
  reviews: ReviewItem[];
  onClose: () => void;
  onApplied: (applied: ApplyResult[]) => void;
  t: Messages;
}) {
  type PanelState =
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "preview"; data: ApplyResponse }
    | { kind: "done"; data: ApplyResponse };

  const [state, setState] = useState<PanelState>({ kind: "loading" });
  // Editable copy of the AI prompt for the held remainder (shown inline so the
  // user can tweak it before copying).
  const [promptText, setPromptText] = useState("");

  const heldPrompt = state.kind === "preview" || state.kind === "done" ? state.data.heldPrompt : "";
  useEffect(() => {
    if (heldPrompt) setPromptText(heldPrompt);
  }, [heldPrompt]);

  // Run dry-run preview on mount
  useEffect(() => {
    fetch("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviews, write: false }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ApplyResponse>;
      })
      .then((data) => setState({ kind: "preview", data }))
      .catch(() => setState({ kind: "error", message: t.applyError }));
  }, []);

  const handleWrite = useCallback(() => {
    fetch("/api/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviews, write: true }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ApplyResponse>;
      })
      .then((data) => {
        setState({ kind: "done", data });
        // Refresh the sheet to the written values and drop the now-applied
        // reviews, so the view matches what is on disk.
        onApplied(data.results.filter((r) => r.status === "applied"));
      })
      .catch(() => setState({ kind: "error", message: t.applyError }));
  }, [reviews, t, onApplied]);

  const handleOverlayClick = useCallback((e: Event) => {
    if ((e.target as HTMLElement).classList.contains("rs-overlay")) onClose();
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  function formatTarget(target: ApplyResultTarget): string {
    const parts = [target.sheet];
    if (target.category) parts.push(target.category);
    if (target.param) parts.push(target.param);
    if (target.instance) parts.push(`(${target.instance})`);
    return parts.join(" > ");
  }

  function statusLabel(status: ApplyResult["status"]): string {
    if (status === "applied") return t.statusApplied;
    if (status === "skipped") return t.statusSkipped;
    if (status === "held") return t.statusHeld;
    return t.statusOutOfScope;
  }

  function renderResults(data: ApplyResponse) {
    // Group results by file (undefined file => special key)
    const groups = new Map<string, ApplyResult[]>();
    const NO_FILE = "\0no-file";
    for (const r of data.results) {
      const key = r.file ?? NO_FILE;
      const g = groups.get(key);
      if (g) g.push(r);
      else groups.set(key, [r]);
    }

    const entries = Array.from(groups.entries());
    return entries.map(([fileKey, results]) => {
      const displayFile = fileKey === NO_FILE ? t.applyNoFile : fileKey;
      return html`
        <div class="rs-apply-group" key=${fileKey}>
          <div class="rs-apply-file">${displayFile}</div>
          ${results.map((r, i) => {
            // The core (apply.ts) always holds a generated-source value with
            // this exact English reason; the UI substitutes the translated,
            // user-facing message (also used as its tooltip) here.
            const isGenerated = r.status === "held" && r.reason === HELD_REASON_GENERATED;
            const reasonText = isGenerated ? t.applySkippedGenerated : r.reason;
            return html`
            <div class=${`rs-apply-row rs-apply-row-${r.status} ${isGenerated ? "rs-apply-row-generated" : ""}`} key=${i}
                 title=${isGenerated ? t.applySkippedGenerated : undefined}>
              <div class="rs-apply-target">${statusLabel(r.status)} · ${formatTarget(r.target)}</div>
              ${r.status === "applied" && r.before !== undefined && r.after !== undefined
                ? html`
                    <div class="rs-apply-diff">
                      <span class="rs-strikethrough">${r.before.trim()}</span>
                      <span>→</span>
                      <span class="rs-suggested">${r.after.trim()}</span>
                    </div>
                  `
                : reasonText
                  ? html`<div class="rs-apply-reason">${reasonText}</div>`
                  : null}
            </div>
          `;
          })}
        </div>
      `;
    });
  }

  const previewData = state.kind === "preview" || state.kind === "done" ? state.data : null;

  return html`
    <div class="rs-overlay" onClick=${handleOverlayClick}>
      <div class="rs-modal rs-apply-modal" role="dialog">
        <header>
          <div>
            <h4>${t.applyPreviewTitle}</h4>
          </div>
          <button class="rs-modal-close" onClick=${onClose} aria-label="${t.shortcutClose}">×</button>
        </header>

        ${previewData && html`
          <div class="rs-apply-summary">
            <span class="rs-apply-summary-chip rs-apply-chip-applied">${previewData.applied} ${t.statusApplied}</span>
            <span class="rs-apply-summary-chip rs-apply-chip-skipped">${previewData.skipped} ${t.statusSkipped}</span>
            <span class="rs-apply-summary-chip rs-apply-chip-held">${previewData.held} ${t.statusHeld}</span>
            <span class="rs-apply-summary-chip rs-apply-chip-oos">${previewData.out_of_scope} ${t.statusOutOfScope}</span>
          </div>
        `}

        <div class="rs-apply-body">
          ${state.kind === "loading" && html`<div class="rs-apply-loading">${t.applyLoading}</div>`}
          ${state.kind === "error" && html`<div class="rs-apply-error">${state.message}</div>`}
          ${state.kind === "done" && html`<div class="rs-apply-done">${t.wroteFiles(state.data.applied)}</div>`}
          ${previewData && renderResults(previewData)}
          ${previewData && previewData.applied === 0 && state.kind === "preview" && html`
            <div class="rs-apply-reason">${t.applyEmpty}</div>
          `}
          ${heldPrompt && html`
            <div class="rs-apply-held">
              <div class="rs-apply-held-head">
                <span class="rs-apply-held-title">${t.applyHeldTitle}</span>
                <button class="rs-btn-cancel" onClick=${() => navigator.clipboard.writeText(promptText).then(() => alert(t.aiPromptCopied))}>
                  ${t.applyHeldPromptCopy}
                </button>
              </div>
              <p class="rs-apply-held-hint">${t.applyHeldHint}</p>
              <textarea class="rs-apply-held-text" spellcheck=${false}
                        value=${promptText}
                        onInput=${(e: Event) => setPromptText((e.target as HTMLTextAreaElement).value)}></textarea>
            </div>
          `}
        </div>

        <div class="rs-apply-footer">
          <div></div>
          <div class="rs-apply-footer-actions">
            <button class="rs-btn-cancel" onClick=${onClose}>${t.shortcutClose}</button>
            ${state.kind !== "done" && html`
              <button class="rs-btn-primary"
                      disabled=${!previewData || previewData.applied === 0}
                      onClick=${handleWrite}>
                ${previewData ? t.applyWriteN(previewData.files.length) : t.applyPreviewTitle}
              </button>
            `}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// AI prompt modal — shows the generated prompt in an editable textarea so the
// user can tweak it before copying (used by the toolbar "AI" button).
// ============================================================

function PromptModal({ text, onClose, t }: {
  text: string;
  onClose: () => void;
  t: Messages;
}) {
  const [value, setValue] = useState(text);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleOverlayClick = useCallback((e: Event) => {
    if ((e.target as HTMLElement).classList.contains("rs-overlay")) onClose();
  }, [onClose]);

  return html`
    <div class="rs-overlay" onClick=${handleOverlayClick}>
      <div class="rs-modal rs-apply-modal" role="dialog">
        <header>
          <div><h4>${t.aiPromptTitle}</h4></div>
          <button class="rs-modal-close" onClick=${onClose} aria-label="${t.shortcutClose}">×</button>
        </header>
        <div class="rs-apply-body">
          <p class="rs-apply-held-hint">${t.aiPromptHint}</p>
          <textarea class="rs-apply-held-text" spellcheck=${false}
                    value=${value}
                    onInput=${(e: Event) => setValue((e.target as HTMLTextAreaElement).value)}></textarea>
        </div>
        <div class="rs-apply-footer">
          <div></div>
          <div class="rs-apply-footer-actions">
            <button class="rs-btn-cancel" onClick=${onClose}>${t.shortcutClose}</button>
            <button class="rs-btn-primary" onClick=${() => navigator.clipboard.writeText(value).then(() => alert(t.aiPromptCopied))}>
              ${t.applyHeldPromptCopy}
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Review modal component
// ============================================================

// field: Name of the field being reviewed ("key", "value", "default", "description", "remarks", etc.)
// currentValue: Current value of that cell
function ReviewModal({ target, field, currentValue, sharedRow, reviews, onSave, onDelete, onClose, t }: {
  target: ReviewItem["target"];
  field: string;
  currentValue: string;
  // True when the clicked cell belongs to a row with ONE stored value shown in
  // every environment column. Such a finding is ambiguous until the reviewer
  // says which they mean — this environment, or the shared value — so the modal
  // asks instead of guessing.
  sharedRow?: boolean;
  reviews: ReviewItem[];
  onSave: (review: ReviewItem) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  t: Messages;
}) {
  // Find existing review (one review per cell)
  // A shared row can hold a review at either scope, so look for both and let
  // whichever exists preselect the radio.
  const rowTarget = useMemo(() => {
    const { instance: _dropped, ...rest } = target;
    return rest;
  }, [target]);
  const existingHere = useMemo(
    () => reviews.find((r) => targetKey(r.target) === targetKey(target) && r.target.field === field),
    [reviews, target, field]
  );
  const existingShared = useMemo(
    () =>
      sharedRow && target.instance
        ? reviews.find((r) => targetKey(r.target) === targetKey(rowTarget) && r.target.field === field)
        : undefined,
    [reviews, rowTarget, field, sharedRow, target.instance]
  );
  const existing = existingHere ?? existingShared;
  const canChooseScope = !!sharedRow && !!target.instance;
  const [scopeAll, setScopeAll] = useState(!!existingShared && !existingHere);

  const existingChange = existing?.changes?.find((c) => c.field === field);

  const [suggested, setSuggested] = useState(existingChange?.suggested ?? currentValue);
  const [comment, setComment] = useState(existing?.comment ?? "");

  // Reset form when target changes
  useEffect(() => {
    setSuggested(existingChange?.suggested ?? currentValue);
    setComment(existing?.comment ?? "");
  }, [currentValue, field, target.sheet, target.category, target.param, target.instance]);

  const fieldLabels: Record<string, string> = {
    key: t.fieldKey,
    value: t.fieldValue,
    default: t.fieldDefault,
    description: t.fieldDescription,
    remarks: t.fieldRemarks,
    comment: t.fieldComment,
  };
  const fieldLabel = fieldLabels[field] ?? field;

  const targetLabel = useMemo(() => {
    const parts = [target.sheet];
    if (target.category) parts.push(target.category);
    if (target.param) parts.push(target.param);
    if (target.instance) parts.push(`(${target.instance})`);
    return parts.join(" > ");
  }, [target]);

  const handleSave = useCallback(() => {
    const valueChanged = suggested !== currentValue;
    // Moving an existing finding between "this environment" and "all
    // environments" IS the edit — it changes what the finding says — so it must
    // not be rejected as an empty submission.
    const scopeChanged =
      canChooseScope &&
      !!existing &&
      (scopeAll ? existing.target.instance !== undefined : existing.target.instance === undefined);
    if (!comment.trim() && !valueChanged && !scopeChanged) {
      alert(t.validationEmpty);
      return;
    }
    const changes: ReviewItem["changes"] = valueChanged
      ? [{ field, current: currentValue, suggested }]
      : undefined;

    // Scope "all environments" means the shared value itself, which is the
    // row-level target — the same shape this cell produced before per-cell
    // targets existed, so apply can still edit it deterministically.
    const savedTarget = canChooseScope && scopeAll ? rowTarget : target;
    const review: ReviewItem = {
      id: existing?.id ?? genId(),
      target: { ...savedTarget, field },
      changes,
      comment: comment.trim() || "",
      status: "pending",
    };
    onSave(review);
    onClose();
  }, [suggested, comment, existing, target, rowTarget, canChooseScope, scopeAll, field, currentValue, onSave, onClose, t]);

  const handleDelete = useCallback(() => {
    if (existing && confirm(t.confirmDelete)) {
      onDelete(existing.id);
      onClose();
    }
  }, [existing, onDelete, onClose]);

  const suggestedRef = useRef<HTMLTextAreaElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  // Close on ESC
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Focus on open
  useEffect(() => {
    setTimeout(() => {
      if (field !== "comment" && suggestedRef.current) {
        suggestedRef.current.focus();
        suggestedRef.current.select();
      } else if (commentRef.current) {
        commentRef.current.focus();
      }
    }, 50);
  }, [field, currentValue, target.sheet, target.category, target.param, target.instance]);

  // Save on Ctrl+Enter / Cmd+Enter
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  const handleOverlayClick = useCallback((e: Event) => {
    if ((e.target as HTMLElement).classList.contains("rs-overlay")) onClose();
  }, [onClose]);

  const showSuggestField = field !== "comment";
  const isEditing = !!existing;

  return html`
    <div class="rs-overlay" onClick=${handleOverlayClick}>
      <div class="rs-modal" role="dialog" aria-label="${t.reviewTooltip}">
        <header>
          <div>
            <h4>${fieldLabel}</h4>
            <div class="rs-modal-path">${targetLabel}</div>
          </div>
          <button class="rs-modal-close" onClick=${onClose} aria-label="${t.shortcutClose}">\u00d7</button>
        </header>

        <div class="rs-new-review">
          ${canChooseScope && html`
            <div class="rs-scope-row">
              <span class="rs-scope-hint">${t.scopeSharedHint}</span>
              <label class="rs-scope-opt">
                <input type="radio" name="rs-scope" checked=${!scopeAll} onChange=${() => setScopeAll(false)} />
                <span>${t.scopeThisEnv(target.instance ?? "")}</span>
              </label>
              <label class="rs-scope-opt">
                <input type="radio" name="rs-scope" checked=${scopeAll} onChange=${() => setScopeAll(true)} />
                <span>${t.scopeAllEnvs}</span>
              </label>
            </div>
          `}
          ${showSuggestField && html`
            <div class="rs-form-row">
              <label for="rs-suggested">${t.fieldValue} <span class="rs-hint">${t.valueLabelHint}</span></label>
              <textarea id="rs-suggested" ref=${suggestedRef} value=${suggested}
                        onInput=${(e: Event) => setSuggested((e.target as HTMLTextAreaElement).value)}
                        onKeyDown=${handleKeyDown}
                        placeholder="" rows="2"></textarea>
            </div>
          `}

          <div class="rs-form-row">
            <label for="rs-comment">${t.commentLabel}</label>
            <textarea id="rs-comment" ref=${commentRef} value=${comment}
                      onInput=${(e: Event) => setComment((e.target as HTMLTextAreaElement).value)}
                      onKeyDown=${handleKeyDown}
                      placeholder="${t.commentPlaceholder}" rows="3"></textarea>
          </div>

          <div class="rs-modal-footer">
            <span class="rs-modal-shortcuts">
              <kbd>Ctrl</kbd>+<kbd>Enter</kbd> ${t.shortcutSave}\u3000<kbd>Esc</kbd> ${t.shortcutClose}
            </span>
            <div class="rs-modal-actions">
              ${isEditing && html`<button class="rs-btn-danger" onClick=${handleDelete}>${t.delete}</button>`}
              <button class="rs-btn-primary" onClick=${handleSave}>${isEditing ? t.update : t.save}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ============================================================
// Toolbar menu (popover)
// ============================================================

// A labelled trigger button plus a panel anchored under it. Used for the two
// clusters that were previously loose icon rows: the view filters (a panel of
// labelled checkboxes, so all four states are readable at once instead of being
// guessed from four icons) and the once-per-session review actions.
//
// Deliberately small: a backdrop to catch the outside click, Escape to close,
// aria-expanded on the trigger. No portal, no focus trap, no roving arrow keys —
// every item is a real button, so tab order already works.
function ToolbarMenu({ label, title, icon, active, children }: {
  label: string;
  title?: string;
  icon?: VNode;
  active?: boolean;
  children: VNode | (VNode | null)[];
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return html`
    <div class="rs-toolbar-menu-wrap">
      <button class=${`rs-toolbar-btn rs-toolbar-btn-labelled ${active ? "rs-toolbar-btn-active" : ""}`}
              onClick=${() => setOpen(!open)} title=${title ?? label}
              aria-haspopup="true" aria-expanded=${open}>
        ${icon ?? null}<span class="rs-btn-label">${label}</span>
        <svg class="rs-btn-caret" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      ${open && html`
        <div class="rs-of-backdrop" onClick=${() => setOpen(false)}></div>
        <div class="rs-of-menu rs-toolbar-menu" onClick=${(e: Event) => e.stopPropagation()}>${children}</div>
      `}
    </div>
  `;
}

// A labelled checkbox row inside a ToolbarMenu: the panel stays open so several
// filters can be set in one visit.
function MenuCheck({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) {
  return html`
    <label class="rs-menu-check">
      <input type="checkbox" checked=${checked} onChange=${onToggle} />
      <span>${label}</span>
    </label>
  `;
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return html`<button class=${`rs-menu-item ${danger ? "rs-menu-item-danger" : ""}`} onClick=${onClick}>${label}</button>`;
}

// ============================================================
// Review decision (判定) controls
// ============================================================

// The cell of the check column: a button for "I have looked at this", toggled
// in a single click, because a pass over an exhaustive sheet IS several hundred
// of those. Session-local — nothing here is written anywhere. The two derived
// states render as plain text: neither is toggled from here (an exclusion is
// authored in sheet.yml, a change request is resolved by editing the change),
// so neither should look like a control.
function DecisionCell({ state, paramKey, onToggleOk, t }: {
  state: RowState;
  paramKey: string;
  onToggleOk: () => void;
  t: Messages;
}) {
  // A change request is not toggled from here — it is resolved by editing or
  // withdrawing the change — so it renders as plain muted text. Whatever renders
  // as a control IS a control.
  if (state === "change_requested") {
    return html`<span class="rs-decision-derived">${t.decisionChangeRequested}</span>`;
  }

  // A native checkbox: this repeats down hundreds of rows, so it has to be the
  // quietest mark that still reads as a control — a bordered pill with a word in
  // it turns the column into noise. Empty boxes ARE the "what is left" display.
  // The label makes the whole cell the hit area (see styles.ts).
  const checked = state === "ok";
  return html`
    <label class="rs-check" title=${checked ? t.decisionClear : t.decisionMarkOk}>
      <input type="checkbox" checked=${checked} onChange=${onToggleOk}
             aria-label=${`${t.checkHeader}: ${paramKey}`} />
    </label>
  `;
}

// ============================================================
// Reviewable cell component
// ============================================================

function ReviewableCell({ value, target, field, reviews, reviewEnabled, onOpenReview, className, isCode, badge, subline, unsetLabel, sharedRow }: {
  value: string;
  target: ReviewItem["target"];
  field: string;
  reviews: ReviewItem[];
  reviewEnabled: boolean;
  onOpenReview: (target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => void;
  className?: string;
  isCode?: boolean;
  badge?: VNode | null;
  // Optional muted line(s) under the value (e.g. the key cell's backing
  // provenance identity, an origin tag, or an out-of-scope reason). A single
  // cell can stack more than one, hence the array form.
  subline?: VNode | (VNode | null)[] | null;
  // Shown in place of an empty value when nothing is set here and the product's
  // default applies. A label, not a value — so it is rendered as a tag rather
  // than as code, and a suggestion replaces it rather than being appended to it.
  unsetLabel?: string;
  // Passed straight through to the review modal (see CellToolCtx.sharedRow).
  sharedRow?: boolean;
}) {
  // A shared-scope review lives on the row target, so a shared row's cells match
  // BOTH: their own environment target and the row's. That is what makes an
  // "all environments" finding visible in every environment column — and it is
  // also how the Compare overlay's synthetic reviews (diffview.ts emits row
  // targets for changed common values) keep rendering.
  const altTargetKey = sharedRow ? targetKey({ ...target, instance: undefined }) : undefined;
  const cellReviews = reviews.filter((r) => {
    const k = targetKey(r.target);
    if (k !== targetKey(target) && k !== altTargetKey) return false;
    return r.target.field === field;
  });
  const hasReview = cellReviews.length > 0;
  // Reflect suggested value from review on screen. A suggestion may be the empty
  // string (a proposal to DELETE/clear the value) — that is a real change, so
  // test for presence with `!== undefined`, not truthiness, and render the
  // now-empty value with a ∅ placeholder so the deletion is visible.
  const suggestedVal = hasReview
    ? cellReviews[0].changes?.find((c) => c.field === field)?.suggested
    : undefined;
  const hasSuggestion = suggestedVal !== undefined;
  // Value for copy/modal: use suggested value if available
  const effectiveValue = suggestedVal ?? value;

  // The "nothing is set here" label stands in for the empty value, so a
  // suggestion strikes through the LABEL — writing a value into this cell means
  // it stops using the default, which is exactly what the reviewer is proposing.
  const showUnsetLabel = !!unsetLabel && value === "";
  const current = showUnsetLabel
    ? html`<span class=${`rs-unset-label ${hasSuggestion ? "rs-strikethrough" : ""}`}>${unsetLabel}</span>`
    : isCode
      ? html`<code class=${hasSuggestion ? "rs-strikethrough" : ""}>${value}</code>`
      : hasSuggestion
        ? html`<span class="rs-strikethrough">${value}</span>`
        : value;

  const displayValue = hasSuggestion
    ? (isCode
      ? html`${current} <code class="rs-suggested">${suggestedVal || "∅"}</code>`
      : html`${current} <span class="rs-suggested">${suggestedVal || "∅"}</span>`)
    : current;

  // Copy is offered on any non-empty cell (every value is worth copying); the
  // suggest action only when review is enabled.
  const canCopy = value.length > 0;
  const showActions = canCopy || reviewEnabled;

  // The primary gesture is to open the review dialog. Double-clicking the cell
  // does the same as the toolbar's "Suggest" — a big, familiar target (the
  // spreadsheet idiom) — so we clear any accidental word-selection first.
  const openSuggest = (): void => {
    try { window.getSelection()?.removeAllRanges(); } catch { /* noop */ }
    onOpenReview(target, field, effectiveValue, sharedRow);
  };

  // Report this cell to the single shared toolbar on hover (no per-cell toolbar,
  // so there is never more than one on screen).
  const tdRef = useRef<HTMLTableCellElement | null>(null);
  const reportHover = (): void => {
    const el = tdRef.current;
    if (!el) return;
    const scroller = el.closest(".rs-table-wrapper") as HTMLElement | null;
    showCellTool({ rect: el.getBoundingClientRect(), target, field, effectiveValue, sharedRow, hasReview, canCopy, reviewEnabled, scroller });
  };

  return html`
    <td ref=${tdRef}
        class=${`${className ?? ""} ${hasReview ? "rs-cell-has-review" : ""}`}
        onDblClick=${reviewEnabled ? openSuggest : undefined}
        onMouseEnter=${showActions ? reportHover : undefined}
        onMouseLeave=${showActions ? hideCellToolSoon : undefined}>
      <div class="rs-value-cell">
        <span class="rs-cell-content">${displayValue}${badge}</span>
        ${subline}
      </div>
    </td>
  `;
}

// The single shared toolbar host: reads the hovered-cell store and renders one
// floating toolbar, portaled to <body> and clamped into the viewport.
function CellToolbarHost({ onOpenReview, t }: {
  onOpenReview: (target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => void;
  t: Messages;
}) {
  const [ctx, setCtx] = useState<CellToolCtx | null>(null);
  // Dismiss on scroll/resize so the fixed toolbar can't drift from its cell, and
  // suppress re-showing until scrolling settles (otherwise cells sliding under a
  // stationary cursor re-trigger hover every frame → flicker). One persistent
  // listener so suppression keeps refreshing across the whole scroll gesture.
  useEffect(() => {
    cellToolSetter = setCtx;
    const onScroll = (): void => suppressCellToolWhileScrolling();
    const onResize = (): void => hideCellToolNow();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      cellToolSetter = null;
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  if (!ctx) return null;
  const top = Math.max(4, Math.min(ctx.rect.top + 4, window.innerHeight - 44));
  const right = Math.max(8, window.innerWidth - ctx.rect.right + 6);
  const openSuggest = (): void => {
    try { window.getSelection()?.removeAllRanges(); } catch { /* noop */ }
    onOpenReview(ctx.target, ctx.field, ctx.effectiveValue, ctx.sharedRow);
    hideCellToolNow();
  };

  return createPortal(
    html`
      <div class="rs-cell-toolbar" role="toolbar" aria-label="${t.cellActions}"
           style=${`top:${top}px;right:${right}px`}
           onMouseEnter=${keepCellTool} onMouseLeave=${hideCellToolSoon}
           onWheel=${(e: WheelEvent) => {
             // The toolbar is a fixed overlay, so the browser would scroll the
             // viewport (and on horizontal swipe, trigger back-nav). Forward
             // horizontal intent to the table's own scroll container; leave
             // vertical scrolling to the page.
             const sc = ctx.scroller;
             if (sc && Math.abs(e.deltaX) > Math.abs(e.deltaY) && sc.scrollWidth > sc.clientWidth) {
               sc.scrollLeft += e.deltaX;
               e.preventDefault();
             }
           }}>
        ${ctx.reviewEnabled && html`
          <button class="rs-tool rs-tool-suggest ${ctx.hasReview ? "rs-tool-on" : ""}"
                  onClick=${openSuggest}
                  title="${t.reviewTooltip}" aria-label="${t.reviewTooltip}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
            <span class="rs-tool-label">${ctx.hasReview ? t.suggestEdit : t.suggest}</span>
          </button>
        `}
        ${ctx.canCopy && ctx.reviewEnabled && html`<span class="rs-tool-sep" aria-hidden="true"></span>`}
        ${ctx.canCopy && html`
          <button class="rs-tool rs-tool-copy" onClick=${(e: Event) => copyToClipboard(ctx.effectiveValue, e.currentTarget as HTMLElement)} title="${t.copyTooltip}" aria-label="${t.copyTooltip}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="rs-tool-label">${t.copyLabel}</span>
          </button>
        `}
      </div>
    `,
    document.body
  );
}

// Format an ISO timestamp (e.g. "2026-06-18T09:00:00Z") in the viewer's local
// time zone, using a locale-neutral ISO-8601-style string ("2026-06-18 18:00:00
// +09:00"). This avoids ambiguous locale formats (e.g. US "06/18/2026, 6:00 PM")
// while still showing the viewer's local time. Falls back to the raw string if
// it is not a parseable date.
function formatTimestamp(value: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, "0");
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // Local UTC offset, e.g. "+09:00" for JST, "Z" for UTC.
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const offset = offMin === 0 ? "Z" : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${date} ${time} ${offset}`;
}

// ============================================================
// Per-table view preferences (persisted in localStorage)
// ============================================================

type TableViewPrefs = { view?: "normal" | "transposed"; freeze?: number };

const VIEW_PREFS_KEY = "rs-table-view-prefs:v1";

// Namespace prefs per document so different sheets opened from disk do not share
// table identities that happen to collide.
function viewPrefsNamespace(): string {
  return `${location.pathname}::${document.title}`;
}

function readAllViewPrefs(): Record<string, Record<string, TableViewPrefs>> {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Record<string, TableViewPrefs>>) : {};
  } catch {
    return {};
  }
}

function loadTablePrefs(tableId: string): TableViewPrefs {
  return readAllViewPrefs()[viewPrefsNamespace()]?.[tableId] ?? {};
}

function saveTablePrefs(tableId: string, prefs: TableViewPrefs): void {
  try {
    const all = readAllViewPrefs();
    const ns = viewPrefsNamespace();
    all[ns] = { ...(all[ns] ?? {}), [tableId]: { ...(all[ns]?.[tableId] ?? {}), ...prefs } };
    localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(all));
  } catch {
    // localStorage unavailable (private mode, disabled, file:// restrictions)
  }
}

function loadOutlineOpen(): boolean {
  try { return localStorage.getItem("rs-outline-open") === "1"; } catch { return false; }
}

function saveOutlineOpen(open: boolean): void {
  try { localStorage.setItem("rs-outline-open", open ? "1" : "0"); } catch { /* ignore */ }
}


// ============================================================
// Parameter table component
// ============================================================

function ParamTable({ params, sheetName, sheetInstances, sheetIndex, categoryPath, depth, columns, reviews, reviewEnabled, showComments, filterCommented, hideOutOfScope, showDefaults, filterUndecided, sessionChecks, decisionsEnabled, onDecide, categoryOutOfScope, onOpenReview, diff, t }: {
  params: ParamData[];
  sheetName: string;
  // The sheet's declared review axis (see Sheet.instances).
  sheetInstances?: string[];
  sheetIndex: number;
  categoryPath: string;
  depth: number;
  columns?: SheetData["columns"];
  reviews: ReviewItem[];
  reviewEnabled: boolean;
  showComments: boolean;
  filterCommented: boolean;
  hideOutOfScope: boolean;
  showDefaults: boolean;
  filterUndecided: boolean;
  sessionChecks: Record<string, SessionCheck>;
  decisionsEnabled: boolean;
  onDecide: (sheet: string, paramKey: string, next: SessionCheck | null) => void;
  // The nearest enclosing category's effective out-of-scope (already resolved
  // for its own ancestry) — applies to a param that sets no `out_of_scope` of
  // its own (nearest-wins: a param-level flag overrides the category's).
  categoryOutOfScope?: OutOfScope;
  onOpenReview: (target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => void;
  diff?: DiffStatusMap;
  t: Messages;
}) {
  // Diff overlay helpers (no-op when not comparing).
  const rowDiff = (key: string): DiffStatus | undefined => diff?.get(rowKey(sheetName, categoryPath, key));
  const instDiff = (key: string, name: string): DiffStatus | undefined => diff?.get(instKey(sheetName, categoryPath, key, name));
  // Columns come from the sheet's DECLARED axis first, then any instance a row
  // actually carries (a diff can introduce one the declaration never had).
  // Declaring it matters: a category where every value happens to be shared
  // would otherwise render single-column, and a reviewer could not say
  // "production should override this" about any row in it.
  const instanceNames = (() => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const n of sheetInstances ?? []) if (!seen.has(n)) { seen.add(n); names.push(n); }
    for (const p of params) for (const i of p.instances ?? []) if (!seen.has(i.name)) { seen.add(i.name); names.push(i.name); }
    return names;
  })();
  const hasInstances = instanceNames.length > 0;

  // Per-table view preferences, restored from localStorage and persisted on
  // change so a reviewer's layout choices survive a reload. Identified by
  // sheet + category path (unique per table). Hooks are declared unconditionally
  // to satisfy the rules of hooks.
  const tableId = `${sheetName}\u0000${categoryPath}`;
  const hasAnyDescription = params.some((p) => p.description);

  // View orientation for Pattern B tables. Default "normal" (rows = parameters,
  // columns = instances); "transposed" swaps the axes for easier comparison.
  const [view, setView] = useState<"normal" | "transposed">(() => loadTablePrefs(tableId).view ?? "normal");

  // How many leading metadata columns (key / description / default) stay frozen
  // while scrolling the wide view horizontally. 1 = key only, 2 = + description,
  // 3 = + default, 0 = none. Default freezes key + description.
  const [freezeLevel, setFreezeLevel] = useState<number>(() => loadTablePrefs(tableId).freeze ?? (hasAnyDescription ? 2 : 1));

  // Persist orientation / freeze depth, but only for instance tables (the only
  // ones that expose these controls).
  useEffect(() => {
    if (!hasInstances) return;
    saveTablePrefs(tableId, { view, freeze: freezeLevel });
  }, [hasInstances, tableId, view, freezeLevel]);

  // Detect horizontal overflow. Tables that fit stay in document flow (CSS
  // sticky header); tables wider than the viewport switch to an internal
  // horizontal scrollbar and get a JS following header instead.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  // Pattern B normal view uses a split header (sticky overlay + scrolling body)
  // so its column header can stay put during both vertical and horizontal scroll.
  const splitHeader = hasInstances && view === "normal";
  useEffect(() => {
    if (splitHeader) return; // the split body manages its own horizontal scroll
    const el = wrapperRef.current;
    if (!el) return;
    const check = () => {
      setOverflowing(el.scrollWidth - el.clientWidth > 1);
      // These tables size their leading columns to content (auto layout), but the
      // sticky freeze offsets read fixed --rs-w-* variables. Sync the variables to
      // the columns' actual rendered widths so each frozen column begins exactly
      // where the previous one ends (no gap, no overlap).
      const tbl = el.querySelector("table");
      if (tbl instanceof HTMLElement) {
        const keyCell = tbl.querySelector("tbody .rs-col-key");
        const descCell = tbl.querySelector("tbody .rs-col-description");
        if (keyCell instanceof HTMLElement) {
          tbl.style.setProperty("--rs-w-key", `${keyCell.getBoundingClientRect().width}px`);
        }
        if (descCell instanceof HTMLElement) {
          tbl.style.setProperty("--rs-w-desc", `${descCell.getBoundingClientRect().width}px`);
        }
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [splitHeader, freezeLevel, filterCommented, t]);

  // Keep the split sticky header aligned with the body's horizontal scroll.
  useEffect(() => {
    if (!splitHeader) return;
    const body = wrapperRef.current;
    const head = headRef.current;
    if (!body || !head) return;
    const sync = () => { head.scrollLeft = body.scrollLeft; };
    body.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => body.removeEventListener("scroll", sync);
  }, [splitHeader, freezeLevel, filterCommented, t]);

  const getReviewCount = (target: ReviewItem["target"]): number => {
    return reviews.filter((r) => targetKey(r.target) === targetKey(target)).length;
  };

  // All reviews attached to a parameter row, including ones on a specific
  // instance value (Pattern B). targetKey embeds the instance, so an instance
  // comment never equals the param-level key; match the param prefix instead.
  // The trailing "::" guard prevents "foo" from also matching "foobar".
  const getParamReviews = (param: ParamData): ReviewItem[] => {
    const baseKey = targetKey(baseTarget(param));
    return reviews.filter((r) => {
      const k = targetKey(r.target);
      return k === baseKey || k.startsWith(baseKey + "::");
    });
  };

  // Reviews for a single cell (target + field). targetKey omits the field, so
  // match it separately to keep e.g. a description and a default comment apart.
  const getCellReviews = (target: ReviewItem["target"], field: string): ReviewItem[] =>
    reviews.filter((r) => targetKey(r.target) === targetKey(target) && (r.target.field ?? "") === field);

  // A comment strip spanning colSpan columns. Each entry carries an optional
  // label (the instance in normal view, the parameter in the transposed view)
  // so a per-cell remark is attributed to the right axis.
  const renderCommentRow = (colSpan: number, items: { rev: ReviewItem; label?: string }[]) => {
    if (!showComments || items.length === 0) return null;
    return html`
      <tr class="rs-inline-comment-row">
        <td colspan=${colSpan}>
          <div class="rs-inline-comments">
            ${items.map(({ rev, label }) => html`
              <div class="rs-inline-comment" key=${rev.id}>
                ${label ? html`<span class="rs-ic-inst">${label}</span>` : null}
                ${rev.changes && rev.changes.length > 0
                  ? rev.changes.map((c) => html`<span class="rs-ic-badge">${c.field}: ${c.current ?? ""} \u2192 ${c.suggested}</span>`)
                  : html`<span class="rs-ic-badge rs-ic-note">${t.memo}</span>`
                }
                <span class="rs-ic-text">${rev.comment}</span>
              </div>
            `)}
          </div>
        </td>
      </tr>
    `;
  };

  // Normal view: one strip under each parameter row, labeled by instance.
  const renderInlineComments = (param: ParamData, colSpan: number) =>
    renderCommentRow(colSpan, getParamReviews(param).map((rev) => ({ rev, label: rev.target.instance })));

  // A param's effective out-of-scope: its own flag wins; otherwise it inherits
  // the nearest enclosing category's (nearest-wins).
  const rowOutOfScope = (param: ParamData): OutOfScope | undefined => param.out_of_scope ?? categoryOutOfScope;

  const stateOf = (param: ParamData): RowState => rowStateOf(param, sheetName, sessionChecks, reviews);

  const toggleOk = (param: ParamData): void => {
    onDecide(sheetName, param.key, stateOf(param) === "ok" ? { status: "none" } : { status: "ok" });
  };

  // Visible params under the "commented only" / "hide out-of-scope" /
  // "undecided only" filters.
  const visibleParams = params.filter((param) => {
    // A row nobody set, sitting at the product's own default. Hidden unless
    // asked for: on a sheet whose dictionary is a full extraction these are the
    // majority (121 of 144 on one Keycloak sheet), and the reader's first
    // question is what this project DECIDED. They live in their ordinary
    // category rather than a tree of their own, so turning them on puts each
    // one beside the settings it relates to.
    if (!showDefaults && effectiveOrigin(param) === "default") return false;
    if (hideOutOfScope && rowOutOfScope(param)) return false;
    // The triage loop: show what still needs a decision, click through it,
    // watch it empty out.
    if (filterUndecided && stateOf(param) !== "undecided") return false;
    if (filterCommented) {
      const rowTarget = { sheet: sheetName, category: categoryPath, param: param.key };
      return (
        getReviewCount(rowTarget) > 0 ||
        (param.instances ?? []).some((inst) => getReviewCount({ ...rowTarget, instance: inst.name }) > 0)
      );
    }
    return true;
  });

  // Under a filter a category can end up with nothing to show; render nothing
  // rather than an empty table (a materialized sheet has dozens of categories).
  if (visibleParams.length === 0) return null;

  const baseTarget = (param: ParamData): ReviewItem["target"] => ({ sheet: sheetName, category: categoryPath, param: param.key });

  const paramHasReview = (param: ParamData): boolean => {
    const rowTarget = baseTarget(param);
    return (
      getReviewCount(rowTarget) > 0 ||
      (param.instances ?? []).some((inst) => getReviewCount({ ...rowTarget, instance: inst.name }) > 0)
    );
  };

  // Unified cell-matrix model. Pattern A is treated as "Pattern B with a single
  // unnamed value": one canonical set of lines (description / default / values /
  // remarks / custom) drives both the wide (normal) and transposed views, with
  // the parameter as the other axis. "values" expands to one column per instance
  // (Pattern B) or a single "value" column (Pattern A).
  type CellSpec =
    | { kind: "review"; value: string; target: ReviewItem["target"]; field: string; className: string; isCode: boolean; copyable: boolean; unsetLabel?: string; sharedRow?: boolean }
    | { kind: "plain"; content: string | VNode; className: string; style: string };

  type TableLine = {
    key: string;
    label: string;
    lineKind: "attr" | "instance" | "value";
    colClass: string;
    colStyle: string;
    freezePos?: number;
    cell: (param: ParamData) => CellSpec;
  };

  const descPresent = visibleParams.some((p) => p.description);
  const remarksPresent = visibleParams.some((p) => p.remarks);

  // Leading metadata lines (freeze-eligible): description (col 2) and default.
  const leadingLines: TableLine[] = [];
  if (descPresent) {
    leadingLines.push({
      key: "__description", label: t.descriptionHeader, lineKind: "attr", colClass: "rs-col-description", colStyle: "", freezePos: 2,
      cell: (param) => ({ kind: "review", value: pickLang(param.description, "en") ?? "", target: baseTarget(param), field: "description", className: "rs-col-description", isCode: false, copyable: false }),
    });
  }
  leadingLines.push({
    key: "__default", label: t.defaultValue, lineKind: "attr", colClass: "rs-col-default", colStyle: "", freezePos: descPresent ? 3 : 2,
    cell: (param) => ({ kind: "review", value: param.default ?? "-", target: baseTarget(param), field: "default", className: "rs-col-default", isCode: true, copyable: false }),
  });

  // Value lines: one per instance (Pattern B) or a single value column (Pattern A).
  const valueLines: TableLine[] = hasInstances
    ? instanceNames.map((name) => ({
        key: `inst:${name}`, label: name, lineKind: "instance", colClass: "rs-col-value", colStyle: "",
        cell: (param) => {
          // Background encodes ONE thing: does the value differ from the product
          // default? (yellow rs-changed = differs). Origin is a separate channel:
          //   - rs-cell-unset ("—", no background) = equals the default and this
          //     environment does not set it — the default applies.
          //   - rs-cell-common (border + muted, layered on yellow) = a common
          //     value (Pattern A) that differs from the default: not a per-env
          //     edit, but its effective value is shown so it isn't hidden.
          const def = param.default ?? "";
          const isB = !!(param.instances && param.instances.length > 0);
          if (isB) {
            // Pattern B: an explicit per-environment value (build.ts emits one
            // instance per environment).
            const inst = param.instances!.find((i) => i.name === name);
            const value = inst?.value ?? "";
            const isSameAsDefault = value === def;
            const id = instDiff(param.key, name);
            // In diff mode, an instance not present in this row's union is a
            // blank gap; tint added/removed/changed cells.
            const diffCls = id && id !== "unchanged" ? `rs-diff-cell-${id}` : (diff && !inst ? "rs-diff-cell-absent" : "");
            // Equals the default AND empty → the environment leaves it at the
            // (empty) default: render as unset "—" rather than a blank cell.
            const cls = isSameAsDefault ? (value === "" ? "rs-cell-unset" : "rs-same-as-default") : "rs-changed";
            return { kind: "review", value, target: { ...baseTarget(param), instance: name }, field: "value", className: `rs-col-value ${cls} ${diffCls}`, isCode: true, copyable: value.length > 0, unsetLabel: t.usesDefault };
          }
          // Pattern A: one stored value, shown in every environment column. The
          // cell still targets ITS environment, because a review here is a
          // statement about that environment's effective configuration
          // ("production should override this"), not about where the value is
          // stored. Saying it for every environment at once is the modal's
          // "all environments" scope, which drops the instance again.
          const common = param.value ?? "";
          if (rowOutOfScope(param)) {
            // e.g. a secret — shown read-only; the out-of-scope row styling wins.
            return { kind: "review", value: common, target: { ...baseTarget(param), instance: name }, field: "value", className: "rs-col-value rs-same-as-default", isCode: true, copyable: false, sharedRow: true };
          }
          // "Nothing is set here" and "what is set equals the default" are two
          // different facts, and only the first one is `usesDefault`. This used
          // to test `common === def` alone, which blanked the cell of a
          // deliberately written directive whenever its value happened to match
          // the product's — httpd's `ProxyRequests Off`, a line that exists to
          // say this host is NOT a forward proxy, read as "not set" and left a
          // reviewer to work the truth out of the remarks. `origin` is the fact
          // that decides it, and the model has carried it all along.
          const isUnset = effectiveOrigin(param) === "default";
          const isSameAsDefault = common === def;
          return {
            kind: "review",
            value: isUnset ? "" : common,
            target: { ...baseTarget(param), instance: name },
            field: "value",
            className: `rs-col-value ${isUnset ? "rs-cell-unset" : isSameAsDefault ? "rs-same-as-default" : "rs-changed rs-cell-common"}`,
            isCode: true,
            copyable: !isUnset,
            unsetLabel: t.usesDefault,
            sharedRow: true,
          };
        },
      }))
    : [{
        key: "__value", label: t.setValue, lineKind: "value", colClass: "rs-col-value", colStyle: "",
        cell: (param) => {
          const value = param.value ?? "";
          const isSameAsDefault = value === (param.default ?? "");
          return { kind: "review", value, target: baseTarget(param), field: "value", className: `rs-col-value ${isSameAsDefault ? "rs-same-as-default" : "rs-changed"}`, isCode: true, copyable: true };
        },
      }];

  // Trailing attribute lines: remarks then any author-defined custom columns.
  const trailingLines: TableLine[] = [];
  if (remarksPresent) {
    trailingLines.push({
      key: "__remarks", label: t.remarksHeader, lineKind: "attr", colClass: "rs-col-remarks", colStyle: "",
      cell: (param) => ({ kind: "review", value: pickLang(param.remarks, "en") ?? "", target: baseTarget(param), field: "remarks", className: "rs-col-remarks", isCode: false, copyable: false }),
    });
  }
  // "under_key" columns are not columns at all — they render as a muted sub-line
  // inside the key cell (see keySubline). Only trailing columns get their own cell.
  const trailingCols = (columns ?? []).filter((c) => c.place !== "under_key");
  const underKeyCols = (columns ?? []).filter((c) => c.place === "under_key");
  trailingCols.forEach((col) => {
    trailingLines.push({
      key: `col:${col.field}`, label: col.header, lineKind: "attr", colClass: col.className ?? "", colStyle: col.width ? `width:${col.width}` : "",
      cell: (param) => {
        const val = resolveColumnValue(param, col.field);
        return { kind: "plain", content: renderColumnValue(col, val), className: `${col.className ?? ""} ${col.render === "status" ? `rs-status-${val}` : ""}`, style: col.align ? `text-align:${col.align}` : "" };
      },
    });
  });

  // The session checkmark gets its OWN column rather than a chip stacked under
  // the key: in the key cell it sat next to the origin tag, which is styled the
  // same way but is not interactive — same visual language, different
  // affordance. A labelled column says what it is, and only the rows you can
  // actually tick render a button (an excluded row or one with a change request
  // shows plain text, since neither is the reader's to toggle here).
  if (decisionsEnabled) {
    trailingLines.push({
      key: "__check",
      label: t.checkHeader,
      lineKind: "attr",
      colClass: "rs-col-check",
      colStyle: "",
      cell: (param) => ({
        kind: "plain",
        content: html`<${DecisionCell} state=${stateOf(param)} paramKey=${param.key}
                                       onToggleOk=${() => toggleOk(param)} t=${t} />` as VNode,
        className: "rs-col-check",
        style: "",
      }),
    });
  }

  // Normal columns:  key, description, default, values, remarks, custom.
  const normalLines = [...leadingLines, ...valueLines, ...trailingLines];
  // Transposed rows: attributes grouped first, then instances.
  const transposedLines = [...leadingLines, ...trailingLines, ...valueLines];

  const renderCell = (spec: CellSpec, cellKey: string) =>
    spec.kind === "review"
      ? html`<${ReviewableCell} key=${cellKey} value=${spec.value} target=${spec.target} field=${spec.field}
          reviews=${reviews} reviewEnabled=${reviewEnabled} onOpenReview=${onOpenReview}
          className=${spec.className} isCode=${spec.isCode} copyable=${spec.copyable}
          unsetLabel=${spec.unsetLabel} sharedRow=${spec.sharedRow} t=${t} />`
      : html`<td key=${cellKey} class=${spec.className} style=${spec.style}>${spec.content}</td>`;

  // Freeze boundary (normal view): pin icons in the leading-column headers.
  const maxFreeze = descPresent ? 3 : 2;
  const effFreeze = Math.max(0, Math.min(freezeLevel, maxFreeze));
  const colHeader = (label: string, colClass: string, colStyle: string, freezePos?: number) => {
    if (freezePos === undefined) return html`<th class=${colClass} style=${colStyle}>${label}</th>`;
    const frozen = effFreeze >= freezePos;
    return html`
      <th class=${`${colClass} ${frozen ? "rs-col-frozen" : ""}`} style=${colStyle}>
        <div class="rs-th-inner">
          <span>${label}</span>
          <button type="button" class=${`rs-pin ${frozen ? "rs-pin-on" : ""}`}
                  aria-pressed=${frozen} title=${frozen ? t.unfreezeColumnTip : t.freezeColumnTip}
                  onClick=${() => setFreezeLevel(effFreeze === freezePos ? freezePos - 1 : freezePos)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill=${frozen ? "currentColor" : "none"} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
          </button>
        </div>
      </th>
    `;
  };

  // Normal orientation: rows = parameters, columns = values (+ leading/trailing).
  const normalHeaderRow = html`
    <tr>
      ${colHeader(t.paramName, "rs-col-key", "", 1)}
      ${normalLines.map((line) => colHeader(line.label, line.colClass, line.colStyle, line.freezePos))}
    </tr>`;
  const normalBody = visibleParams.map((param) => {
    const rd = rowDiff(param.key);
    // Legibility: at most one badge-style marker per row. "Out of scope" is now
    // row-level muting + a visible inline reason line (not a badge), so the only
    // badge left here is the diff status.
    const rowBadge = diff ? diffBadge(rd) : null;
    // Provenance sub-line (under_key columns, e.g. the backing Ansible variable).
    const sublineText = underKeyCols
      .map((col) => resolveColumnValue(param, col.field))
      .filter((v) => v.length > 0)
      .join(" · ");
    // Nearest-wins: a param-level out_of_scope overrides the category's;
    // otherwise the enclosing (possibly out-of-scope) category's applies.
    const oos = rowOutOfScope(param);
    const tag = originTag(param, t);
    // The product's own name for this setting, when it has one. Shown as the
    // row's heading with the KEY demoted to a sub-line, because those are two
    // different jobs: the label is what a reviewer recognises (Keycloak's
    // console says 「署名アルゴリズム」), the key is where the value lives
    // (`attributes["saml.signature.algorithm"]`, which verify and apply
    // resolve by) and can never be dropped.
    //
    // A label that merely repeats the description is not shown twice — 18 of
    // this Keycloak extraction's fields carry a name and no help text, so
    // their description IS the label.
    const label = typeof param.label === "string" ? param.label : undefined;
    const keySubline: (VNode | null)[] = [];
    if (label) keySubline.push(html`<span class="rs-key-subline"><code>${param.key}</code></span>` as VNode);
    if (sublineText) keySubline.push(html`<span class="rs-key-subline"><code>${sublineText}</code></span>` as VNode);
    if (tag) keySubline.push(html`<span class="rs-key-subline"><span class="rs-origin-tag" title=${tag.title}>${tag.label}</span></span>` as VNode);
    if (oos) {
      keySubline.push(html`
        <span class="rs-key-subline rs-oos-reason">
          ${t.outOfScope}: ${oos.reason}${oos.owner ? html` · ${t.outOfScopeOwner}${oos.owner}` : null}
        </span>
      ` as VNode);
    }
    return html`
    <tr key=${param.key} id=${paramAnchorId(sheetIndex, categoryPath, param.key)}
        class=${`rs-param-row ${oos ? "rs-row-excluded" : ""} ${paramHasReview(param) ? "rs-has-review" : ""} ${rd && rd !== "unchanged" ? `rs-diff-row-${rd}` : ""}`}>
      <${ReviewableCell} value=${label ?? param.key} target=${baseTarget(param)} field="key"
        reviews=${reviews} reviewEnabled=${reviewEnabled} onOpenReview=${onOpenReview}
        className="rs-col-key" isCode=${!label} t=${t} badge=${rowBadge} subline=${keySubline.length > 0 ? keySubline : null} />
      ${normalLines.map((line) => renderCell(line.cell(param), line.key))}
    </tr>
    ${renderInlineComments(param, 1 + normalLines.length)}
  `;
  });

  const renderNormal = () => splitHeader
    // Pattern B: split the table so the column header can stick (and the body
    // scroll horizontally). table-layout: fixed gives both halves identical
    // column widths; JS syncs the header's horizontal offset to the body.
    ? html`
      <div class="rs-table-split">
        <div class="rs-sticky-head" ref=${headRef}>
          <table class=${`rs-param-table rs-param-table-wide rs-param-table-fixed rs-freeze-${effFreeze}`}>
            <thead>${normalHeaderRow}</thead>
          </table>
        </div>
        <div class="rs-table-wrapper rs-split-body" ref=${wrapperRef}>
          <table class=${`rs-param-table rs-param-table-wide rs-param-table-fixed rs-freeze-${effFreeze}`}>
            <tbody>${normalBody}</tbody>
          </table>
        </div>
      </div>
    `
    : html`
      <div class=${`rs-table-wrapper ${overflowing ? "rs-overflowing" : ""}`} ref=${wrapperRef}>
        <table class=${`rs-param-table rs-param-table-wide rs-freeze-${effFreeze}`}>
          <thead>${normalHeaderRow}</thead>
          <tbody>${normalBody}</tbody>
        </table>
      </div>
    `;

  // Transposed orientation (instance tables only): rows = lines, columns = params.
  const renderTransposed = () => html`
    <div class=${`rs-table-wrapper ${overflowing ? "rs-overflowing" : ""}`} ref=${wrapperRef}>
      <table class="rs-param-table rs-param-table-transposed">
        <thead>
          <tr>
            <th class="rs-row-label rs-corner">${t.instanceHeader}</th>
            ${visibleParams.map((param) => {
              const sub = underKeyCols.map((col) => resolveColumnValue(param, col.field)).filter((v) => v.length > 0).join(" · ");
              const oos = rowOutOfScope(param);
              const tag = originTag(param, t);
              return html`
                <th key=${param.key} class=${`rs-col-key ${oos ? "rs-row-excluded" : ""} ${paramHasReview(param) ? "rs-has-review" : ""}`}>
                  <code>${param.key}</code>
                  ${sub ? html`<span class="rs-key-subline"><code>${sub}</code></span>` : null}
                  ${tag ? html`<span class="rs-key-subline"><span class="rs-origin-tag" title=${tag.title}>${tag.label}</span></span>` : null}
                  ${oos ? html`<span class="rs-key-subline rs-oos-reason">${t.outOfScope}: ${oos.reason}${oos.owner ? html` · ${t.outOfScopeOwner}${oos.owner}` : null}</span>` : null}
                </th>
              `;
            })}
          </tr>
        </thead>
        <tbody>
          ${transposedLines.map((line) => {
            // Comments for this row's cells, labeled by parameter (the column).
            const rowComments = visibleParams.flatMap((param) => {
              const spec = line.cell(param);
              return spec.kind === "review"
                ? getCellReviews(spec.target, spec.field).map((rev) => ({ rev, label: param.key }))
                : [];
            });
            return html`
              <tr key=${line.key} class=${line.lineKind === "attr" ? "rs-attr-row" : ""}>
                <th scope="row" class=${`rs-row-label ${line.lineKind === "instance" ? "rs-row-label-instance" : ""}`}>
                  ${line.lineKind === "instance" ? html`<code>${line.label}</code>` : line.label}
                </th>
                ${visibleParams.map((param) => renderCell(line.cell(param), param.key))}
              </tr>
              ${renderCommentRow(1 + visibleParams.length, rowComments)}
            `;
          })}
        </tbody>
      </table>
    </div>
  `;

  return html`
    <div class="rs-table-block" style=${`--rs-depth:${depth}`}>
      ${hasInstances && html`
        <div class="rs-table-toolbar">
          <div class="rs-view-toggle" role="group" aria-label=${t.viewToggleLabel}>
            <button type="button" class=${`rs-view-btn ${view === "normal" ? "rs-view-btn-active" : ""}`}
                    aria-pressed=${view === "normal"} onClick=${() => setView("normal")} title=${t.viewNormalTip}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
              <span>${t.viewNormal}</span>
            </button>
            <button type="button" class=${`rs-view-btn ${view === "transposed" ? "rs-view-btn-active" : ""}`}
                    aria-pressed=${view === "transposed"} onClick=${() => setView("transposed")} title=${t.viewTransposeTip}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
              <span>${t.viewTranspose}</span>
            </button>
          </div>
        </div>
      `}
      ${hasInstances && view === "transposed" ? renderTransposed() : renderNormal()}
    </div>
  `;
}

// Resolve a custom column's value from a parameter. A bare field is a key in
// `param.extra` (e.g. "verify_status"); a dotted field is a path from the
// parameter root (e.g. "extra.verify_status", "value").
function resolveColumnValue(param: ParamData, field: string): string {
  if (field.includes(".")) {
    let cur: unknown = param;
    for (const part of field.split(".")) {
      if (cur === null || typeof cur !== "object") return "";
      cur = (cur as Record<string, unknown>)[part];
    }
    return typeof cur === "string" ? cur : "";
  }
  const ex = param.extra?.[field];
  return typeof ex === "string" ? ex : "";
}

function renderColumnValue(col: NonNullable<SheetData["columns"]>[number], val: string): string {
  if (col.render === "status") {
    if (val === "ok") return "\u2713 OK";
    if (val === "ng") return "\u2717 NG";
    if (val === "na" || !val) return "-";
  }
  return val;
}

// ============================================================
// Header inline comment
// ============================================================

function HeaderInlineComment({ target, reviews, t }: {
  target: ReviewItem["target"];
  reviews: ReviewItem[];
  t: Messages;
}) {
  const revs = reviews.filter((r) => targetKey(r.target) === targetKey(target));
  if (revs.length === 0) return null;

  return html`
    <div class="rs-header-comment">
      ${revs.map((rev) => html`
        <div class="rs-inline-comment" key=${rev.id}>
          ${rev.changes && rev.changes.length > 0
            ? rev.changes.map((c) => html`<span class="rs-ic-badge">${c.field}: ${c.current ?? ""} \u2192 ${c.suggested}</span>`)
            : html`<span class="rs-ic-badge rs-ic-note">${t.memo}</span>`
          }
          ${rev.comment && html`<span class="rs-ic-text">${rev.comment}</span>`}
        </div>
      `)}
    </div>
  `;
}

// ============================================================
// Category component (recursive)
// ============================================================

// A category counts as materialize noise — and collapses by default, body and
// outline alike — when its ENTIRE subtree (its own params plus every
// descendant category's, recursively) sits at `origin: "default"`: a setting
// the project configures NOWHERE, shown at the product's own default so the
// sheet stays the exhaustive ledger materialize exists to produce. This is
// checked structurally, off the rows themselves, and deliberately NEVER by
// the category's own name/label: `DictionaryMaterialize.defaultsCategory` is
// an ordinary build-time string (`既定値（未使用）`, `Product defaults
// (unused)`, or whatever a project's build.yml sets it to), so matching
// against it would silently stop collapsing the moment someone switches
// `--lang` or a project renames the category — do not "simplify" this back to
// a name check. An empty subtree (no params anywhere under it) does not
// qualify: there is nothing to collapse, and vacuous truth is not materialize
// noise.
function categoryDefaultSummary(category: CategoryData): { count: number; allDefault: boolean } {
  let count = 0;
  let allDefault = true;
  for (const p of category.params ?? []) {
    count++;
    if (effectiveOrigin(p) !== "default") allDefault = false;
  }
  for (const sub of category.categories ?? []) {
    const s = categoryDefaultSummary(sub);
    count += s.count;
    if (!s.allDefault) allDefault = false;
  }
  return { count, allDefault };
}

function CategorySection({ category, sheetName, sheetInstances, sheetIndex, sheetFilePath, parentPath, depth, columns, reviews, reviewEnabled, showComments, filterCommented, hideOutOfScope, showDefaults, filterUndecided, sessionChecks, decisionsEnabled, onDecide, inheritedOutOfScope, onOpenReview, diff, t }: {
  category: CategoryData;
  sheetName: string;
  sheetInstances?: string[];
  sheetIndex: number;
  sheetFilePath?: string;
  parentPath: string;
  depth: number;
  columns?: SheetData["columns"];
  reviews: ReviewItem[];
  reviewEnabled: boolean;
  showComments: boolean;
  filterCommented: boolean;
  hideOutOfScope: boolean;
  showDefaults: boolean;
  filterUndecided: boolean;
  sessionChecks: Record<string, SessionCheck>;
  decisionsEnabled: boolean;
  onDecide: (sheet: string, paramKey: string, next: SessionCheck | null) => void;
  // The nearest ancestor category's effective out-of-scope, already resolved.
  // "Out of scope" marks a category AND its descendants, so this threads down
  // through nested categories; a category's own flag (nearest-wins) overrides it.
  inheritedOutOfScope?: OutOfScope;
  onOpenReview: (target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => void;
  diff?: DiffStatusMap;
  t: Messages;
}) {
  const effOutOfScope = category.out_of_scope ?? inheritedOutOfScope;
  if (hideOutOfScope && effOutOfScope) return null;
  // With unset rows hidden, a category made entirely of them has nothing to
  // show — and a heading over an empty table reads as a rendering bug. This is
  // not a small case: 15 of the Keycloak configuration sheet's 21 groups are
  // whole feature areas (Vault, Telemetry, OpenAPI) this project never touches.
  if (!showDefaults && categoryDefaultSummary(category).allDefault) return null;
  const categoryPath = parentPath ? `${parentPath}/${category.name}` : category.name;
  const catStatus = diff?.get(catKey(sheetName, categoryPath));
  const catTarget = { sheet: sheetName, category: categoryPath };
  const catReviewCount = reviews.filter((r) => targetKey(r.target) === targetKey(catTarget)).length;

  const HeadingTag = depth <= 1 ? "h3" : depth === 2 ? "h4" : "h5";

  // Nobody clicks three hundred rows one at a time, so a category can be
  // cleared in one go — but only the rows that are genuinely undecided: an
  // excluded row or one with a change request is never swept up by it.
  const undecidedHere = (category.params ?? []).filter(
    (p) => rowStateOf(p, sheetName, sessionChecks, reviews) === "undecided"
  );
  const bulkOk = (): void => {
    if (!confirm(t.confirmBulkOk(undecidedHere.length))) return;
    for (const p of undecidedHere) onDecide(sheetName, p.key, { status: "ok" });
  };


  return html`
    <div id=${navAnchorId(sheetIndex, categoryPath)} class=${`rs-category rs-depth-${depth} ${effOutOfScope ? "rs-out-of-scope" : ""}`} style=${`--rs-depth:${depth}`}>
      <div class="rs-category-header">
        <${HeadingTag}>
          ${category.tag && html`<span class="rs-cat-tag">${category.tag}</span>`}
          <span class=${`rs-cat-label ${catStatus === "removed" ? "rs-diff-strike" : ""}`}>${category.display ?? category.name}</span>
          ${effOutOfScope && html`<span class="rs-oos-badge">${t.outOfScope}</span>`}
          ${diff && diffBadge(catStatus)}
          ${category.file_path && category.file_path !== sheetFilePath && category.file_path !== category.name && html`<span class="rs-cat-filepath">${category.file_path}</span>`}
          ${decisionsEnabled && undecidedHere.length > 0 && html`
            <button class="rs-bulk-ok" onClick=${bulkOk} title=${t.bulkOkCategory}>
              ${t.bulkOkCategory} (${undecidedHere.length})
            </button>
          `}
          ${reviewEnabled && html`
            <span class="rs-header-actions ${catReviewCount > 0 ? "rs-has-comment" : ""}">
              <button class="rs-head-tool ${catReviewCount > 0 ? "rs-head-tool-on" : ""}"
                      onClick=${() => onOpenReview(catTarget, "comment", "")}
                      title="${t.commentOnCategory}" aria-label="${t.commentOnCategory}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                <span class="rs-tool-label">${t.comment}</span>
              </button>
            </span>
          `}
        </${HeadingTag}>
        ${effOutOfScope && html`
          <div class="rs-oos-reason">
            ${t.outOfScope}: ${effOutOfScope.reason}${effOutOfScope.owner ? html` · ${t.outOfScopeOwner}${effOutOfScope.owner}` : null}
          </div>
        `}
      </div>
      ${showComments && catReviewCount > 0 && html`
        <${HeaderInlineComment} target=${catTarget} reviews=${reviews} t=${t} />
      `}

      ${category.params && category.params.length > 0 && html`
        <${ParamTable} params=${category.params} sheetName=${sheetName} sheetInstances=${sheetInstances} sheetIndex=${sheetIndex} categoryPath=${categoryPath}
                       depth=${depth}
                       columns=${columns} reviews=${reviews} reviewEnabled=${reviewEnabled}
                       showComments=${showComments} filterCommented=${filterCommented} hideOutOfScope=${hideOutOfScope} showDefaults=${showDefaults}
                       filterUndecided=${filterUndecided} sessionChecks=${sessionChecks}
                       decisionsEnabled=${decisionsEnabled} onDecide=${onDecide}
                       categoryOutOfScope=${effOutOfScope}
                       onOpenReview=${onOpenReview} diff=${diff} t=${t} />
      `}

      ${category.categories?.map((sub) => html`
        <${CategorySection} key=${sub.name} category=${sub} sheetName=${sheetName} sheetInstances=${sheetInstances} sheetIndex=${sheetIndex}
                            sheetFilePath=${sheetFilePath} parentPath=${categoryPath} depth=${depth + 1}
                            columns=${columns} reviews=${reviews} reviewEnabled=${reviewEnabled}
                            showComments=${showComments} filterCommented=${filterCommented} hideOutOfScope=${hideOutOfScope} showDefaults=${showDefaults}
                            filterUndecided=${filterUndecided} sessionChecks=${sessionChecks}
                            decisionsEnabled=${decisionsEnabled} onDecide=${onDecide}
                            inheritedOutOfScope=${effOutOfScope}
                            onOpenReview=${onOpenReview} diff=${diff}
                            t=${t} />
      `)}
    </div>
  `;
}


// ============================================================
// Heading navigation (outline + command palette)
// ============================================================

type NavEntry = {
  kind: "category" | "param" | "comment";
  sheetIndex: number;
  sheetName: string;
  path: string;
  name: string;
  depth: number;
  id: string;
  fallbackId?: string;
  search: string;
  text: string; // original-case haystack, used to show the matched snippet
  // The real structural category path a jump into this entry lands inside —
  // NOT `path` above, which for a "comment" entry is a display string ("cat /
  // param"), not something navAnchorId/collapseKey can address. Undefined
  // when the entry has no enclosing category (a sheet-level comment). Used
  // solely to auto-expand a collapsed category on jump (see App's
  // a hidden unset row) — never rendered.
  categoryPath?: string;
  // Set only on "category" entries: whether this category qualifies as
  // materialize noise (categoryDefaultSummary) and, if so, its recursive row
  // count — carried here so the outline can both hide its collapsed
  // descendants and show the same count the body shows.
};

// A short excerpt of `text` around the query match, so a result makes clear why
// it matched (e.g. a hit on a parameter's remarks rather than its key).
function matchSnippet(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return "";
  const start = Math.max(0, i - 24);
  const end = Math.min(text.length, i + q.length + 36);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

// Render `text` with each (case-insensitive) occurrence of the query wrapped in
// <mark> so the matched portion stands out, as search UIs normally do.
function highlightMatch(text: string, q: string): Array<string | VNode> {
  if (!q) return [text];
  const lower = text.toLowerCase();
  const parts: Array<string | VNode> = [];
  let i = 0;
  let idx = lower.indexOf(q, i);
  while (idx >= 0) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(html`<mark class="rs-hl">${text.slice(idx, idx + q.length)}</mark>` as VNode);
    i = idx + q.length;
    idx = lower.indexOf(q, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

// Stable DOM id for a category, shared by the rendered header and the nav jump
// targets.
//
// Escaping, not stripping. Replacing every run of non-[a-zA-Z0-9] with a single
// "-" collapsed the entire name on the sheets this tool is for: 「接続設定」,
// 「認証」 and 「メモリ」 all became `nav-1--`, so the nav highlighted three
// entries at once and a jump landed on whichever came first in the document.
// The escape below is reversible and therefore injective — two different names
// cannot produce one id — which is the property that was missing.
//
// Non-ASCII is left ALONE rather than percent-encoded. It is legal in an HTML
// id and in a CSS identifier, and encoding it costs nine characters per
// Japanese character for no gain: these ids are resolved with getElementById
// and never appear in a URL (location.hash carries the sheet index, nothing
// else). So a Japanese category keeps its own name in the id, and only the
// ASCII punctuation that a CSS selector would choke on is escaped.
//
// `_` escapes itself, or `_5F` and a literal `_` would collide and the mapping
// would stop being injective — which is the whole point.
function encodeIdPart(s: string): string {
  return s.replace(/[^A-Za-z0-9\u00A0-\uFFFF-]/g, (c) =>
    c === "_" ? "_5F" : `_${c.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`
  );
}

function navAnchorId(sheetIndex: number, path: string): string {
  return `nav-${sheetIndex}-${encodeIdPart(path)}`;
}

// Stable DOM id for a parameter row.
function paramAnchorId(sheetIndex: number, path: string, key: string): string {
  return `${navAnchorId(sheetIndex, path)}--${encodeIdPart(key)}`;
}

// Flatten every sheet's categories (depth-first); used by the outline and search.
function collectNav(data: SheetData, showDefaults: boolean): NavEntry[] {
  const out: NavEntry[] = [];
  data.sheets.forEach((sheet, sheetIndex) => {
    const walk = (cats: CategoryData[], parentPath: string, depth: number) => {
      cats.forEach((c) => {
        const path = parentPath ? `${parentPath}/${c.name}` : c.name;
        // The outline must agree with the body about what exists. A category of
        // nothing but unset rows renders nothing while they are hidden, so an
        // entry for it would jump to a heading that is not there.
        if (!showDefaults && categoryDefaultSummary(c).allDefault) return;
        out.push({
          kind: "category", sheetIndex, sheetName: sheet.name, path, name: c.display ?? c.name, depth,
          id: navAnchorId(sheetIndex, path), search: `${sheet.name} ${path}`.toLowerCase(), text: `${sheet.name} / ${path}`,
          categoryPath: path,
        });
        if (c.categories) walk(c.categories, path, depth + 1);
      });
    };
    walk(sheet.categories, "", 1);
  });
  return out;
}

// Flatten every parameter (key + value(s) + description) for search; jumps to
// the parameter row, falling back to its category when no row is rendered.
// Search sees what the reader sees. A result for a row the document is not
// showing is noise at best, and at worst it lands a jump on an element that is
// not in the DOM. The palette can widen its own scope (see NavPalette) — which
// widens the DOCUMENT, so the two never disagree about what exists.
//
// Excluding them silently would be its own failure: "no match" would read as
// "this product has no such setting" when the setting is there, at its default.
// The palette says which scope it is in, always.
function collectParams(data: SheetData, showDefaults: boolean): NavEntry[] {
  const out: NavEntry[] = [];
  data.sheets.forEach((sheet, sheetIndex) => {
    const walk = (cats: CategoryData[], parentPath: string, depth: number) => {
      cats.forEach((c) => {
        const path = parentPath ? `${parentPath}/${c.name}` : c.name;
        (c.params ?? []).forEach((p) => {
          if (!showDefaults && effectiveOrigin(p) === "default") return;
          const value = p.value ?? (p.instances ?? []).map((i) => `${i.name} ${i.value}`).join(" ");
          const extra = Object.values(p.extra ?? {}).join(" ");
          const text = `${p.key} = ${value} ${p.default ? `(default ${p.default})` : ""} ${pickLang(p.description, "en") ?? ""} ${pickLang(p.remarks, "en") ?? ""} ${extra}`.replace(/\s+/g, " ").trim();
          out.push({
            kind: "param", sheetIndex, sheetName: sheet.name, path, name: p.key, depth,
            id: paramAnchorId(sheetIndex, path, p.key),
            fallbackId: navAnchorId(sheetIndex, path),
            search: `${text} ${sheet.name} ${path}`.toLowerCase(),
            text,
            categoryPath: path,
          });
        });
        if (c.categories) walk(c.categories, path, depth + 1);
      });
    };
    walk(sheet.categories, "", 1);
  });
  return out;
}

function NavOutline({ entries, sheets, currentId, onJump, onClose, diff, t }: {
  // Already filtered to hide the descendants of a collapsed materialize
  // category — consistent with the body,
  // which renders nothing under a collapsed heading either.
  entries: NavEntry[];
  sheets: SheetData["sheets"];
  currentId: string | null;
  onJump: (sheetIndex: number, id: string, fallbackId?: string, sheetName?: string, categoryPath?: string) => void;
  onClose: () => void;
  diff?: DiffStatusMap;
  t: Messages;
}) {
  return html`
    <aside class="rs-outline" aria-label=${t.navOutline}>
      <div class="rs-outline-head">
        <span>${t.navOutline}</span>
        <button class="rs-outline-close" onClick=${onClose} aria-label="close">×</button>
      </div>
      <nav class="rs-outline-body">
        ${sheets.map((sheet, si) => {
          const ss = diff?.get(sheetKey(sheet.name));
          return html`
          <div class="rs-outline-sheet" key=${si}>
            <button class=${`rs-outline-sheetname ${ss === "removed" ? "rs-diff-strike" : ""}`} onClick=${() => onJump(si, `sheet-${si}`)}>${sheet.name} ${diff && diffBadge(ss)}</button>
            ${entries.filter((e) => e.sheetIndex === si).map((e) => {
              const es = e.kind === "category" ? diff?.get(catKey(e.sheetName, e.path)) : undefined;
              return html`
              <div class=${`rs-outline-row ${currentId === e.id ? "rs-outline-current" : ""}`} key=${e.id}
                   style=${`padding-left:${0.75 + (e.depth - 1) * 0.85}rem`}>
                <button class=${`rs-outline-item ${es === "removed" ? "rs-diff-strike" : ""}`}
                        onClick=${() => onJump(e.sheetIndex, e.id, undefined, e.sheetName, e.categoryPath)}>
                  ${e.name} ${diff && diffBadge(es)}
                </button>
              </div>
            `;
            })}
          </div>
        `;
        })}
      </nav>
    </aside>
  `;
}

function NavPalette({ entries, onJump, onClose, showDefaults, onToggleDefaults, t }: {
  entries: NavEntry[];
  onJump: (sheetIndex: number, id: string, fallbackId?: string, sheetName?: string, categoryPath?: string) => void;
  onClose: () => void;
  // The document-wide unset-rows toggle, surfaced here because "I cannot find
  // it" is exactly when a reader needs to widen the scope. Deliberately the
  // SAME state as the filter menu's: a search-only scope would let the palette
  // list rows the sheet behind it does not have.
  showDefaults: boolean;
  onToggleDefaults: () => void;
  t: Messages;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const q = query.trim().toLowerCase();
  const results = (q ? entries.filter((e) => e.search.includes(q)) : entries).slice(0, 50);
  const clampedSel = Math.min(sel, Math.max(0, results.length - 1));

  const onKeyDown = (e: KeyboardEvent) => {
    // Ignore keys while an IME composition is active so confirming a conversion
    // with Enter (or cancelling with Esc) doesn't jump/close the dialog.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[clampedSel]; if (r) onJump(r.sheetIndex, r.id, r.fallbackId, r.sheetName, r.categoryPath); }
    // The shortcut that opened the palette widens it on a second press: the
    // moment a reader wants unset rows is the moment a search came up short,
    // and reaching for the mouse then is the interruption. The chip in the
    // header shows which scope is active, so this never changes silently.
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); onToggleDefaults(); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  return html`
    <div class="rs-palette-overlay" onClick=${onClose}>
      <div class="rs-palette" onClick=${(e: Event) => e.stopPropagation()}>
        <div class="rs-palette-inputrow">
          <input ref=${inputRef} class="rs-palette-input" type="text" placeholder=${t.navSearchPlaceholder}
                 value=${query} onInput=${(e: Event) => { setQuery((e.target as HTMLInputElement).value); setSel(0); }}
                 onKeyDown=${onKeyDown} />
          <button type="button" class=${`rs-palette-scope ${showDefaults ? "rs-palette-scope-all" : ""}`}
                  title=${t.searchScopeHint} onClick=${onToggleDefaults}>
            ${showDefaults ? t.searchScopeAll : t.searchScopeSet}
          </button>
        </div>
        <div class="rs-palette-list">
          ${results.length === 0
            ? html`<div class="rs-palette-empty">${t.navNoResults}</div>`
            : results.map((r, i) => {
                // Show why it matched when the hit is in a field other than the name.
                const snippet = q && !r.name.toLowerCase().includes(q) ? matchSnippet(r.text, q) : "";
                return html`
                  <button key=${`${r.kind}:${r.id}`}
                          class=${`rs-palette-item ${i === clampedSel ? "rs-palette-sel" : ""}`}
                          onMouseEnter=${() => setSel(i)} onClick=${() => onJump(r.sheetIndex, r.id, r.fallbackId, r.sheetName, r.categoryPath)}>
                    <span class="rs-palette-name">
                      ${r.kind === "param" ? html`<span class="rs-palette-kind">${t.fieldKey}</span>` : ""}
                      ${r.kind === "comment" ? html`<span class="rs-palette-kind">${t.memo}</span>` : ""}
                      ${highlightMatch(r.name, q)}
                    </span>
                    ${snippet && html`<span class="rs-palette-snippet">${highlightMatch(snippet, q)}</span>`}
                    <span class="rs-palette-ctx">${r.kind === "category" ? r.sheetName + (r.depth > 1 ? ` ／ ${r.path.split("/").slice(0, -1).join(" ／ ")}` : "") : `${r.sheetName} ／ ${r.path}`}</span>
                  </button>
                `;
              })}
        </div>
      </div>
    </div>
  `;
}

// Sheet tabs that fit are shown; the rest collapse into a "▾" overflow menu.
// When the active sheet is in the overflow set, the button shows its name so the
// current sheet is always visible.
function SheetTabs({ sheets, activeSheet, hasMetadata, onSelect, t }: {
  sheets: SheetData["sheets"];
  activeSheet: number;
  hasMetadata: boolean;
  onSelect: (idx: number) => void;
  t: Messages;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [cutoff, setCutoff] = useState(sheets.length);
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const right = el.getBoundingClientRect().right;
      const tabEls = Array.from(el.querySelectorAll<HTMLElement>("[data-sheet-idx]"));
      let c = 0;
      for (const tab of tabEls) {
        if (tab.getBoundingClientRect().right <= right + 0.5) c++;
        else break;
      }
      setCutoff(c);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheets, hasMetadata]);

  const hasOverflow = cutoff < sheets.length;
  const activeHidden = activeSheet >= 0 && activeSheet >= cutoff;

  return html`
    <div class="rs-tabs-left" ref=${ref}>
      ${hasMetadata && html`
        <button role="tab" aria-selected=${activeSheet === -1}
                class=${`rs-tab ${activeSheet === -1 ? "rs-tab-active" : ""}`}
                onClick=${() => onSelect(-1)}>${t.overview}</button>
      `}
      ${sheets.map((sheet, idx) => html`
        <button key=${idx} data-sheet-idx=${idx} role="tab" aria-selected=${idx === activeSheet}
                class=${`rs-tab ${idx === activeSheet ? "rs-tab-active" : ""} ${idx >= cutoff ? "rs-tab-clipped" : ""}`}
                onClick=${() => onSelect(idx)}>${sheet.name}</button>
      `)}
    </div>
    ${hasOverflow && html`
      <div class="rs-tabs-of">
        <button class=${`rs-tab-overflow ${activeHidden ? "rs-tab-active" : ""}`}
                aria-haspopup="true" aria-expanded=${menuOpen} title=${t.moreSheets}
                onClick=${() => setMenuOpen((v) => !v)}>
          ${activeHidden ? html`<span class="rs-of-active">${sheets[activeSheet].name}</span>` : ""}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        ${menuOpen && html`
          <div class="rs-of-backdrop" onClick=${() => setMenuOpen(false)}></div>
          <div class="rs-of-menu" role="menu">
            ${sheets.map((sheet, idx) => idx < cutoff ? null : html`
              <button key=${idx} role="menuitem"
                      class=${`rs-of-item ${idx === activeSheet ? "rs-of-current" : ""}`}
                      onClick=${() => { onSelect(idx); setMenuOpen(false); }}>${sheet.name}</button>
            `)}
          </div>
        `}
      </div>
    `}
  `;
}

// ============================================================
// Main app
// ============================================================

function App({ data, reviewEnabled, lang, setLang, diff, reviewsOverride, server, applyEnabled }: {
  data: SheetData;
  reviewEnabled: boolean;
  lang: Lang;
  setLang: (l: Lang) => void;
  // Diff overlay: when comparing versions, App renders the merged sheets with
  // these synthetic reviews (changed values as old -> new) and a status map for
  // row/instance tinting. Review editing is disabled in this mode.
  diff?: DiffStatusMap;
  reviewsOverride?: ReviewItem[];
  server?: boolean;
  // Document-level apply capability (`capabilities.apply`, default true): when
  // false, every apply-related affordance is hidden — never shown in the
  // reading view either way, only gated here at the action-surface level.
  applyEnabled?: boolean;
}) {
  const t = useMemo(() => getMessages(lang), [lang]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'light');
  const storageKey = getStorageKey(data);
  const [savedReviews, setReviews] = useState<ReviewItem[]>(() => loadReviews(storageKey));
  const diffMode = !!reviewsOverride;
  const reviews = reviewsOverride ?? savedReviews;
  const effReviewEnabled = diffMode ? false : reviewEnabled;
  const hasMetadataInit = !!(data.metadata?.project || data.metadata?.version || data.metadata?.generated_at || data.metadata?.changelog?.length || data.metadata?.extra);

  // Restore tab index from URL hash (hash is 1-based)
  const getInitialTab = (): number => {
    const hash = location.hash.replace("#", "");
    if (hash === "overview") return -1;
    const num = parseInt(hash, 10);
    if (!isNaN(num) && num >= 1 && num <= data.sheets.length) return num - 1;
    return hasMetadataInit ? -1 : 0;
  };
  const [activeSheet, setActiveSheetState] = useState(getInitialTab);

  // Update URL hash on tab change (1-based)
  const setActiveSheet = useCallback((idx: number) => {
    setActiveSheetState(idx);
    location.hash = idx === -1 ? "overview" : String(idx + 1);
  }, []);
  const [filterCommented, setFilterCommented] = useState(false);
  const [hideOutOfScope, setHideOutOfScope] = useState(false);
  // Rows nobody set, at the product's own default. Off by default: the sheet's
  // first job is to show what this project DECIDED, and on a materialized sheet
  // the unset rows outnumber the decided ones several times over. The count in
  // the label is what keeps the ledger claim visible while they are hidden —
  // "there are 121 more, all at the product default" is the statement, and
  // enumerating them on screen is not required to make it.
  const [showDefaults, setShowDefaults] = useState(false);
  const [filterUndecided, setFilterUndecided] = useState(false);
  const [sessionChecks, setSessionChecks] = useState<Record<string, SessionCheck>>(() => loadSessionChecks(storageKey));
  const [showComments, setShowComments] = useState(false);
  const [modalTarget, setModalTarget] = useState<{ target: ReviewItem["target"]; field: string; currentValue: string; sharedRow?: boolean } | null>(null);
  const [applyPanelOpen, setApplyPanelOpen] = useState(false);
  const [promptModalText, setPromptModalText] = useState<string | null>(null);

  useEffect(() => {
    if (diffMode) return; // never persist synthetic diff reviews
    saveReviews(storageKey, savedReviews);
  }, [savedReviews, storageKey, diffMode]);

  useEffect(() => {
    if (diffMode) return;
    saveSessionChecks(storageKey, sessionChecks);
  }, [sessionChecks, storageKey, diffMode]);

  // Decisions are review actions: never offered while comparing versions, and
  // never in a delivery (--no-review) copy.
  const decisionsEnabled = effReviewEnabled;

  const handleDecide = useCallback((sheet: string, paramKey: string, next: SessionCheck | null): void => {
    setSessionChecks((prev) => {
      const key = checkKey(sheet, paramKey);
      if (next === null) {
        const { [key]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: next };
    });
  }, []);


  // Print what is on screen. An earlier version force-expanded every collapsed
  // category via beforeprint/afterprint, reasoning that a printed ledger must
  // be complete. That was the wrong default once unset rows became a document-
  // wide toggle: a reader who has hidden them has said what this printout is
  // FOR, and handing them 198 pages they deliberately collapsed is not
  // completeness, it is ignoring the instruction. Completeness is still one
  // click away — turn the rows on, then print — and the toggle's own label
  // carries the count either way, so a printout that omits them still says how
  // many were omitted.

  // Apply-to-files replaces Export as the primary action only when a serve
  // backend can actually write. Everything else keeps the same slot in both
  // modes, so a reader who saw a delivered sheet last week finds the same
  // controls in the same places in a serve session.
  const serveApply = applyEnabled !== false && !!server && !diff;
  // Display-only "show comments" is not counted: the badge means "rows are
  // being hidden from you".
  const activeFilters = [filterCommented, hideOutOfScope, filterUndecided].filter(Boolean).length;
  // Every unset row in the document, for the toggle's own label.
  const defaultRowCount = data.sheets.reduce((n, sheet) => {
    const walk = (cats: CategoryData[]): number =>
      cats.reduce(
        (m, c) =>
          m +
          (c.params ?? []).filter((p) => effectiveOrigin(p) === "default").length +
          walk(c.categories ?? []),
        0
      );
    return n + walk(sheet.categories);
  }, 0);

  const progress = useMemo(() => {
    const sheet = activeSheet >= 0 ? data.sheets[activeSheet] : undefined;
    return sheet ? checkProgress(sheetRowStates(sheet, sessionChecks, reviews, showDefaults)) : null;
  }, [activeSheet, data, sessionChecks, reviews, showDefaults]);

  // Expose the sticky tab bar's height so document-flow sticky table headers can
  // stick just below it.
  useEffect(() => {
    const update = () => {
      const tabs = document.querySelector(".rs-sheet-tabs");
      const h = tabs ? Math.round(tabs.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty("--rs-tabbar-h", `${h}px`);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // --- Heading navigation (outline + command palette) ---
  const categoryEntries = useMemo(() => collectNav(data, showDefaults), [data, showDefaults]);
  const paramEntries = useMemo(() => collectParams(data, showDefaults), [data, showDefaults]);
  // Review comments are searchable too; each jumps to its target row/category.
  const commentEntries = useMemo<NavEntry[]>(() => {
    if (diffMode) return []; // synthetic diff reviews are not searchable comments
    const idxByName = new Map(data.sheets.map((s, i) => [s.name, i]));
    const out: NavEntry[] = [];
    reviews.forEach((r) => {
      const text = `${r.comment ?? ""} ${(r.changes ?? []).map((c) => `${c.current ?? ""} ${c.suggested}`).join(" ")}`.trim();
      if (!text) return;
      const si = idxByName.get(r.target.sheet);
      if (si === undefined) return;
      const cat = r.target.category;
      const param = r.target.param;
      let id: string;
      let fallbackId: string | undefined;
      if (cat && param) { id = paramAnchorId(si, cat, param); fallbackId = navAnchorId(si, cat); }
      else if (cat) { id = navAnchorId(si, cat); }
      else { id = `sheet-${si}`; }
      out.push({
        kind: "comment", sheetIndex: si, sheetName: r.target.sheet,
        path: [cat, param].filter(Boolean).join(" / ") || r.target.sheet,
        name: r.comment || text, depth: 1, id, fallbackId,
        search: `${text} ${r.target.sheet} ${cat ?? ""} ${param ?? ""}`.toLowerCase(),
        text,
        categoryPath: cat,
      });
    });
    return out;
  }, [data, reviews, diffMode]);
  const paletteEntries = useMemo(() => [...categoryEntries, ...paramEntries, ...commentEntries], [categoryEntries, paramEntries, commentEntries]);
  const [outlineOpen, setOutlineOpen] = useState<boolean>(() => loadOutlineOpen());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [currentNavId, setCurrentNavId] = useState<string | null>(null);
  // After an outline/palette click we pin the highlight to the clicked target and
  // suppress the scroll-spy briefly, so the programmatic scroll settling doesn't
  // re-select whatever category happens to sit in the top band (which is what
  // steals the highlight when the target is near the bottom and can't reach top).
  const spySuppressUntil = useRef(0);

  useEffect(() => { saveOutlineOpen(outlineOpen); }, [outlineOpen]);



  const jumpToNav = useCallback((sheetIndex: number, id: string, fallbackId?: string, sheetName?: string, categoryPath?: string) => {
    setPaletteOpen(false);
    // Instant jump (no smooth animation) so far-away targets land immediately.
    // Fall back to the category when the exact row is not rendered (e.g. a
    // transposed table, where a parameter is a column rather than a row).
    const scroll = () => {
      const el = document.getElementById(id) ?? (fallbackId ? document.getElementById(fallbackId) : null);
      if (!el) return;
      el.scrollIntoView({ block: "start" });
      // Briefly flash the landed-on target so it's easy to spot.
      let flashEl: Element = el;
      if (el.classList.contains("rs-category")) flashEl = el.querySelector(".rs-category-header") ?? el;
      else if (el.classList.contains("rs-sheet")) flashEl = el.querySelector(".rs-sheet-header") ?? el;
      flashEl.classList.remove("rs-jump-flash");
      void (flashEl as HTMLElement).offsetWidth; // restart the animation if re-triggered
      flashEl.classList.add("rs-jump-flash");
      window.setTimeout(() => flashEl.classList.remove("rs-jump-flash"), 1700);
      // Highlight the clicked target immediately and hold it against the
      // scroll-spy while the programmatic scroll settles (the outline shows
      // categories, so a param jump highlights its containing category).
      setCurrentNavId(fallbackId ?? id);
      spySuppressUntil.current = Date.now() + 700;
    };
    const sheetChanged = sheetIndex !== activeSheet;
    if (sheetChanged) setActiveSheet(sheetIndex);
    // Switching sheets only takes effect on the next render, so the target
    // isn't in the DOM yet this tick.
    if (sheetChanged) {
      requestAnimationFrame(() => requestAnimationFrame(scroll));
    } else {
      scroll();
    }
  }, [activeSheet, setActiveSheet]);

  // Cmd/Ctrl+K opens search; Escape closes the overlays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return; // don't react during IME composition
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); setPaletteOpen(true); }
      else if (e.key === "Escape") { setPaletteOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Scroll-spy: highlight the last category scrolled past a reference line near
  // the top. Unlike a fixed top band, this still resolves at the very bottom of
  // the page — where the last categories can never reach the top — by selecting
  // the last category when scrolled to the end. A click (jumpToNav) pins its
  // selection briefly so this doesn't override it while the scroll settles.
  useEffect(() => {
    const compute = (): void => {
      if (Date.now() < spySuppressUntil.current) return;
      const cats = Array.from(document.querySelectorAll<HTMLElement>(".rs-category[id]"));
      if (cats.length === 0) { setCurrentNavId(null); return; }
      const scroller = document.scrollingElement ?? document.documentElement;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      if (atBottom) { setCurrentNavId(cats[cats.length - 1].id); return; }
      const line = window.innerHeight * 0.25;
      let current = cats[0].id;
      for (const el of cats) {
        if (el.getBoundingClientRect().top <= line) current = el.id;
        else break;
      }
      setCurrentNavId(current);
    };
    compute();
    // Capture phase so scrolls inside nested containers are seen too.
    window.addEventListener("scroll", compute, true);
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("scroll", compute, true);
      window.removeEventListener("resize", compute);
    };
  }, [activeSheet, data]);

  const handleSaveReview = useCallback((review: ReviewItem) => {
    setReviews((prev) => {
      const idx = prev.findIndex((r) => r.id === review.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = review;
        return next;
      }
      return [...prev, review];
    });
  }, []);

  const handleDeleteReview = useCallback((id: string) => {
    setReviews((prev) => prev.filter((r) => r.id !== id));
  }, []);

  // After a serve-mode write, refresh the sheet so it matches what was written:
  // update each applied cell to its new value and drop the now-applied reviews.
  const handleApplied = useCallback((applied: ApplyResult[]) => {
    if (applied.length === 0) return;
    for (const r of applied) {
      const tgt = r.target;
      const sheet = data.sheets.find((s) => s.name === tgt.sheet);
      if (!sheet) continue;
      let cats: CategoryData[] | undefined = sheet.categories;
      let cat: CategoryData | undefined;
      for (const name of (tgt.category ?? "").split("/")) {
        cat = cats?.find((c) => c.name === name);
        if (!cat) break;
        cats = cat.categories;
      }
      const param = cat?.params?.find((p) => p.key === tgt.param);
      if (!param) continue;
      if (tgt.instance) {
        const inst = param.instances?.find((i) => i.name === tgt.instance);
        if (inst) inst.value = r.suggested;
      } else {
        param.value = r.suggested;
      }
    }
    const appliedKeys = new Set(applied.map((a) => targetKey(a.target)));
    setReviews((prev) =>
      prev.filter((rev) => {
        if (!appliedKeys.has(targetKey(rev.target))) return true;
        // Keep comment-only reviews on the same cell; drop the value-change one.
        return !rev.changes?.some((c) => c.field === "value");
      })
    );
  }, [data]);

  const handleExport = useCallback(() => {
    const doc: ReviewDocument = {
      schema_version: "2.0",
      created_at: new Date().toISOString(),
      reviews,
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "review.json";
    a.click();
    URL.revokeObjectURL(url);
  }, [reviews]);

  const handleImport = useCallback(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const doc = JSON.parse(reader.result as string) as ReviewDocument;
          if (doc.schema_version !== "2.0") {
            alert(t.unsupportedSchema);
            return;
          }
          setReviews((prev) => {
            const existingIds = new Set(prev.map((r) => r.id));
            const newReviews = doc.reviews.filter((r) => !existingIds.has(r.id));
            if (newReviews.length === 0) {
              alert(t.noNewReviews);
              return prev;
            }
            alert(t.importedReviews(newReviews.length));
            return [...prev, ...newReviews];
          });
        } catch {
          alert(t.jsonParseError);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }, []);

  const handleCopyPrompt = useCallback(() => {
    const text = buildPromptText(reviews, data);
    if (!text) {
      alert(t.noPendingReviews);
      return;
    }
    setPromptModalText(text);
  }, [reviews, data, t]);

  const handleClearAll = useCallback(() => {
    if (reviews.length === 0) return;
    if (confirm(t.confirmClearAll(reviews.length))) {
      setReviews([]);
    }
  }, [reviews]);

  const openReview = useCallback((target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => {
    setModalTarget({ target, field, currentValue, sharedRow });
  }, []);

  const title = data.metadata?.title ?? t.defaultTitle;

  const hasMetadata = !!(data.metadata?.project || data.metadata?.version || data.metadata?.generated_at || data.metadata?.changelog?.length || data.metadata?.extra);
  // Tabs: overview (if metadata exists) + each sheet
  const OVERVIEW_TAB = -1;

  return html`
    <div class=${`rs-app ${outlineOpen ? "rs-outline-open" : ""}`}>
      <nav class="rs-sheet-tabs" role="tablist">
        <div class="rs-tabs-nav">
          <button class=${`rs-toolbar-btn ${outlineOpen ? "rs-toolbar-btn-active" : ""}`} onClick=${() => setOutlineOpen(!outlineOpen)}
                  title=${t.navOutlineTip} aria-label=${t.navOutlineTip} aria-pressed=${outlineOpen}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          </button>
          <button class="rs-toolbar-btn" onClick=${() => setPaletteOpen(true)} title=${t.navSearchTip} aria-label=${t.navSearchTip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
        </div>
        <${SheetTabs} sheets=${data.sheets} activeSheet=${activeSheet}
                      hasMetadata=${hasMetadata} onSelect=${setActiveSheet} t=${t} />
        <div class="rs-tabs-right">
          ${effReviewEnabled && html`
            ${progress && html`<span class="rs-decision-progress">${t.decisionProgress(progress.decided, progress.total)}</span>`}

            <${ToolbarMenu} label=${activeFilters > 0 ? t.filterMenuCount(activeFilters) : t.filterMenu}
                            active=${activeFilters > 0}
                            icon=${html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>` as VNode}>
              <${MenuCheck} label=${t.showCommentsToggle} checked=${showComments} onToggle=${() => setShowComments(!showComments)} />
              <div class="rs-menu-divider"></div>
              <${MenuCheck} label=${t.showCommentedOnly} checked=${filterCommented} onToggle=${() => setFilterCommented(!filterCommented)} />
              ${decisionsEnabled
                ? html`<${MenuCheck} label=${t.undecidedOnly} checked=${filterUndecided} onToggle=${() => setFilterUndecided(!filterUndecided)} />`
                : null}
              <${MenuCheck} label=${t.hideOutOfScope} checked=${hideOutOfScope} onToggle=${() => setHideOutOfScope(!hideOutOfScope)} />
              ${defaultRowCount > 0 && html`
                <${MenuCheck} label=${t.showDefaults(defaultRowCount)} checked=${showDefaults}
                              onToggle=${() => setShowDefaults(!showDefaults)} />
              `}
            <//>

            ${/* The one thing the session exists to produce, and the only filled
                  button on the bar. Same slot in both modes: hand the review
                  back (static) or write it into the files (serve). */ ""}
            ${serveApply
              ? html`
                <button class="rs-toolbar-btn rs-toolbar-btn-primary" onClick=${() => setApplyPanelOpen(true)} title=${t.applyToFiles}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                  <span class="rs-btn-label">${t.applyToFiles}</span>
                </button>
              `
              : html`
                <button class="rs-toolbar-btn rs-toolbar-btn-primary" onClick=${handleExport} title=${t.exportReview}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span class="rs-btn-label">${t.exportReview}</span>
                </button>
              `}

            <${ToolbarMenu} label=${t.reviewMenu(reviews.length)}>
              ${serveApply ? html`<${MenuItem} label=${t.exportReview} onClick=${handleExport} />` : null}
              <${MenuItem} label=${t.importReviewMenu} onClick=${handleImport} />
              ${applyEnabled !== false && !server
                ? html`<${MenuItem} label=${t.aiPromptCopy} onClick=${handleCopyPrompt} />`
                : null}
              <div class="rs-menu-divider"></div>
              <${MenuItem} label=${t.clearAllMenu} onClick=${handleClearAll} danger=${true} />
            <//>

            <span class="rs-tabs-sep"></span>
          `}
          <button class="rs-toolbar-btn" title=${t.themeToggle} aria-label=${t.themeToggle}
                  onClick=${() => {
                    const next = (document.documentElement.dataset.theme === 'dark') ? 'light' : 'dark';
                    document.documentElement.dataset.theme = next;
                    try { localStorage.setItem('rs-theme', next); } catch(e) { /* ignore */ }
                    setTheme(next as 'light' | 'dark');
                  }}>
            ${theme === 'dark'
              ? html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
              : html`<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
            }
          </button>
          <button class="rs-toolbar-btn rs-lang-switch" aria-label=${lang === "ja" ? "Switch to English" : "日本語に切り替え"}
                  onClick=${() => setLang(lang === "ja" ? "en" : "ja")}>
            ${lang === "ja" ? "EN" : "JA"}
          </button>
        </div>
      </nav>

      <main class="rs-main">
        ${activeSheet === OVERVIEW_TAB && hasMetadata && html`
          <section class="rs-overview">
            <h1>${title}</h1>

            <div class="rs-overview-grid">
              ${data.metadata?.project && html`
                <div class="rs-overview-item">
                  <dt>${t.project}</dt>
                  <dd>${data.metadata.project}</dd>
                </div>
              `}
              ${data.metadata?.version && html`
                <div class="rs-overview-item">
                  <dt>${t.version}</dt>
                  <dd>${data.metadata.version}</dd>
                </div>
              `}
              ${data.metadata?.generated_at && html`
                <div class="rs-overview-item">
                  <dt>${t.generatedAt}</dt>
                  <dd>${formatTimestamp(data.metadata.generated_at)}</dd>
                </div>
              `}
              ${data.metadata?.extra && Object.entries(data.metadata.extra).map(([k, v]) => html`
                <div class="rs-overview-item" key=${k}>
                  <dt>${k}</dt>
                  <dd>${v}</dd>
                </div>
              `)}
            </div>

            ${data.metadata?.changelog && data.metadata.changelog.length > 0 && html`
              <div class="rs-changelog-section">
                <h2>${t.changelog}</h2>
                <table class="rs-changelog-table">
                  <thead><tr><th>${t.changelogVersion}</th><th>${t.changelogDate}</th><th>${t.changelogAuthor}</th><th>${t.changelogDescription}</th></tr></thead>
                  <tbody>
                    ${data.metadata.changelog.map((entry) => html`
                      <tr key=${entry.version}><td>${entry.version}</td><td>${entry.date}</td><td>${entry.author}</td><td>${entry.description}</td></tr>
                    `)}
                  </tbody>
                </table>
              </div>
            `}

            <div class="rs-overview-sheets">
              <h2>${t.sheetList}</h2>
              <ul>
                ${data.sheets.map((sheet, idx) => html`
                  <li key=${idx}>
                    <button class="rs-overview-sheet-link" onClick=${() => setActiveSheet(idx)}>
                      ${sheet.name}
                    </button>
                    ${sheet.file_path && html`<span class="rs-overview-sheet-path">${sheet.file_path}</span>`}
                  </li>
                `)}
              </ul>
            </div>
          </section>
        `}

        ${data.sheets.map((sheet, idx) => {
          if (idx !== activeSheet) return null;
          const sheetTarget = { sheet: sheet.name };
          const sheetReviewCount = reviews.filter((r) => targetKey(r.target) === targetKey(sheetTarget)).length;

          return html`
            <section key=${sheet.name} id=${`sheet-${idx}`} class="rs-sheet">
              <div class="rs-sheet-header">
                <h2>
                  <span class=${diff?.get(sheetKey(sheet.name)) === "removed" ? "rs-diff-strike" : ""}>${sheet.name}</span>
                  ${diff && diffBadge(diff.get(sheetKey(sheet.name)))}
                  ${effReviewEnabled && html`
                    <span class="rs-header-actions ${sheetReviewCount > 0 ? "rs-has-comment" : ""}">
                      <button class="rs-head-tool ${sheetReviewCount > 0 ? "rs-head-tool-on" : ""}"
                              onClick=${() => openReview(sheetTarget, "comment", "")}
                              title="${t.commentOnSheet}" aria-label="${t.commentOnSheet}">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        <span class="rs-tool-label">${t.comment}</span>
                      </button>
                    </span>
                  `}
                </h2>
              </div>
              ${showComments && sheetReviewCount > 0 && html`
                <${HeaderInlineComment} target=${sheetTarget} reviews=${reviews} t=${t} />
              `}
              ${sheet.file_path && html`
                <p class="rs-file-path">
                  <code>${sheet.file_path}</code>
                  ${sheet.source_file && sheet.source_file !== sheet.file_path && html`
                    <span class="rs-source-path">${t.sheetSourceLabel}: <code>${sheet.source_file}</code></span>
                  `}
                </p>
              `}

              ${sheet.categories.map((cat) => html`
                <${CategorySection} key=${cat.name} category=${cat} sheetName=${sheet.name} sheetInstances=${sheet.instances} sheetIndex=${idx}
                                    sheetFilePath=${sheet.file_path} parentPath="" depth=${1}
                                    columns=${data.columns} reviews=${reviews} reviewEnabled=${effReviewEnabled}
                                    showComments=${showComments} filterCommented=${filterCommented} hideOutOfScope=${hideOutOfScope} showDefaults=${showDefaults}
                                    filterUndecided=${filterUndecided} sessionChecks=${sessionChecks}
                                    decisionsEnabled=${decisionsEnabled} onDecide=${handleDecide}
                                    onOpenReview=${openReview} diff=${diff}
                                    t=${t} />
              `)}
            </section>
          `;
        })}
      </main>

      ${outlineOpen && html`
        <${NavOutline} entries=${categoryEntries} sheets=${data.sheets} currentId=${currentNavId}
                       onJump=${jumpToNav} onClose=${() => setOutlineOpen(false)} diff=${diff} t=${t} />
      `}

      ${paletteOpen && html`
        <${NavPalette} entries=${paletteEntries} onJump=${jumpToNav} onClose=${() => setPaletteOpen(false)}
                       showDefaults=${showDefaults} onToggleDefaults=${() => setShowDefaults((v) => !v)} t=${t} />
      `}

      ${modalTarget && html`
        <${ReviewModal} target=${modalTarget.target} field=${modalTarget.field}
                        currentValue=${modalTarget.currentValue} sharedRow=${modalTarget.sharedRow} reviews=${reviews}
                        onSave=${handleSaveReview} onDelete=${handleDeleteReview}
                        onClose=${() => setModalTarget(null)} t=${t} />
      `}

      ${applyEnabled !== false && applyPanelOpen && html`
        <${ApplyPanel} reviews=${reviews} onClose=${() => setApplyPanelOpen(false)} onApplied=${handleApplied} t=${t} />
      `}

      ${promptModalText !== null && html`
        <${PromptModal} text=${promptModalText} onClose=${() => setPromptModalText(null)} t=${t} />
      `}

      <${CellToolbarHost} onOpenReview=${openReview} t=${t} />
    </div>
  `;
}

// ============================================================
// Versions & diff
// ============================================================

type SheetVersion = {
  id?: string;
  version: string;
  date?: string;
  tags?: string[];
  author?: string;
  note?: string;
  columns?: SheetData["columns"];
  sheets: SheetData["sheets"];
};
type Payload = { metadata?: SheetData["metadata"]; versions: SheetVersion[]; capabilities?: Capabilities };

const versionId = (v: SheetVersion): string => v.id ?? v.version;
const versionLabel = (v: SheetVersion): string => `${v.version}${v.date ? ` (${v.date})` : ""}`;

// Compare is only ever entered from this bar, and this bar stays visible while
// comparing — so the diff's own output (the summary) and its one filter belong
// here, next to the selectors that produced them, rather than in the tab bar
// across the screen.
function VersionBar({ versions, activeId, compare, fromId, toId, onSelect, onToggleCompare, onFrom, onTo, diffSummary, changedOnly, onChangedOnly, t }: {
  versions: SheetVersion[];
  activeId: string;
  compare: boolean;
  fromId: string;
  toId: string;
  onSelect: (id: string) => void;
  onToggleCompare: () => void;
  onFrom: (id: string) => void;
  onTo: (id: string) => void;
  diffSummary?: { changed: number; added: number; removed: number };
  changedOnly?: boolean;
  onChangedOnly?: (v: boolean) => void;
  t: Messages;
}) {
  const opts = (selected: string) =>
    versions.map((v) => html`<option value=${versionId(v)} selected=${versionId(v) === selected}>${versionLabel(v)}</option>`);
  return html`
    <div class="rs-version-bar">
      ${!compare
        ? html`
          <label class="rs-version-pick">
            <span>${t.versionLabel}</span>
            <select onChange=${(e: Event) => onSelect((e.target as HTMLSelectElement).value)}>${opts(activeId)}</select>
          </label>
          <button type="button" class="rs-version-btn" onClick=${onToggleCompare}>${t.compareVersions}</button>
        `
        : html`
          <label class="rs-version-pick"><span>${t.diffFrom}</span>
            <select onChange=${(e: Event) => onFrom((e.target as HTMLSelectElement).value)}>${opts(fromId)}</select>
          </label>
          <span class="rs-version-arrow">▸</span>
          <label class="rs-version-pick"><span>${t.diffTo}</span>
            <select onChange=${(e: Event) => onTo((e.target as HTMLSelectElement).value)}>${opts(toId)}</select>
          </label>
          <button type="button" class="rs-version-btn" onClick=${onToggleCompare}>${t.exitCompare}</button>
          ${diffSummary && html`
            <span class="rs-diff-summary">${t.diffSummary(diffSummary.changed, diffSummary.added, diffSummary.removed)}</span>
            <label class="rs-diff-changed-only">
              <input type="checkbox" checked=${changedOnly} onChange=${(e: Event) => onChangedOnly?.((e.target as HTMLInputElement).checked)} />
              <span>${t.diffChangedOnly}</span>
            </label>
          `}
        `}
    </div>
  `;
}

const DIFF_BADGE: Record<DiffStatus, string> = { added: "+", removed: "−", changed: "~", unchanged: "" };

// A small +/−/~ chip for a sheet/category/param/instance, shown only when the
// status is a real change.
function diffBadge(status: DiffStatus | undefined) {
  if (!status || status === "unchanged") return null;
  return html`<span class=${`rs-diff-badge rs-diff-badge-${status}`}>${DIFF_BADGE[status]}</span>`;
}

// ============================================================
// Root (version switching + diff) and entry point
// ============================================================

function Root({ payload, reviewEnabled, initialLang, server }: { payload: Payload; reviewEnabled: boolean; initialLang: Lang; server: boolean }) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const t = useMemo(() => getMessages(lang), [lang]);
  // Document-level opt-out (`capabilities.apply: false`): hides every
  // apply-related affordance (the "apply to files" panel and the AI-prompt
  // export) regardless of server mode. Absent/true means apply is available.
  const applyEnabled = payload.capabilities?.apply !== false;
  const versions = payload.versions;
  const latest = versions[versions.length - 1];

  const [activeId, setActiveId] = useState(() => versionId(latest));
  const [compare, setCompare] = useState(false);
  const [fromId, setFromId] = useState(() => versionId(versions[Math.max(0, versions.length - 2)]));
  const [toId, setToId] = useState(() => versionId(latest));
  const [changedOnly, setChangedOnly] = useState(true);

  const byId = useMemo(() => new Map(versions.map((v) => [versionId(v), v])), [versions]);
  const active = byId.get(activeId) ?? latest;
  // In compare mode the "to" (current) version is what you view; "from" is the
  // older baseline you compare against.
  const fromV = byId.get(fromId) ?? versions[0];
  const toV = byId.get(toId) ?? latest;

  // Resolve LangText prose to the active language up front, so both the diff
  // (structural string compare) and the normal view see plain strings and the
  // language toggle re-resolves everything live.
  const fromSheets = useMemo(() => localizeSheets(fromV.sheets, lang), [fromV, lang]);
  const toSheets = useMemo(() => localizeSheets(toV.sheets, lang), [toV, lang]);
  const shownSheets = useMemo(() => localizeSheets((compare ? toV : active).sheets, lang), [compare, toV, active, lang]);

  // Diff overlay: merge the two snapshots into render-ready sheets + synthetic
  // reviews (old -> new) + a status map, all consumed by the normal App view.
  const diffModel = useMemo(
    () => (compare ? buildDiffModel(fromSheets, toSheets, changedOnly) : null),
    [compare, fromSheets, toSheets, changedOnly]
  );

  const shown = compare ? toV : active;
  const data = useMemo<SheetData>(() => ({
    metadata: { ...payload.metadata, version: shown.version, generated_at: shown.date },
    columns: shown.columns,
    sheets: diffModel ? diffModel.sheets : shownSheets,
  }), [shown, payload.metadata, diffModel, shownSheets]);

  return html`
    <div class="rs-root">
      ${versions.length > 1 && html`<${VersionBar} versions=${versions} activeId=${activeId} compare=${compare}
        fromId=${fromId} toId=${toId} onSelect=${setActiveId} onToggleCompare=${() => setCompare((c) => !c)}
        onFrom=${setFromId} onTo=${setToId} diffSummary=${diffModel?.summary}
        changedOnly=${changedOnly} onChangedOnly=${setChangedOnly} t=${t} />`}
      <${App} data=${data} reviewEnabled=${reviewEnabled} lang=${lang} setLang=${setLang}
        diff=${diffModel?.status} reviewsOverride=${diffModel?.reviews}
        server=${server} applyEnabled=${applyEnabled} />
    </div>
  `;
}

function init() {
  const dataEl = document.getElementById("sheet-data");
  if (!dataEl) return;
  const raw = JSON.parse(dataEl.textContent ?? "{}");
  // Accept the normalized { metadata, versions } payload, or a bare single-version
  // { metadata, columns, sheets } for robustness.
  const payload: Payload = Array.isArray(raw.versions)
    ? raw
    : { metadata: raw.metadata, versions: [{ version: raw.metadata?.version ?? "current", date: raw.metadata?.generated_at, sheets: raw.sheets ?? [], columns: raw.columns }], capabilities: raw.capabilities };

  const configEl = document.getElementById("sheet-config");
  const config = configEl ? JSON.parse(configEl.textContent ?? "{}") : {};
  const reviewEnabled = config.review !== false;
  const lang: Lang = config.lang === "en" ? "en" : "ja";
  const serverMode = config.server === true;

  const appEl = document.getElementById("app");
  if (!appEl) return;
  render(html`<${Root} payload=${payload} reviewEnabled=${reviewEnabled} initialLang=${lang} server=${serverMode} />`, appEl);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

// Exported for the DOM tests (tests/viewer.test.ts), which render the real
// component tree against a real document rather than re-implementing its
// behaviour. `init()` above is a no-op without the embedded #app/#sheet-data
// elements, so importing this module in a test is safe. The bundle is built
// from this same entry point and is unaffected by the export.
export { Root, App };
