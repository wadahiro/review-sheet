// Browser-side JS: Renders parameter sheet + review UI with Preact + htm
// This file is bundled by bun build and inlined into the HTML

import { h, render, type VNode } from "preact";
import { createPortal } from "preact/compat";
import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "preact/hooks";
import htm from "htm";
import { getMessages, type Lang, type Messages } from "./i18n.js";
import { localizeSheets, localizeGroups, localizeColumns } from "../localize.js";
import {
  buildPromptText,
  targetLabel,
  retargetReviews,
  effectiveOrigin,
  HELD_REASON_GENERATED,
  HELD_REASON_ADDED_ROW,
  HELD_REASON_STRUCK_ROW,
  HELD_REASON_DOCUMENT,
  type SheetData,
  type CategoryData,
  type ParamData,
  type ReviewItem,
} from "../prompt.js";
import { buildDiffModel, rowKey, instKey, catKey, sheetKey, type DiffStatusMap } from "../diffview.js";
import { isEdit, targetKey } from "../edits.js";
import { toMarkdownSheet, renderSheetMarkdown, parseSheetMarkdown } from "../sheet-markdown.js";
import { getMarkdownRenderer } from "./markdown-runtime.js";
import { EVIDENCE_SCHEME } from "../evidence.js";
import { MarkdownSheetBody } from "./md-sheet.js";
import { NavTree, chapterPath } from "./nav-tree.js";
import { sectionize } from "./doc-sections.js";
import { navAnchorId, paramAnchorId, encodeIdPart } from "./anchors.js";
import {
  showCellTool,
  hideCellToolSoon,
  hideCellToolNow,
  keepCellTool,
  suppressCellToolWhileScrolling,
  setCellToolSetter,
  type CellToolCtx,
} from "./cell-tool.js";
import { markdownToCategories, declaredInstances, withEnvironment, withoutEnvironment, renameEnvironment } from "../sheet-markdown.js";
import { runMermaid } from "./mermaid-runtime.js";
import { filesFromDrop } from "./drop-set.js";
import { readMarkdownSet, documentPreviews } from "../md-read.js";
import { SET_BLOCK_ID, setBlockJson, spliceSetBlock } from "../set-block.js";
import { setShowSources, showSources } from "./display-config.js";
import type { DiffStatus } from "../diff.js";
import { pickLang, type OutOfScope, type Capabilities, type ArtifactPreview, PRESENCE_VALUE } from "../types.js";

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
// What the panel's provenance line CLAIMS about the document under it. Three
// kinds, three different claims, and the wrong one is a lie the reader has no
// way to detect: "Rendered from" over an authored `.tf` says this tool produced
// it, and over an OBSERVED file it says the tool produced what a host was found
// holding — the opposite of what evidence is for.
export function artifactProvenance(a: { nature?: string; observed?: { host: string; at: string } }, t: Messages): string {
  if (a.nature === "source") return t.artifactSourceFile;
  if (a.nature === "observed") {
    return t.artifactCollectedFrom
      .replace("{host}", a.observed?.host ?? "")
      .replace("{at}", a.observed?.at ?? "");
  }
  return t.artifactRenderedFrom;
}

function originTag(param: ParamData, t: Messages): { label: string; title: string } | null {
  // Checked first, and it wins: a row the recipient wrote has no origin in the
  // configuration at all, which is a stronger statement than any of the below.
  if (param.added) return { label: t.originAdded, title: t.originAddedTip };
  const origin = effectiveOrigin(param);
  if (origin === "embedded") {
    // The FILE, not a word for the category. Tried both: a one-word label reads
    // cleanly and throws away the thing a reader of such a row actually needs —
    // these 75 rows are spread over four files, and "edit that file" is the
    // whole remedy, so which file is the useful half. What the marker MEANS is
    // explained once per sheet by the legend instead of being crammed into
    // every row's label.
    const file = showSources() ? param.source?.file : undefined;
    const base = file ? file.split("/").pop() : undefined;
    return { label: base ?? t.originEmbedded, title: file ? `${t.originEmbeddedTip}\n${file}` : t.originEmbeddedTip };
  }
  if (origin === "default") return { label: t.originDefault, title: t.originDefaultTip };
  return null;
}

// What the product's own UI calls this value, if the dictionary says. Returns
// undefined for a value no option covers — a deployed value the bound
// dictionary version does not list, or one carrying a placeholder — and that
// silence is deliberate: the cell falls back to showing the raw value alone,
// which is what it always showed.
// What a value cell SHOWS instead of the stored string, when the two are not
// the same thing to a reader.
//
// A presence row holds this tool's spelling of "it is there" — a string written
// nowhere in the file being reviewed. The annotation rule that puts a product's
// name for a value beside the value (`1` shown as `1 One Level`) exists because
// `value` is what the review dialog opens with, the copy button yields and
// apply writes back; for presence none of those hold — apply refuses such a
// row, and copying `true` gives a string the file does not contain. So the word
// stands alone, and `value` stays the identity underneath, as `display` is for.
function presenceDisplay(param: ParamData, value: string, t: Messages): string | undefined {
  return param.presence === true && value === PRESENCE_VALUE ? optionLabel(param, value, t) : undefined;
}

function optionLabel(param: ParamData, value: string, t?: Messages): string | undefined {
  // A row recorded by PRESENCE holds this tool's spelling of "it is there",
  // which is written nowhere in the file the reviewer is checking. What belongs
  // in the cell is what presence MEANS here: the product's word if the bound
  // dictionary carries one, and a neutral one otherwise.
  if (param.presence === true && value === PRESENCE_VALUE) {
    const own = typeof param.presence_label === "string" ? param.presence_label : undefined;
    return own && own.length > 0 ? own : t?.present;
  }
  if (!param.options || value === "") return undefined;
  const hit = param.options.find((o) => o.value === value);
  const label = hit?.label;
  return typeof label === "string" && label.length > 0 && label !== value ? label : undefined;
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
// localStorage persistence
// ============================================================

// Where this document's unsaved work is kept in THIS browser.
//
// The metadata alone is not enough to say which document that is: every copy of
// one generated file carries the same project, version and generated_at, so two
// copies shared a buffer — edit one without saving, open the other, and the
// first one's work is in it, ready to be saved into the wrong file. The newest
// save's id separates them, and a file that has never been saved has no id and
// keeps the bare key, which is what a freshly generated document has always
// used.
// The key the PANEL's own state hangs on — which chapters are folded, and where
// the list is scrolled. Deliberately NOT getStorageKey: that one identifies a
// REVISION, because an unsaved edit belongs to the copy it was typed into and
// must never surface in another. Folds and a scroll position are not edits.
// They are how a reader has arranged the room, and keying them to the revision
// threw the arrangement away every time the document was regenerated or saved —
// which, while a sheet is being built, is many times an hour.
//
// The document's own identity instead: project, version and title. Two
// documents of one project keep their own arrangements (their titles differ),
// and a new build of either walks back into the room it left.
export function navStateKey(data: SheetData): string {
  return "review-sheet:" + [data.metadata?.project ?? "", data.metadata?.version ?? "", data.metadata?.title ?? ""].join(":");
}

export function getStorageKey(data: SheetData): string {
  const parts = [
    data.metadata?.project ?? "",
    data.metadata?.version ?? "",
    data.metadata?.generated_at ?? "",
  ];
  return "review-sheet:" + parts.join(":");
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


function loadReviews(storageKey: string): ReviewItem[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return JSON.parse(raw);
  } catch { /* empty */ }
  return [];
}

const EDITOR_NAME_KEY = "rs-editor-name";

// A handle to the file the recipient last saved over, so the second save does
// not ask again. Kept in memory only — a file handle is not serializable, and
// asking once per session is not the friction worth solving.
let savedFileHandle: FileSystemFileHandle | null = null;

type FileSystemWritable = { write: (data: string) => Promise<void>; close: () => Promise<void> };
type FileSystemFileHandle = { createWritable: () => Promise<FileSystemWritable> };
type SavePicker = (options: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;

// Let the browser paint before starting synchronous work. Without this, a
// "saving…" state set immediately before a long task never reaches the screen.
const paint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

// The keys already in one category, so a newly added row cannot collide with an
// existing one — two rows with the same key ARE the same row to every target,
// anchor and edit in the document.
function keysInCategory(data: SheetData, target: ReviewItem["target"]): string[] {
  const sheet = data.sheets.find((s) => s.name === target.sheet);
  if (!sheet) return [];
  let cats: CategoryData[] | undefined = sheet.categories;
  let cat: CategoryData | undefined;
  for (const name of (target.category ?? "").split("/")) {
    cat = cats?.find((c) => c.name === name);
    if (!cat) return [];
    cats = cat.categories;
  }
  return (cat?.params ?? []).map((p) => p.key);
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

function PromptModal({ text, fromEdits, onClose, t }: {
  text: string;
  // What the prompt was built FROM. In a maintainable document it is not a set
  // of proposals waiting to be judged, it is what the sheet already says and
  // the files have not caught up with — a different thing to hand an AI, and
  // saying "pending reviews" there is simply false.
  fromEdits: boolean;
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
          <p class="rs-apply-held-hint">${fromEdits ? t.aiPromptHintEdits : t.aiPromptHint}</p>
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
// Edit modal (editing a generated document)
// ============================================================

// A document sheet's body.
function DocumentBody({ sheet, onEvidence, t }: {
  sheet: SheetData["sheets"][number];
  // Open the document a verdict's evidence cell cites. Absent when this page
  // carries no evidence, and then the cell was never a link either — the
  // rule is decided once, where the cell is written (evidence.ts).
  onEvidence?: (id: string, line?: number) => void;
  t: Messages;
}) {
  const html_ = sheet.document!.html;

  // Diagrams are drawn HERE, not by the build — see mermaid-runtime.ts. After
  // every render of this body, including the one an edit causes: a diagram
  // somebody just changed has to be re-drawn from the text they changed, and
  // the html above is replaced wholesale, so the drawn svg goes with it.
  const body = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    runMermaid(body.current);
  }, [html_]);

  // A wide table's header, lifted out of the scroller so it can stick to the page.
//
// Sticky inside a horizontal scroller pins to the SCROLLER, not the page: the
// header parks partway down the table instead of at the top of the viewport.
// The sheet solved this by splitting the table — header in its own element
// above the body, horizontal offset synced — and a document's tables get the
// same treatment, built here because markdown has no way to emit it.
//
// The two halves must agree on column widths or the header lies about which
// column is which. The sheet gets that from `table-layout: fixed` over declared
// widths; a markdown table has none, so the widths are MEASURED off the real
// one and written onto both as a colgroup. Re-measured on resize, since that is
// when they change.
function splitHead(wrapper: HTMLElement): void {
  const table = wrapper.querySelector("table");
  const thead = table?.querySelector("thead");
  if (table === null || thead === null || thead === undefined) return;
  const widths = [...thead.querySelectorAll("th")].map((th) => Math.round(th.getBoundingClientRect().width));
  if (widths.length === 0 || widths.some((w) => w === 0)) return;
  const colgroup = (): HTMLElement => {
    const g = document.createElement("colgroup");
    for (const w of widths) {
      const c = document.createElement("col");
      c.style.width = `${w}px`;
      g.appendChild(c);
    }
    return g;
  };
  const apply = (t: HTMLElement): void => {
    t.querySelector("colgroup")?.remove();
    t.insertBefore(colgroup(), t.firstChild);
    t.style.tableLayout = "fixed";
    t.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
  };

  let split = wrapper.parentElement;
  let head: HTMLElement | null = null;
  if (split?.classList.contains("rs-table-split") === true) {
    head = split.querySelector<HTMLElement>(".rs-sticky-head");
  } else {
    // First time: build the split around the wrapper the markdown gave us.
    split = document.createElement("div");
    split.className = "rs-table-split rs-doc-split";
    wrapper.parentElement?.insertBefore(split, wrapper);
    split.appendChild(wrapper);
    wrapper.classList.add("rs-split-body");
    head = document.createElement("div");
    head.className = "rs-sticky-head rs-doc-sticky-head";
    const clone = document.createElement("table");
    clone.appendChild(thead.cloneNode(true));
    head.appendChild(clone);
    split.insertBefore(head, wrapper);
    // The header now lives above; leaving it in the body too would show it
    // twice while the top of the table is on screen.
    (thead as HTMLElement).style.visibility = "hidden";
    wrapper.addEventListener("scroll", () => { if (head !== null) head.scrollLeft = wrapper.scrollLeft; }, { passive: true });
  }
  apply(table as HTMLElement);
  const clone = head?.querySelector("table");
  if (clone !== null && clone !== undefined) apply(clone as HTMLElement);
}

// A table's column header sticks while its rows are read — the same rule the
  // sheet's tables follow, and for the same reason a hundred-row test table
  // needs it. Two things only the running page can know, so both are measured
  // here rather than written into the stylesheet:
  //
  //   * WHERE it sticks. Under the tab bar and under the section heading that
  //     sticks below it; that heading is styled prose, and its rendered height
  //     is not a number any rule here could carry.
  //   * WHETHER it sticks at all. A wrapper wide enough to scroll horizontally
  //     is a scroll container, and a header inside one pins to the container
  //     instead of the page — parked partway down the table. Measured, marked,
  //     and the stylesheet gives the header up exactly there.
  useLayoutEffect(() => {
    const root = body.current;
    if (root === null) return;
    const measure = (): void => {
      const head = root.querySelector("h2");
      root.style.setProperty("--rs-doc-head-h", head === null ? "0px" : `${Math.round(head.getBoundingClientRect().height)}px`);
      for (const w of root.querySelectorAll<HTMLElement>(".rs-doc-table")) {
        const over = w.scrollWidth - w.clientWidth > 1;
        w.classList.toggle("rs-overflowing", over);
        if (over) splitHead(w);
      }
    };
    measure();
    window.addEventListener("resize", measure, { passive: true });
    return () => window.removeEventListener("resize", measure);
  }, [html_]);

  // The document is cut into sections so its sticky headings are released by
  // the end of what they head (doc-sections.ts). Before paint, or the pile the
  // sections exist to prevent is on screen for a frame.
  useLayoutEffect(() => {
    if (body.current !== null) sectionize(body.current);
  }, [html_]);


  // An evidence cell's link, delegated at the document root: the cells are
  // markdown the record wrote, so nothing here can attach a handler per cell
  // without re-rendering somebody's document.
  const openEvidence = (e: Event): void => {
    if (onEvidence === undefined) return;
    const a = (e.target as Element | null)?.closest?.(`a[href^="${EVIDENCE_SCHEME}"]`);
    const ref = a?.getAttribute("href");
    if (ref === null || ref === undefined) return;
    e.preventDefault();
    const { id, line } = parseEvidenceRef(ref);
    onEvidence(id, line);
  };

  return html`
    <div class="rs-doc" ref=${body} onClick=${openEvidence} dangerouslySetInnerHTML=${{ __html: html_ }}></div>
  `;
}

// A short, stable name for a pasted image. Content-addressed so the same
// picture pasted twice is one file, and so two people pasting the same
// screenshot do not each add one. FNV-1a: this names a file, it does not
// protect anything, and a hash nobody has to install beats one that drags a
// dependency into the viewer.
function contentHash(uri: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < uri.length; i++) {
    h ^= uri.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const extensionOf = (uri: string): string => IMAGE_EXT[/^data:([^;,]+)/.exec(uri)?.[1] ?? ""] ?? "png";

// The VALUE columns a hand-maintained document knows about.
//
// Called columns and not environments, because that is what they are here: the
// axis is usually the project's environments, and nothing makes it so — a
// document may just as well hold one column per node, per tenant, or per
// release. The filter that hides them has always called them columns too. The
// model's word for them is `instances`, and the change report keeps it, since
// what it is read against IS an environment list (build.yml's).
//
// ONE set, for the whole document — an axis belongs to the document, not to a
// page. Which sheets use which of them is not decided here and cannot be: a
// table has the column or it does not, and that is the sheet's own business
// (its heading carries the control for it).
//
// So this defines names. Adding one touches no table — there is nothing to put
// in a column nobody has asked for yet. Renaming and removing DO touch every
// table that has the column, because the alternative is a column naming an
// environment that no longer exists, which is a document disagreeing with
// itself.
//
// What this does NOT do is create the environment on the project's side: a
// layer of configuration and the files behind it are decisions, and they are
// stated in the change report for whoever applies the sheet.
function EnvironmentModal({ environments, sheets, onSave, onClose, t }: {
  environments: string[];
  sheets: { name: string; display: string; markdown: string; instances: string[] }[];
  onSave: (names: string[], edits: { sheet: string; markdown: string }[]) => void;
  onClose: () => void;
  t: Messages;
}) {
  const [adding, setAdding] = useState("");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const add = (): void => {
    const name = adding.trim();
    if (name === "" || environments.includes(name)) return;
    onSave([...environments, name], []);
    setAdding("");
  };

  const rename = (from: string): void => {
    const to = prompt(t.envRename, from);
    if (to === null || to.trim() === "" || to.trim() === from || environments.includes(to.trim())) return;
    onSave(
      environments.map((n) => (n === from ? to.trim() : n)),
      sheets.filter((s) => s.instances.includes(from)).map((s) => ({ sheet: s.name, markdown: renameEnvironment(s.markdown, from, to.trim()) }))
    );
  };

  // Only ever reached for an environment no sheet carries a column for — the
  // button is disabled otherwise — so there is no table to rewrite and nothing
  // written in one to lose.
  const remove = (name: string): void => {
    if (!confirm(t.envRemoveUnusedConfirm(name))) return;
    onSave(
      environments.filter((n) => n !== name),
      []
    );
  };

  return html`
    <div class="rs-overlay" onClick=${(e: Event) => { if ((e.target as HTMLElement).classList.contains("rs-overlay")) onClose(); }}>
      <div class="rs-modal" role="dialog" aria-label="${t.envManage}">
        <header>
          <div><h4>${t.envManage}</h4></div>
          <button class="rs-modal-close" onClick=${onClose} aria-label="${t.shortcutClose}">\u00d7</button>
        </header>
        <div class="rs-new-review">
          <table class="rs-changelog-table rs-env-table">
            <tbody>
              ${environments.map((name) => {
                // In use somewhere: removing it would take a column and the
                // values in it out of a sheet nobody is looking at. The sheet
                // says so first, from its own heading — the check is the rule,
                // and a disabled button with the reason on it is the whole
                // explanation this dialog needs.
                const used = sheets.some((s) => s.instances.includes(name));
                return html`
                  <tr key=${name}>
                    <td><code>${name}</code></td>
                    <td class="rs-env-actions">
                      <button class="rs-btn-cancel" onClick=${() => rename(name)}>${t.envRename}</button>
                      <button class="rs-btn-danger" disabled=${used} title=${used ? t.envInUse : ""}
                              onClick=${() => remove(name)}>${t.envRemove}</button>
                    </td>
                  </tr>
                `;
              })}
            </tbody>
          </table>
          <div class="rs-form-row rs-env-add">
            <input type="text" value=${adding} placeholder=${t.envName}
                   onInput=${(e: Event) => setAdding((e.target as HTMLInputElement).value)}
                   onKeyDown=${(e: KeyboardEvent) => { if (e.key === "Enter") add(); }} />
            <button class="rs-btn-primary" onClick=${add} disabled=${adding.trim() === ""}>${t.envAdd}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Which of the document's value columns THIS sheet carries.
//
// The other half of the split, and the half that belongs to the sheet: a table
// covers the environments it covers, and the ones it does not are simply not
// there. Adding the column writes it into every table of the sheet, which is
// the part nobody would do by hand.
function SheetEnvironmentModal({ sheet, environments, markdown, onSave, onClose, t }: {
  sheet: string;
  environments: string[];
  markdown: string;
  onSave: (markdown: string) => void;
  onClose: () => void;
  t: Messages;
}) {
  const here = declaredInstances(markdown) ?? [];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggle = (name: string): void => {
    if (here.includes(name)) {
      if (!confirm(t.envRemoveFromSheetConfirm(name))) return;
      onSave(withoutEnvironment(markdown, name));
      return;
    }
    onSave(withEnvironment(markdown, name));
  };

  return html`
    <div class="rs-overlay" onClick=${(e: Event) => { if ((e.target as HTMLElement).classList.contains("rs-overlay")) onClose(); }}>
      <div class="rs-modal" role="dialog" aria-label="${t.envSheetManage}">
        <header>
          <div>
            <h4>${t.envSheetManage}</h4>
            <div class="rs-modal-path">${sheet}</div>
          </div>
          <button class="rs-modal-close" onClick=${onClose} aria-label="${t.shortcutClose}">\u00d7</button>
        </header>
        <div class="rs-new-review">
          <div class="rs-env-others">
            ${environments.map((name) => html`
              <label key=${name} class="rs-env-sheet-row">
                <input type="checkbox" checked=${here.includes(name)} onChange=${() => toggle(name)} />
                <code>${name}</code>
              </label>
            `)}
          </div>
          ${environments.length === 0 && html`<p class="rs-edit-note">${t.envNoneDefined}</p>`}
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
        <div class="rs-of-menu rs-toolbar-menu rs-scroll-thin" onClick=${(e: Event) => e.stopPropagation()}>${children}</div>
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
// Reviewable cell component
// ============================================================

function ReviewableCell({ value, display, target, field, reviews, reviewEnabled, onOpenReview, className, isCode, badge, subline, unsetLabel, valueLabel, sharedRow, t }: {
  value: string;
  // What to SHOW in place of `value`, when the two differ. The key cell of a
  // row inside a block shows only its own last segment — the blocks above it
  // are rows of their own now, so repeating them in every descendant's key is
  // the redundancy container rows exist to remove.
  //
  // `value` stays the identity regardless: it is what a review records as the
  // current text and what everything outside this table (the review dialog, the
  // AI prompt, the command palette) shows, correctly, since that is the string
  // apply and verify resolve by.
  display?: string;
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
  // What the product's own UI calls this value, shown BESIDE it and never
  // folded into it — see the render below.
  valueLabel?: string;
  // Passed straight through to the review modal (see CellToolCtx.sharedRow).
  sharedRow?: boolean;
  // True when this row is currently struck through.
  t: Messages;
}) {
  // A shared-scope review lives on the row target, so a shared row's cells match
  // BOTH: their own environment target and the row's. That is what makes an
  // "all environments" finding visible in every environment column — and it is
  // also how the Compare overlay's synthetic reviews (diffview.ts emits row
  // targets for changed common values) keep rendering.
  const altTargetKey = sharedRow ? targetKey({ ...target, instance: undefined }) : undefined;
  const matching = reviews.filter((r) => {
    const k = targetKey(r.target);
    if (k !== targetKey(target) && k !== altTargetKey) return false;
    return r.target.field === field;
  });
  // A finding (`pending`) is a proposal and is drawn as "current -> suggested".
  // An `applied` item is one apply already wrote into the file, so the value
  // beside it is already the new one and there is nothing to draw over.
  const cellReviews = matching.filter((r) => !isEdit(r));
  const hasReview = cellReviews.length > 0;
  // Reflect suggested value from review on screen. A suggestion may be the empty
  // string (a proposal to DELETE/clear the value) — that is a real change, so
  // test for presence with `!== undefined`, not truthiness, and render the
  // now-empty value with a ∅ placeholder so the deletion is visible.
  const suggestedVal = hasReview
    ? cellReviews[0].changes?.find((c) => c.field === field)?.suggested
    : undefined;
  const hasSuggestion = suggestedVal !== undefined;
  // Value for copy/modal: use suggested value if available.
  //
  // The DISPLAYED text when the two differ, which is what a reader expects a
  // copy button beside something to hand them — and what a labelled row has
  // always yielded, since `value` is the label there. A key cell showing
  // `max-count` handing over the whole address was the odd one out.
  const effectiveValue = suggestedVal ?? display ?? value;

  // The "nothing is set here" label stands in for the empty value, so a
  // suggestion strikes through the LABEL — writing a value into this cell means
  // it stops using the default, which is exactly what the reviewer is proposing.
  const showUnsetLabel = !!unsetLabel && value === "";
  // What the cell SHOWS. Only ever differs from `value` where a row's identity
  // is longer than what a reader needs in front of them — see `display`.
  const shown = display ?? value;
  const current = showUnsetLabel
    ? html`<span class=${`rs-unset-label ${hasSuggestion ? "rs-strikethrough" : ""}`}>${unsetLabel}</span>`
    : isCode
      ? html`<code class=${hasSuggestion ? "rs-strikethrough" : ""}>${shown}</code>`
      : hasSuggestion
        ? html`<span class="rs-strikethrough">${shown}</span>`
        : shown;

  // The product's own name for this value, as an annotation NEXT TO it — never
  // part of it. `value` is the same string the review dialog opens with, the
  // copy button yields and `apply` writes back to the config file, so folding
  // "One Level" into a `1` would put that text into a deployed file. It is
  // dropped entirely once a suggestion is on screen: the label describes the
  // CURRENT value, and leaving it beside a struck-through old value and a new
  // one would read as if it belonged to the suggestion.
  const withOptionLabel = (v: unknown): unknown =>
    valueLabel === undefined || hasSuggestion ? v : html`${v} <span class="rs-option-label">${valueLabel}</span>`;

  const displayValue = hasSuggestion
    ? (isCode
      ? html`${current} <code class="rs-suggested">${suggestedVal || "∅"}</code>`
      : html`${current} <span class="rs-suggested">${suggestedVal || "∅"}</span>`)
    : withOptionLabel(current);

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
  // The cell lays its contents out in a ROW (value, then the review/copy
  // affordances), which is right until something is stacked under the value —
  // a provenance line, an origin marker, one line per environment. Those are
  // block elements and a flex row lays block children out side by side all the
  // same, so they came out on one line however they were styled.
  const hasSubline = Array.isArray(subline) ? subline.some(Boolean) : !!subline;
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
      <div class=${`rs-value-cell ${hasSubline ? "rs-value-cell-stacked" : ""}`}>
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
    setCellToolSetter(setCtx);
    const onScroll = (): void => suppressCellToolWhileScrolling();
    const onResize = (): void => hideCellToolNow();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      setCellToolSetter(null);
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

// Where the file panel sits. A preference about this READER's screen, not about
// this document — a wide monitor wants the file beside the sheet, a laptop
// wants it under a nine-column table — so it is stored once per browser rather
// than per document, and it outlives the file being regenerated.
//
// Unset means "whatever the document being opened wants": a row's file to the
// right, so the row stays beside it, and evidence along the bottom, so the wide
// record it was opened from keeps its width. Choosing once overrides both,
// which is the whole point of choosing.
const DOCK_KEY = "rs-artifact-dock:v1";
export type Dock = "right" | "below";
function loadDock(): Dock | undefined {
  try {
    const v = localStorage.getItem(DOCK_KEY);
    return v === "right" || v === "below" ? v : undefined;
  } catch {
    return undefined;
  }
}
function saveDock(d: Dock): void {
  try {
    localStorage.setItem(DOCK_KEY, d);
  } catch {
    /* a document opened where storage is refused still works, it just forgets */
  }
}

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

// Open unless the reader closed it. The tree is the document's only navigation
// now, so a document that opened with it hidden would open with none — and it
// carries the CURRENT SHEET's headings as well as the sheet list, so it is not
// empty even in a document of one sheet.
function loadOutlineOpen(): boolean {
  try { return localStorage.getItem("rs-outline-open") !== "0"; } catch { return true; }
}

function saveOutlineOpen(open: boolean): void {
  try { localStorage.setItem("rs-outline-open", open ? "1" : "0"); } catch { /* ignore */ }
}


// ============================================================
// Parameter table component
// ============================================================

function ParamTable({ params, sheetName, sheetInstances, sheetIndex, categoryPath, depth, columns, reviews, reviewEnabled, showComments, filterCommented, hideOutOfScope, showDefaults, hiddenInstances, categoryOutOfScope, onOpenReview, artifact, diff, t }: {
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
  // Environments the reader has switched off. Empty = show them all.
  hiddenInstances: Set<string>;
  // The nearest enclosing category's effective out-of-scope (already resolved
  // for its own ancestry) — applies to a param that sets no `out_of_scope` of
  // its own (nearest-wins: a param-level flag overrides the category's).
  categoryOutOfScope?: OutOfScope;
  onOpenReview: (target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => void;
  // The deployed-file panel, when this document has one: `idFor` says which
  // preview (if any) holds this row, `open` shows it there. A single prop
  // because the two halves are useless apart, and threading two through every
  // level between App and a row would be twice the noise for one feature.
  artifact?: ArtifactAccess;
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
    // Narrowed here, at the ONE place the axis is decided, so everything that
    // reads it follows: the columns, the transposed view, the freeze
    // arithmetic, and the "every environment agrees" collapse. Filtering the
    // rendering instead would have left each of those to remember separately.
    const shown = names.filter((n) => !hiddenInstances.has(n));
    // Hiding every environment would leave a Pattern B row with nothing to show
    // and no way to get back — a filter that can empty the screen is a trap, so
    // the last one cannot be switched off.
    return shown.length > 0 ? shown : names;
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
    if (filterCommented) {
      const rowTarget = { sheet: sheetName, category: categoryPath, param: param.key };
      return (
        getReviewCount(rowTarget) > 0 ||
        (param.instances ?? []).some((inst) => getReviewCount({ ...rowTarget, instance: inst.name }) > 0)
      );
    }
    return true;
  });

  // A row that survived a filter still hangs under its blocks, so those blocks
  // stay on screen even when the filter would have removed them — otherwise a
  // setting appears indented under nothing, and the reader is left to guess
  // which `<Directory>` they are looking at, which is precisely the question
  // container rows exist to answer.
  //
  // Ancestors are re-admitted, never re-ordered: the params keep their original
  // sequence, so a block still sits above its contents.
  const kept = new Set(visibleParams.map((p) => p.key));
  const needed = new Set(visibleParams.flatMap((p) => (p.container_path ?? []).map((c) => c.path)));
  const shown = needed.size === 0 ? visibleParams : params.filter((p) => kept.has(p.key) || needed.has(p.key));

  // Under a filter a category can end up with nothing to show; render nothing
  // rather than an empty table (a materialized sheet has dozens of categories).
  if (shown.length === 0) return null;

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
    | { kind: "review"; value: string; target: ReviewItem["target"]; field: string; className: string; isCode: boolean; copyable: boolean; unsetLabel?: string; valueLabel?: string; display?: string; sharedRow?: boolean }
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

  const descPresent = shown.some((p) => p.description);
  const remarksPresent = shown.some((p) => p.remarks);
  // The "Shipped" column (ansible recipe's `baseline:`) — shown only when some
  // row on this sheet actually carries one, same gating `descPresent`/
  // `remarksPresent` use, so a sheet that never declares `baseline:` renders
  // byte-for-byte as it did before this column existed.
  const baselinePresent = shown.some((p) => p.baseline !== undefined);

  // Leading metadata lines (freeze-eligible): description (col 2) and default.
  const leadingLines: TableLine[] = [];
  if (descPresent) {
    leadingLines.push({
      key: "__description", label: t.descriptionHeader, lineKind: "attr", colClass: "rs-col-description", colStyle: "", freezePos: 2,
      cell: (param) => ({ kind: "review", value: pickLang(param.description, "en") ?? "", target: baseTarget(param), field: "description", className: "rs-col-description", isCode: false, copyable: false }),
    });
  }
  leadingLines.push({
    key: "__default", label: baselinePresent ? t.asInstalled : t.defaultValue, lineKind: "attr", colClass: "rs-col-default", colStyle: "", freezePos: descPresent ? 3 : 2,
    // What is in effect on a freshly installed host, which is the one thing a
    // reviewer needs in order to judge our value: the vendor's shipped file if
    // it states this directive, the product's documented default if it does
    // not. ONE column — the two used to be shown side by side, which put the
    // tool's own two sources on screen instead of the reader's one question,
    // and the vendor's file wins because it is what the host actually has.
    //
    // On a `baseline` row (the vendor shipped it and we removed it) this shows
    // what the vendor had. It deliberately does NOT say what applies instead:
    // the container may have been removed with the directive, and answering
    // that needs the product's own merge semantics, which this tool does not
    // model. The row exists so a reviewer asks the question, not so the sheet
    // answers it wrongly.
    cell: (param) => {
      const shown = param.baseline ?? param.default ?? "-";
      // Where the default was READ, when it is a distribution's shipped file
      // rather than the product's own documentation. Beside the value, because
      // the description on the same row quotes the product — logrotate's says
      // "Default is 0" while the shipped logrotate.conf makes it 4, and both
      // are true one layer apart. Without the source the row reads as broken.
      // Only when the DEFAULT is what the cell shows. `baseline` wins over it
      // above, and it is a different fact (what the distribution shipped in
      // this file) with a different source — annotating it with the defaults
      // file would name the wrong document.
      const from = param.baseline === undefined ? param.default_from : undefined;
      return {
        kind: "review",
        value: shown,
        target: baseTarget(param),
        field: "default",
        className: "rs-col-default",
        isCode: true,
        copyable: false,
        display: presenceDisplay(param, shown, t),
        // A presence row takes no label at all: `display` above has already
        // put the word in place of the stored value, and a label beside it
        // would repeat it ("あり (あり)").
        valueLabel:
          presenceDisplay(param, shown, t) !== undefined
            ? undefined
            : from !== undefined && shown !== "-"
              ? from
              : optionLabel(param, shown, t),
      };
    },
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
            // "Nothing is set here" and "this environment's file does not have
            // the line" are two different facts, and this cell said the first
            // about the second: a block a `{% if %}` keeps out of dev read
            // "uses default", about a line dev's file does not contain.
            const unsetLabel = !inst && param.absent_where_unlisted ? t.notInThisFile : t.usesDefault;
            return { kind: "review", value, target: { ...baseTarget(param), instance: name }, field: "value", className: `rs-col-value ${cls} ${diffCls}`, isCode: true, copyable: value.length > 0, unsetLabel, display: presenceDisplay(param, value, t), valueLabel: presenceDisplay(param, value, t) === undefined ? optionLabel(param, value, t) : undefined };
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
            return { kind: "review", value: common, target: { ...baseTarget(param), instance: name }, field: "value", display: presenceDisplay(param, common, t), className: "rs-col-value rs-same-as-default", isCode: true, copyable: false, sharedRow: true, valueLabel: presenceDisplay(param, common, t) === undefined ? optionLabel(param, common, t) : undefined };
          }
          // "Nothing is set here" and "what is set equals the default" are two
          // different facts, and only the first one is `usesDefault`. This used
          // to test `common === def` alone, which blanked the cell of a
          // deliberately written directive whenever its value happened to match
          // the product's — httpd's `ProxyRequests Off`, a line that exists to
          // say this host is NOT a forward proxy, read as "not set" and left a
          // reviewer to work the truth out of the remarks. `origin` is the fact
          // that decides it, and the model has carried it all along.
          //
          // `origin: "baseline"` reads the same way visually (empty, muted
          // cell) but is a different fact from "default" — nothing the product
          // ships is in effect either, because the vendor's directive is not in
          // the deployed file at all — so it gets its own label.
          const baselineAbsent = effectiveOrigin(param) === "baseline";
          const isUnset = effectiveOrigin(param) === "default" || baselineAbsent;
          const isSameAsDefault = common === def;
          return {
            kind: "review",
            value: isUnset ? "" : common,
            target: { ...baseTarget(param), instance: name },
            field: "value",
            className: `rs-col-value ${isUnset ? "rs-cell-unset" : isSameAsDefault ? "rs-same-as-default" : "rs-changed rs-cell-common"}`,
            isCode: true,
            copyable: !isUnset,
            unsetLabel: baselineAbsent ? t.originBaselineDisabled : t.usesDefault,
            display: isUnset ? undefined : presenceDisplay(param, common, t),
            valueLabel: isUnset || presenceDisplay(param, common, t) !== undefined ? undefined : optionLabel(param, common, t),
            sharedRow: true,
          };
        },
      }))
    : [{
        key: "__value", label: t.setValue, lineKind: "value", colClass: "rs-col-value", colStyle: "",
        cell: (param) => {
          const value = param.value ?? "";
          // See the hasInstances branch above for why `baseline` origin gets
          // its own disabled reading rather than looking like an ordinary
          // (empty) value.
          const baselineAbsent = effectiveOrigin(param) === "baseline";
          const isSameAsDefault = value === (param.default ?? "");
          return {
            kind: "review",
            value,
            target: baseTarget(param),
            field: "value",
            className: `rs-col-value ${baselineAbsent ? "rs-cell-unset" : isSameAsDefault ? "rs-same-as-default" : "rs-changed"}`,
            isCode: true,
            copyable: !baselineAbsent,
            unsetLabel: baselineAbsent ? t.originBaselineDisabled : undefined,
            display: presenceDisplay(param, value, t),
            valueLabel: presenceDisplay(param, value, t) === undefined ? optionLabel(param, value, t) : undefined,
          };
        },
      }];

  // Trailing attribute lines: remarks, then the "Shipped" baseline column (when
  // any row has one), then any author-defined custom columns.
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

  // Normal columns:  key, description, default, values, remarks, custom.
  const normalLines = [...leadingLines, ...valueLines, ...trailingLines];
  // Transposed rows: attributes grouped first, then instances.
  const transposedLines = [...leadingLines, ...trailingLines, ...valueLines];

  const renderCell = (spec: CellSpec, cellKey: string) =>
    spec.kind === "review"
      ? html`<${ReviewableCell} key=${cellKey} value=${spec.value} target=${spec.target} field=${spec.field}
          reviews=${reviews} reviewEnabled=${reviewEnabled}
          onOpenReview=${onOpenReview}
          className=${spec.className} isCode=${spec.isCode} copyable=${spec.copyable}
          unsetLabel=${spec.unsetLabel} valueLabel=${spec.valueLabel} display=${spec.display} sharedRow=${spec.sharedRow} t=${t} />`
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
  // A block whose opening carries no argument gets no row of its own — there is
  // no decision in `<RequireAll>` beyond the fact that it groups — but its level
  // is still an indent step, and an indent step nothing explains is worse than
  // no indent at all: the reader sees a setting pushed two levels in with one
  // heading above it and has to guess what the other level was.
  //
  // So the viewer draws it, from the chain the rows already carry. It is not a
  // row and must not become one: nothing is keyed by it, no dictionary owes it a
  // description, it has no review target and no place in a diff. It appears and
  // disappears with its contents for free, because it is derived from them.
  const emittedBlocks = new Set(shown.map((p) => p.key));
  // The block's ARGUMENT belongs on this line whenever the line is standing in
  // for a container row that is not on screen. Without it two `<Directory>`
  // blocks redraw as two identical `Directory` headers and the reader cannot
  // tell which one a displaced setting came from — the same redundancy question
  // the container rows answered, asked from the other side.
  const blockLine = (b: { path: string; name?: string; subject?: string }, depth: number): VNode =>
    html`<tr key=${`block:${b.path}`} class="rs-param-row rs-row-container rs-row-structure" style=${`--rs-block-depth:${depth}`}>
      <td class="rs-col-key"><code>${b.name ?? ""}</code></td>
      <td class="rs-col-value rs-block-subject" colSpan=${Math.max(1, normalLines.length)}>${b.subject ? html`<code>${b.subject}</code>` : null}</td>
    </tr>` as VNode;

  // `layout: file+categories`: the file heads these rows and the grouping it
  // displaced sub-heads them here, from `sub_category` on the rows themselves.
  // Derived rather than stored as categories, so the row identity every review
  // target and diff key is written against does not move when a project changes
  // its mind about the layout.
  //
  // Grouping REORDERS, which is why it is opt-in: a block's contents can be
  // classified away from the block, and then they are read under a different
  // sub-head than the line that opens them. The build reports each family it
  // separated; the redrawn block line above such a row carries the block's own
  // argument so the row still says what it was torn from.
  // A group holding rows from more than one file. `layout: categories` heads by
  // the product's grouping and says nothing about files, which is right for a
  // unit whose file is how it SHIPS — but when two files' rows land under one
  // heading, nothing on the page distinguishes them, and a reader takes them
  // for one file's settings. So each row says which file it is a line of,
  // exactly where the mixture is, rather than the mixture being reported once
  // at build time to somebody who is not the reader.
  const fileOfRow = (p: ParamData): string | undefined => p.deployed_file;
  const mixedFiles = new Set(shown.map(fileOfRow).filter((f): f is string => f !== undefined)).size > 1;

  const subKey = (p: ParamData): string => (p.sub_category ?? []).join(" / ");
  const subHeaded = shown.some((p) => (p.sub_category?.length ?? 0) > 0);
  const ordered = subHeaded
    ? // First appearance decides the order of the sub-heads, and rows keep
      // their order within one. A sort by name would reshuffle the page every
      // time a group was renamed.
      [...new Map<string, ParamData[]>(shown.map((p) => [subKey(p), []])).entries()]
        .map(([k, _]) => shown.filter((p) => subKey(p) === k))
        .flat()
    : shown;

  const subHeadLine = (label: string): VNode =>
    html`<tr key=${`sub:${label}`} class="rs-param-row rs-row-subhead">
      <td class="rs-col-key" colSpan=${1 + Math.max(1, normalLines.length)}>${label}</td>
    </tr>` as VNode;

  let lastSub: string | undefined;
  const normalBody = ordered.flatMap((param) => {
    const out: VNode[] = [];
    if (subHeaded) {
      const k = subKey(param);
      if (k !== lastSub) {
        lastSub = k;
        // A row the file heads but the dictionary never grouped sits at the top
        // with no sub-head, rather than under one invented for it.
        if (k !== "") out.push(subHeadLine(k));
      }
    }
    (param.container_path ?? []).forEach((b, i) => {
      if (emittedBlocks.has(b.path)) return;
      emittedBlocks.add(b.path);
      out.push(blockLine(b, i));
    });
    return [...out, renderParamRow(param)];
  });

  function renderParamRow(param: ParamData) {
    const rd = rowDiff(param.key);
    // Legibility: at most one badge-style marker per row. "Out of scope" is now
    // row-level muting + a visible inline reason line (not a badge), so the only
    // badge left here is the diff status.
    const rowBadge = diff ? diffBadge(rd) : null;
    // Provenance sub-lines (under_key columns, e.g. the backing Ansible
    // variable), each with its own heading.
    //
    // The heading is the point. Without it this line and the key line above are
    // both a bare identifier in the same type at the same size, and nothing
    // says which is the row's own name and which is where its value comes
    // from — the two questions they answer. The heading is already declared
    // (sheet.yml's under_key label, in both languages); it was being thrown
    // away at render time. Resolved to the active language up front, like every
    // other LangText in this file (see localizeColumns).
    const underKeyLines = underKeyCols
      .map((col) => ({
        head: col.header,
        value: resolveColumnValue(param, col.field),
      }))
      .filter((x) => x.value.length > 0);
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
    // The key goes beneath the label because they answer different questions —
    // what a reviewer recognises, and where the value lives. When they are the
    // same string there is only one question, and printing it twice reads as a
    // row that could not decide what it is called.
    if (label && label !== param.key) keySubline.push(html`<span class="rs-key-subline"><code>${param.key}</code></span>` as VNode);
    for (const line of underKeyLines) {
      keySubline.push(
        html`<span class="rs-key-subline"><span class="rs-subline-head">${line.head}</span><code>${line.value}</code></span>` as VNode
      );
    }
    if (tag) keySubline.push(html`<span class="rs-key-subline"><span class="rs-origin-tag" title=${tag.title}>${tag.label}</span></span>` as VNode);
    // WHY this row is in some environments and not others. `instances` above
    // already says where; the test that decides it is the next question a
    // reviewer has, and until now it lived only on the struck-through line of
    // the preview panel — a place you reach by knowing to look.
    if (param.present_when?.length) {
      keySubline.push(html`
        <span class="rs-key-subline rs-present-when">
          <span class="rs-subline-head">${t.presentWhen}</span>
          <code>${param.present_when.map((c) => (c.negated ? `not ${c.variable}` : c.variable)).join(" and ")}</code>
        </span>
      ` as VNode);
    }
    const rowFile = mixedFiles ? fileOfRow(param) : undefined;
    if (rowFile !== undefined) {
      keySubline.push(
        html`<span class="rs-key-subline rs-row-file"><span class="rs-subline-head">${t.rowFile}</span><code>${rowFile}</code></span>` as VNode
      );
    }
    // The way into the file this row is a line of. Only where there IS one: a
    // row with no artifact (a product default, a variable-axis sheet) gets no
    // affordance rather than one that opens nothing.
    const artifactId = artifact?.idFor(sheetName, categoryPath, param.key);
    if (artifactId !== undefined) {
      keySubline.push(html`
        <span class="rs-key-subline">
          <button class="rs-artifact-chip" title=${t.artifactOpen}
                  onClick=${(e: Event) => { e.stopPropagation(); artifact!.open(artifactId, param.key); }}>
            ${t.artifactTitle}
          </button>
        </span>
      ` as VNode);
    }
    if (oos) {
      keySubline.push(html`
        <span class="rs-key-subline rs-oos-reason">
          ${t.outOfScope}: ${oos.reason}${oos.owner ? html` · ${t.outOfScopeOwner}${oos.owner}` : null}
        </span>
      ` as VNode);
    }
    // The blocks this row sits in. Their number is its indent, and the last of
    // them is the row directly above it — so the key cell shows only what this
    // row adds, which is the whole point: `Directory["/var/www"].AllowOverride`
    // repeated the block in every one of its settings, and the block is a row
    // of its own now.
    const depth = param.container_path?.length ?? 0;
    const leaf = keyLeaf(param);
    return html`
    <tr key=${param.key} id=${paramAnchorId(sheetIndex, categoryPath, param.key)}
        class=${`rs-param-row ${param.container ? "rs-row-container" : ""} ${param.container?.nameFromDocs ? "rs-name-from-docs" : ""} ${oos ? "rs-row-excluded" : ""} ${param.added ? "rs-row-added" : ""} ${param.deleted ? "rs-row-deleted" : ""} ${paramHasReview(param) ? "rs-has-review" : ""} ${rd && rd !== "unchanged" ? `rs-diff-row-${rd}` : ""}`}
        style=${depth > 0 ? `--rs-block-depth:${depth}` : undefined}
        title=${param.deleted ? t.rowDeletedTip : undefined}>
      <${ReviewableCell} value=${label ?? param.key} display=${label ? undefined : leaf} target=${baseTarget(param)} field="key"
        reviews=${reviews} reviewEnabled=${reviewEnabled}
        onOpenReview=${onOpenReview}
        className="rs-col-key" isCode=${!label} t=${t} badge=${rowBadge} subline=${keySubline.length > 0 ? keySubline : null} />
      ${normalLines.map((line) => renderCell(line.cell(param), line.key))}
    </tr>
    ${renderInlineComments(param, 1 + normalLines.length)}
  `;
  }

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
            ${shown.map((param) => {
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
            const rowComments = shown.flatMap((param) => {
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
                ${shown.map((param) => renderCell(line.cell(param), param.key))}
              </tr>
              ${renderCommentRow(1 + shown.length, rowComments)}
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
function categoryDefaultSummary(category: CategoryData): { count: number; allDefault: boolean; noted: boolean } {
  let count = 0;
  let allDefault = true;
  // A paragraph is content of its own. Hiding a section because every ROW in it
  // is unset is right; hiding one that somebody wrote a note into — including a
  // section that is nothing BUT a note — hides what they wrote.
  let noted = typeof category.note === "string" && category.note !== "";
  for (const p of category.params ?? []) {
    count++;
    if (effectiveOrigin(p) !== "default") allDefault = false;
  }
  for (const sub of category.categories ?? []) {
    const s = categoryDefaultSummary(sub);
    count += s.count;
    if (!s.allDefault) allDefault = false;
    if (s.noted) noted = true;
  }
  return { count, allDefault, noted };
}

function CategorySection({ category, sheetName, sheetInstances, sheetIndex, sheetFilePath, parentPath, depth, columns, reviews, reviewEnabled, showComments, filterCommented, hideOutOfScope, showDefaults, hiddenInstances, headingExtra, inheritedOutOfScope, onOpenReview, artifact, diff, t }: {
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
  hiddenInstances: Set<string>;
  // Rendered at the right-hand end of THIS category's heading (the side-by-side
  // switch, on a component). Only ever passed to the outermost level.
  headingExtra?: VNode | null;
  // The nearest ancestor category's effective out-of-scope, already resolved.
  // "Out of scope" marks a category AND its descendants, so this threads down
  // through nested categories; a category's own flag (nearest-wins) overrides it.
  inheritedOutOfScope?: OutOfScope;
  onOpenReview: (target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => void;
  artifact?: ArtifactAccess;
  diff?: DiffStatusMap;
  t: Messages;
}) {
  const effOutOfScope = category.out_of_scope ?? inheritedOutOfScope;
  if (hideOutOfScope && effOutOfScope) return null;
  // With unset rows hidden, a category made entirely of them has nothing to
  // show — and a heading over an empty table reads as a rendering bug. This is
  // not a small case: 15 of the Keycloak configuration sheet's 21 groups are
  // whole feature areas (Vault, Telemetry, OpenAPI) this project never touches.
  const summary = categoryDefaultSummary(category);
  if (!showDefaults && summary.allDefault && !summary.noted) return null;
  const categoryPath = parentPath ? `${parentPath}/${category.name}` : category.name;
  const catStatus = diff?.get(catKey(sheetName, categoryPath));
  const catTarget = { sheet: sheetName, category: categoryPath };
  const catReviewCount = reviews.filter((r) => targetKey(r.target) === targetKey(catTarget)).length;

  const HeadingTag = depth <= 1 ? "h3" : depth === 2 ? "h4" : "h5";


  return html`
    <div id=${navAnchorId(sheetIndex, categoryPath)} class=${`rs-category rs-depth-${depth} ${effOutOfScope ? "rs-out-of-scope" : ""}`} style=${`--rs-depth:${depth}`}>
      <div class="rs-category-header">
        <${HeadingTag}>
          ${category.tag && html`<span class="rs-cat-tag">${category.tag}</span>`}
          <span class=${`rs-cat-label ${catStatus === "removed" ? "rs-diff-strike" : ""}`}>${category.display ?? category.name}</span>
          ${effOutOfScope && html`<span class="rs-oos-badge">${t.outOfScope}</span>`}
          ${diff && diffBadge(catStatus)}
          ${(() => {
            // The path this category's settings land on, beside its heading —
            // unless the heading IS that path, which is the ordinary case for a
            // sheet whose components are files: the project labels the category
            // `/etc/systemd/system/keycloak.service` and the same string
            // arrived again as its file_path, so the heading read it twice.
            //
            // Compared against what is SHOWN, not against `name`: the label is
            // what a reader sees (`display`), and the guard that existed asked
            // the other one — `keycloak.service` — which never matched. Same
            // rule the key cell already follows for a label that repeats its
            // key.
            const heading = category.display ?? category.name;
            return category.file_path && category.file_path !== sheetFilePath && category.file_path !== heading
              ? html`<span class="rs-cat-filepath">${category.file_path}</span>`
              : null;
          })()}
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
          ${/* LAST in the heading. Its margin-left: auto absorbs the free space,
                so whatever follows it is pushed to the right edge — placed
                before the comment button, it moved the comment button out to
                the end of the row instead, which is not where it sits on any
                other heading. */ ""}
          ${headingExtra}
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

      ${/* The section's own paragraph, above its table: what this section is, a
            caveat about it, a decision recorded beside the rows rather than in
            one of them. Plain text, deliberately — a markdown renderer here
            would be a second one to keep honest, and this is a note, not a
            page. */ ""}
      ${typeof category.note === "string" && category.note !== "" && html`
        <p class="rs-category-note">${category.note}</p>
      `}

      ${category.params && category.params.length > 0 && html`
        <${ParamTable} params=${category.params} sheetName=${sheetName} sheetInstances=${sheetInstances} sheetIndex=${sheetIndex} categoryPath=${categoryPath} hiddenInstances=${hiddenInstances}
                       depth=${depth}
                       columns=${columns} reviews=${reviews} reviewEnabled=${reviewEnabled}
                       showComments=${showComments} filterCommented=${filterCommented} hideOutOfScope=${hideOutOfScope} showDefaults=${showDefaults}
                       categoryOutOfScope=${effOutOfScope}
                       onOpenReview=${onOpenReview} artifact=${artifact} diff=${diff} t=${t} />
      `}

      ${category.categories?.map((sub) => html`
        <${CategorySection} key=${sub.name} category=${sub} sheetName=${sheetName} sheetInstances=${sheetInstances} sheetIndex=${sheetIndex} hiddenInstances=${hiddenInstances}
                            sheetFilePath=${sheetFilePath} parentPath=${categoryPath} depth=${depth + 1}
                            columns=${columns} reviews=${reviews} reviewEnabled=${reviewEnabled}
                            showComments=${showComments} filterCommented=${filterCommented} hideOutOfScope=${hideOutOfScope} showDefaults=${showDefaults}
                            inheritedOutOfScope=${effOutOfScope}
                            onOpenReview=${onOpenReview} artifact=${artifact} diff=${diff}
                            t=${t} />
      `)}
    </div>
  `;
}


// ============================================================
// Heading navigation (outline + command palette)
// ============================================================

// `text` is a line of a DOCUMENT sheet's own prose — a paragraph, a list item,
// a row of one of its tables. Indexed because the palette is where a reader
// looks for a word they remember, and a test record's items live in table rows
// that no other entry kind reaches: searching for the setting a verdict is
// about found the parameter sheet's row and never the record's.
type NavEntry = {
  kind: "category" | "param" | "comment" | "text";
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

// Stable DOM id for a parameter row.
// An id fragment inside an attribute selector. `CSS.escape` where it exists
// (every browser this ships to), a conservative fallback where it does not
// (happy-dom, in tests).
function cssEscape(v: string): string {
  const g = globalThis as { CSS?: { escape?: (s: string) => string } };
  return g.CSS?.escape ? g.CSS.escape(v) : v.replace(/["\\]/g, "\\$&");
}

// What a row's key cell shows: the key minus the block it sits in.
//
// Stripping a PREFIX, and only when it matches exactly — the chain is built by
// joining the same segments the key is, so it always does, and a mismatch means
// something upstream disagreed about the row's address rather than that the
// display should guess. In that case the whole key is shown, which is never
// wrong, only long.
function keyLeaf(param: ParamData): string {
  // `@` marks an ATTRIBUTE in this tool's own path grammar, because
  // `<foo bar="1">` and `<foo><bar>1</bar></foo>` would otherwise both address
  // as `foo.bar`. The file writes `max-count="10000"`; the marker is ours, and
  // the key column shows the file's words. Stripped for display only — the key
  // itself, which apply and verify resolve by, keeps it.
  const attr = (k: string): string => (k.startsWith("@") ? k.slice(1) : k);
  // A block shows what KIND of block it is, and its argument goes in the value
  // column beside it — `Directory` / `"/var/www"`. Showing the address here
  // instead would put the same string in both cells, which is the exact
  // redundancy these rows were added to remove.
  // A block shows what KIND of block it is, and its argument goes in the value
  // column beside it — `Directory` / `"/var/www"`. Showing the address here
  // instead would put the same string in both cells, which is the exact
  // redundancy these rows were added to remove.
  if (param.container) return param.container.name ?? "";
  const parent = param.container_path?.[param.container_path.length - 1];
  if (!parent) return attr(param.key);
  const prefix = `${parent.path}.`;
  return attr(param.key.startsWith(prefix) ? param.key.slice(prefix.length) : param.key);
}



// Flatten every sheet's categories (depth-first); used by the outline and search.
function collectNav(data: SheetData, showDefaults: boolean, pivoted: Set<string>): NavEntry[] {
  const out: NavEntry[] = [];
  data.sheets.forEach((sheet, sheetIndex) => {
    // A document's headings ARE its outline. They carry the ids the renderer
    // baked into the HTML, so the jump machinery needs nothing new: the entry
    // is resolved with getElementById exactly like a category anchor.
    //
    // Which headings appear was decided at build time (`nav_depth`) and is
    // stated in the model. Re-deciding it here would give the same document two
    // answers depending on which side of the pipeline you asked.
    // A PROSE document's headings are its outline. A sheet handed over as
    // markdown is not one: it has rows, and they are in the categories derived
    // from its text — so it goes through the ordinary walk below, or the outline
    // shows the sheet's name and nothing under it.
    if (sheet.document && sheet.document.mode !== "sheet") {
      for (const h of sheet.document.headings ?? []) {
        out.push({
          kind: "category", sheetIndex, sheetName: sheet.name, path: h.text, name: h.text,
          depth: h.level,
          id: h.id,
          search: `${sheet.display ?? ""} ${sheet.name} ${h.text}`.toLowerCase(),
          text: `${sheet.display ?? sheet.name} / ${h.text}`,
        });
      }
      return;
    }
    // A sheet being read side by side has no component headings — the
    // components are columns — so its outline has to mirror THAT shape or every
    // entry points at an anchor the page no longer has, and the panel silently
    // stops working. Same ids the pivot's own groups carry.
    if (pivoted.has(sheet.name)) {
      // EVERY level, not just the ones holding rows: the pivot renders a
      // heading per level exactly as the stacked view does, so an outline that
      // listed only the leaves would drop the parents a reader navigates by —
      // and they are on the page, so there is nothing to justify omitting them.
      // The components being compared, as an ordinary entry: it is a heading on
      // the page like any other, so it is listed like any other — same style,
      // and clickable. A line of its own in a smaller type read as a caption
      // and, being no entry at all, went nowhere when clicked.
      const subjects = (sheet.categories ?? []).map((c) => c.display ?? c.name).join(" / ");
      out.push({
        kind: "category", sheetIndex, sheetName: sheet.name, path: subjects, name: subjects, depth: 1,
        id: navAnchorId(sheetIndex, subjects),
        search: `${sheet.display ?? ""} ${sheet.name} ${subjects}`.toLowerCase(),
        text: `${sheet.display ?? sheet.name} / ${subjects}`,
        categoryPath: subjects,
      });
      const seen = new Set<string>();
      for (const row of pivotSheet(sheet).rows) {
        for (let n = 1; n <= row.path.length; n++) {
          const segs = row.path.slice(0, n);
          const path = segs.join("/");
          if (seen.has(path)) continue;
          seen.add(path);
          out.push({
            kind: "category", sheetIndex, sheetName: sheet.name, path, name: segs[segs.length - 1],
            // One deeper than in the body's own terms: the components heading
            // is the level above them here, exactly as a component is in the
            // stacked view.
            depth: n + 1,
            id: navAnchorId(sheetIndex, path),
            search: `${sheet.display ?? ""} ${sheet.name} ${path}`.toLowerCase(),
            text: `${sheet.display ?? sheet.name} / ${path}`,
            categoryPath: path,
          });
        }
      }
      return;
    }
    const walk = (cats: CategoryData[], parentPath: string, depth: number) => {
      cats.forEach((c) => {
        const path = parentPath ? `${parentPath}/${c.name}` : c.name;
        // The outline must agree with the body about what exists. A category of
        // nothing but unset rows renders nothing while they are hidden, so an
        // entry for it would jump to a heading that is not there.
        const sum = categoryDefaultSummary(c);
        if (!showDefaults && sum.allDefault && !sum.noted) return;
        out.push({
          kind: "category", sheetIndex, sheetName: sheet.name, path, name: c.display ?? c.name, depth,
          id: navAnchorId(sheetIndex, path),
          // Both: the reader searches by what the tab says, and a saved review
          // or a colleague's message names the identity.
          search: `${sheet.display ?? ""} ${sheet.name} ${path}`.toLowerCase(),
          text: `${sheet.display ?? sheet.name} / ${path}`,
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
// One entry per line of a document that carries words. The id is not an
// element's — a document's blocks carry `data-rs-line`, not ids, since the
// markdown they were rendered from is what a reader edits — so it names the
// line and `jumpToNav` resolves it by that attribute.
export const docLineId = (sheetIndex: number, line: number): string => `rs-doc-line:${sheetIndex}:${line}`;

function collectDocLines(data: SheetData): NavEntry[] {
  const out: NavEntry[] = [];
  data.sheets.forEach((sheet, sheetIndex) => {
    const md = sheet.document?.markdown;
    if (md === undefined || sheet.document?.mode === "sheet") return;
    // Headings are already entries of their own (the outline's), and a table's
    // separator row is punctuation. A fenced block's contents are left in: a
    // command somebody is looking for is as likely to be in one as in prose.
    md.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || /^\|?[\s|:-]+\|?$/.test(line)) return;
      if (line.startsWith("<!--")) return;
      // A table row reads as its cells, not as its pipes.
      const shown = (line.startsWith("|") ? line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter((c) => c !== "").join(" / ") : line).trim();
      if (shown === "") return;
      out.push({
        kind: "text", sheetIndex, sheetName: sheet.name, path: sheet.display ?? sheet.name,
        name: shown.length > 80 ? `${shown.slice(0, 80)}…` : shown,
        depth: 0,
        id: docLineId(sheetIndex, i + 1),
        search: `${shown} ${sheet.display ?? ""} ${sheet.name}`.toLowerCase(),
        text: shown,
      });
    });
  });
  return out;
}

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
            search: `${text} ${sheet.display ?? ""} ${sheet.name} ${path}`.toLowerCase(),
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









// The switch between the stacked and side-by-side readings. Rendered at the
// right-hand end of a component's own heading rather than up in the sheet
// header: it is a statement about THESE components, and beside them is where a
// reader wonders whether they can be compared.
function CompareToggle({ on, onToggle, t }: {
  on: boolean;
  onToggle: () => void;
  t: Messages;
}) {
  return html`
    <label class="rs-compare-toggle" title=${t.compareComponents}>
      <input type="checkbox" checked=${on} onChange=${onToggle} />
      <span>${t.compareComponents}</span>
    </label>
  `;
}

// ============================================================
// Components side by side
// ============================================================

// A sheet whose components are several of the SAME kind of thing — two realms,
// three OIDC clients — is read to answer one question: where do they differ?
// Stacked as headings that means scrolling between two blocks and holding the
// values in your head. Pivoted, the answer is a glance across a row.
//
// Built by re-shaping the render tree, NOT by moving components onto the
// `instances` axis. An Instance carries only name/value/source, so a pivot
// through it would flatten every cell to a value and lose what a comparison is
// actually about: "this one sets it, that one is on the product default" is the
// finding, and `origin` lives on the row. Here each cell is still its own
// Parameter, so it keeps its origin, its source, and — the part that matters
// most — its own review target. A finding filed in this view is the same
// finding as one filed in the stacked view.
type PivotRow = {
  key: string;
  // The category path WITHOUT the component level, which is what the components
  // have in common and therefore what the rows are grouped by.
  path: string[];
  byComponent: Map<string, ParamData>;
};


function pivotSheet(sheet: SheetData["sheets"][number]): { components: CategoryData[]; rows: PivotRow[] } {
  const components = sheet.categories ?? [];
  const rows = new Map<string, PivotRow>();
  for (const component of components) {
    const add = (p: ParamData, path: string[]): void => {
      const id = `${path.join("/")}::${p.key}`;
      const row = rows.get(id) ?? { key: p.key, path, byComponent: new Map() };
      row.byComponent.set(component.name, p);
      rows.set(id, row);
    };
    const walk = (cats: CategoryData[] | undefined, path: string[]): void => {
      for (const c of cats ?? []) {
        const here = [...path, c.name];
        for (const p of c.params ?? []) add(p, here);
        walk(c.categories, here);
      }
    };
    // A row the component holds DIRECTLY — `category: null`, the field that in
    // the admin console sits above the tabs rather than on one. Walking only
    // the children dropped it from this view alone, and this is the view where
    // it is most likely to exist: one component per client or per realm is
    // exactly the shape that puts fields above the tabs.
    for (const p of component.params ?? []) add(p, []);
    walk(component.categories, []);
  }
  return { components, rows: [...rows.values()] };
}

// The same shape, with VERSIONS as the columns instead of components.
//
// A comparison across two product releases cannot use the component axis: on
// three of the four sheets an upgrade review needs, that axis is already spent
// on the data's own identity — the LDAP providers, the clients, the files of
// keycloak.conf — and taking it for versions would give up the very breakdown
// those sheets exist for. Versions are the axis that is free, and (crucially)
// it crosses the component axis rather than competing with it: a component
// stays a category, and `internal-ldap` on one side lines up with `internal-ldap` on
// the other by name, exactly as `buildDiffModel` already merges them.
//
// Emitting `{ components, rows }` rather than a new shape is the whole point —
// PivotView renders this unchanged, so there is one columnar table in the
// product and not two that can drift apart.
//
// Rows are keyed by SHEET + path + key, because this pivots a whole document
// rather than one sheet: `enabled` under `keycloak realm` and `enabled` under
// `keycloak oidc clients` are different rows and must not collapse into one.
function pivotVersions(
  fromSheets: SheetData["sheets"],
  toSheets: SheetData["sheets"],
  fromLabel: string,
  toLabel: string
): { components: CategoryData[]; rows: PivotRow[] } {
  const rows = new Map<string, PivotRow>();
  const side = (sheets: SheetData["sheets"], label: string): void => {
    for (const sheet of sheets) {
      const walk = (cats: CategoryData[] | undefined, path: string[]): void => {
        for (const c of cats ?? []) {
          const here = [...path, c.name];
          for (const p of c.params ?? []) {
            const id = `${sheet.name}::${here.join("/")}::${p.key}`;
            const row = rows.get(id) ?? { key: p.key, path: [sheet.name, ...here], byComponent: new Map() };
            row.byComponent.set(label, p);
            rows.set(id, row);
          }
          walk(c.categories, here);
        }
      };
      walk(sheet.categories, []);
    }
  };
  // `from` first so a row present only in the baseline still appears, in the
  // order the baseline had it — a removed setting is a finding, not an absence.
  side(fromSheets, fromLabel);
  side(toSheets, toLabel);
  return {
    components: [{ name: fromLabel, params: [], categories: [] }, { name: toLabel, params: [], categories: [] }],
    rows: [...rows.values()],
  };
}



// A pivot table with its column header split out, the same shape the stacked
// view uses for a table wide enough to need its own horizontal scroll.
//
// It has to be split. A scroll container breaks page-level sticky for
// everything inside it, so a header left in the table either scrolls away
// vertically or — with a top offset it cannot honour — parks partway down the
// table. The header lives outside the scroller, sticks to the page, and has its
// horizontal offset synced to the body it belongs to.
function PivotTable({ header, depth, columns, children }: { header: VNode; depth: number; columns: number; children: VNode }) {
  const headRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const body = bodyRef.current;
    const head = headRef.current;
    if (!body || !head) return;
    const sync = (): void => { head.scrollLeft = body.scrollLeft; };
    body.addEventListener("scroll", sync, { passive: true });
    sync();
    return () => body.removeEventListener("scroll", sync);
  }, []);
  return html`
    <div class="rs-table-split" style=${`--rs-depth:${depth}; --rs-pivot-cols:${columns}`}>
      <div class="rs-sticky-head" ref=${headRef}>
        <table class="rs-param-table rs-param-table-fixed rs-pivot-table">
          <thead>${header}</thead>
        </table>
      </div>
      <div class="rs-table-wrapper rs-split-body rs-pivot-scroll rs-scroll-thin" ref=${bodyRef}>
        <table class="rs-param-table rs-param-table-fixed rs-pivot-table">
          ${children}
        </table>
      </div>
    </div>
  `;
}

// The pivot table itself: one row per (category path, key), one column per
// component.
//
// Rendered through the SAME structure as the stacked view — a .rs-category per
// level, its heading, the table at the leaf — rather than as a flat list of
// groups. Everything that keys off that structure then keeps working: the
// outline's entries and anchors, the stacked sticky headings, the scroll
// offsets, and the jump flash. Flat groups broke all four at once: parent
// levels had no heading to list or to land on, and the flash lit the whole
// group because the group was what carried the anchor.
type PivotNode = { name: string; path: string[]; rows: PivotRow[]; children: Map<string, PivotNode> };

function pivotTree(rows: PivotRow[]): PivotNode {
  const root: PivotNode = { name: "", path: [], rows: [], children: new Map() };
  for (const row of rows) {
    let node = root;
    for (const seg of row.path) {
      const next = node.children.get(seg) ?? { name: seg, path: [...node.path, seg], rows: [], children: new Map() };
      node.children.set(seg, next);
      node = next;
    }
    node.rows.push(row);
  }
  return root;
}

function PivotView({ sheet, pivot, sheetIndex, hiddenInstances, showDefaults, reviews, reviewEnabled, onOpenReview, onLeave, t }: {
  sheet: SheetData["sheets"][number];
  // Supplied when the columns are not this sheet.s components — a version
  // comparison pivots a whole document, so its columns and rows are built
  // elsewhere (pivotVersions) and handed in ready.
  pivot?: { components: CategoryData[]; rows: PivotRow[] };
  sheetIndex: number;
  onLeave?: () => void;
  hiddenInstances: Set<string>;
  showDefaults: boolean;
  reviews: ReviewItem[];
  reviewEnabled: boolean;
  onOpenReview: (target: ReviewItem["target"], field: string, currentValue: string, sharedRow?: boolean) => void;
  t: Messages;
}) {
  const { components, rows } = pivot ?? pivotSheet(sheet);
  // The heading's own text, and the path its anchor is keyed by — the outline
  // has to name the same string to point at it.
  const subjects = components.map((c) => c.display ?? c.name).join(" / ");
  const shownRows = rows.filter((r) => showDefaults || [...r.byComponent.values()].some((p) => effectiveOrigin(p) !== "default"));
  const tree = pivotTree(shownRows);

  // What one cell shows.
  //
  // `stacked` is decided for the whole ROW, not per cell: when one component
  // varies by environment and another does not, showing three labelled lines
  // beside a single bare value reads as the second component having no
  // per-environment value at all — it has one, the same in each. Stacking both
  // puts the environments on the same lines so the row can be read across,
  // which is the entire point of this view.
  const envValues = (p: ParamData): { name: string; value: string }[] | undefined => {
    if (!p.instances || p.instances.length === 0) return undefined;
    const shown = p.instances.filter((i) => !hiddenInstances.has(i.name));
    return shown.length > 0 ? shown : p.instances;
  };
  const varies = (p: ParamData | undefined): boolean => {
    const envs = p ? envValues(p) : undefined;
    return !!envs && new Set(envs.map((i) => i.value)).size > 1;
  };
  // The environments this sheet is read along, minus the ones switched off.
  const envNames = (sheet.instances ?? []).filter((n) => !hiddenInstances.has(n));
  // The product's default, under the value, in the same cell — because in this
  // table a large share of the rows have no value at all and the default is the
  // only thing they say. Measured on one project: 672 of 1016 rows are unset
  // (`origin: default` or `baseline`), all of them with `value: undefined`, so
  // a columnar view that showed values alone would put two blank columns beside
  // each other and call it "no difference" — over exactly the rows where a
  // version comparison finds things (see diff.ts's `effective`).
  //
  // Shown ALWAYS on an unset row, where it is the value in force and there is
  // nothing else to print. On a row the project sets, shown only when the
  // columns disagree: the configured value is the subject there, and repeating
  // an identical default down every row would bury the handful that moved.
  const defaultLine = (p: ParamData | undefined, columnsDiffer: boolean): string | undefined => {
    const d = p?.default;
    if (d === undefined || d === "") return undefined;
    const unset = p !== undefined && (effectiveOrigin(p) === "default" || effectiveOrigin(p) === "baseline");
    return unset || columnsDiffer ? `${t.defaultValue}: ${d}` : undefined;
  };

  const cellValue = (p: ParamData | undefined, stacked: boolean): { text: string; sub?: string[] } => {
    if (!p) return { text: "" };
    const envs = envValues(p);
    if (!envs) {
      // One value for every environment. Written out per environment while the
      // row is stacked, so it lines up with the component beside it that does
      // vary — otherwise the same value in all of them reads as none of them.
      const value = p.value ?? "";
      return stacked && envNames.length > 0
        ? { text: "", sub: envNames.map((n) => `${n}: ${value}`) }
        : { text: value };
    }
    const values = new Set(envs.map((i) => i.value));
    if (values.size === 1 && !stacked) return { text: envs[0].value };
    return { text: "", sub: envs.map((i) => `${i.name}: ${i.value}`) };
  };

  const headerRow = html`
    <tr>
      <th class="rs-col-key">${t.paramName}</th>
      ${components.map((c) => html`<th key=${c.name} class="rs-col-value">${c.display ?? c.name}</th>`)}
    </tr>
  `;

  // The table's own sticky header sits one level BELOW the headings above it:
  // the stacked view's convention, and the reason it is passed the node's depth
  // rather than a constant. Fixed at 1 it landed at the same offset as a
  // depth-2 category heading and was painted over by it — stuck, invisible, and
  // indistinguishable from not sticking at all.
  const renderTable = (groupRows: PivotRow[], depth: number) => html`
    <${PivotTable} header=${headerRow} depth=${depth} columns=${components.length}>
        <tbody>
          ${groupRows.map((row) => {
            // Do every column agree? The one question this view exists to
            // answer, so it is marked rather than left to be spotted.
            const present = components.map((c) => row.byComponent.get(c.name)).filter((p): p is ParamData => p !== undefined);
            const stacked = present.some(varies);
            const texts = new Set(present.map((p) => cellValue(p, stacked).text + (cellValue(p, stacked).sub ?? []).join("|")));
            // Defaults are compared in their own right: two columns can hold the
            // same value (or no value at all) while the product default beneath
            // them moved, which is the finding an upgrade review is looking for.
            const defaults = new Set(present.map((p) => p.default ?? ""));
            const defaultsDiffer = present.length === components.length && defaults.size > 1;
            const agree = present.length === components.length && texts.size === 1 && !defaultsDiffer;
            return html`
              <tr key=${row.key} class=${`rs-param-row ${agree ? "" : "rs-pivot-differs"}`}>
                <td class="rs-col-key"><code>${row.key}</code></td>
                ${components.map((c) => {
                  const p = row.byComponent.get(c.name);
                  if (!p) {
                    // Not merely unset: this component has no such parameter at
                    // all, which is itself the finding on a sheet built to
                    // compare siblings.
                    return html`<td key=${c.name} class="rs-col-value rs-pivot-absent" title=${t.pivotAbsent}>—</td>`;
                  }
                  const { text, sub } = cellValue(p, stacked);
                  const dflt = defaultLine(p, defaultsDiffer);
                  const tag = originTag(p, t);
                  return html`<${ReviewableCell} key=${c.name}
                    value=${text}
                    target=${{ sheet: sheet.name, category: [c.name, ...row.path].join("/"), param: row.key }}
                    field="value" reviews=${reviews} reviewEnabled=${reviewEnabled}
                    onOpenReview=${onOpenReview}
                    className="rs-col-value" isCode=${true} copyable=${text.length > 0}
                    subline=${[
                      ...(sub ?? []).map((line) => html`<span class="rs-key-subline"><code>${line}</code></span>` as VNode),
                      ...(dflt ? [html`<span class=${`rs-key-subline rs-pivot-default ${defaultsDiffer ? "rs-pivot-default-differs" : ""}`}><code>${dflt}</code></span>` as VNode] : []),
                      ...(tag ? [html`<span class="rs-key-subline"><span class="rs-origin-tag" title=${tag.title}>${tag.label}</span></span>` as VNode] : []),
                    ]}
                    t=${t} />`;
                })}
              </tr>
            `;
          })}
        </tbody>
    <//>
  `;

  const renderNode = (node: PivotNode, depth: number): VNode => {
    const HeadingTag = depth <= 1 ? "h3" : depth === 2 ? "h4" : "h5";
    const path = node.path.join("/");
    return html`
      <div class=${`rs-category rs-depth-${depth}`} id=${navAnchorId(sheetIndex, path)} style=${`--rs-depth:${depth}`} key=${path}>
        <div class="rs-category-header">
          <${HeadingTag}><span class="rs-cat-label">${node.name}</span></${HeadingTag}>
        </div>
        ${node.rows.length > 0 ? renderTable(node.rows, depth) : null}
        ${[...node.children.values()].map((child) => renderNode(child, depth + 1))}
      </div>
    ` as VNode;
  };

  return html`
    <div class="rs-pivot">
      ${/* The components lose their headings here — they are columns now — so
            they are named once at the top. The column header row says it too,
            but that scrolls away, and "which two things am I looking at" is the
            first question this view has to keep answering. */ ""}
      ${/* The component heading, for several components at once — so it is
            THE component heading, in the same style and at the same level. A
            line of bold text where a tinted panel with a rule used to be reads
            as a caption rather than as the level it replaced, and the
            categories below it then have no heading to sit under. */ ""}
      <div class="rs-category rs-depth-1" id=${navAnchorId(sheetIndex, subjects)} style=${`--rs-depth:1`}>
        ${/* The toggle goes INSIDE the heading, exactly where the stacked view
              puts it. The heading is a tinted panel with flex: 1, so a sibling
              beside it ends the panel early and the row comes out as a short
              block of colour with a control floating past its edge. */ ""}
        <div class="rs-category-header">
          <h3>
            <span class="rs-cat-label">${subjects}</span>
            ${onLeave && html`<${CompareToggle} on=${true} onToggle=${onLeave} t=${t} />`}
          </h3>
        </div>
        ${/* Rows with no category of their own go first, directly under the
              components heading — the same order the stacked view uses, where a
              category's own params precede its sub-categories. */ ""}
        ${tree.rows.length > 0 ? renderTable(tree.rows, 1) : null}
        ${[...tree.children.values()].map((child) => renderNode(child, 2))}
      </div>
    </div>
  `;
}

// ============================================================
// Main app
// ============================================================

// ============================================================
// Artifact preview panel
// ============================================================

// The deployed file, beside the sheet.
//
// A value cannot be judged alone: `StartServers 2` is right or wrong depending
// on the `<IfModule mpm_event_module>` around it, and a container is not a row
// — it has no value, no definition site and nothing to review. So the file goes
// next to the sheet rather than its brackets being turned into parameters.
//
// A PINNED PANEL, not a modal. The requirement was to review a setting WHILE
// seeing its surrounding context; a full-screen overlay shows the context
// INSTEAD of the row, which is the problem it was there to solve.
//
// It is a LENS, not data: no review affordances, no source maps of its own, no
// place in the search index. The rows remain the only reviewable values. The
// one thing it does besides scroll-and-highlight is the inverse jump — click a
// line, land on its row.
// `key` is how a ROW opens the panel — highlight the line that IS this row.
// `line` is how the test record's evidence opens it: a verdict was read at a
// line number, not at a key, and an observed document carries no keys at all
// (types.ts) precisely so it can never be reached the other way.
type ArtifactTarget = { id: string; key?: string; instance?: string; line?: number };

// `<preview id>#L<n>` — what an evidence cell puts in `data-rs-evidence`
// (evidence.ts). Parsed rather than split blind: an id contains spaces and
// slashes, and the line suffix is the only part with a fixed shape.
export function parseEvidenceRef(value: string): { id: string; line?: number } {
  const raw = value.startsWith(EVIDENCE_SCHEME) ? decodeURIComponent(value.slice(EVIDENCE_SCHEME.length)) : value;
  const m = /^(.*?)(?:#L(\d+))?$/.exec(raw);
  return { id: m?.[1] ?? raw, ...(m?.[2] === undefined ? {} : { line: Number(m[2]) }) };
}

// What a row needs in order to offer "show me this line in the file".
export type ArtifactAccess = {
  idFor: (sheetName: string, categoryPath: string, key: string) => string | undefined;
  open: (id: string, key: string) => void;
};

function ArtifactPanel({ previews, target, onClose, onPick, onJumpRow, dock, onDock, t }: {
  previews: ArtifactPreview[];
  target: ArtifactTarget;
  onClose: () => void;
  onPick: (instance: string | undefined) => void;
  onJumpRow: (sheet: string, key: string) => void;
  // Where the panel sits, and how the reader moves it. Both are here rather
  // than in the CSS because the choice is the reader's: a wide monitor wants
  // the file beside the sheet, a laptop wants it under a nine-column table.
  dock: Dock;
  onDock: (d: Dock) => void;
  t: Messages;
}) {
  const mine = previews.filter((a) => a.id === target.id);
  const shown =
    mine.find((a) => target.instance !== undefined && a.instances?.includes(target.instance)) ?? mine[0];
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Scroll the row's own line into view whenever the target or the instance
  // changes — that is the entire point of opening the panel from a row.
  useLayoutEffect(() => {
    const el = bodyRef.current?.querySelector(".rs-here");
    if (el) (el as HTMLElement).scrollIntoView({ block: "center" });
    else bodyRef.current?.scrollTo({ top: 0 });
  }, [target.id, target.key, target.line, shown]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!shown) return null;

  // Only the lines that are the sheet ADMITTING A GAP. A line the toolchain
  // fills in at deploy time is not one, and counting it made the warning fire
  // on every file in a real project without once pointing at a setting — which
  // is worse than not warning at all, since it buried the case that matters.
  const gaps = shown.lines.filter((l) => l.kind === "unrendered" && l.cause !== "deploy-time").length;

  return html`
    <aside class=${`rs-artifact-panel ${dock === "below" ? "rs-artifact-below" : ""}`} aria-label=${t.artifactTitle}>
      <div class="rs-artifact-head">
        ${/* Pinned to the panel's own top-right corner rather than laid out
             beside the path: a deployed path is long and wraps, and a close
             button that moves with the text is one a reader has to look for. */ ""}
        ${/* Where it sits, chosen once and remembered — the same control a
             browser's own inspector puts here, for the same reason: the right
             answer depends on the screen, not on the file. */ ""}
        <div class="rs-artifact-dock">
          <button class=${`rs-dock-btn ${dock === "right" ? "rs-dock-on" : ""}`} onClick=${() => onDock("right")}
                  title=${t.artifactDockRight} aria-label=${t.artifactDockRight} aria-pressed=${dock === "right"}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg>
          </button>
          <button class=${`rs-dock-btn ${dock === "below" ? "rs-dock-on" : ""}`} onClick=${() => onDock("below")}
                  title=${t.artifactDockBelow} aria-label=${t.artifactDockBelow} aria-pressed=${dock === "below"}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="14" x2="21" y2="14"/></svg>
          </button>
        </div>
        <button class="rs-modal-close rs-artifact-close" onClick=${onClose} aria-label=${t.shortcutClose}>\u00d7</button>
        <div class="rs-artifact-title">
          <span class="rs-artifact-path">${shown.nature === "source" ? shown.source_file : (shown.deployed_path ?? shown.source_file)}</span>
        </div>
        <div class="rs-artifact-meta">
          ${/* Provenance — which file to edit — and nothing else. A tally of how
               many lines carried no Jinja is the lens describing its own optics:
               a reviewer cannot act on it, and "verbatim" reads as a claim about
               trust when it only means the template had no braces there. A
               `nature: "source"` preview is the authored file itself, not
               something rendered FROM it — "Rendered from" would be a false
               claim, so it gets its own label instead. */ ""}
          ${/* …and the path only when it says something the title has not. An
               OBSERVED document's source IS the subject the title already
               names — the file it was read from, or the command it is the
               output of — so repeating it puts the same string on screen
               twice, once as a heading and once as evidence of itself. */ ""}
          ${showSources()
            ? html`${artifactProvenance(shown, t)}${(shown.deployed_path ?? shown.source_file) === shown.source_file && shown.nature === "observed"
                ? null
                : html`: <code>${shown.source_file}</code>`}`
            : null}
          ${/* The exception, and only when there IS one. Costs nothing at zero,
               and when it fires it is the index that makes a marked line 200
               rows down get found instead of scrolled past. */ ""}
          ${gaps > 0
            ? html`<br /><span class="rs-artifact-warn">${t.artifactUnrendered.replace("{n}", String(gaps))}</span>`
            : null}
        </div>
        ${mine.length > 1 && html`
          <div class="rs-artifact-tabs">
            ${mine.map((a) => {
              const label = (a.instances ?? []).join(" / ");
              return html`<button class=${`rs-artifact-tab ${a === shown ? "rs-on" : ""}`}
                                  onClick=${() => onPick(a.instances?.[0])}>${label}</button>`;
            })}
          </div>
        `}
      </div>
      <div class="rs-artifact-body" ref=${bodyRef}>
        ${shown.lines.map((line, i) => {
          const here =
            target.line !== undefined
              ? i + 1 === target.line
              : (line.keys ?? (line.key === undefined ? [] : [line.key])).includes(target.key ?? "");
          const title =
            line.kind === "absent"
              ? t.artifactKindAbsent.replace("{reason}", line.reason ?? "")
              : line.kind === "unrendered"
                ? (line.cause === "deploy-time" ? t.artifactKindDeployTime : t.artifactKindUnrendered).replace(
                  "{reason}",
                  line.reason ?? ""
                )
                : line.key !== undefined
                  ? t.artifactJumpRow
                  : undefined;
          return html`
            <div class=${`rs-artifact-line rs-kind-${line.kind} ${line.key !== undefined ? "rs-has-row" : ""} ${here ? "rs-here" : ""}`}
                 title=${title}
                 onClick=${line.key !== undefined ? () => onJumpRow(shown.sheet, line.key!) : undefined}>
              <span class="rs-artifact-no">${i + 1}</span>
              <span class="rs-artifact-text">${line.text === "" ? "\u00a0" : line.text}</span>
            </div>
          `;
        })}
      </div>
    </aside>
  `;
}

function App({ data: baseData, artifacts, reviewEnabled, promptEnabled = true, lang, diff, reviewsOverride, versionPivot, server, applyEnabled, onSaveSingle }: {
  data: SheetData;
  // A whole-document columnar comparison: rows keyed by sheet + path + key,
  // one column per VERSION. Supplied only while comparing, and rendered
  // INSTEAD of the sheets — it is one table across every sheet, because the
  // question it answers ("what moved between these two releases") is not a
  // per-sheet question.
  versionPivot?: { components: CategoryData[]; rows: PivotRow[] };
  // The deployed files this document's rows describe (ArtifactPanel). Per
  // version, like `columns` — a template that changed between two revisions
  // must not be redrawn under the older document.
  artifacts?: ArtifactPreview[];
  // Write what is on screen into a copy of this page. Present only when the
  // page is holding a set — there is nothing to write out otherwise.
  onSaveSingle?: () => void;
  reviewEnabled: boolean;
  // Let the recipient change values and remarks in place (`--allow edit`).
  // Offer the AI prompt at all (`--allow ...,prompt`). A judgement about the
  // AUDIENCE, not about the mode: in the usual flow the edited document goes
  // back to whoever built it and the prompt is produced there, by `apply`,
  // against the real files — so the copy inside the handed-over document is
  // often something its holder has no use for.
  promptEnabled?: boolean;
  lang: Lang;
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
  // See init(): the document as loaded, and the history it already carried.
}) {
  const t = useMemo(() => getMessages(lang), [lang]);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.dataset.theme as 'light' | 'dark') ?? 'light');
  // Findings live in THIS BROWSER and nowhere else: a generated sheet is a
  // read-only file, so there is no second copy for the union to reconcile.
  const storageKey = getStorageKey(baseData);
  const [savedReviews, setReviews] = useState<ReviewItem[]>(() => loadReviews(storageKey));
  // Saved findings name the category their row was in when they were written.
  // A category is display structure — a product dictionary supplies most of
  // them, and an upgrade can move a setting to another screen — so they are
  // re-pointed at wherever the row is now, once, before anything compares
  // targets. Without this, upgrading the dictionary under a review in progress
  // detaches every finding on a moved row and says nothing.
  const retargeted = useMemo(() => retargetReviews(savedReviews, baseData), [savedReviews, baseData]);
  const movedReviews = retargeted.moved;
  const diffMode = !!reviewsOverride;
  const reviews = reviewsOverride ?? retargeted.reviews;
  const effReviewEnabled = diffMode ? false : reviewEnabled;

  // The environments this document knows about. One set for the whole document
  // — which sheets USE which is a matter of what columns their tables have.
  const environments = useMemo(() => {
    const seen: string[] = [];
    for (const s of baseData.sheets) for (const n of s.instances ?? []) if (!seen.includes(n)) seen.push(n);
    return seen;
  }, [baseData]);

  const data = useMemo<SheetData>(() => {
    const base = baseData;
    // A sheet whose model is its markdown carries no categories — the text is the
    // model. They are DERIVED here, from that text, so everything that asks
    // "what rows does this sheet have" (the outline, the search palette, the
    // side-by-side comparison) keeps working with no second implementation and
    // no chance of disagreeing with the page. The BODY still renders from the
    // text itself: this is an index, not a model.
    if (!base.sheets.some((s) => s.document?.mode === "sheet")) return base;
    return {
      ...base,
      sheets: base.sheets.map((s) => {
        if (s.document?.mode !== "sheet") return s;
        const markdown = s.document.markdown ?? "";
        // The environments the DOCUMENT declares. The model's list is what it
        // was generated with; the document is what it says now, and in this
        // mode the document is the model — an environment somebody added is an
        // environment, everywhere, not a column the page treats as one and the
        // rest of the viewer does not know about.
        // The document's set decides what a column MEANS; this sheet's tables
        // decide which of them it has. Both are needed: the first to read a
        // header, the second to know what this sheet covers.
        const here = (declaredInstances(markdown) ?? []).filter((n) => environments.includes(n));
        return { ...s, instances: here, categories: markdownToCategories(markdown, environments, lang) };
      }),
    };
  }, [baseData, lang, environments]);
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

  // WHERE IN the document, carried in the fragment beside which document it is.
  // A reload otherwise put the reader back at the top of the right sheet, which
  // on a long one is not where they were — and the browser cannot help, because
  // it restores the scroll before this page has built the content that would
  // make that position exist.
  //
  // The fragment and not a stored position, because this is an ADDRESS: it is
  // the thing a reader copies into a mail to say "this row", and it survives
  // back and forward without a second mechanism. Not a path either — a
  // delivered document is opened from a file:// URL, where pushState with a
  // path is a SecurityError (measured), so the fragment is the only address
  // this document can have.
  const [initialAnchor] = useState(() => {
    const raw = location.hash.replace("#", "");
    const slash = raw.indexOf("/");
    if (slash < 0) return null;
    try { return decodeURIComponent(raw.slice(slash + 1)) || null; } catch { return null; }
  });

  // Set while a JUMP is switching sheets (jumpToNav). A jump names a place
  // inside the document it opens; choosing a document from the navigation names
  // none, and the two want opposite things from the scroll — so the jump says
  // so, and the selection below stands aside.
  const jumpOwnsScroll = useRef(false);

  // Update URL hash on tab change (1-based)
  const setActiveSheet = useCallback((idx: number) => {
    setActiveSheetState(idx);
    location.hash = idx === -1 ? "overview" : String(idx + 1);
    // …and the document opens at its BEGINNING. Switching sheets replaces what
    // is on screen and leaves the scroll where it was, so choosing a document
    // while deep inside another one landed that far down the new one —
    // measured, 9000px in, with its first heading 3.1k pixels above the screen.
    //
    // HERE rather than on a change of activeSheet, because choosing the
    // document already being read is the same request: a reader who jumped into
    // the middle of it and then clicks its name in the tree is asking to go
    // back to the top of it, and an act that does nothing looks broken.
    if (!jumpOwnsScroll.current) window.scrollTo({ top: 0 });
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
  const [showComments, setShowComments] = useState(false);
  // Environments switched off in the filter menu. A document-wide set of NAMES
  // rather than a per-sheet selection: "show me production" is one decision a
  // reader makes about the whole review, and the sheets that do not have that
  // environment are simply unaffected.
  const [hiddenInstances, setHiddenInstances] = useState<Set<string>>(() => new Set());
  // Sheets currently read side by side, by name — a per-sheet choice, since
  // only a sheet whose components are siblings has anything to compare.
  // A sheet declaring `compare_components: "always"` starts pivoted and never
  // leaves: it exists to compare, so the stacked reading is not a state it has.
  const alwaysPivoted = useMemo(
    () => new Set(data.sheets.filter((s) => s.compare_components === "always").map((s) => s.name)),
    [data.sheets]
  );
  const [pivoted, setPivoted] = useState<Set<string>>(() => new Set(alwaysPivoted));
  const [modalTarget, setModalTarget] = useState<{ target: ReviewItem["target"]; field: string; currentValue: string; sharedRow?: boolean } | null>(null);
  const [applyPanelOpen, setApplyPanelOpen] = useState(false);
  const [promptModalText, setPromptModalText] = useState<string | null>(null);

  useEffect(() => {
    if (diffMode) return; // never persist synthetic diff reviews
    saveReviews(storageKey, savedReviews);
  }, [savedReviews, storageKey, diffMode]);


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
  // The environments of the sheet being read — its own, in its own order.
  //
  // Not the document's: a sheet declares which environments it covers, and they
  // genuinely differ (an infrastructure sheet built from a plan that is never
  // run locally has no "local"). Listing every name the document mentions
  // offers to switch off a column this table does not have, and listing them in
  // document order put the menu in a different order than the columns beside
  // it. The selection itself stays document-wide — "show me production" is one
  // decision about the review — so a name hidden here is still hidden on the
  // sheets that do have it.
  const allInstances = (() => {
    const sheet = activeSheet >= 0 ? data.sheets[activeSheet] : undefined;
    if (!sheet) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const n of sheet.instances ?? []) if (!seen.has(n)) { seen.add(n); names.push(n); }
    const walk = (cats: CategoryData[] | undefined): void => {
      for (const c of cats ?? []) {
        for (const p of c.params ?? []) for (const i of p.instances ?? []) if (!seen.has(i.name)) { seen.add(i.name); names.push(i.name); }
        walk(c.categories);
      }
    };
    walk(sheet.categories);
    return names;
  })();

  const toggleInstance = (name: string): void => {
    setHiddenInstances((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      // Never all of THIS sheet's: a filter that can empty every value column
      // leaves the reader looking at keys with no way to see what this is
      // about. Counted against the sheet on screen, since that is the table the
      // toggle would empty.
      return allInstances.every((n) => next.has(n)) ? prev : next;
    });
  };
  // "Show comments" is not counted; a hidden environment is. The badge means
  // "you are not seeing all of it", and a column switched off withholds as much
  // as a row filtered out — more, since nothing on screen hints at its absence.
  const activeFilters = [filterCommented, hideOutOfScope, allInstances.some((n) => hiddenInstances.has(n))].filter(Boolean).length;
  // Every unset row in the document, for the toggle's own label.
  // Does this document hand its sheets over as markdown? Read once: several
  // controls exist or not depending on it.
  const markdownSheets = data.sheets.some((s) => s.document?.mode === "sheet");
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

  // Expose the sticky tab bar's height so document-flow sticky table headers can
  // stick just below it. Every sticky offset in the document is derived from
  // this one number — category headings, table headers, the outline panel's top
  // and height, and every scroll-margin-top — so a stale value does not degrade
  // gracefully: headings park at the wrong line and anchors land under the bar.
  //
  // Observed rather than recomputed on `resize`, because the bar's height is
  // not a function of the window's. It changes whenever its own content does,
  // and a window resize is only one of the ways that happens.
  useEffect(() => {
    const el = document.querySelector(".rs-sheet-tabs");
    const update = () => {
      const h = el ? Math.round(el.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty("--rs-tabbar-h", `${h}px`);
    };
    update();
    if (!el || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- Heading navigation (outline + command palette) ---
  const categoryEntries = useMemo(() => collectNav(data, showDefaults, pivoted), [data, showDefaults, pivoted]);
  const paramEntries = useMemo(() => collectParams(data, showDefaults), [data, showDefaults]);
  // A document's own words, so the palette reaches a test record's rows — the
  // one place a reader's remembered word lives that no other entry kind holds.
  const docTextEntries = useMemo(() => collectDocLines(data), [data]);
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
  const paletteEntries = useMemo(() => [...categoryEntries, ...paramEntries, ...docTextEntries, ...commentEntries], [categoryEntries, paramEntries, docTextEntries, commentEntries]);
  // A book document opens WITH its chapters showing: the tree is the navigation
  // there, not an aid to it, and a document set whose navigation starts hidden
  // opens as a page with no way out of itself. A tabbed document keeps the
  // drawer it has always had, closed until asked for.
  const [outlineOpen, setOutlineOpen] = useState<boolean>(loadOutlineOpen);
  // Held here rather than inside the tree: hiding the tree unmounts it, and a
  // filter the reader had to type again every time they reclaimed the space is
  // a filter that charges them for using the panel. Not persisted — reopening
  // the document should show the document, not the last search.
  const [navFilter, setNavFilter] = useState("");
  // A document SET states that it is one (`nav: book`, types.ts). The tree
  // replaces the tab strip and stands beside the text; every other document
  // keeps the strip it has always had.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [currentNavId, setCurrentNavId] = useState<string | null>(null);
  // After an outline/palette click we pin the highlight to the clicked target and
  // suppress the scroll-spy briefly, so the programmatic scroll settling doesn't
  // re-select whatever category happens to sit in the top band (which is what
  // steals the highlight when the target is near the bottom and can't reach top).
  const spySuppressUntil = useRef(0);

  useEffect(() => { saveOutlineOpen(outlineOpen); }, [outlineOpen]);



  // The inverse jump: a line of the previewed file back to the row that reviews
  // it. Found in the DOM rather than recomputed, because a row's anchor is
  // `<sheet>--<category path>--<key>` and only the rendered tree knows which
  // category path this key ended up under.
  const jumpToRow = useCallback((_sheet: string, key: string) => {
    const land = (): boolean => {
      const el = document.querySelector(`[id$="--${cssEscape(encodeIdPart(key))}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.classList.remove("rs-jump-flash");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("rs-jump-flash");
      window.setTimeout(() => el.classList.remove("rs-jump-flash"), 1700);
      return true;
    };
    if (land()) return;
    // Not rendered — almost always because the row is a product default and the
    // unset rows are hidden. Show them and try again on the next paint, rather
    // than doing nothing: a click that silently accomplishes nothing is the
    // same failure as an affordance that opens nothing, and the reader has just
    // pointed at the line and said "this one".
    setShowDefaults(true);
    // A macrotask, not a microtask: the re-render is queued by the state change
    // above and has to have happened before the row can be found.
    window.setTimeout(land, 0);
  }, []);

  // An ordinary anchor, or a document LINE — which has no id, because the
  // markdown a reader edits is what those blocks are addressed by.
  const resolveNavTarget = (id: string): HTMLElement | null => {
    const at = /^rs-doc-line:\d+:(\d+)$/.exec(id);
    if (at === null) return document.getElementById(id);
    return document.querySelector(`.rs-doc [data-rs-line="${at[1]}"]`);
  };
  const jumpToNav = useCallback((sheetIndex: number, id: string, fallbackId?: string, sheetName?: string, categoryPath?: string) => {
    setPaletteOpen(false);
    // Instant jump (no smooth animation) so far-away targets land immediately.
    // Fall back to the category when the exact row is not rendered (e.g. a
    // transposed table, where a parameter is a column rather than a row).
    const scroll = () => {
      const el = resolveNavTarget(id) ?? (fallbackId ? resolveNavTarget(fallbackId) : null);
      if (!el) return;
      // scrollIntoView aims at where a box IS, and a document's section heading
      // is STICKY — so its box is wherever the scroll has pushed it, not where
      // the section starts. Jumping from far away therefore missed by whatever
      // the sticky shift was: measured on a real set, a jump to the first
      // section of a test document landed 5.2k pixels down, at the very END of
      // that section, because a section left behind holds its heading at its
      // own bottom edge and that is the box the browser aimed at.
      //
      // So the sticking is suspended for the aim and restored immediately: the
      // browser then sees the heading where the section actually begins, and
      // the scroll-margin the heading already declares still applies. Nothing
      // is painted in between — the class is added and removed inside one
      // frame, around a call that scrolls synchronously.
      aimAt(el);
      // Briefly flash the landed-on target so it's easy to spot.
      // The header ROW, not the heading inside it: the flash marks where you
      // landed, and a tint the width of the words is not that. What it paints
      // WITH is what had to change — see rs-flash in styles.ts.
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
    if (sheetChanged) { jumpOwnsScroll.current = true; setActiveSheet(sheetIndex); }
    // Switching sheets only takes effect on the next render, so the target
    // isn't in the DOM yet this tick.
    if (sheetChanged) {
      requestAnimationFrame(() => requestAnimationFrame(() => { scroll(); jumpOwnsScroll.current = false; }));
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
      // A document sheet has no categories; its outline is its headings, so
      // those are what the spy has to follow. Taken from the MODEL rather than
      // from a selector, so the elements tracked are exactly the entries the
      // outline lists — a heading below `nav_depth` is on the page but in no
      // entry, and scrolling past one would otherwise clear the highlight to
      // point at nothing.
      //
      // Without this the spy found zero elements here and set the current entry
      // to null on every scroll, which also wiped the highlight jumpToNav had
      // just set — the outline looked broken in a document and only there.
      const activeDoc = activeSheet >= 0 ? data.sheets[activeSheet]?.document : undefined;
      const cats = activeDoc
        ? (activeDoc.headings ?? [])
            .map((h) => document.getElementById(h.id))
            .filter((el): el is HTMLElement => el !== null)
        : Array.from(document.querySelectorAll<HTMLElement>(".rs-category[id]"));
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

  // …and that is what goes in the fragment. replaceState, not an assignment to
  // location.hash: a reader scrolling through a document would otherwise leave
  // a history entry per section and could not get back out with the back
  // button. The section is dropped on the overview, which has none.
  useEffect(() => {
    const base = activeSheet === -1 ? "overview" : String(activeSheet + 1);
    const next = currentNavId === null || activeSheet === -1
      ? `#${base}`
      : `#${base}/${encodeURIComponent(currentNavId)}`;
    if (location.hash !== next) history.replaceState(null, "", next);
  }, [currentNavId, activeSheet]);

  // Arriving with one: the document is already the right one (getInitialTab
  // reads the same fragment), so all that is left is to land on the place it
  // names. Two frames, for the same reason a jump across sheets takes them —
  // the content has to be in the DOM before it can be measured. A fragment
  // naming something this document no longer has simply stays at the top,
  // which is what a stale link should do.
  useEffect(() => {
    if (initialAnchor === null) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.getElementById(initialAnchor);
      if (el !== null) aimAt(el);
    }));
  }, []);

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
      // The original tree, not the edit-overlaid view: a serve-mode write lands
      // in the config file, so it moves the BASELINE.
      const sheet = baseData.sheets.find((s) => s.name === tgt.sheet);
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
  }, [baseData]);

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

  // In edit mode the items are `applied`, not `pending`, so the prompt is built
  // from the same collapsed plan the CLI uses — one net change per cell, plus
  // the added and struck-out rows with the reason they cannot be written by a
  // source map. Without that the two would describe the same change
  // differently, and the browser's version would be the wrong one.
  //
  const handleCopyPrompt = useCallback(() => {
    const text = buildPromptText(reviews, baseData);
    if (!text) {
      alert(t.noPendingReviews);
      return;
    }
    setPromptModalText(text);
  }, [reviews, baseData, t]);

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

  const [artifactTarget, setArtifactTarget] = useState<ArtifactTarget | null>(null);
  // Which SHAPE the open document wants. An observed document was reached from
  // a record whose rows are nine columns wide, and a panel that takes 34rem off
  // the width leaves that table unreadable — see the CSS. Read off the document
  // itself rather than remembered from how it was opened: the panel can only
  // ever show one, and the document knows what it is.
  const evidenceOpen =
    artifactTarget !== null &&
    (artifacts ?? []).some((a) => a.id === artifactTarget.id && a.nature === "observed");
  const [dock, setDock] = useState<Dock | undefined>(loadDock);
  const pickDock = (d: Dock): void => { setDock(d); saveDock(d); };
  // The reader's choice, or what the document being opened wants.
  const dockNow: Dock = dock ?? (evidenceOpen ? "below" : "right");
  // Which preview a row belongs to, resolved once per document. A sheet
  // covering several artifacts keys them by component, which the viewer only
  // knows as the outermost category — the same resolution `assembleSheets`
  // does for a per-component binding. A key present in exactly one of the
  // sheet's previews needs no disambiguation at all, which is every
  // single-artifact sheet.
  const artifactIndex = useMemo(() => {
    // …and never an OBSERVED one. Its lines carry the same keys — it is the
    // same file, read off a host — so admitting it here would make a row's
    // "show me this line" open the evidence or the rendered artifact depending
    // on which was emitted last. The row's document is the one this sheet
    // describes; evidence is reached from the record that cites it.
    // Keyed by sheet AND component, never by key alone. Two components of one
    // sheet share a key space by design — a Keycloak realm sheet has `enabled`
    // under every realm — so a component-scoped index is what stops a row
    // offering to open a file that has no line for it. Measured on a real
    // sheet: 28 lines in one file were matching 46 rows.
    const out = new Map<string, string>();
    for (const a of artifacts ?? []) {
      if (a.nature === "observed") continue;
      for (const line of a.lines) {
        // Every row the line IS, not only the one it jumps back to: a line
        // holding two settings is two rows, and both want the button.
        for (const k of line.keys ?? (line.key === undefined ? [] : [line.key])) {
          out.set(`${a.sheet}\u0000${a.component ?? ""}\u0000${k}`, a.id);
        }
      }
    }
    return out;
  }, [artifacts]);
  // Every name a sheet's outermost category could be wearing, against the
  // component the previews are indexed by.
  //
  // Two things had to go: splitting the category path on "/" to get its head —
  // a component that is a deployed file contains one, so that took the empty
  // string before the leading slash — and then assuming the head IS the
  // component. It need not be. A component is free to be a short alias
  // (`keycloak.conf`) while the category is the file it deploys
  // (`/opt/keycloak/conf/keycloak.conf`), and after the category-naming fixes
  // that is the ordinary case, not a corner. The artifact knows both, so both
  // are keys here.
  const componentByCategory = useMemo(() => {
    const bySheet = new Map<string, Map<string, string>>();
    const add = (sheet: string, name: string | undefined, component: string): void => {
      if (name === undefined || name === "") return;
      const m = bySheet.get(sheet) ?? new Map<string, string>();
      if (!m.has(name)) m.set(name, component);
      bySheet.set(sheet, m);
    };
    for (const a of artifacts ?? []) {
      if (a.component === undefined) continue;
      add(a.sheet, a.component, a.component);
      add(a.sheet, a.deployed_path, a.component);
    }
    return bySheet;
  }, [artifacts]);
  const artifactFor = useCallback((sheetName: string, categoryPath: string, key: string): string | undefined => {
    // The component is the outermost category, exactly as `assembleSheets`
    // resolves it for a per-component binding — and it collapses away on a
    // single-component sheet, which is why the unscoped lookup is the fallback
    // rather than an error.
    //
    // Read off the names that EXIST rather than by splitting the path: the
    // separator is "/" and a category naming a deployed file contains one.
    // Longest first, so a name nested inside another wins.
    const known = [...(componentByCategory.get(sheetName)?.entries() ?? [])].sort((a, b) => b[0].length - a[0].length);
    const head =
      known.find(([name]) => categoryPath === name || categoryPath.startsWith(`${name}/`))?.[1] ??
      categoryPath.split("/")[0];
    return (
      artifactIndex.get(`${sheetName}\u0000${head}\u0000${key}`) ??
      artifactIndex.get(`${sheetName}\u0000\u0000${key}`)
    );
  }, [artifactIndex, componentByCategory]);
  const artifactAccess = useMemo<ArtifactAccess | undefined>(
    () =>
      (artifacts?.length ?? 0) === 0
        ? undefined
        : { idFor: artifactFor, open: (id, key) => setArtifactTarget({ id, key }) },
    [artifacts, artifactFor]
  );

  const hasMetadata = !!(data.metadata?.project || data.metadata?.version || data.metadata?.generated_at || data.metadata?.changelog?.length || data.metadata?.extra);
  // Tabs: overview (if metadata exists) + each sheet
  const OVERVIEW_TAB = -1;

  return html`
    <div class=${`rs-app ${outlineOpen ? "rs-outline-open" : ""} rs-book ${artifactTarget ? (dockNow === "below" ? "rs-with-evidence" : "rs-with-artifact") : ""}`}>
      <nav class="rs-sheet-tabs" aria-label=${t.navOutline}>
        <div class="rs-tabs-nav">
          <button class=${`rs-toolbar-btn ${outlineOpen ? "rs-toolbar-btn-active" : ""}`} onClick=${() => setOutlineOpen(!outlineOpen)}
                  title=${t.navOutlineTip} aria-label=${t.navOutlineTip} aria-pressed=${outlineOpen}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
          </button>
        </div>
        ${/* The document is read as chapters, from the tree beside the text
              (nav-tree.ts). A strip of tabs above it was the older reading and
              is gone: it could not show a hierarchy, and a hundred of them is a
              menu nobody can see. The bar keeps the PATH to where the reader
              is, which a tree scrolled out of view cannot say. */ ""}
        ${html`<nav class="rs-tabs-book" aria-label=${t.navOutline}>
              ${/* The document itself is the root of the path and a LINK to its
                    front matter — the convention every reader of a docs site
                    already has, and the one place the front matter is reachable
                    from with the tree hidden. It also puts the document's title
                    into the chrome, which otherwise appears only on the page it
                    links to. The chapters between are text: they are headings,
                    not pages, and linking them would invent a destination. */ ""}
              <a class="rs-crumb rs-crumb-root" href="#overview"
                 aria-current=${activeSheet < 0 ? "page" : undefined}
                 onClick=${(ev: MouseEvent) => {
                   if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return;
                   ev.preventDefault();
                   setActiveSheet(-1);
                 }}>${data.metadata?.title ?? t.overview}</a>
              ${(() => {
                const path = chapterPath(data.groups, data.sheets, activeSheet, lang, baseData.numbering !== false);
                return path.map(
                  (seg, i) => html`<span class="rs-crumb" key=${i}
                                         aria-current=${i === path.length - 1 ? "page" : undefined}>${seg}</span>`
                );
              })()}
            </nav>`}
        <div class="rs-tabs-right">
          ${
            // Filters stay while comparing. They were gated on review being on,
            // which diff mode switches off — taking with it the only control
            // that reveals unset rows, and a version comparison finds most of
            // what it finds among exactly those (the product default moved
            // under a value nobody set). Reviewing is what diff mode disables;
            // deciding which rows are on screen is not reviewing.
            // …and in a markdown-backed sheet, where reviewing may be off:
            // hiding the rows nobody set is what makes a 1500-row sheet
            // readable, and it is not a review affordance.
            (effReviewEnabled || diffMode || markdownSheets) && html`
            <${ToolbarMenu} label=${activeFilters > 0 ? t.filterMenuCount(activeFilters) : t.filterMenu}
                            active=${activeFilters > 0}
                            icon=${html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>` as VNode}>
              ${/* Showing comments, and keeping only the rows that have one,
                    are about FINDINGS — so they belong to a document that can
                    hold findings. A hand-maintained one cannot: it has no cell
                    to attach one to, and a filter for something that cannot
                    exist only ever hides everything. */ ""}
              ${effReviewEnabled && html`
                <${MenuCheck} label=${t.showCommentsToggle} checked=${showComments} onToggle=${() => setShowComments(!showComments)} />
                <div class="rs-menu-divider"></div>
                <${MenuCheck} label=${t.showCommentedOnly} checked=${filterCommented} onToggle=${() => setFilterCommented(!filterCommented)} />
              `}
              <${MenuCheck} label=${t.hideOutOfScope} checked=${hideOutOfScope} onToggle=${() => setHideOutOfScope(!hideOutOfScope)} />
              ${defaultRowCount > 0 && html`
                <${MenuCheck} label=${t.showDefaults(defaultRowCount)} checked=${showDefaults}
                              onToggle=${() => setShowDefaults(!showDefaults)} />
              `}
              ${/* Last, behind a divider and a heading of its own: everything
                    above decides which ROWS are on screen, and this decides
                    which COLUMNS. Sitting in the middle of the row toggles it
                    read as one more of them. */ ""}
              ${allInstances.length > 1 && html`
                <div class="rs-menu-divider"></div>
                <div class="rs-menu-section">${t.columnsShown}</div>
                ${allInstances.map((name) => html`
                  <${MenuCheck} key=${name} label=${name} checked=${!hiddenInstances.has(name)}
                                onToggle=${() => toggleInstance(name)} />
                `)}
              `}
            <//>
          `}

          ${/* Search sits with the tools rather than beside the chapters: the
                button on the left opens the panel next to it — a control whose
                target is there belongs there — while search has no place of its
                own on the page, which is what a toolbar is for. AFTER the
                filters, because those change what the page shows and keep a
                count of it; a control with state deserves the fixed slot, and a
                transient overlay can sit beside it. */ ""}
          <button class="rs-toolbar-btn" onClick=${() => setPaletteOpen(true)} title=${t.navSearchTip} aria-label=${t.navSearchTip}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          </button>
          <span class="rs-tabs-sep"></span>

          ${/* Handing a REVIEW back — the export, the import, the clear — is
                about findings, and belongs to a document that holds them. It
                sits behind its own gate rather than the filters' widened one: a
                hand-maintained document saves ITSELF, and a review.json beside
                it is a second, lesser copy of what the file already carries —
                one that looks like an alternative to saving, which is how work
                gets lost. */ ""}
          ${(effReviewEnabled || diffMode) && html`
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
              ${applyEnabled !== false && !server && promptEnabled
                ? html`<${MenuItem} label=${t.aiPromptCopy} onClick=${handleCopyPrompt} />`
                : null}
              <div class="rs-menu-divider"></div>
              <${MenuItem} label=${t.clearAllMenu} onClick=${handleClearAll} danger=${true} />
            <//>
          `}
          ${/* No export here, deliberately. In REVIEW mode the document cannot
                write itself and findings live only in this browser's storage,
                so exporting them is the single way out and the whole point. In
                EDIT mode the document saves itself and `apply -r sheet.html`
                reads it, so a JSON of the same entries is a second, lesser copy
                of what the file already carries — and one that looks like an
                alternative to saving, which is how work gets lost. What is left
                here is the prompt, for whoever maintains the sheet without a
                CLI. */ ""}
          ${promptEnabled && html`
            <button class="rs-toolbar-btn rs-toolbar-btn-labelled" onClick=${handleCopyPrompt} title=${t.aiPromptCopy}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              <span class="rs-btn-label">${t.aiPromptCopy}</span>
            </button>
          `}
          ${/* One file, with the folder inside it. Last of the ACTIONS,
                because it is the one with a file at the end of it — and it is
                only here when the page is holding a folder to write. The point
                is that the next reading needs no folder and no gesture: a
                document that has to be assembled before it can be read is one
                nobody assembles. */ ""}
          ${onSaveSingle !== undefined && html`
            <span class="rs-tabs-sep"></span>
            <button class="rs-toolbar-btn rs-toolbar-btn-labelled" onClick=${onSaveSingle}
                    title=${t.saveSingleTip} aria-label=${t.saveSingleTip}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              <span class="rs-btn-label">${t.saveSingle}</span>
            </button>
          `}
          ${/* How the document LOOKS, which is nobody's work and everybody's
                preference: at the edge, past the actions, before the one
                button with consequences. */ ""}
          <span class="rs-tabs-sep"></span>
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
          ${/* The language toggle re-resolves the prose the MODEL carries, in
                both languages, at display time. A document handed over as
                markdown carries text instead — rendered once, in the language
                it was generated in — so the switch would move the buttons and
                leave every description, heading and column header as it was.
                A control that half works is worse than one that is not there. */ ""}
        </div>
      </nav>

      ${/* A link into the set, opened HERE rather than by the browser.
            Every address a sheet carries is a path in the folder, and while the
            folder is beside the page the browser resolves it — which stops the
            moment the page is somewhere else, which is the whole point of a
            page that carries the set with it. So a link naming something this
            document HAS opens the panel; one naming something it does not is
            left to the browser, which is right in the folder and honest
            outside it. */ ""}
      <main class="rs-main" onClick=${(e: MouseEvent) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
        const raw = a?.getAttribute("href");
        if (raw === null || raw === undefined || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("#")) return;
        const [path = "", frag = ""] = decodeURI(raw).split("#");
        const hit = (artifacts ?? []).find((x) => x.id === path);
        if (hit === undefined) return;
        e.preventDefault();
        const line = /^L(\d+)$/.exec(frag);
        setArtifactTarget({ id: hit.id, ...(line === null ? {} : { line: Number(line[1]) }) });
      }}>
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
              ${(data.groups?.length ?? 0) > 0
                ? (data.groups ?? []).map((g) => html`
                    <div class="rs-overview-group" key=${g.name}>
                      <div class="rs-overview-groupname">${g.display ?? g.name}</div>
                      <ul>
                        ${data.sheets.map((sheet, idx) => sheet.group !== g.name ? null : html`
                          <li key=${idx}>
                            <button class="rs-overview-sheet-link" onClick=${() => setActiveSheet(idx)}>
                              ${sheet.display ?? sheet.name}
                            </button>
                          </li>
                        `)}
                      </ul>
                    </div>
                  `)
                : html`<ul>
                ${data.sheets.map((sheet, idx) => html`
                  <li key=${idx}>
                    <button class="rs-overview-sheet-link" onClick=${() => setActiveSheet(idx)}>
                      ${sheet.display ?? sheet.name}
                    </button>
                  </li>
                `)}
              </ul>`}
            </div>
          </section>
        `}

        ${versionPivot && html`
          <section class="rs-sheet">
            <div class="rs-sheet-header"><h1>${versionPivot.components.map((c) => c.name).join("  ↔  ")}</h1></div>
            <${PivotView} sheet=${{ name: "", categories: [] }} pivot=${versionPivot} sheetIndex=${0}
                          hiddenInstances=${hiddenInstances} showDefaults=${showDefaults}
                          reviews=${[]} reviewEnabled=${false}
                          onOpenReview=${() => {}} t=${t} />
          </section>
        `}

        ${!versionPivot && data.sheets.map((sheet, idx) => {
          if (idx !== activeSheet) return null;
          const sheetTarget = { sheet: sheet.name };
          const sheetReviewCount = reviews.filter((r) => targetKey(r.target) === targetKey(sheetTarget)).length;

          return html`
            <section key=${sheet.name} id=${`sheet-${idx}`} class="rs-sheet">
              <div class="rs-sheet-header">
                ${/* On a DOCUMENT sheet this heading is the document's own
                      title: markdown.ts drops the source's first `#` from the
                      body (the page already carries its name here, in the
                      reader's language), so line 1 has no other element on the
                      page. Without this the one heading a reader is most likely
                      to select was the one the keystroke could not address. */ ""}
                <h2 ...${sheet.document === undefined ? {} : { "data-rs-line": 1 }}>
                  <span class=${diff?.get(sheetKey(sheet.name)) === "removed" ? "rs-diff-strike" : ""}>${sheet.display ?? sheet.name}</span>
                  ${diff && diffBadge(diff.get(sheetKey(sheet.name)))}
                  ${/* A hand-maintained sheet has no category heading to hang
                        the side-by-side switch on, so it lives in the sheet's
                        own heading — the comparison is about the whole sheet
                        either way. */ ""}
                  ${sheet.document?.mode === "sheet" && sheet.compare_components && !alwaysPivoted.has(sheet.name) && html`
                    <span class="rs-header-actions">
                      <${CompareToggle} on=${pivoted.has(sheet.name)} t=${t}
                                        onToggle=${() => setPivoted((prev) => {
                                          const next = new Set(prev);
                                          if (next.has(sheet.name)) next.delete(sheet.name);
                                          else next.add(sheet.name);
                                          return next;
                                        })} />
                    </span>
                  `}
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
                  ${showSources() && sheet.source_file && sheet.source_file !== sheet.file_path && html`
                    <span class="rs-source-path">${t.sheetSourceLabel}: <code>${sheet.source_file}</code></span>
                  `}
                </p>
              `}

              ${sheet.document?.mode === "sheet" && pivoted.has(sheet.name)
                ? html`<${PivotView} sheet=${sheet}
                                     sheetIndex=${idx} hiddenInstances=${hiddenInstances} showDefaults=${showDefaults}
                                     reviews=${[]} reviewEnabled=${false}
                                     onOpenReview=${() => {}}
                                     onLeave=${alwaysPivoted.has(sheet.name) ? undefined : () => setPivoted((prev) => { const next = new Set(prev); next.delete(sheet.name); return next; })} t=${t} />`
                : sheet.document?.mode === "sheet"
                ? html`<${MarkdownSheetBody}
                          markdown=${sheet.document.markdown ?? ""}
                          instances=${sheet.instances ?? []} lang=${lang} sheetIndex=${idx}
                          hiddenInstances=${hiddenInstances} showDefaults=${showDefaults}
                          rowKeys=${sheet.document.row_keys} sheetName=${sheet.name} artifact=${artifactAccess}
                          t=${t} />`
                : sheet.document
                ? html`<${DocumentBody} sheet=${sheet}
                                        onEvidence=${(artifacts ?? []).some((a) => a.nature === "observed")
                                          ? (id: string, line?: number) => setArtifactTarget({ id, line })
                                          : undefined} t=${t} />`
                : pivoted.has(sheet.name)
                ? html`<${PivotView} sheet=${sheet} sheetIndex=${idx} hiddenInstances=${hiddenInstances} showDefaults=${showDefaults}
                                     reviews=${reviews} reviewEnabled=${effReviewEnabled}
                                     onOpenReview=${openReview}
                                     onLeave=${alwaysPivoted.has(sheet.name) ? undefined : () => setPivoted((prev) => { const next = new Set(prev); next.delete(sheet.name); return next; })} t=${t} />`
                : sheet.categories.map((cat) => html`
                <${CategorySection} key=${cat.name} category=${cat} sheetName=${sheet.name} sheetInstances=${sheet.instances} sheetIndex=${idx} hiddenInstances=${hiddenInstances}
                                    headingExtra=${sheet.compare_components && sheet.compare_components !== "always"
                                      ? html`<${CompareToggle} on=${false} t=${t}
                                                               onToggle=${() => setPivoted((prev) => new Set(prev).add(sheet.name))} />` as VNode
                                      : null}
                                    sheetFilePath=${sheet.file_path} parentPath="" depth=${1}
                                    columns=${data.columns} reviews=${reviews} reviewEnabled=${effReviewEnabled}
                                    showComments=${showComments} filterCommented=${filterCommented} hideOutOfScope=${hideOutOfScope} showDefaults=${showDefaults}
                                    onOpenReview=${openReview} artifact=${artifactAccess} diff=${diff}
                                    t=${t} />
              `)}
            </section>
          `;
        })}
      </main>

      ${/* ONE panel in a book document. The outline drawer and this tree would
            otherwise be two lists of the same thing, both fixed to the left
            edge, with no way to say which is for what — so the tree carries the
            current sheet's own headings and the drawer is not offered here. */ ""}
      ${outlineOpen && html`
        <${NavTree} sheets=${data.sheets} groups=${data.groups} activeSheet=${activeSheet}
                    numbering=${baseData.numbering !== false} lang=${lang}
                    filter=${navFilter} onFilter=${setNavFilter} docKey=${navStateKey(data)}
                    headings=${categoryEntries.map((e) => ({
                      sheetIndex: e.sheetIndex,
                      id: e.id,
                      name: e.name,
                      depth: e.depth,
                      current: currentNavId === e.id,
                    }))}
                    onSelect=${setActiveSheet}
                    onJumpHeading=${(id: string) => {
                      const e = categoryEntries.find((x) => x.id === id);
                      if (e !== undefined) jumpToNav(e.sheetIndex, e.id, undefined, e.sheetName, e.categoryPath);
                    }} t=${t} />
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
        <${PromptModal} text=${promptModalText} fromEdits=${false} onClose=${() => setPromptModalText(null)} t=${t} />
      `}

      ${artifactTarget && html`
        <${ArtifactPanel} previews=${artifacts ?? []} target=${artifactTarget} dock=${dockNow} onDock=${pickDock}
                          onClose=${() => setArtifactTarget(null)}
                          onPick=${(instance: string | undefined) => setArtifactTarget((c) => (c ? { ...c, instance } : c))}
                          onJumpRow=${jumpToRow} t=${t} />
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
  groups?: SheetData["groups"];
  // Whether this snapshot's chapters are numbered — carried per version like
  // `groups` (types.ts).
  numbering?: SheetData["numbering"];
  sheets: SheetData["sheets"];
  artifacts?: ArtifactPreview[];
};
type Payload = { metadata?: SheetData["metadata"]; versions: SheetVersion[]; capabilities?: Capabilities };

const versionId = (v: SheetVersion): string => v.id ?? v.version;
const versionLabel = (v: SheetVersion): string => `${v.version}${v.date ? ` (${v.date})` : ""}`;

// Compare is only ever entered from this bar, and this bar stays visible while
// comparing — so the diff's own output (the summary) and its one filter belong
// here, next to the selectors that produced them, rather than in the tab bar
// across the screen.
// Put a target under the top of the page, with any STICKING suspended for the
// measurement — see jumpToNav for why that is not optional.
function aimAt(el: Element): void {
  const doc = el.closest(".rs-doc");
  doc?.classList.add("rs-doc-unstuck");
  el.scrollIntoView({ block: "start" });
  doc?.classList.remove("rs-doc-unstuck");
}

function VersionBar({ versions, activeId, compare, fromId, toId, onSelect, onToggleCompare, onFrom, onTo, diffSummary, changedOnly, onChangedOnly, columnar, onColumnar, t }: {
  versions: SheetVersion[];
  activeId: string;
  compare: boolean;
  fromId: string;
  toId: string;
  onSelect: (id: string) => void;
  onToggleCompare: () => void;
  onFrom: (id: string) => void;
  onTo: (id: string) => void;
  diffSummary?: { changed: number; docOnly: number; added: number; removed: number; unchanged: number };
  changedOnly?: boolean;
  // Side by side rather than inline. Not a display preference so much as a
  // different question: inline asks "what changed in this sheet", columnar asks
  // "what do these two releases say about the same key".
  columnar?: boolean;
  onColumnar?: (v: boolean) => void;
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
            <span class="rs-diff-summary">${t.diffSummary(diffSummary.changed, diffSummary.docOnly, diffSummary.added, diffSummary.removed, diffSummary.unchanged)}</span>
            <label class="rs-diff-changed-only">
              <input type="checkbox" checked=${changedOnly} onChange=${(e: Event) => onChangedOnly?.((e.target as HTMLInputElement).checked)} />
              <span>${t.diffChangedOnly}</span>
            </label>
            <label class="rs-diff-changed-only">
              <input type="checkbox" checked=${columnar} onChange=${(e: Event) => onColumnar?.((e.target as HTMLInputElement).checked)} />
              <span>${t.compareComponents}</span>
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

function Root({ payload, reviewEnabled, promptEnabled = true, showSources: sources = true, initialLang, server, dropped, onSaveSingle }: { payload: Payload; reviewEnabled: boolean; promptEnabled?: boolean; showSources?: boolean; initialLang: Lang; server: boolean; dropped?: string; onSaveSingle?: () => void }) {
  // Applied here rather than in an effect: it decides what the FIRST render
  // draws, and an effect runs after it.
  setShowSources(sources);
  // The content's language was decided at generation (localize.ts); this is
  // the same answer, for the UI's own chrome.
  const lang = initialLang;
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
  // Inline (old value struck through, new beside it) or columnar (one column
  // per version). Both read the same diff; they differ in what a glance costs.
  // Inline keeps the sheet's own shape and every column it has; columnar puts
  // the two releases beside each other, which is what an upgrade review asks
  // for and what no view offered.
  const [columnar, setColumnar] = useState(false);

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

  // Built from the localized sheets, so the columns hold whatever language the
  // viewer is showing — the same input the inline overlay reads.
  const versionPivot = useMemo(
    () => (compare && columnar ? pivotVersions(fromSheets, toSheets, versionLabel(fromV), versionLabel(toV)) : undefined),
    [compare, columnar, fromSheets, toSheets, fromV, toV]
  );

  const shown = compare ? toV : active;
  const data = useMemo<SheetData>(() => ({
    metadata: { ...payload.metadata, version: shown.version, generated_at: shown.date },
    columns: localizeColumns(shown.columns, lang),
    groups: localizeGroups(shown.groups, lang),
    ...(shown.numbering === undefined ? {} : { numbering: shown.numbering }),
    sheets: diffModel ? diffModel.sheets : shownSheets,
  }), [shown, payload.metadata, diffModel, shownSheets, lang]);

  return html`
    <div class="rs-root">
      ${/* What is on screen is the folder somebody dropped, not what this file
            was built from. Said permanently rather than as a message that goes
            away: the two look identical, and a reader who arrives at a sheet
            without having done the dropping has no other way to know. */ ""}
      ${dropped !== undefined && html`<div class="rs-dropped-bar" role="status">${dropped}</div>`}
      ${versions.length > 1 && html`<${VersionBar} versions=${versions} activeId=${activeId} compare=${compare}
        fromId=${fromId} toId=${toId} onSelect=${setActiveId} onToggleCompare=${() => setCompare((c) => !c)}
        onFrom=${setFromId} onTo=${setToId} diffSummary=${diffModel?.summary}
        changedOnly=${changedOnly} onChangedOnly=${setChangedOnly}
        columnar=${columnar} onColumnar=${setColumnar} t=${t} />`}
      <${App} data=${data} artifacts=${shown.artifacts} reviewEnabled=${reviewEnabled} promptEnabled=${promptEnabled} lang=${lang}
        diff=${diffModel?.status} reviewsOverride=${diffModel?.reviews} versionPivot=${versionPivot}
        server=${server} applyEnabled=${applyEnabled} onSaveSingle=${onSaveSingle} />
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
  // Off only when the author said so (`--allow` without `prompt`): a document
  // built before this switch existed still offers it.
  const promptEnabled = config.prompt !== false;
  // Where a value is WRITTEN, shown or not. On unless the author said otherwise
  // (`--no-sources`) — see GenerateOptions.sources for what it is for.
  const showSources = config.sources !== false;
  const lang: Lang = config.lang === "en" ? "en" : "ja";
  const serverMode = config.server === true;

  const appEl = document.getElementById("app");
  if (!appEl) return;
  // The set on screen, when the page is showing one — and the one thing that
  // can be written back out. A document that can carry a folder has to be able
  // to be GIVEN one and keep it: otherwise the recipient drags the same folder
  // onto the same page after every edit, forever.
  let held: { path: string; text: string }[] | null = null;

  const saveSingle = (): void => {
    if (held === null) return;
    const pristine =
      (window as unknown as { __rsPristine?: string }).__rsPristine ??
      `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
    let out: string;
    try {
      out = spliceSetBlock(pristine, setBlockJson(held));
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      return;
    }
    const url = URL.createObjectURL(new Blob([out], { type: "text/html" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "sheet.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next task, not now: the download reads the blob after the
    // click returns, and revoking it here cancels it in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const draw = (p: Payload, dropped?: string): void => {
    render(
      html`<${Root} payload=${p} reviewEnabled=${dropped === undefined && reviewEnabled} initialLang=${lang}
                    server=${dropped === undefined && serverMode} promptEnabled=${dropped === undefined && promptEnabled}
                    showSources=${showSources} dropped=${dropped}
                    onSaveSingle=${held === null ? undefined : saveSingle} />`,
      appEl
    );
  };
  // A set the page CARRIES — what "Save as one file" wrote into a copy of this
  // page, so the document opens on the current text with no folder beside it
  // and no gesture. That is the whole of what the drop below is a way IN to:
  // dragging is a gesture to repeat after every edit, and this is how it stops
  // being one.
  //
  // The same code path as the drop, fed from a block instead of a folder: two
  // ways in, one reading, so a page cannot show one thing when dropped and
  // another when opened.
  const carried = document.getElementById(SET_BLOCK_ID);
  const carriedText = (carried?.textContent ?? "").trim();
  if (carriedText !== "" && carriedText !== "null") {
    const files = JSON.parse(carriedText) as { path: string; text: string }[];
    held = files;
    const read = readMarkdownSet(files, lang);
    if (read.problems.length > 0) console.warn(read.problems.join("\n"));
    if (read.sheets.length > 0) {
      draw({
        metadata: { ...payload.metadata, ...read.metadata },
        versions: [
          {
            version: "current",
            sheets: read.sheets as never,
            groups: read.groups as never,
            artifacts: documentPreviews(read.documents),
          },
        ],
      } as Payload);
    } else {
      draw(payload);
    }
  } else {
    draw(payload);
  }

  // A folder of markdown, dropped, replaces what is on screen.
  //
  // This is the whole of the no-toolchain half of the delivery: the recipient
  // edits the markdown (or has an assistant edit it) and then has to be able to
  // LOOK at it, and nothing in their hands can regenerate this page. What they
  // see afterwards is the FOLDER, and the page says so — a document silently
  // showing something other than what it was built from is the failure this is
  // most able to cause.
  //
  // Reviewing is off in that state, and so is the prompt and the server: those
  // act on the model the file was built from, and the rows on screen are no
  // longer it.
  document.addEventListener("dragover", (e) => {
    if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === "file")) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    const dt = e.dataTransfer;
    if (dt === null || ![...dt.items].some((i) => i.kind === "file")) return;
    e.preventDefault();
    void filesFromDrop(dt).then((files) => {
      if (files.length === 0) {
        alert(getMessages(lang).dropNoSheets);
        return;
      }
      const read = readMarkdownSet(files, lang);
      if (read.sheets.length === 0) {
        alert(getMessages(lang).dropNoSheets);
        return;
      }
      held = files;
      if (read.problems.length > 0) console.warn(read.problems.join("\n"));
      draw(
        {
          metadata: { ...payload.metadata, ...read.metadata },
          versions: [
            {
              version: "current",
              sheets: read.sheets as never,
              groups: read.groups as never,
              artifacts: documentPreviews(read.documents),
            },
          ],
        } as Payload,
        getMessages(lang).droppedFolder(read.sheets.length)
      );
    });
  });
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
