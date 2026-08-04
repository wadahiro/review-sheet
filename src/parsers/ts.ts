// TypeScript annotation parser: extracts `@rs`-annotated values from TS/TSX source
// (config-as-code: AWS CDK, Pulumi, plain config modules). See spec/annotation.md.
//
// It wraps the language-agnostic `annotation` core with a TS descriptor. The value
// is the verbatim RHS expression; edits replace that node's byte range and are then
// re-parsed to reject any change that would produce invalid syntax.

import { Lang } from "@ast-grep/napi";
import {
  annotationExtract,
  annotationLocate,
  annotationEdit,
  extractAnnotations,
  lintAnnotations,
  DEFAULT_MARKER,
  type LangDescriptor,
  type AnnotationResult,
  type LintIssue,
} from "../annotation.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult, type ExtractOptions } from "../parser.js";
import type { SourceLocation } from "../types.js";

// Tsx parses both .ts and .tsx (a superset for our purposes), so extract/locate/edit
// all use one grammar — important because locate/edit have no filename to switch on.
const TS_DESC: LangDescriptor = {
  lang: Lang.Tsx,
  valueKinds: [
    { kind: "pair", keyField: "key", valueField: "value" },
    { kind: "variable_declarator", keyField: "name", valueField: "value" },
  ],
  pathSegments: [
    { kind: "variable_declarator", field: "name" },
    { kind: "class_declaration", field: "name" },
  ],
  constructKinds: ["new_expression"],
  stringKinds: ["string"],
};

const tsParser: ConfigParser = {
  name: "ts",
  priority: 20,
  meta: {
    title: "TypeScript (annotations)",
    summary: "In-source `@rs` annotations on TS/TSX config-as-code (CDK, Pulumi); value = the RHS expression.",
    files: "*.ts *.tsx *.mts *.cts (with @rs annotations)",
    detection: "extension (.ts/.tsx/.mts/.cts)",
    pathStyle: "StorageStack.Data.bucketName — class/construct-id/declarator names + property key",
    notes: [
      "Only `@rs`-annotated properties are extracted (explicit opt-in).",
      "value is the verbatim right-hand-side expression (literal or wrapped, e.g. Duration.seconds(30)); strings shown unquoted.",
      "Edits replace the RHS node range and are re-parsed; a change that breaks syntax is rejected.",
      "Category accumulates by lexical scope (`@rs:category`), outer→inner.",
    ],
    examples: ["storage.bucketName", "StorageStack.Sessions.readCapacity"],
  },
  // Claim all TS/TSX by extension (not on marker presence) so a no-annotation file
  // extracts nothing rather than falling through to the generic line parser.
  detect: (file) => /\.(ts|tsx|mts|cts)$/.test(file.toLowerCase()),
  extract: (content, file, opts) => annotationExtract(content, file, TS_DESC, opts?.marker),
  locate: (content, source: SourceLocation, _expected: string, opts?: ExtractOptions): LocateResult =>
    annotationLocate(content, source, TS_DESC, opts?.marker),
  edit: (content, source: SourceLocation, current: string, suggested: string, opts?: ExtractOptions): EditResult =>
    annotationEdit(content, source, current, suggested, TS_DESC, opts?.marker),
};
registerParser(tsParser);

// ---- inspection / lint (for the CLI `annotations` command) -------------------

export function inspectTs(content: string, marker: string = DEFAULT_MARKER): AnnotationResult {
  return extractAnnotations(content, TS_DESC, marker);
}
export function lintTs(content: string, marker: string = DEFAULT_MARKER): LintIssue[] {
  return lintAnnotations(content, Lang.Tsx, marker);
}
