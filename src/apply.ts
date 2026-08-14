// Deterministic "apply" core: turn reviewed value changes into precise,
// verified edits using the source map. Anything that cannot be applied with
// confidence is left untouched and handed to the AI prompt instead.
//
// File I/O is injected (readFile) so the core stays pure and unit-testable; the
// CLI wires in the real filesystem and handles writing.

import {
  buildSourceIndex,
  retargetReviews,
  findEntry,
  resolveSource,
  buildPromptText,
  HELD_REASON_GENERATED,
  HELD_REASON_SUBSTITUTED,
  HELD_REASON_DEFAULT,
  HELD_REASON_BASELINE,
  HELD_REASON_SHARED_INSTANCE,
  type SheetData,
  type ReviewItem,
  type ReviewTarget,
  type ReviewChange,
  type SourceLocation,
} from "./prompt.js";
import { resolveParser, type ExtractOptions } from "./parser.js";
import "./parsers/index.js";

export type ApplyStatus = "applied" | "skipped" | "held" | "out_of_scope";

export type ApplyResult = {
  target: ReviewItem["target"];
  file?: string;
  status: ApplyStatus;
  // "skipped" = already at the suggested value (idempotent). "held" = could not
  // verify the location, so it was left for the AI prompt; reason explains why.
  reason?: string;
  line?: number; // 1-based line that was (or would be) edited
  before?: string;
  after?: string;
  current: string;
  suggested: string;
};

export type ApplyOutcome = {
  results: ApplyResult[];
  // Final content for each file that has at least one applied edit.
  files: { path: string; content: string }[];
  // AI prompt covering everything not applied deterministically (held value
  // changes, documentation edits, and comment-only notes).
  heldPrompt: string;
  applied: number;
  skipped: number;
  held: number;
  out_of_scope: number;
  // Findings whose row has MOVED to another category since they were written —
  // re-pointed rather than dropped, and reported because a review silently
  // changing where it points is precisely what this project does not do.
  moved: { target: ReviewTarget; from: string; to: string }[];
};

type ReadFile = (path: string) => string | null;

// `opts` (currently just `marker`, for the ts/py annotation parsers' `edit`)
// is threaded through to every parser dispatch — see ExtractOptions
// (parser.ts) for why this is an ordinary argument and not process-wide config.
export function computeApply(
  data: SheetData,
  reviews: ReviewItem[],
  readFile: ReadFile,
  opts?: ExtractOptions
): ApplyOutcome {
  const index = buildSourceIndex(data);
  // A saved finding names the category its row was in when it was written, and
  // a category moves — a product dictionary supplies most of them, and an
  // upgrade can put a setting on another screen. Re-point them at the current
  // document ONCE, here, so every lookup below is an exact hit and none of them
  // needs a fallback of its own. Applying a change to the wrong file because a
  // category was renamed is the failure this prevents.
  const retargeted = retargetReviews(reviews, data);
  const pending = retargeted.reviews.filter((r) => r.status === "pending");

  // Lazily loaded, progressively edited file contents (as line arrays).
  const working = new Map<string, string[] | null>(); // null = unreadable
  const touched = new Set<string>();
  const load = (path: string): string[] | null => {
    if (!working.has(path)) {
      const raw = readFile(path);
      working.set(path, raw === null ? null : raw.split("\n"));
    }
    return working.get(path) ?? null;
  };

  const results: ApplyResult[] = [];
  const heldReviews: ReviewItem[] = [];

  for (const r of pending) {
    const changes = r.changes ?? [];
    const heldChanges: ReviewChange[] = [];

    // Out-of-scope targets are skipped outright — not held, not prompted.
    if (r.target.param && r.target.category) {
      const entry = findEntry(index, r.target)?.entry;
      if (entry?.outOfScope) {
        for (const c of changes) {
          results.push({
            target: r.target,
            file: entry.fileFallback,
            status: "out_of_scope",
            reason: entry.outOfScopeReason ? `out of scope: ${entry.outOfScopeReason}` : "out of scope",
            current: c.current ?? "",
            suggested: c.suggested,
          });
        }
        continue;
      }
    }

    for (const c of changes) {
      if (c.field !== "value") {
        heldChanges.push(c); // documentation edit -> prompt
        continue;
      }
      const current = c.current ?? "";
      const res = resolveSource(r.target, index);
      const entry = r.target.param ? findEntry(index, r.target)?.entry : undefined;

      // One environment, but the row stores a single shared value: refuse before
      // any parser is dispatched. `res.file` here is the SHARED definition (or
      // the sheet's display fallback), which must not be edited to satisfy one
      // environment — reported as context, never opened. `default`/`baseline`
      // rows are excluded here for the same reason: both fall through to the
      // origin check below instead, which reports the more specific "there is
      // no line at all" fact rather than the "wrong scope" one.
      if (
        r.target.instance &&
        entry &&
        entry.param.instances === undefined &&
        entry.param.origin !== "default" &&
        entry.param.origin !== "baseline"
      ) {
        results.push({
          target: r.target,
          file: res.file,
          status: "held",
          reason: HELD_REASON_SHARED_INSTANCE,
          current,
          suggested: c.suggested,
        });
        heldChanges.push(c);
        continue;
      }

      // `origin: "default"` means our deliverable sets this parameter NOWHERE:
      // there is no line to rewrite, and a category/sheet `file_path` fallback
      // must not tempt the editor into one — applying the change means adding
      // the setting, which is a judgement call left to the AI prompt. Checked
      // before the per-target loop for that reason.
      //
      // `origin: "baseline"` holds for the same reason (no line, anywhere, to
      // rewrite) — the vendor shipped this key and this deliverable does not
      // have it — with its own held reason so the AI prompt says which of the
      // two facts it is.
      if (entry?.param.origin === "default" || entry?.param.origin === "baseline") {
        results.push({
          target: r.target,
          file: entry.fileFallback,
          status: "held",
          reason: entry.param.origin === "baseline" ? HELD_REASON_BASELINE : HELD_REASON_DEFAULT,
          current,
          suggested: c.suggested,
        });
        heldChanges.push(c);
        continue;
      }

      // The same value may be defined in several files (primary `source` plus
      // `additional_sources`). Edit every site; the change is held for the AI
      // prompt if any one of them cannot be applied. A `ref` entry is not a
      // site of the same kind: it holds a *reference expression* to the value,
      // not the value itself, so writing the suggested value there would
      // corrupt the file — it is simply excluded, neither applied nor held
      // (a ref site is not a failed edit; it was never an edit at all).
      const targets: { source?: SourceLocation; file?: string }[] = [{ source: res.source, file: res.file }];
      if (!r.target.instance) {
        for (const a of entry?.param.additional_sources ?? []) {
          if (a.ref !== undefined) continue;
          targets.push({ source: a, file: a.file ?? entry?.fileFallback });
        }
      }

      let anyHeld = false;
      for (const tgt of targets) {
        const base = { target: r.target, file: tgt.file, current, suggested: c.suggested };
        // A generated source is a build artifact regenerated by some other
        // process; editing it directly would be lost on the next generation,
        // so it is always held for the AI-prompt/manual fallback instead.
        if (tgt.source?.generated) {
          results.push({ ...base, status: "held", reason: HELD_REASON_GENERATED });
          anyHeld = true;
          continue;
        }
        // See HELD_REASON_SUBSTITUTED: the value here is a whole rendered line
        // and the site holds one variable inside it.
        if (tgt.source?.substituted) {
          results.push({ ...base, status: "held", reason: HELD_REASON_SUBSTITUTED });
          anyHeld = true;
          continue;
        }
        if (!tgt.file) {
          results.push({ ...base, status: "held", reason: "no file mapped" });
          anyHeld = true;
          continue;
        }
        if (current === "") {
          results.push({ ...base, status: "held", reason: "empty current value (cannot target)" });
          anyHeld = true;
          continue;
        }
        const lines = load(tgt.file);
        if (lines === null) {
          results.push({ ...base, status: "held", reason: "file not readable" });
          anyHeld = true;
          continue;
        }
        // Dispatch to the matching parser (structural + line/anchor fallback is
        // handled inside each parser's edit method).
        const text = lines.join("\n");
        const parser = resolveParser(tgt.file, text);
        if (!parser) {
          results.push({ ...base, status: "held", reason: "no parser found" });
          anyHeld = true;
          continue;
        }
        const st = parser.edit(text, tgt.source ?? {}, current, c.suggested, opts);
        if (st.status === "applied") {
          working.set(tgt.file, st.content.split("\n"));
          touched.add(tgt.file);
          // A fallback edit is still applied (the line was verified against the
          // current value), but say so — the source map it went through is one
          // reordering away from breaking. See EditResult.fallback.
          results.push({
            ...base,
            status: "applied",
            reason: st.fallback === undefined ? "parser edit" : `parser edit by line fallback — ${st.fallback}`,
            before: st.before,
            after: st.after,
          });
        } else if (st.status === "skipped") {
          results.push({ ...base, status: "skipped", reason: "already at suggested value" });
        } else {
          // st.status === "error"
          results.push({ ...base, status: "held", reason: st.reason });
          anyHeld = true;
        }
      }
      if (anyHeld) heldChanges.push(c);
    }

    // Reconstruct the leftover review for the AI prompt: held value changes +
    // all documentation changes, or a standalone note.
    const hasNote = changes.length === 0 && !!r.comment;
    if (heldChanges.length > 0 || hasNote) {
      heldReviews.push({ ...r, changes: heldChanges.length > 0 ? heldChanges : undefined });
    }
  }

  const files = [...touched].map((path) => ({ path, content: working.get(path)!.join("\n") }));
  return {
    results,
    moved: retargeted.moved,
    files,
    heldPrompt: buildPromptText(heldReviews, data),
    applied: results.filter((r) => r.status === "applied").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    held: results.filter((r) => r.status === "held").length,
    out_of_scope: results.filter((r) => r.status === "out_of_scope").length,
  };
}
