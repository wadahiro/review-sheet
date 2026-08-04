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

import { extractFile, type Format } from "../extract.js";
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type { SheetInputs, ExtractedMap, ValueLayer } from "../assemble.js";
import { makeKeySelector } from "../keyglob.js";

const schema = {
  type: "object",
  required: ["snapshots"],
  properties: {
    snapshots: { type: "object", minProperties: 1, additionalProperties: { type: "string" } },
    format: { type: "string" },
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
        const key = e.source.path ?? e.key;
        if (!selector.select(key)) continue;
        entries.set(key, { value: e.value, source: { ...e.source, file, generated: true } });
      }
      overlays.push({ kind: "overlay", instance, entries });
    }

    // A pattern that never matched is almost always a typo or a path that moved
    // in a regenerated artifact, and its only symptom is rows quietly missing.
    const unmatched = selector.unmatchedPatterns();
    if (unmatched.length > 0) {
      console.warn(`snapshot recipe: sheet "${name}": include/exclude pattern matched nothing: ${unmatched.join(", ")}`);
    }

    return {
      name,
      instances: io.instances,
      // No shared defaults exist in a snapshot set — see the module doc.
      layers: [{ kind: "base", entries: new Map() }, ...overlays],
      embedded: [],
    };
  },
};

registerRecipe(snapshotRecipe);
