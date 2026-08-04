// Tests for the "snapshot" recipe (src/recipes/snapshot.ts): one pre-rendered
// artifact per instance, no shared base.
//
// Two layers of coverage:
//   1. Unit tests against in-memory artifacts — the recipe's own contract
//      (empty base -> everything Pattern B, generated sources, include/exclude
//      globs, partial instances, instance validation).
//   2. An end-to-end pass over the committed examples/cdk-snapshot: its real
//      build.yml + CloudFormation templates through loadBuildSpec ->
//      recipe.load -> assembleSheetsWithReport, then computeApply to prove a
//      change against a generated source is HELD rather than written into the
//      synthesized artifact.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { readFileSync } from "node:fs";
import { resolve as resolvePath, join, isAbsolute } from "node:path";
import { loadBuildSpec } from "../src/spec";
import { getRecipe, type RecipeIO } from "../src/recipe";
import "../src/recipes/index";
import { assembleSheetsWithReport, type AssembleOpts, type SheetInputs } from "../src/assemble";
import { computeApply } from "../src/apply";
import { HELD_REASON_GENERATED, type SheetData, type ReviewItem } from "../src/prompt";
import type { Parameter, InstanceParameter, ParameterSheetInput } from "../src/types";

// The metadata provider registry is a process-wide singleton (see
// assemble.test.ts for the full rationale) — neutralize any non-core provider
// so enrich()'s counts don't depend on cross-file test execution order.
beforeEach(stubNonBuiltInProviders);

const REPO_ROOT = resolvePath(__dirname, "..");

function snapshotRecipe() {
  const r = getRecipe("snapshot");
  if (!r) throw new Error("snapshot recipe is not registered");
  return r;
}

// ---- 1. unit: in-memory artifacts --------------------------------------------

const STAGING = JSON.stringify({
  Resources: {
    Fn: {
      Type: "AWS::Lambda::Function",
      Properties: { MemorySize: 512, Timeout: 10, Code: { S3Key: "a.zip" } },
      DeletionPolicy: "Delete",
    },
  },
});

const PRODUCTION = JSON.stringify({
  Resources: {
    Fn: {
      Type: "AWS::Lambda::Function",
      Properties: { MemorySize: 1769, Timeout: 30, Code: { S3Key: "b.zip" }, ReservedConcurrentExecutions: 100 },
      DeletionPolicy: "Retain",
    },
  },
});

function io(overrides: Partial<RecipeIO> = {}): RecipeIO {
  const files: Record<string, string> = {
    "/p/staging.template.json": STAGING,
    "/p/production.template.json": PRODUCTION,
  };
  return {
    readFile: (path: string) => files[path] ?? null,
    specDir: "/p",
    resolve: (p: string) => resolvePath("/p", p),
    instances: ["staging", "production"],
    ...overrides,
  };
}

const BASIC_SPEC = {
  name: "API",
  recipe: "snapshot",
  snapshots: { staging: "staging.template.json", production: "production.template.json" },
};

function load(spec: Record<string, unknown>, over: Partial<RecipeIO> = {}): SheetInputs {
  return snapshotRecipe().load(spec as Parameters<ReturnType<typeof snapshotRecipe>["load"]>[0], io(over));
}

describe("snapshot recipe", () => {
  it("emits an empty base layer plus one overlay per instance", () => {
    const si = load({ ...BASIC_SPEC, include: ["Resources.*.Properties.MemorySize"] });

    const base = si.layers.filter((l) => l.kind === "base");
    expect(base.length).toBe(1); // assembleSheets requires exactly one
    expect(base[0].kind === "base" && base[0].entries.size).toBe(0);
    expect(si.layers.filter((l) => l.kind === "overlay").map((l) => (l.kind === "overlay" ? l.instance : ""))).toEqual([
      "staging",
      "production",
    ]);
    expect(si.keyMap).toBeUndefined();
    expect(si.embedded).toEqual([]);
  });

  it("keys by structural path and marks every source as generated", () => {
    const si = load({ ...BASIC_SPEC, include: ["Resources.*.Properties.MemorySize"] });
    const staging = si.layers.find((l) => l.kind === "overlay" && l.instance === "staging");
    if (staging?.kind !== "overlay") throw new Error("no staging overlay");

    expect([...staging.entries.keys()]).toEqual(["Resources.Fn.Properties.MemorySize"]);
    const entry = staging.entries.get("Resources.Fn.Properties.MemorySize");
    expect(entry?.value).toBe("512");
    expect(entry?.source.generated).toBe(true);
    expect(entry?.source.file).toBe("/p/staging.template.json");
    expect(entry?.source.path).toBe("Resources.Fn.Properties.MemorySize");
  });

  it("selects keys with include/exclude globs (* within a segment, ** across)", () => {
    const keysOf = (spec: Record<string, unknown>): string[] => {
      const si = load(spec);
      const ov = si.layers.find((l) => l.kind === "overlay" && l.instance === "production");
      return ov?.kind === "overlay" ? [...ov.entries.keys()] : [];
    };

    // No include: everything the parser yields (including the resource Type and
    // the asset key) — the reason a synthesized artifact needs a filter at all.
    expect(keysOf(BASIC_SPEC)).toContain("Resources.Fn.Type");

    // `*` does not cross a "." boundary, so it selects one resource's direct
    // properties only.
    expect(keysOf({ ...BASIC_SPEC, include: ["Resources.*.Properties.*"] })).toEqual([
      "Resources.Fn.Properties.MemorySize",
      "Resources.Fn.Properties.Timeout",
      "Resources.Fn.Properties.ReservedConcurrentExecutions",
    ]);

    // `**` does, so nested property maps come along — and exclude removes them.
    expect(keysOf({ ...BASIC_SPEC, include: ["Resources.*.Properties.**"] })).toContain(
      "Resources.Fn.Properties.Code.S3Key"
    );
    expect(
      keysOf({ ...BASIC_SPEC, include: ["Resources.*.Properties.**"], exclude: ["**.Code.**"] })
    ).not.toContain("Resources.Fn.Properties.Code.S3Key");

    // Several include patterns union; a non-Properties key needs its own.
    expect(keysOf({ ...BASIC_SPEC, include: ["Resources.*.Properties.*", "Resources.*.DeletionPolicy"] })).toContain(
      "Resources.Fn.DeletionPolicy"
    );
  });

  it("rejects a snapshot for an instance the spec does not declare", () => {
    expect(() =>
      load({ ...BASIC_SPEC, snapshots: { staging: "staging.template.json", qa: "production.template.json" } })
    ).toThrow(/not one of the spec's instances \(staging, production\)/);
  });

  it("reports a missing artifact by path", () => {
    expect(() => load({ ...BASIC_SPEC, snapshots: { staging: "nope.json" } })).toThrow(
      /snapshot for "staging" not found: \/p\/nope\.json/
    );
  });

  it("orders overlays by the spec's instances, not the mapping's key order", () => {
    const si = load({
      ...BASIC_SPEC,
      snapshots: { production: "production.template.json", staging: "staging.template.json" },
    });
    expect(si.layers.filter((l) => l.kind === "overlay").map((l) => (l.kind === "overlay" ? l.instance : ""))).toEqual([
      "staging",
      "production",
    ]);
  });

  it("skips an instance that has no artifact (component not deployed there)", () => {
    const si = load({ ...BASIC_SPEC, snapshots: { production: "production.template.json" } });
    expect(si.instances).toEqual(["staging", "production"]); // the column still exists
    expect(si.layers.filter((l) => l.kind === "overlay").length).toBe(1);
  });
});

// ---- 2. end-to-end: the committed cdk-snapshot example ------------------------

function buildExample(): { input: ParameterSheetInput; report: ReturnType<typeof assembleSheetsWithReport>["report"] } {
  const exampleRoot = join(REPO_ROOT, "examples", "cdk-snapshot");
  const specDir = join(exampleRoot, "review-sheet");
  const readFile = (p: string): string | null => {
    try {
      return readFileSync(isAbsolute(p) ? p : join(exampleRoot, p), "utf-8");
    } catch {
      return null;
    }
  };

  const spec = loadBuildSpec(join(specDir, "build.yml"), { readFile });
  const recipeIo: RecipeIO = {
    readFile,
    specDir,
    resolve: (p: string) => resolvePath(specDir, p),
    instances: spec.instances,
  };
  const inputs: SheetInputs[] = [];
  // A sheet's own dictionaries (build.yml's sheets[].dictionaries) are no
  // longer read by assembleSheets from the project metadata file — collect
  // them the same way assemble-spec.ts's assembleFromSpecWithReport does.
  // `categories`/`under_key` are now read straight off the project metadata
  // (sheet.yml) by assembleSheets itself — nothing to collect here.
  const dictionaries: NonNullable<AssembleOpts["dictionaries"]> = {};
  for (const sheetSpec of spec.sheets) {
    const recipe = getRecipe(sheetSpec.recipe);
    if (!recipe) throw new Error(`Unknown recipe "${sheetSpec.recipe}"`);
    inputs.push(recipe.load(sheetSpec, recipeIo));
    if (sheetSpec.dictionaries) dictionaries[sheetSpec.name] = sheetSpec.dictionaries;
  }
  const opts: AssembleOpts = {
    readFile,
    projectPath: spec.enrich?.project,
    metadataDirs: spec.enrich?.metadata_dirs,
    argumentSpecs: spec.enrich?.argument_specs,
    lang: spec.enrich?.lang,
    strictMetadata: spec.enrich?.strict,
    metadata: spec.metadata,
    capabilities: spec.capabilities,
    dictionaries,
  };
  return assembleSheetsWithReport(inputs, opts);
}

function allParams(input: ParameterSheetInput): Parameter[] {
  return input.sheets.flatMap((s) => (s.categories ?? []).flatMap((c) => c.params ?? []));
}

function instancesOf(p: Parameter): InstanceParameter["instances"] {
  return (p as InstanceParameter).instances ?? [];
}

describe("snapshot recipe: examples/cdk-snapshot", () => {
  it("turns two synthesized templates into one all-Pattern-B sheet", () => {
    const { input, report } = buildExample();
    const params = allParams(input);

    expect(params.length).toBe(19);
    // No shared base exists, so nothing can be Pattern A / embedded.
    expect(params.every((p) => p.origin === "overlay")).toBe(true);
    expect(params.every((p) => instancesOf(p).length > 0)).toBe(true);
    expect(params.every((p) => instancesOf(p).every((i) => i.source?.generated === true))).toBe(true);

    expect(input.capabilities).toEqual({ apply: false });
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual([
      "Data store",
      "Scaling",
      "Compute",
      "Logging",
    ]);
    // Every description comes from the project metadata (no dictionary here);
    // the one out-of-scope parameter is exempt from the strictness gate.
    expect(report.byProvider).toEqual({ project: 23 });
    expect(params.filter((p) => p.out_of_scope).length).toBe(1);
  });

  it("gives a resource that exists in only one environment a partial Pattern B", () => {
    const params = allParams(buildExample().input);

    const maxCapacity = params.find((p) => p.key.endsWith("TableReadScalingTargetD6E4C6F0.Properties.MaxCapacity"));
    expect(instancesOf(maxCapacity!).map((i) => i.name)).toEqual(["production"]);

    const memory = params.find((p) => p.key.endsWith("ApiFunction4A2B0C1D.Properties.MemorySize"));
    expect(instancesOf(memory!).map((i) => [i.name, i.value])).toEqual([
      ["staging", "512"],
      ["production", "1769"],
    ]);
  });

  it("holds an apply against the synthesized artifact instead of editing it", () => {
    const { input } = buildExample();
    const key = allParams(input).find((p) => p.key.endsWith("ApiFunction4A2B0C1D.Properties.MemorySize"))!.key;

    const reviews: ReviewItem[] = [
      {
        id: "r1",
        status: "pending",
        target: { sheet: "API stack", category: "Compute", param: key, instance: "production", field: "value" },
        changes: [{ field: "value", current: "1769", suggested: "3008" }],
      },
    ];

    const out = computeApply(input as SheetData, reviews, (p: string) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    });

    expect(out.applied).toBe(0);
    expect(out.files.length).toBe(0);
    expect(out.results.map((r) => [r.status, r.reason])).toEqual([["held", HELD_REASON_GENERATED]]);
  });
});
