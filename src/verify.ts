// Source-map verification: confirm that every value's source actually resolves
// in the real configuration (file readable, located by line/anchor, and the
// recorded value still present). This is the deterministic guard-rail that makes
// any generation method — AI or converter — trustworthy: generate, verify, fix.
//
// File I/O is injected so the core stays pure and unit-testable.

import { parserForSource, type ExtractOptions } from "./parser.js";
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
  // `origin: "baseline"` — the vendor shipped this key and this deliverable
  // does not have it anywhere. Always skipped the same way a source-less
  // `default` row is (see the check below), but with its own message: unlike
  // `default`, a `baseline` row never has a `source.generated` exception, so
  // there is nothing conditional about the skip.
  isBaseline?: boolean;
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
        // additional_sources lives on the PARAMETER, not the instance — collect
        // it once here regardless of shape, never once per instance (an
        // instance-shaped param has no single `value` to pair a non-ref entry
        // against, so the schema only allows `ref` entries there; a ref site's
        // expectation is the reference text itself, not any one instance's
        // value — see types.ts's `ParameterBase.additional_sources`).
        const pushAdditional = (primaryValue: string | undefined) => {
          for (const a of p.additional_sources ?? []) {
            out.push({
              target: { sheet, category: path, param: p.key },
              value: a.ref ?? primaryValue ?? "",
              source: a,
              fileFallback: a.file ?? def,
              outOfScope: pOOS !== undefined,
              outOfScopeReason: pOOS?.reason,
            });
          }
        };
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
              isBaseline: p.origin === "baseline",
            });
          }
          pushAdditional(undefined);
        } else if (p.value !== undefined) {
          out.push({
            target: { sheet, category: path, param: p.key },
            value: p.value,
            source: p.source,
            fileFallback: p.source?.file ?? def,
            outOfScope: pOOS !== undefined,
            outOfScopeReason: pOOS?.reason,
            isDefault: p.origin === "default",
            isBaseline: p.origin === "baseline",
          });
          // The same value defined in extra files (additional_sources): each
          // non-ref entry is verified against the same expected value; a ref
          // entry is verified against its own reference text instead (see
          // pushAdditional above).
          pushAdditional(p.value);
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
    // A `default` row CAN carry a source now (the widened definition in
    // types.ts's Origin comment: a value observed in a generated artifact,
    // `source.generated: true`, is `default` too) — that source is real
    // evidence and must go on being checked like any other row's, or a
    // Terraform-plan-derived sheet would stop verifying the hundreds of
    // source maps it demoted from `overlay` to `default` (see
    // SheetInputs.authoredKeys). Only a `default` row with NO source at all —
    // the documented-default case, which has nothing to resolve — short-
    // circuits here.
    if (entry.isDefault && !entry.source) {
      checks.push({ target: entry.target, status: "default", message: "product default — nothing set, no source expected" });
      continue;
    }
    // `baseline` rows never carry a source at all (checked in validate.ts's
    // findBaselineOriginErrors) — the vendor shipped this key and this
    // deliverable does not have it anywhere, so — unlike `default` — there is
    // no evidence-channel exception to fall through for. Counted in the same
    // "default" bucket `default` origin rows use (see VerifyOutcome.default):
    // both mean "nothing to resolve, and that is expected", which is exactly
    // what that bucket exists to say without inflating "unmapped".
    if (entry.isBaseline) {
      checks.push({
        target: entry.target,
        status: "default",
        message: "vendor shipped this — not present in this deliverable, no source expected",
      });
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
    // The DECLARED base format wins the parser choice where there is one — a
    // location written by a format the file name cannot name must be read back
    // by that same format. See parserForSource.
    const picked = parserForSource(file, raw, entry.source ?? {}, opts);
    const parser = picked.parser;
    if (parser) {
      // A ref site's `entry.value` is the reference text (see collectValues),
      // passed here as `expected` so a parser's line/anchor fallback confirms
      // the right line the same way it does for an ordinary value.
      // A membership row's value is presence, and the site holds the MEMBER —
      // `- ssh` is how a list writes "ssh is permitted". So the text to confirm
      // at the location is the member, not the row's `true`, which appears in
      // the file nowhere. See SourceLocation.member.
      const member = entry.source?.member;
      const expected = member ?? entry.value;
      const loc = parser.locate(raw, entry.source ?? {}, expected, picked.opts);
      const isRef = entry.source?.ref !== undefined;
      if ("value" in loc) {
        // Equality is the whole-value special case of containment: a
        // structural-path locate returns the site's ACTUAL value (not an echo
        // of `expected`), so a composed site like `https://$(env:X)/p` only
        // matches by `.includes`, never `===`. The line/anchor fallback (below,
        // via locateLine) already confirms containment itself and echoes
        // `expected` back, so `.includes` holds there too — one rule covers
        // both locate paths.
        // Three relations, not two. `ref`: the site holds a reference TO the
        // value, so the row's text must appear in the site. `substituted`: the
        // site holds a PART of the row (the variable's value inside a rendered
        // line), so the site's text must appear in the row. Otherwise: equal.
        const isSubstituted = entry.source?.substituted === true;
        const matched =
          member !== undefined
            ? // Equality where the locate returned the member itself, containment
              // where it returned the line holding it — the same two-path rule the
              // ref case uses, applied to the member rather than to the value.
              loc.value === member || loc.value.includes(member)
            : isRef
              ? loc.value.includes(entry.value)
              : isSubstituted
                ? entry.value.includes(loc.value)
                : loc.value === entry.value;
        if (matched) {
          checks.push(
            loc.fallback === undefined
              ? { target: entry.target, file, status: "ok", message: "verified" }
              : { target: entry.target, file, status: "ok", message: `verified by line fallback — ${loc.fallback}`, fallback: loc.fallback }
          );
        } else if (isSubstituted) {
          checks.push({
            target: entry.target,
            file,
            status: "error",
            message: `"${loc.value}" is no longer part of the rendered line "${entry.value}" — variable renamed, or the template changed around it?`,
          });
        } else if (member !== undefined) {
          checks.push({
            target: entry.target,
            file,
            status: "error",
            message: `"${member}" is no longer a member here — removed from the list, or renamed?`,
          });
        } else if (isRef) {
          checks.push({ target: entry.target, file, status: "error", message: `reference "${entry.value}" no longer present — value hardcoded or wiring changed?` });
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
      } else if (isRef) {
        checks.push({ target: entry.target, file, status: "error", message: `reference "${entry.value}" not found (${loc.error}) — value hardcoded or wiring changed?` });
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
