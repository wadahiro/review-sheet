// Python annotation parser: the same `@rs` model as the TS parser, for Python
// config-as-code (AWS CDK for Python, Pulumi, settings modules). Python is not in
// the base @ast-grep/napi build, so its grammar is registered dynamically.

import { registerDynamicLanguage } from "@ast-grep/napi";
import pyLang from "@ast-grep/lang-python";
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

const PY_LANG = "python";
// registerDynamicLanguage must run once before parsing; module caching makes this
// run once per process. Guard against an accidental double-registration.
try {
  registerDynamicLanguage({ [PY_LANG]: pyLang as unknown as Parameters<typeof registerDynamicLanguage>[0][string] });
} catch {
  // already registered — ignore
}

const PY_DESC: LangDescriptor = {
  lang: PY_LANG,
  valueKinds: [
    { kind: "assignment", keyField: "left", valueField: "right" },
    { kind: "keyword_argument", keyField: "name", valueField: "value" },
    { kind: "pair", keyField: "key", valueField: "value" },
  ],
  pathSegments: [
    { kind: "assignment", field: "left" },
    { kind: "class_definition", field: "name" },
    { kind: "function_definition", field: "name" },
  ],
  constructKinds: ["call"],
  stringKinds: ["string"],
};

const pyParser: ConfigParser = {
  name: "py",
  priority: 20,
  meta: {
    title: "Python (annotations)",
    summary: "In-source `@rs` annotations on Python config-as-code (CDK for Python, Pulumi, settings); value = the RHS expression.",
    files: "*.py (with @rs annotations)",
    detection: "extension (.py)",
    pathStyle: "config.read_capacity — assignment/class/construct-id names + key",
    notes: [
      "Only `@rs`-annotated assignments / keyword-arguments / dict entries are extracted.",
      "value is the verbatim RHS (literal, `Duration.seconds(30)`, enum, …); strings shown unquoted.",
      "Python grammar is registered dynamically via @ast-grep/lang-python.",
    ],
    examples: ["MAX_CONN", "config.read_capacity"],
  },
  detect: (file) => file.toLowerCase().endsWith(".py"),
  extract: (content, file, opts) => annotationExtract(content, file, PY_DESC, opts?.marker),
  locate: (content, source: SourceLocation, _expected: string, opts?: ExtractOptions): LocateResult =>
    annotationLocate(content, source, PY_DESC, opts?.marker),
  edit: (content, source: SourceLocation, current: string, suggested: string, opts?: ExtractOptions): EditResult =>
    annotationEdit(content, source, current, suggested, PY_DESC, opts?.marker),
};
registerParser(pyParser);

export function inspectPy(content: string, marker: string = DEFAULT_MARKER): AnnotationResult {
  return extractAnnotations(content, PY_DESC, marker);
}
export function lintPy(content: string, marker: string = DEFAULT_MARKER): LintIssue[] {
  return lintAnnotations(content, PY_LANG, marker);
}
