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

// A machine-generated artifact addresses a value by where it SITS, which is an
// identity but rarely a name. `key:` rewrites it to what a reviewer calls the
// setting — and to what a product dictionary is keyed by — before assembly.
describe("snapshot recipe: key transform", () => {
  const STEPS = [{ pattern: "^Resources\\.([A-Za-z0-9]+)\\.Properties\\.(.+)$", replace: "$1.$2", on_no_match: "drop" as const }];

  it("renames the row by the transformed key, keeping the raw path as the source", () => {
    const si = load({ ...BASIC_SPEC, key: { from: "path", steps: STEPS } });
    const staging = si.layers.find((l) => l.kind === "overlay" && l.instance === "staging");
    if (staging?.kind !== "overlay") throw new Error("no staging overlay");

    expect([...staging.entries.keys()]).toContain("Fn.MemorySize");
    // The source map must still point at the artifact's own address, or verify
    // and apply would look for "Fn.MemorySize" in a file that has no such path.
    expect(staging.entries.get("Fn.MemorySize")?.source.path).toBe("Resources.Fn.Properties.MemorySize");
  });

  it("drops a scalar the transform does not match, instead of keeping its raw path", () => {
    const si = load({ ...BASIC_SPEC, key: { from: "path", steps: STEPS } });
    const staging = si.layers.find((l) => l.kind === "overlay" && l.instance === "staging");
    if (staging?.kind !== "overlay") throw new Error("no staging overlay");
    // Everything outside Resources.*.Properties.* is gone, not passed through
    // under its artifact address.
    expect([...staging.entries.keys()].every((k) => !k.startsWith("Resources."))).toBe(true);
  });

  it("selects include/exclude against the TRANSFORMED key", () => {
    const si = load({ ...BASIC_SPEC, key: { from: "path", steps: STEPS }, include: ["Fn.*"] });
    const staging = si.layers.find((l) => l.kind === "overlay" && l.instance === "staging");
    if (staging?.kind !== "overlay") throw new Error("no staging overlay");
    expect([...staging.entries.keys()].length).toBeGreaterThan(0);
    expect([...staging.entries.keys()].every((k) => k.startsWith("Fn."))).toBe(true);
  });

  it("reports a drop pattern that matched nothing across ALL instances, not per artifact", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      load({ ...BASIC_SPEC, key: { from: "path", steps: [{ pattern: "^NoSuchRoot\\.(.+)$", replace: "$1", on_no_match: "drop" as const }] } });
    } finally {
      console.warn = original;
    }
    expect(warnings.filter((w) => w.includes("key transform pattern matched nothing")).length).toBe(1);
  });
});

// An artifact often carries the project's own grouping where nothing else can
// see it. A Terraform plan's module path says "these resources are the Keycloak
// database" — a cluster, its subnet group, its security group, the secret
// holding its password — which the AWS provider's taxonomy scatters across
// three services because it groups by what AWS sells.
describe("snapshot recipe: component transform", () => {
  const PLAN = JSON.stringify({
    resource_changes: [
      { address: "module.aurora.aws_rds_cluster.this", change: { after: { engine_version: "16.4" } } },
      { address: "module.aurora.aws_security_group.aurora", change: { after: { name_prefix: "db-" } } },
      { address: "module.alb.aws_lb.this", change: { after: { idle_timeout: 60 } } },
      { address: "aws_vpc.root", change: { after: { cidr_block: "10.0.0.0/16" } } },
    ],
  });
  const files = { "/p/staging.template.json": PLAN };
  const over = {
    readFile: (path: string) => (files as Record<string, string>)[path] ?? null,
    extractOptions: { idFields: ["address"] },
  };
  const KEY = {
    from: "path" as const,
    steps: [
      {
        pattern: '^resource_changes\\[address="?(?:module\\.([^.]+)\\.)?([^"\\]]+?)"?\\]\\.change\\.after\\.(.+)$',
        replace: "$1.$2.$3",
        on_no_match: "drop" as const,
      },
    ],
  };
  const CATEGORY = {
    from: "path" as const,
    steps: [
      {
        pattern: '^resource_changes\\[address="?module\\.([^.]+)\\..*$',
        replace: "$1",
        on_no_match: "drop" as const,
      },
    ],
  };

  // `component:` reaches a recipe through RecipeIO (spec.ts strips it as a
  // common sheet field), so the tests hand it over the same way the real path
  // does rather than through the sheet spec.
  function load1(spec: Record<string, unknown>): SheetInputs {
    const { component, ...rest } = spec as { component?: Record<string, unknown> };
    return load({ name: "S", snapshots: { staging: "staging.template.json" }, ...rest }, { ...over, component });
  }

  it("puts every row of one module under that module, across resource types", () => {
    const si = load1({ key: KEY, component: CATEGORY });
    const cat = si.componentOf!;
    // The cluster and the security group that guards it: one purpose, one
    // category, two different AWS services.
    expect([...cat.entries()].filter(([, v]) => v === "aurora").length).toBe(2);
    expect([...cat.values()]).toContain("alb");
  });

  it("leaves a row with no module ungrouped, so it can fall back to the dictionary", () => {
    const si = load1({ key: KEY, component: CATEGORY });
    const rootRow = [...si.componentOf!.keys()].find((k) => k.includes("aws_vpc"));
    expect(rootRow).toBeUndefined();
  });

  it("carries no componentOf at all when the sheet declares no category transform", () => {
    const si = load1({ key: KEY });
    expect(si.componentOf).toBeUndefined();
  });
});

// The transform yields an ID; what the component IS is the one thing the
// artifact cannot carry. `names:` supplies it, and the two are checked against
// each other in both directions.
describe("snapshot recipe: component names", () => {
  const PLAN = JSON.stringify({
    resource_changes: [
      { address: "module.aurora.aws_rds_cluster.this", change: { after: { engine_version: "16.4" } } },
      { address: "module.alb.aws_lb.this", change: { after: { idle_timeout: 60 } } },
    ],
  });
  const files = { "/p/staging.template.json": PLAN };
  const over = {
    readFile: (path: string) => (files as Record<string, string>)[path] ?? null,
    extractOptions: { idFields: ["address"] },
  };
  const KEY = {
    from: "path" as const,
    steps: [{ pattern: '^resource_changes\\[address="?module\\.([^.]+?)\\.([^"\\]]+?)"?\\]\\.change\\.after\\.(.+)$', replace: "$1.$2.$3", on_no_match: "drop" as const }],
  };
  const derive = { from: "path" as const, steps: [{ pattern: '^resource_changes\\[address="?module\\.([^.]+?)\\..*$', replace: "$1", on_no_match: "drop" as const }] };

  function load1(component: Record<string, unknown>): SheetInputs {
    return load({ name: "S", snapshots: { staging: "staging.template.json" }, key: KEY }, { ...over, component });
  }

  // Rows are filed under the derived ID, and the declared name rides along as
  // a label. Filing under the name would make identity move with wording — a
  // `--lang ja` build and a `--lang en` build would produce different review
  // targets for the same sheet, and fixing a typo would orphan every pending
  // review. See types.ts's Category.
  it("files rows under the ID and carries the name as a label", () => {
    const si = load1({ ...derive, names: { aurora: { name: { ja: "Keycloak DB", en: "Keycloak database" } }, alb: { name: "SSO endpoint" } } });
    expect(new Set(si.componentOf!.values())).toEqual(new Set(["aurora", "alb"]));
    expect(si.componentLabels!.get("aurora")).toEqual({ ja: "Keycloak DB", en: "Keycloak database" });
    // A single string means the same text in both languages, not "English".
    expect(si.componentLabels!.get("alb")).toEqual({ en: "SSO endpoint", ja: "SSO endpoint" });
  });

  it("fails when the artifact grows a component nobody named", () => {
    expect(() => load1({ ...derive, names: { aurora: { name: "Keycloak DB" } } })).toThrow(/named nowhere: alb/);
  });

  it("fails when a name outlives the component it named", () => {
    expect(() =>
      load1({ ...derive, names: { aurora: { name: "Keycloak DB" }, alb: { name: "SSO endpoint" }, gone: { name: "old thing" } } })
    ).toThrow(/absent from the artifact: gone/);
  });

  it("keeps the derived id when no names are declared at all", () => {
    const si = load1(derive);
    expect(new Set(si.componentOf!.values())).toEqual(new Set(["aurora", "alb"]));
  });
});

// A key transform can collapse two distinct values onto one key. Last-writer-
// wins would delete a row with no trace AND leave the sheet looking correct —
// one ALB where there are two — so this fails the build instead.
describe("snapshot recipe: key collisions", () => {
  const TWO_ALBS = JSON.stringify({
    resource_changes: [
      { address: "module.alb_aaaa.aws_lb.this", change: { after: { idle_timeout: 60 } } },
      { address: "module.alb_bbbb.aws_lb.this", change: { after: { idle_timeout: 120 } } },
    ],
  });
  const files = { "/p/staging.template.json": TWO_ALBS, "/p/production.template.json": TWO_ALBS };
  const over = {
    readFile: (path: string) => (files as Record<string, string>)[path] ?? null,
    extractOptions: { idFields: ["address"] },
  };
  // Drops the module segment — the mistake this exists to catch.
  const DROPS_MODULE = {
    from: "path" as const,
    steps: [
      {
        pattern: '^resource_changes\\[address="?(?:module\\.[^.]+\\.)?(aws_[a-z0-9_]+)\\.([^"]+?)"?\\]\\.change\\.after\\.(.+)$',
        replace: "$1.$2.$3",
        on_no_match: "drop" as const,
      },
    ],
  };

  it("fails, naming both artifact paths, rather than keeping the last one", () => {
    expect(() =>
      load({ name: "S", snapshots: { staging: "staging.template.json" }, key: DROPS_MODULE }, over)
    ).toThrow(/key collision/);
  });

  it("names the row key and both sources, so the fix is visible from the message", () => {
    let message = "";
    try {
      load({ name: "S", snapshots: { staging: "staging.template.json" }, key: DROPS_MODULE }, over);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("aws_lb.this.idle_timeout");
    expect(message).toContain("module.alb_aaaa");
    expect(message).toContain("module.alb_bbbb");
  });

  it("accepts the same artifact once the transform keeps what distinguishes them", () => {
    const KEEPS_MODULE = {
      from: "path" as const,
      steps: [
        {
          pattern: '^resource_changes\\[address="?module\\.([^.]+)\\.(aws_[a-z0-9_]+)\\.([^"]+?)"?\\]\\.change\\.after\\.(.+)$',
          replace: "$1.$2.$3.$4",
          on_no_match: "drop" as const,
        },
      ],
    };
    const si = load({ name: "S", snapshots: { staging: "staging.template.json" }, key: KEEPS_MODULE }, over);
    const staging = si.layers.find((l) => l.kind === "overlay" && l.instance === "staging");
    if (staging?.kind !== "overlay") throw new Error("no staging overlay");
    expect([...staging.entries.keys()].sort()).toEqual([
      "alb_aaaa.aws_lb.this.idle_timeout",
      "alb_bbbb.aws_lb.this.idle_timeout",
    ]);
  });
});

// Whether an empty string spells absence is a property of the RENDERER, never
// of the format — so it is declared per sheet, and off unless declared.
describe("snapshot recipe: empty_means_unset", () => {
  const SPEC = {
    name: "S",
    snapshots: { staging: "staging.template.json", production: "production.template.json" },
  };
  // A route-table shape in miniature: one target set, its mutually exclusive
  // siblings filled with "" by the renderer.
  const WITH_EMPTY = JSON.stringify({
    Route: { gateway_id: "igw-1", nat_gateway_id: "", transit_gateway_id: "" },
  });
  const files = { "/p/staging.template.json": WITH_EMPTY, "/p/production.template.json": WITH_EMPTY };
  const over = { readFile: (path: string) => (files as Record<string, string>)[path] ?? null };

  it("keeps empty strings by default, because an empty string is a real value", () => {
    const si = load({ ...SPEC }, over);
    const staging = si.layers.find((l) => l.kind === "overlay" && l.instance === "staging");
    if (staging?.kind !== "overlay") throw new Error("no staging overlay");
    expect([...staging.entries.values()].some((v) => v.value === "")).toBe(true);
  });

  it("drops them when the sheet declares that this artifact means absence by them", () => {
    const si = load({ ...SPEC, empty_means_unset: true }, over);
    const staging = si.layers.find((l) => l.kind === "overlay" && l.instance === "staging");
    if (staging?.kind !== "overlay") throw new Error("no staging overlay");
    expect([...staging.entries.values()].some((v) => v.value === "")).toBe(false);
    // The one that IS set survives — this drops absence, not the block.
    expect([...staging.entries.values()].map((v) => v.value)).toEqual(["igw-1"]);
  });

  it("reports how many it dropped, so the author can check the claim", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      load({ ...SPEC, empty_means_unset: true }, over);
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => /empty-string value\(s\) treated as unset/.test(w))).toBe(true);
  });
});

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
