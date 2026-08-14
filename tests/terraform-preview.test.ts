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
import type { ArtifactLine } from "../src/types";
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
