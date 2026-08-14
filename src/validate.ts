import Ajv, { type ErrorObject } from "ajv";
import inputSchema from "./schema/input.schema.json";
import reviewSchema from "./schema/review.schema.json";
import type { ParameterSheetInput, VersionedSheetInput, ReviewDocument, Category, SourceLocation } from "./types.js";

const ajv = new Ajv({ allErrors: true });

const validateInputSchema = ajv.compile(inputSchema);
const validateReviewSchema = ajv.compile(reviewSchema);

// `out_of_scope` used to be a plain boolean plus a separate sibling reason
// field; both are gone now — it must be the object form below. Surface a
// dedicated message so callers get a migration hint instead of ajv's generic
// "must be object".
const OUT_OF_SCOPE_MIGRATION_MESSAGE =
  "out_of_scope must be an object { reason, owner? }; boolean form is no longer supported";

function formatSchemaError(e: ErrorObject): string {
  const path = e.instancePath || "/";
  if (path.endsWith("/out_of_scope") && e.keyword === "type") {
    return `${path}: ${OUT_OF_SCOPE_MIGRATION_MESSAGE}`;
  }
  return `${path}: ${e.message}`;
}

// Cross-field rule that the schema alone cannot express: an `embedded` origin
// param is a literal baked into the source, so it can never carry
// per-environment `instances`.
function findEmbeddedOriginErrors(input: ParameterSheetInput): string[] {
  const errors: string[] = [];
  const walkCategories = (categories: Category[], path: string): void => {
    for (let ci = 0; ci < categories.length; ci++) {
      const category = categories[ci];
      const catPath = `${path}/categories/${ci}`;
      const params = category.params ?? [];
      for (let pi = 0; pi < params.length; pi++) {
        const param = params[pi];
        if (param.origin === "embedded" && "instances" in param && param.instances !== undefined) {
          errors.push(`${catPath}/params/${pi}: embedded origin cannot have per-environment instances`);
        }
      }
      if (category.categories) walkCategories(category.categories, catPath);
    }
  };
  input.sheets.forEach((sheet, si) => walkCategories(sheet.categories, `/sheets/${si}`));
  return errors;
}

// Cross-field rule that the schema alone cannot express: `origin: "default"`
// means our authored sources set NOTHING (see the `Origin` comment in
// types.ts) — either the documented default (no `source` at all) or a value
// OBSERVED in a generated artifact (`source.generated: true`). A `source`
// present without `generated: true` would be the row claiming a location in a
// file THIS project authors while simultaneously claiming nobody set it —
// exactly the false "this project set it" reading the widened `default`
// exists to prevent. Checked per instance too (Pattern B): an
// InstanceParameter has no single `source`, so each instance's own is
// checked in place.
function isGeneratedSource(source: SourceLocation | undefined): boolean {
  return source?.generated === true;
}

function findDefaultOriginErrors(input: ParameterSheetInput): string[] {
  const errors: string[] = [];
  const walkCategories = (categories: Category[], path: string): void => {
    for (let ci = 0; ci < categories.length; ci++) {
      const category = categories[ci];
      const catPath = `${path}/categories/${ci}`;
      const params = category.params ?? [];
      for (let pi = 0; pi < params.length; pi++) {
        const param = params[pi];
        if (param.origin !== "default") continue;
        if ("instances" in param && param.instances !== undefined) {
          param.instances.forEach((instance, ii) => {
            if (instance.source !== undefined && !isGeneratedSource(instance.source)) {
              errors.push(
                `${catPath}/params/${pi}/instances/${ii}: default origin cannot carry a location in an authored ` +
                  `file — source.generated must be true`
              );
            }
          });
        } else if ("source" in param && param.source !== undefined && !isGeneratedSource(param.source)) {
          errors.push(
            `${catPath}/params/${pi}: default origin cannot carry a location in an authored file — ` +
              `source.generated must be true`
          );
        }
      }
      if (category.categories) walkCategories(category.categories, catPath);
    }
  };
  input.sheets.forEach((sheet, si) => walkCategories(sheet.categories, `/sheets/${si}`));
  return errors;
}

// Cross-field rule that the schema alone cannot express: `origin: "baseline"`
// means the vendor shipped this key and this deliverable does not have it
// ANYWHERE — see the `Origin` comment in types.ts. Unlike `default`, there is
// no evidence-channel exception: a `baseline` row must never carry a `source`,
// full stop, because nothing in our files holds it. Checked per instance too,
// for the same Pattern B reason findDefaultOriginErrors is.
function findBaselineOriginErrors(input: ParameterSheetInput): string[] {
  const errors: string[] = [];
  const walkCategories = (categories: Category[], path: string): void => {
    for (let ci = 0; ci < categories.length; ci++) {
      const category = categories[ci];
      const catPath = `${path}/categories/${ci}`;
      const params = category.params ?? [];
      for (let pi = 0; pi < params.length; pi++) {
        const param = params[pi];
        if (param.origin !== "baseline") continue;
        if ("instances" in param && param.instances !== undefined) {
          param.instances.forEach((instance, ii) => {
            if (instance.source !== undefined) {
              errors.push(
                `${catPath}/params/${pi}/instances/${ii}: baseline origin cannot carry a source — nothing in our ` +
                  `files holds it`
              );
            }
          });
        } else if ("source" in param && param.source !== undefined) {
          errors.push(`${catPath}/params/${pi}: baseline origin cannot carry a source — nothing in our files holds it`);
        }
      }
      if (category.categories) walkCategories(category.categories, catPath);
    }
  };
  input.sheets.forEach((sheet, si) => walkCategories(sheet.categories, `/sheets/${si}`));
  return errors;
}

export function validateInput(data: unknown): ParameterSheetInput {
  if (!validateInputSchema(data)) {
    const errors = validateInputSchema.errors ?? [];
    const messages = errors.map(formatSchemaError);
    throw new Error(
      `Input data validation error:\n${messages.join("\n")}`
    );
  }
  const input = data as ParameterSheetInput;
  const originErrors = [
    ...findEmbeddedOriginErrors(input),
    ...findDefaultOriginErrors(input),
    ...findBaselineOriginErrors(input),
  ];
  if (originErrors.length > 0) {
    throw new Error(`Input data validation error:\n${originErrors.join("\n")}`);
  }
  return input;
}

// Returns true if a parsed document is the multi-version shape.
export function isVersionedInput(data: unknown): data is VersionedSheetInput {
  return typeof data === "object" && data !== null && Array.isArray((data as { versions?: unknown }).versions);
}

// Validate a multi-version document by reusing the single-version schema for
// each version's sheets, with version context in any error.
export function validateVersionedInput(data: unknown): VersionedSheetInput {
  if (!isVersionedInput(data)) {
    throw new Error("Input data validation error:\n/versions: must be an array");
  }
  const doc = data as VersionedSheetInput;
  if (doc.versions.length === 0) {
    throw new Error("Input data validation error:\n/versions: must contain at least one version");
  }
  doc.versions.forEach((v, i) => {
    if (typeof v.version !== "string" || v.version === "") {
      throw new Error(`Input data validation error:\n/versions/${i}/version: must be a non-empty string`);
    }
    try {
      validateInput({ sheets: v.sheets, columns: v.columns, artifacts: v.artifacts });
    } catch (e) {
      const msg = e instanceof Error ? e.message.replace(/^Input data validation error:\n/, "") : String(e);
      throw new Error(`Input data validation error (version "${v.version}"):\n${msg}`);
    }
  });
  return doc;
}

export function validateReview(data: unknown): ReviewDocument {
  if (!validateReviewSchema(data)) {
    const errors = validateReviewSchema.errors ?? [];
    const messages = errors.map(
      (e) => `${e.instancePath || "/"}: ${e.message}`
    );
    throw new Error(
      `Review data validation error:\n${messages.join("\n")}`
    );
  }
  return data as ReviewDocument;
}
