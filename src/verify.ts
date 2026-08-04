// Source-map verification: confirm that every value's source actually resolves
// in the real configuration (file readable, located by line/anchor, and the
// recorded value still present). This is the deterministic guard-rail that makes
// any generation method — AI or converter — trustworthy: generate, verify, fix.
//
// File I/O is injected so the core stays pure and unit-testable.

import { resolveParser, type ExtractOptions } from "./parser.js";
import "./parsers/index.js";
import type { SheetData, SourceLocation, ReviewTarget } from "./prompt.js";
import { pickLang } from "./types.js";

// "unmapped" = a value we DO set whose location could not be resolved (a real
// gap in the source map). "default" = a value we deliberately do not set
// (`origin: "default"`), so there is nothing to resolve — counted apart so an
// exhaustive ledger's hundreds of default rows never read as hundreds of gaps.
export type CheckStatus = "ok" | "warn" | "error" | "unmapped" | "out_of_scope" | "default";

export type SourceCheck = {
  target: ReviewTarget;
  file?: string;
  status: CheckStatus;
  message: string;
  // Set when the value WAS found, but through the line+anchor fallback because
  // its recorded structural path did not resolve (see LocateResult.fallback).
  // Deliberately still `ok` — the value is where the model says it is, so no gate
  // should fail — but counted apart, because "resolved by path" and "the path is
  // broken and the line happened to match" are not the same claim, and only the
  // first survives the file being reordered.
  fallback?: string;
};

export type VerifyOutcome = {
  checks: SourceCheck[];
  ok: number;
  warn: number;
  error: number;
  unmapped: number;
  out_of_scope: number;
  default: number;
  // Subset of `ok`, not a separate bucket.
  fallback: number;
};

type ReadFile = (path: string) => string | null;

type ValueEntry = {
  target: ReviewTarget;
  value: string;
  source?: SourceLocation;
  fileFallback?: string;
  outOfScope?: boolean;
  outOfScopeReason?: string;
  // `origin: "default"` — the product's own default, set nowhere in our files.
  isDefault?: boolean;
};

// Collect every concrete value (simple value + each Pattern B instance) with
// the file context inherited from category/sheet, mirroring buildSourceIndex.
// The source file fallback is the nearest `source_file`, else the nearest
// display `file_path` (an instance/value `source.file` still overrides it).
function collectValues(data: SheetData): ValueEntry[] {
  const out: ValueEntry[] = [];
  const walk = (
    cats: SheetData["sheets"][number]["categories"] | undefined,
    sheet: string,
    parentPath: string,
    fileFallback?: string,
    sourceFallback?: string,
    inheritedOOS?: { reason?: string }
  ): void => {
    for (const cat of cats ?? []) {
      const path = parentPath ? `${parentPath}/${cat.name}` : cat.name;
      const file = cat.file_path ?? fileFallback;
      const src = cat.source_file ?? sourceFallback;
      const def = src ?? file; // effective default source file
      // verify prints in English, so a bilingual reason resolves to English.
      const oos = inheritedOOS ?? (cat.out_of_scope ? { reason: pickLang(cat.out_of_scope.reason, "en") } : undefined);
      for (const p of cat.params ?? []) {
        const pOOS = oos ?? (p.out_of_scope ? { reason: pickLang(p.out_of_scope.reason, "en") } : undefined);
        if (p.instances && p.instances.length > 0) {
          for (const inst of p.instances) {
            out.push({
              target: { sheet, category: path, param: p.key, instance: inst.name },
              value: inst.value,
              source: inst.source,
              fileFallback: inst.source?.file ?? def,
              outOfScope: pOOS !== undefined,
              outOfScopeReason: pOOS?.reason,
              isDefault: p.origin === "default",
            });
          }
        } else if (p.value !== undefined) {
          out.push({
            target: { sheet, category: path, param: p.key },
            value: p.value,
            source: p.source,
            fileFallback: p.source?.file ?? def,
            outOfScope: pOOS !== undefined,
            outOfScopeReason: pOOS?.reason,
            isDefault: p.origin === "default",
          });
          // The same value defined in extra files (additional_sources): each is
          // verified independently against the same expected value.
          for (const a of p.additional_sources ?? []) {
            out.push({
              target: { sheet, category: path, param: p.key },
              value: p.value,
              source: a,
              fileFallback: a.file ?? def,
              outOfScope: pOOS !== undefined,
              outOfScopeReason: pOOS?.reason,
            });
          }
        }
      }
      walk(cat.categories, sheet, path, file, src, oos);
    }
  };
  for (const sheet of data.sheets) walk(sheet.categories, sheet.name, "", sheet.file_path, sheet.source_file);
  return out;
}

// `opts` (currently just `marker`, for the ts/py annotation parsers'
// `locate`) is threaded through to every parser dispatch — see
// ExtractOptions (parser.ts) for why this is an ordinary argument and not
// process-wide config.
export function verifySources(data: SheetData, readFile: ReadFile, opts?: ExtractOptions): VerifyOutcome {
  const checks: SourceCheck[] = [];

  for (const entry of collectValues(data)) {
    if (entry.outOfScope) {
      checks.push({
        target: entry.target,
        status: "out_of_scope",
        message: entry.outOfScopeReason ? `out of scope: ${entry.outOfScopeReason}` : "out of scope (skipped)",
      });
      continue;
    }
    // Nothing is set for this parameter, so nothing can (or should) resolve —
    // reported apart from "unmapped", which means a source map that failed.
    if (entry.isDefault) {
      checks.push({ target: entry.target, status: "default", message: "product default — nothing set, no source expected" });
      continue;
    }
    const file = entry.source?.file ?? entry.fileFallback;

    if (!file) {
      checks.push({ target: entry.target, status: "unmapped", message: "no file mapped (apply will defer to AI)" });
      continue;
    }
    const raw = readFile(file);
    if (raw === null) {
      // A generated source is a build artifact that may simply not have been
      // produced yet (or ever) — a missing file is expected, not a failure.
      if (entry.source?.generated) {
        checks.push({ target: entry.target, file, status: "warn", message: "generated file not present (build artifact) — apply will defer to AI" });
      } else {
        checks.push({ target: entry.target, file, status: "error", message: "file not readable" });
      }
      continue;
    }
    const parser = resolveParser(file, raw);
    if (parser) {
      const loc = parser.locate(raw, entry.source ?? {}, entry.value, opts);
      if ("value" in loc) {
        if (loc.value === entry.value) {
          checks.push(
            loc.fallback === undefined
              ? { target: entry.target, file, status: "ok", message: "verified" }
              : { target: entry.target, file, status: "ok", message: `verified by line fallback — ${loc.fallback}`, fallback: loc.fallback }
          );
        } else {
          checks.push({ target: entry.target, file, status: "error", message: `value "${loc.value}", expected "${entry.value}" — stale value?` });
        }
        continue;
      }
      // loc has error
      if (loc.status === "unmapped") {
        checks.push({ target: entry.target, file, status: "unmapped", message: "no line/anchor/path locator (apply will defer to AI)" });
      } else if (loc.status === "warn") {
        checks.push({ target: entry.target, file, status: "warn", message: loc.error });
      } else {
        checks.push({ target: entry.target, file, status: "error", message: `value "${entry.value}" not found (${loc.error}) — stale value or wrong line/anchor?` });
      }
      continue;
    }
    checks.push({ target: entry.target, file, status: "unmapped", message: "no parser found" });
  }

  return {
    checks,
    ok: checks.filter((c) => c.status === "ok").length,
    warn: checks.filter((c) => c.status === "warn").length,
    error: checks.filter((c) => c.status === "error").length,
    unmapped: checks.filter((c) => c.status === "unmapped").length,
    out_of_scope: checks.filter((c) => c.status === "out_of_scope").length,
    default: checks.filter((c) => c.status === "default").length,
    fallback: checks.filter((c) => c.fallback !== undefined).length,
  };
}
