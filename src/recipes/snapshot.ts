// Snapshot recipe: one pre-rendered artifact per instance, no shared base.
//
// Some tools keep their per-environment divergence in PROGRAM LOGIC rather than
// in per-environment files — AWS CDK's `if (stage === "production")`, Terraform's
// `count`/conditional expressions, a Helm chart's template `if`. There is no
// overlay file to diff: the only place the resolved values exist is the
// artifact the tool renders (`cdk synth`, `terraform plan -json`,
// `helm template`). So the user pre-renders ONE artifact per environment and
// commits it; this recipe reads each artifact as that instance's values.
//
// Recipes never execute a toolchain — no `cdk`/`terraform` is spawned here.
// The artifacts are ordinary committed files, extracted by the normal parsers
// (extract.ts), which keeps `import --spec` hermetic and offline.
//
// Consequences of having no base layer:
//   - Every parameter is Pattern B (`origin: overlay`). An empty base layer is
//     emitted so assembleSheets' "exactly one base" rule holds; its overlay-only
//     sweep then turns every key into an instance parameter. Values identical
//     across all environments stay Pattern B too — with independent artifacts
//     there is no evidence that sameness is intentional, and each instance's
//     value has its own source location, so collapsing them to Pattern A would
//     invent a shared origin that does not exist.
//   - A key present in only some artifacts (a prod-only resource) yields a
//     partial Pattern B: the environments that have it show a value, the others
//     show a blank cell — which is exactly the review-worthy fact.
//
// Every extracted source is marked `generated: true`: the artifact is rebuilt by
// the next `synth`/`plan`, so a direct edit would be silently lost. `apply`
// therefore HOLDS these changes for the AI-prompt/manual fallback (see
// HELD_REASON_GENERATED in prompt.ts) instead of writing to the artifact, and
// `verify` downgrades a missing artifact to a warning. A spec that uses only
// snapshot sheets should also say `capabilities: { apply: false }` so the viewer
// drops the apply affordance wholesale.
//
// Keys are the extracted STRUCTURAL PATH when the format has one
// (`Resources.ApiFunction.Properties.MemorySize`), falling back to the
// extracted key — a machine-generated artifact repeats leaf names (`Timeout`,
// `Name`) across resources, so the leaf alone is not an identity. Since the
// artifact is machine-generated it also carries far more scalars than anyone
// wants to review; `include`/`exclude` globs select the reviewable subset
// (everything else is dropped before assembly, so it never reaches the
// project-metadata/enrich strictness gate).
//
// That raw path is an identity, but it is rarely a NAME: a Terraform plan
// addresses the same setting as
// `resource_changes[address=module.alb.aws_lb.this].change.after.idle_timeout`,
// which says where the value sits in the artifact and nothing about what a
// reviewer calls it. An optional `key: { from: path, steps: [...] }` — the
// same transform layered/ansible take — rewrites it to `aws_lb.idle_timeout`
// before assembly, which is both what the reviewer reads and what the product
// dictionary is keyed by. A `drop` step doubles as a filter with a reason
// attached, and one that never matches is reported, exactly as with
// include/exclude.

import { extractFile, type Format } from "../extract.js";
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type { SheetInputs, ExtractedMap, ValueLayer } from "../assemble.js";
import { makeKeySelector } from "../keyglob.js";
import { makeKeyTransformer, selectKeySource, keyTransformSchema, type KeyTransform } from "../keytransform.js";
import type { LangText } from "../types.js";

// A reviewer-facing string: one language, or both. Same shape the model uses
// everywhere else (types.ts's LangText).
function asLangText(v: LangText | string): LangText {
  return typeof v === "string" ? { en: v, ja: v } : v;
}

const langTextSchema = {
  oneOf: [
    { type: "string" },
    { type: "object", properties: { en: { type: "string" }, ja: { type: "string" } }, additionalProperties: false, minProperties: 1 },
  ],
};

const schema = {
  type: "object",
  required: ["snapshots"],
  properties: {
    snapshots: { type: "object", minProperties: 1, additionalProperties: { type: "string" } },
    format: { type: "string" },
    key: keyTransformSchema,
    // `component:` is NOT declared here. It is a field every sheet has, so
    // spec.ts validates it as a common one and strips it before this schema is
    // reached; the recipe receives it via RecipeIO instead.
    empty_means_unset: { type: "boolean" },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};

function asString(v: JsonValue | undefined, field: string): string {
  if (typeof v !== "string") throw new Error(`snapshot recipe: "${field}" must be a string`);
  return v;
}

function asObject(v: JsonValue | undefined): Record<string, JsonValue> {
  return v !== undefined && v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, JsonValue>)
    : {};
}

function asStringArray(v: JsonValue | undefined, field: string): string[] {
  return Array.isArray(v) ? v.map((item, i) => asString(item, `${field}[${i}]`)) : [];
}

export const snapshotRecipe: SheetRecipe = {
  name: "snapshot",
  schema,
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const name = asString(sheetSpec.name, "name");
    const snapshots = asObject(sheetSpec.snapshots);
    const format = sheetSpec.format === undefined ? undefined : (asString(sheetSpec.format, "format") as Format);
    const keySpec = sheetSpec.key as KeyTransform | undefined;
    const emptyMeansUnset = sheetSpec.empty_means_unset === true;
    // ONE transformer for the whole sheet, not one per artifact: its record of
    // which "drop" steps never matched has to span every instance, or a step
    // that only ever matches in production would be reported as dead.
    const transformer = keySpec ? makeKeyTransformer(keySpec) : undefined;
    // Read off RecipeIO, not the sheet spec: `component:` is a field EVERY
    // sheet has (spec.ts), so it is stripped before the recipe's own schema
    // validation and handed over here instead. Only the derived form concerns
    // this recipe — a literal one is applied centrally (assemble-spec.ts).
    const componentSpec = io.component as
      | (KeyTransform & { names?: Record<string, { name: LangText | string; purpose?: LangText | string }> })
      | undefined;
    const componentNames = componentSpec?.names;
    const componentTransformer = componentSpec ? makeKeyTransformer(componentSpec) : undefined;
    // Keyed by the transformed row key, which is what assembleSheets looks up.
    const componentOf = new Map<string, string>();
    const derivedIds = new Set<string>();
    const componentLabels = new Map<string, LangText>();
    let emptyDropped = 0;
    const collisions: { key: string; first: string; second: string }[] = [];
    const selector = makeKeySelector(
      asStringArray(sheetSpec.include, "include"),
      asStringArray(sheetSpec.exclude, "exclude")
    );

    for (const instance of Object.keys(snapshots)) {
      if (!io.instances.includes(instance)) {
        throw new Error(
          `snapshot recipe: sheet "${name}" has a snapshot for "${instance}", ` +
            `which is not one of the spec's instances (${io.instances.join(", ")})`
        );
      }
    }

    // Instance order (not the mapping's key order) drives which artifact
    // establishes the parameter order, so the sheet's row order matches the
    // spec's declared instance order regardless of how the YAML was written.
    const overlays: ValueLayer[] = [];
    for (const instance of io.instances) {
      const path = snapshots[instance];
      if (path === undefined) {
        // Legitimate for a component that is not deployed everywhere: that
        // instance simply gets no cell in this sheet.
        console.warn(`snapshot recipe: sheet "${name}" has no snapshot for instance "${instance}"`);
        continue;
      }
      const file = io.resolve(asString(path, `snapshots.${instance}`));
      const content = io.readFile(file);
      if (content === null) throw new Error(`snapshot recipe: snapshot for "${instance}" not found: ${file}`);

      const entries: ExtractedMap = new Map();
      for (const e of extractFile(content, file, format, io.extractOptions)) {
        if (emptyMeansUnset && e.value === "") {
          emptyDropped++;
          continue;
        }
        const key = transformer
          ? transformer.apply(selectKeySource(keySpec!.from, e.key, e.source.path))
          : (e.source.path ?? e.key);
        // undefined = a `drop` step said this scalar is not a reviewable value.
        if (key === undefined) continue;
        // Selection runs on the TRANSFORMED key: an include/exclude written
        // against the artifact's raw addresses would have to be rewritten every
        // time the transform changed, and the transformed key is the one the
        // sheet actually shows.
        if (!selector.select(key)) continue;
        // Two scalars landing on one key means the key does not identify them.
        // The `key:` transform is the usual cause — dropping a Terraform
        // module path is safe only while every resource type appears in at
        // most one module, and a second ALB module collapses
        // module.alb_a.aws_lb.this.idle_timeout and module.alb_b's onto the
        // same row. Last-writer-wins would delete one silently, and the sheet
        // would look correct: one ALB, one idle_timeout, no sign the other
        // exists. Collected and raised together so one run names every
        // collision rather than one per fix.
        const clash = entries.get(key);
        if (clash) {
          collisions.push({ key, first: clash.source.path ?? key, second: e.source.path ?? key });
          continue;
        }
        entries.set(key, { value: e.value, source: { ...e.source, file, generated: true } });
        if (componentTransformer) {
          const cat = componentTransformer.apply(selectKeySource(componentSpec!.from, e.key, e.source.path));
          // undefined = this row's path carries no grouping (a plan with no
          // modules); it falls back to the dictionary's own group downstream.
          if (cat !== undefined) {
            derivedIds.add(cat);
            // Filed under the derived ID, never under the display name. The
            // id is what `sheet::category::param` is keyed by, so it has to be
            // language-independent and stable across a wording change; the name
            // rides along as a label the viewer resolves per language. An
            // earlier version filed under the name, which made a `--lang ja`
            // build and a `--lang en` build produce different review targets
            // for the same sheet.
            componentOf.set(key, cat);
            const named = componentNames?.[cat];
            if (named) componentLabels.set(cat, asLangText(named.name));
          }
        }
      }
      overlays.push({ kind: "overlay", instance, entries });
    }

    // A pattern that never matched is almost always a typo or a path that moved
    // in a regenerated artifact, and its only symptom is rows quietly missing.
    const unmatched = selector.unmatchedPatterns();
    if (unmatched.length > 0) {
      console.warn(`snapshot recipe: sheet "${name}": include/exclude pattern matched nothing: ${unmatched.join(", ")}`);
    }
    if (collisions.length > 0) {
      const shown = collisions.slice(0, 10);
      throw new Error(
        `snapshot recipe: sheet "${name}": ${collisions.length} key collision(s) — two artifact values addressed by one row key. ` +
          `Widen the \`key:\` transform so it keeps what distinguishes them:\n` +
          shown.map((c) => `  ${c.key}\n    ${c.first}\n    ${c.second}`).join("\n") +
          (collisions.length > shown.length ? `\n  ... and ${collisions.length - shown.length} more` : "")
      );
    }
    // Counted and reported rather than quietly applied: `empty_means_unset` is
    // a claim about the artifact, and the number is how an author checks it was
    // the claim they meant to make.
    if (emptyDropped > 0) {
      console.warn(
        `snapshot recipe: sheet "${name}": ${emptyDropped} empty-string value(s) treated as unset (empty_means_unset)`
      );
    }
    const unmatchedSteps = transformer?.unmatchedDropPatterns() ?? [];
    if (unmatchedSteps.length > 0) {
      console.warn(`snapshot recipe: sheet "${name}": key transform pattern matched nothing: ${unmatchedSteps.join(", ")}`);
    }
    if (componentNames) {
      const unnamed = [...derivedIds].filter((id) => !componentNames[id]).sort();
      const stale = Object.keys(componentNames).filter((id) => !derivedIds.has(id)).sort();
      if (unnamed.length > 0 || stale.length > 0) {
        throw new Error(
          `snapshot recipe: sheet "${name}": component names are out of step with the artifact.` +
            (unnamed.length > 0
              ? `\n  produced by the artifact, named nowhere: ${unnamed.join(", ")}` +
                `\n    (a new one appears when the artifact grows a component — name it, or it goes on the sheet as an id)`
              : "") +
            (stale.length > 0 ? `\n  named here, absent from the artifact: ${stale.join(", ")}` : "")
        );
      }
    }
    const unmatchedCategory = componentTransformer?.unmatchedDropPatterns() ?? [];
    if (unmatchedCategory.length > 0) {
      console.warn(`snapshot recipe: sheet "${name}": component transform pattern matched nothing: ${unmatchedCategory.join(", ")}`);
    }

    return {
      name,
      instances: io.instances,
      // No shared defaults exist in a snapshot set — see the module doc.
      layers: [{ kind: "base", entries: new Map() }, ...overlays],
      embedded: [],
      ...(componentOf.size > 0 ? { componentOf } : {}),
      ...(componentLabels.size > 0 ? { componentLabels } : {}),
    };
  },
};

registerRecipe(snapshotRecipe);
