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
import { makeKeyTransformer } from "../src/keytransform";
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

// A repeated block is addressed differently in the two documents that have to
// line up: the .tf parser indexes repeats, while the plan's list elements carry
// an identifying field and the extractor addresses them by it — `name`, `id`
// and `key` are identity fields whether or not a spec declares any. Stripping
// only the index left every such row unmatched, so a value the module plainly
// writes was published as one nobody sets, which the sheet hides by default.
describe("terraform-plan recipe: a repeated block addressed by name", () => {
  beforeEach(stubNonBuiltInProviders);

  const TF = `resource "aws_db_parameter_group" "this" {
  name = "pg"
  parameter {
    name  = "max_connections"
    value = "200"
  }
  parameter {
    name  = "work_mem"
    value = "4096"
  }
}
`;
  const PLAN = JSON.stringify({
    resource_changes: [
      {
        address: "module.db.aws_db_parameter_group.this",
        change: {
          after: {
            name: "pg",
            parameter: [
              { name: "max_connections", value: "200" },
              { name: "work_mem", value: "4096" },
            ],
          },
        },
      },
    ],
  });

  const files: Record<string, string> = { "/f/plan.json": PLAN, "/f/module/main.tf": TF };
  const memIo = (): RecipeIO => ({
    readFile: (p) => files[p] ?? null,
    listDir: (p) => (p === "/f/module" ? ["main.tf"] : null),
    specDir: "/f",
    resolve: (p) => `/f/${p}`,
    instances: ["staging"],
  });

  const load = () => {
    const r = getRecipe("terraform-plan");
    if (!r) throw new Error("terraform-plan recipe is not registered");
    return r.load(
      { name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" }, sources: { db: "module" } },
      memIo()
    );
  };

  it("counts the module's own values as authored, not as provider defaults", () => {
    const authored = load().authoredKeys ?? new Set<string>();
    expect([...authored].filter((k) => k.includes(".parameter[")).sort()).toEqual([
      "db.aws_db_parameter_group.this.parameter[name=max_connections].value",
      "db.aws_db_parameter_group.this.parameter[name=work_mem].value",
    ]);
  });

  it("leaves the rows set, rather than demoting them to origin: default", () => {
    // The visible symptom: an unset row is hidden until "show defaults" is on,
    // so a value the module writes disappears from the sheet.
    const project =
      "params:\n" +
      "  db.aws_db_parameter_group.this.name: { category: DB }\n" +
      "  'db.aws_db_parameter_group.this.parameter[name=max_connections].value': { category: DB }\n" +
      "  'db.aws_db_parameter_group.this.parameter[name=work_mem].value': { category: DB }\n";
    const input = assembleSheets([load()], {
      projectPath: "p.yml",
      readFile: (p: string) => (p === "p.yml" ? project : null),
      strictMetadata: false,
    } as AssembleOpts);
    const rows: { key: string; origin?: string }[] = [];
    const walk = (cats: { params?: { key: string; origin?: string }[]; categories?: unknown }[]): void => {
      for (const c of cats) {
        for (const p of c.params ?? []) rows.push(p);
        walk((c.categories ?? []) as never[]);
      }
    };
    walk(input.sheets[0].categories as never[]);
    const params = rows.filter((r) => r.key.includes(".parameter["));
    expect(params.length).toBe(2);
    expect(params.every((r) => r.origin !== "default")).toBe(true);
  });
});

// The dictionary side of the same mismatch. A provider documents a nested
// block's argument once (`aws_lb.access_logs.enabled`); a plan addresses each
// repetition, by index or by the identifying field its elements carry. Both
// are addressing and the dictionary has neither, so both have to go — stripping
// only the index left a repeated block whose elements have a `name` bound to
// nothing, and it arrived with no description at all.
describe("terraform-plan recipe: dictKeySteps and a repeated block", () => {
  const steps = () => {
    const r = getRecipe("terraform-plan");
    if (!r) throw new Error("terraform-plan recipe is not registered");
    const files: Record<string, string> = {
      "/f/plan.json": JSON.stringify({
        resource_changes: [
          { address: "module.db.aws_db_parameter_group.this", change: { after: { name: "pg" } } },
        ],
      }),
    };
    return r.load(
      { name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" } },
      {
        readFile: (p) => files[p] ?? null,
        specDir: "/f",
        resolve: (p) => `/f/${p}`,
        instances: ["staging"],
      }
    ).dictKeySteps!;
  };

  const apply = (key: string): string | undefined =>
    makeKeyTransformer({ from: "key", steps: steps() }).apply(key);

  it("reduces an indexed block to the argument the provider documents", () => {
    expect(apply("alb.aws_lb.this.access_logs[0].enabled")).toBe("aws_lb.access_logs.enabled");
  });

  it("reduces a name-addressed block to the same thing", () => {
    expect(apply("db.aws_db_parameter_group.this.parameter[name=max_connections].value")).toBe(
      "aws_db_parameter_group.parameter.value"
    );
  });

  it("leaves a quoted map key alone — that is content, not addressing", () => {
    expect(apply('alb.aws_lb.this.tags["Name"]')).toBe('aws_lb.tags["Name"]');
  });
});
