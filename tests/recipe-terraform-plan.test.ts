// `terraform-plan` — `snapshot` with the plan's own shape written down, so a
// project reviewing a plan does not re-derive Terraform's address grammar in
// three hand-written patterns.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { getRecipe } from "../src/recipe";
import "../src/recipes/index.js";
import type { RecipeIO } from "../src/recipe";

beforeEach(stubNonBuiltInProviders);

function recipe() {
  const r = getRecipe("terraform-plan");
  if (!r) throw new Error("terraform-plan recipe is not registered");
  return r;
}

const plan = JSON.stringify({
  format_version: "1.2",
  errored: false,
  relevant_attributes: [{ resource: "aws_lb.this", attribute: ["arn"] }],
  resource_changes: [
    { address: "module.alb.aws_lb.this", change: { after: { idle_timeout: 60, name: "sso" } } },
    { address: "module.ec2.aws_instance.node[0]", change: { after: { ami: "ami-1", instance_type: "t3.small" } } },
    { address: "aws_s3_bucket.logs", change: { after: { bucket: "logs" } } },
  ],
});

const io = (component?: Record<string, unknown>): RecipeIO => ({
  readFile: () => plan,
  specDir: "/r",
  resolve: () => "/r/plan.json",
  instances: ["staging"],
  ...(component ? { component } : {}),
});

describe("terraform-plan recipe", () => {
  it("keys a row by module, resource type, name and argument", () => {
    const si = recipe().load({ name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" } }, io());
    const keys = [...(si.layers.find((l) => l.kind === "overlay")!.entries.keys())].sort();
    expect(keys).toContain("alb.aws_lb.this.idle_timeout");
    expect(keys).toContain("ec2.aws_instance.node[0].ami");
  });

  // Everything a plan holds that is not a resource argument goes, by failing to
  // match one pattern — not by a list of section names to keep up with.
  it("drops the plan's own bookkeeping", () => {
    const si = recipe().load({ name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" } }, io());
    const keys = [...(si.layers.find((l) => l.kind === "overlay")!.entries.keys())];
    expect(keys.some((k) => k.includes("relevant_attributes") || k === "errored" || k.includes("format_version"))).toBe(false);
  });

  // Terraform's own name for it, and it keeps every key the same shape.
  it("files a resource outside any module under `root`", () => {
    const si = recipe().load({ name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" } }, io());
    const keys = [...(si.layers.find((l) => l.kind === "overlay")!.entries.keys())];
    expect(keys).toContain("root.aws_s3_bucket.logs.bucket");
  });

  it("makes each module a component, and leaves a root resource in none", () => {
    const si = recipe().load({ name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" } }, io());
    expect(si.componentOf?.get("alb.aws_lb.this.idle_timeout")).toBe("alb");
    expect(si.componentOf?.get("ec2.aws_instance.node[0].ami")).toBe("ec2");
    expect(si.componentOf?.get("root.aws_s3_bucket.logs.bucket")).toBeUndefined();
  });

  // The provider documents an argument of a resource TYPE, not of one instance
  // in one module, so the recipe says how the two relate.
  it("supplies the dictionary key derivation", () => {
    const si = recipe().load({ name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" } }, io());
    expect(si.dictKeySteps).toBeDefined();
    const { makeKeyTransformer } = require("../src/keytransform");
    const t = makeKeyTransformer({ steps: si.dictKeySteps });
    expect(t.apply("alb.aws_lb.this.idle_timeout")).toBe("aws_lb.idle_timeout");
    expect(t.apply("ec2.aws_instance.node[0].ami")).toBe("aws_instance.ami");
  });

  it("composes the project's own key steps after the plan's", () => {
    const si = recipe().load(
      {
        name: "aws",
        recipe: "terraform-plan",
        snapshots: { staging: "plan.json" },
        key: { steps: [{ pattern: "^alb\\.", replace: "loadbalancer." }] },
      },
      io()
    );
    const keys = [...(si.layers.find((l) => l.kind === "overlay")!.entries.keys())];
    expect(keys).toContain("loadbalancer.aws_lb.this.idle_timeout");
  });

  it("refuses to key from the leaf name", () => {
    expect(() =>
      recipe().load(
        { name: "aws", recipe: "terraform-plan", snapshots: { staging: "plan.json" }, key: { from: "key", steps: [] } },
        io()
      )
    ).toThrow(/must be "path"/);
  });
});
