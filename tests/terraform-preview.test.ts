// The bridge between a plan-derived row key and a module's own `.tf` source
// (terraform-plan.ts's `tfSourceKey`/`normalizeTfKey`), plus the `sources:`
// wiring that turns them into `ArtifactPreview`s beside a real sheet.

import { describe, it, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { tfSourceKey, normalizeTfKey } from "../src/recipes/terraform-plan";
import { getRecipe } from "../src/recipe";
import "../src/recipes/index.js";
import type { RecipeIO } from "../src/recipe";
import type { ArtifactLine, InstanceParameter } from "../src/types";
import { assembleSheets, type AssembleOpts } from "../src/assemble";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";

describe("tfSourceKey", () => {
  it("turns an hcl resource path into a plan-shaped row key, module prepended", () => {
    expect(tfSourceKey("alb", "resource.aws_lb.this.name_prefix")).toBe("alb.aws_lb.this.name_prefix");
  });

  it("returns undefined for a declaration hcl never turns into a resource_changes row", () => {
    expect(tfSourceKey("alb", "variable.name_prefix.default")).toBeUndefined();
    expect(tfSourceKey("alb", "locals.name_prefix")).toBeUndefined();
    expect(tfSourceKey("alb", "output.name_prefix")).toBeUndefined();
    expect(tfSourceKey("alb", "data.aws_ami.this.id")).toBeUndefined();
  });

  it("returns undefined for a path too short to carry an argument", () => {
    expect(tfSourceKey("alb", "resource.aws_lb.this")).toBeUndefined();
  });
});

describe("normalizeTfKey", () => {
  it("lines up a plan row's array-rendered nested block with the source's unindexed path", () => {
    const fromSource = tfSourceKey("alb", "resource.aws_lb_target_group.keycloak.health_check.path")!;
    const fromPlan = "alb.aws_lb_target_group.keycloak.health_check[0].path";
    expect(normalizeTfKey(fromSource)).toBe(normalizeTfKey(fromPlan));
  });
});

// `sources:` wired through the real recipe, against a committed fixture: a
// two-resource module (tests/fixtures/terraform-preview/module/*.tf) and a
// matching plan (tests/fixtures/terraform-preview/plan.json). Real
// readdirSync/readFileSync, not an in-memory stand-in — the same reason
// assemble-spec.test.ts's own RecipeIO.listDir coverage uses a real fixture
// directory: it is the only thing that exercises the actual wiring.
describe("terraform-plan recipe: sources: — previewing a module's .tf beside its plan-derived sheet", () => {
  beforeEach(stubNonBuiltInProviders);

  const FIXTURE_DIR = join(import.meta.dir, "fixtures", "terraform-preview");

  function recipe() {
    const r = getRecipe("terraform-plan");
    if (!r) throw new Error("terraform-plan recipe is not registered");
    return r;
  }

  const io = (): RecipeIO => ({
    readFile: (p) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return null;
      }
    },
    specDir: FIXTURE_DIR,
    resolve: (p) => join(FIXTURE_DIR, p),
    instances: ["staging"],
  });

  const baseSheetSpec = {
    name: "aws",
    recipe: "terraform-plan",
    snapshots: { staging: "plan.json" },
  };

  function lines(preview: { lines: ArtifactLine[] } | undefined): ArtifactLine[] {
    return preview?.lines ?? [];
  }

  it("emits one preview per *.tf file, each nature: source, filed under the right component", () => {
    const si = recipe().load({ ...baseSheetSpec, sources: { alb: "module" } }, io());
    const artifacts = si.artifacts ?? [];
    expect(artifacts).toHaveLength(2);
    for (const a of artifacts) {
      expect(a.nature).toBe("source");
      expect(a.component).toBe("alb");
      expect(a.sheet).toBe("aws");
    }
    expect(artifacts.some((a) => a.source_file.endsWith("main.tf"))).toBe(true);
    expect(artifacts.some((a) => a.source_file.endsWith("variables.tf"))).toBe(true);
    // Two distinct files on one sheet/component must not collide as ids.
    expect(new Set(artifacts.map((a) => a.id)).size).toBe(2);
  });

  it("the authored attribute's line carries its row key", () => {
    const si = recipe().load({ ...baseSheetSpec, sources: { alb: "module" } }, io());
    const main = (si.artifacts ?? []).find((a) => a.source_file.endsWith("main.tf"));
    const line = lines(main).find((l) => l.text.includes("load_balancer_type"));
    expect(line?.key).toBe("alb.aws_lb.this.load_balancer_type");
  });

  it("lines up the plan's array-rendered nested block with the source's unindexed line", () => {
    const si = recipe().load({ ...baseSheetSpec, sources: { alb: "module" } }, io());
    const main = (si.artifacts ?? []).find((a) => a.source_file.endsWith("main.tf"));
    const line = lines(main).find((l) => l.text.includes('"/health"'));
    expect(line?.key).toBe("alb.aws_lb_target_group.keycloak.health_check[0].path");
  });

  it("the provider-default row's key appears on no line", () => {
    const si = recipe().load({ ...baseSheetSpec, sources: { alb: "module" } }, io());
    const allKeys = (si.artifacts ?? []).flatMap((a) => lines(a).map((l) => l.key));
    expect(allKeys).not.toContain("alb.aws_lb.this.idle_timeout");
  });

  it("variables.tf previews with no keys at all — it is context, not a row", () => {
    const si = recipe().load({ ...baseSheetSpec, sources: { alb: "module" } }, io());
    const vars = (si.artifacts ?? []).find((a) => a.source_file.endsWith("variables.tf"));
    expect(lines(vars).length).toBeGreaterThan(0);
    expect(lines(vars).every((l) => l.key === undefined)).toBe(true);
  });

  it("an unknown component in sources: throws", () => {
    expect(() => recipe().load({ ...baseSheetSpec, sources: { loadbalancer: "module" } }, io())).toThrow(/produced no rows/);
  });

  it("a missing directory throws", () => {
    expect(() => recipe().load({ ...baseSheetSpec, sources: { alb: "does-not-exist" } }, io())).toThrow(/directory not found/);
  });
});

// `sources:` now decides row ORIGIN too, not only preview placement
// (assemble.ts's SheetInputs.authoredKeys): a row the module's own .tf never
// assigns is exactly the same class of fact as a materialized one — nobody
// here chose the value, the provider did — so it demotes to
// `origin: "default"` while keeping whatever the plan actually observed for
// it. Extends this file (rather than a sibling) because it is still the
// terraform-plan recipe's `sources:` behavior end-to-end, just carried one
// step further — through assembleSheets — instead of stopping at the
// SheetInputs the recipe returns.
describe("terraform-plan recipe: sources: demotes provider-resolved rows to origin: default", () => {
  beforeEach(stubNonBuiltInProviders);

  const FIXTURE_DIR = join(import.meta.dir, "fixtures", "terraform-preview");

  function recipe() {
    const r = getRecipe("terraform-plan");
    if (!r) throw new Error("terraform-plan recipe is not registered");
    return r;
  }

  const io = (): RecipeIO => ({
    readFile: (p) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    },
    listDir: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return null;
      }
    },
    specDir: FIXTURE_DIR,
    resolve: (p) => join(FIXTURE_DIR, p),
    instances: ["staging"],
  });

  const baseSheetSpec = {
    name: "aws",
    recipe: "terraform-plan",
    snapshots: { staging: "plan.json" },
  };

  // Every row the fixture's plan.json produces, filed under one flat
  // category — enough to clear assembleSheets' hard "every row needs a
  // category" gate without pulling sheet.yml's other machinery into a test
  // about origin, not documentation.
  const PROJECT_YAML = `
params:
  "alb.aws_lb.this.name":
    category: AWS
  "alb.aws_lb.this.load_balancer_type":
    category: AWS
  "alb.aws_lb.this.idle_timeout":
    category: AWS
  "alb.aws_lb_target_group.keycloak.name":
    category: AWS
  "alb.aws_lb_target_group.keycloak.port":
    category: AWS
  "alb.aws_lb_target_group.keycloak.health_check[0].path":
    category: AWS
`;

  function assembleOpts(): AssembleOpts {
    return {
      projectPath: "project.yml",
      readFile: (p) => (p === "project.yml" ? PROJECT_YAML : null),
      strictMetadata: false,
    };
  }

  function paramsByKey(sourcesSpec: Record<string, string>): Map<string, InstanceParameter> {
    const si = recipe().load({ ...baseSheetSpec, sources: sourcesSpec }, io());
    const result = assembleSheets([si], assembleOpts());
    const params = result.sheets[0].categories[0].params! as InstanceParameter[];
    return new Map(params.map((p) => [p.key, p]));
  }

  it("the authored attribute's row stays overlay", () => {
    const params = paramsByKey({ alb: "module" });
    const loadBalancerType = params.get("alb.aws_lb.this.load_balancer_type")!;
    expect(loadBalancerType.origin).toBe("overlay");
    expect(loadBalancerType.instances).toHaveLength(1);
    expect(loadBalancerType.instances[0].value).toBe("application");
    expect(loadBalancerType.instances[0].source?.generated).toBe(true);
  });

  it("the provider-only row becomes origin: default, keeping its instances and its generated source", () => {
    const params = paramsByKey({ alb: "module" });
    const idleTimeout = params.get("alb.aws_lb.this.idle_timeout")!;
    expect(idleTimeout.origin).toBe("default");
    expect(idleTimeout.instances).toHaveLength(1);
    expect(idleTimeout.instances[0].value).toBe("60");
    expect(idleTimeout.instances[0].source?.generated).toBe(true);
  });

  it("a component with no sources: entry keeps every row overlay — absence is not evidence of no authorship", () => {
    // `sources: {}` — the sheet declares the block but never names "alb", the
    // one component this plan produced. Same as omitting a source for it.
    const params = paramsByKey({});
    for (const [, param] of params) expect(param.origin).toBe("overlay");
  });

  it("reports authored/demoted counts for a judged component, and warns for an unjudged one", () => {
    const warnings: string[] = [];
    const spy = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    try {
      paramsByKey({ alb: "module" });
    } finally {
      console.warn = spy;
    }
    const report = warnings.find((w) => w.includes("sources.alb:") && w.includes("authored"));
    expect(report).toBeDefined();
    expect(report).toContain("5 row(s) authored");
    expect(report).toContain("1 demoted");

    const warnings2: string[] = [];
    console.warn = (m: string) => warnings2.push(String(m));
    try {
      paramsByKey({});
    } finally {
      console.warn = spy;
    }
    const unverified = warnings2.find((w) => w.includes('component "alb" has no sources: entry'));
    expect(unverified).toBeDefined();
  });
});
