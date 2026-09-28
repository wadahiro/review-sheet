// THE PLAN THAT PROPOSED THE STACK DEFINES THE ROWS; a plan rendered against
// the state of the applied stack supplies their VALUES.
//
// After an apply, `terraform plan` reports `No changes.` — Terraform's own
// attestation that what is deployed is what was proposed, which is worth
// carrying. Read as a sheet it is a bigger document: a create plan leaves every
// provider-computed attribute out of `change.after` (`after_unknown`: nothing
// has assigned them yet), while a state plan knows all of them, so `after` also
// holds every ARN, id and DNS name the provider issued — several times as many
// keys as the sheet had.
//
// Those extra keys cannot be told from the arguments whose value the PROVIDER
// defaulted, which are real rows: inside the state plan `after_unknown` is
// empty. So the create plan is named rather than a rule inferred from the file
// in hand.

import { describe, it, expect } from "bun:test";
import "../src/recipes/index.js";
import { getRecipe } from "../src/recipe";
import type { RecipeIO } from "../src/recipe";
import type { SheetInputs } from "../src/assemble";

const CREATE = JSON.stringify({
  format_version: "1.2",
  resource_changes: [
    {
      address: "module.alb.aws_lb.this",
      type: "aws_lb",
      name: "this",
      change: {
        actions: ["create"],
        after: { name: "app", internal: false, enable_http2: true },
        // Not yet assigned, so not in `after` — and `subnets` is ONE entry
        // here, whatever length the provider ends up giving it.
        after_unknown: { arn: true, dns_name: true, subnets: true },
      },
    },
  ],
});

const STATE = JSON.stringify({
  format_version: "1.2",
  resource_changes: [
    {
      address: "module.alb.aws_lb.this",
      type: "aws_lb",
      name: "this",
      change: {
        actions: ["no-op"],
        after: {
          name: "app",
          internal: false,
          // …and the value the apply actually produced, which is the point.
          enable_http2: false,
          arn: "arn:aws:elasticloadbalancing:x",
          dns_name: "app-123.elb.amazonaws.com",
          subnets: ["subnet-a", "subnet-b"],
        },
        after_unknown: {},
      },
    },
  ],
});

const io = (): RecipeIO =>
  ({
    readFile: (p: string) => ({ "create.json": CREATE, "state.json": STATE })[p] ?? null,
    specDir: "/spec",
    resolve: (p: string) => p,
    instances: ["staging"],
  }) as never;

const load = (rowsFrom?: string): SheetInputs =>
  getRecipe("terraform-plan")!.load(
    {
      name: "aws",
      recipe: "terraform-plan",
      snapshots: { staging: "state.json" },
      ...(rowsFrom === undefined ? {} : { rows_from: { staging: rowsFrom } }),
    } as never,
    io()
  ) as SheetInputs;

const keysOf = (si: SheetInputs): string[] => {
  const out: string[] = [];
  for (const l of si.layers) for (const k of l.entries.keys()) if (!out.includes(k)) out.push(k);
  return out.sort();
};

describe("a sheet whose rows come from the proposing plan", () => {
  it("keeps the rows that plan proposed", () => {
    expect(keysOf(load("create.json"))).toEqual([
      "alb.aws_lb.this.enable_http2",
      "alb.aws_lb.this.internal",
      "alb.aws_lb.this.name",
    ]);
  });

  // The whole point: the same rows, holding what the apply produced.
  it("takes their values from the plan against state", () => {
    const layer = load("create.json").layers.find((l) => l.kind === "overlay")!;
    expect(layer.entries.get("alb.aws_lb.this.enable_http2")?.value).toBe("false");
  });

  it("leaves out what the provider assigned at apply time", () => {
    const keys = keysOf(load("create.json"));
    expect(keys).not.toContain("alb.aws_lb.this.arn");
    expect(keys).not.toContain("alb.aws_lb.this.dns_name");
  });

  // The case `after_unknown` alone cannot answer: a list the provider sizes at
  // apply time is ONE unexpanded entry in the create plan and N expanded
  // children in the state plan. A child whose parent is not a row is not a row.
  it("leaves out a list the provider sized at apply time, element by element", () => {
    const keys = keysOf(load("create.json"));
    expect(keys.filter((k) => k.startsWith("alb.aws_lb.this.subnets"))).toEqual([]);
  });

  it("says how many it left out, and why", () => {
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => said.push(String(m));
    try {
      load("create.json");
    } finally {
      console.warn = warn;
    }
    const all = said.join("\n");
    expect(all).toContain("4 key(s)");
    expect(all).toContain("the plan that proposed them");
    expect(all).toContain("what the provider assigned at apply time");
    expect(all).toContain("alb.aws_lb.this.arn");
  });

  // Undeclared, nothing changes: a sheet read from the plan that proposed it is
  // every sheet this recipe was written for.
  it("changes nothing when it is not declared", () => {
    expect(keysOf(load())).toEqual([
      "alb.aws_lb.this.arn",
      "alb.aws_lb.this.dns_name",
      "alb.aws_lb.this.enable_http2",
      "alb.aws_lb.this.internal",
      "alb.aws_lb.this.name",
      "alb.aws_lb.this.subnets[0]",
      "alb.aws_lb.this.subnets[1]",
    ]);
  });

  it("says nothing when it is not declared", () => {
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => said.push(String(m));
    try {
      load();
    } finally {
      console.warn = warn;
    }
    expect(said.join("\n")).not.toContain("key(s) are in the snapshot");
  });
});

// TWO ENVIRONMENTS ARE TWO STACKS, which is why this is keyed by environment
// and not one path for the sheet. A `count` that differs between them, or a
// module only one of them has, makes their proposing plans two different
// documents — and one path for both would scope the second environment's rows
// by the first one's stack.
describe("a sheet whose environments propose different stacks", () => {
  const plan = (actions: string[], after: Record<string, unknown>, unknown: Record<string, unknown> = {}) =>
    JSON.stringify({
      format_version: "1.2",
      resource_changes: [
        { address: "module.alb.aws_lb.this", type: "aws_lb", name: "this", change: { actions, after, after_unknown: unknown } },
      ],
    });

  // production runs a second listener staging does not have.
  const FILES: Record<string, string> = {
    "create.staging.json": plan(["create"], { name: "app" }, { arn: true }),
    "create.production.json": plan(["create"], { name: "app", idle_timeout: 60 }, { arn: true }),
    "state.staging.json": plan(["no-op"], { name: "app", arn: "arn:x" }),
    "state.production.json": plan(["no-op"], { name: "app", idle_timeout: 60, arn: "arn:y" }),
  };

  const two = (rowsFrom: Record<string, string>): SheetInputs =>
    getRecipe("terraform-plan")!.load(
      {
        name: "aws",
        recipe: "terraform-plan",
        snapshots: { staging: "state.staging.json", production: "state.production.json" },
        rows_from: rowsFrom,
      } as never,
      {
        readFile: (p: string) => FILES[p] ?? null,
        specDir: "/spec",
        resolve: (p: string) => p,
        instances: ["staging", "production"],
      } as never
    ) as SheetInputs;

  const keysIn = (si: SheetInputs, instance: string): string[] => {
    const layer = si.layers.find((l) => l.kind === "overlay" && l.instance === instance);
    return layer === undefined ? [] : [...layer.entries.keys()].sort();
  };

  // Each environment's rows come from its OWN proposing plan: production keeps
  // the argument it alone sets, and staging does not acquire it.
  it("scopes each environment by its own plan", () => {
    const si = two({ staging: "create.staging.json", production: "create.production.json" });
    expect(keysIn(si, "staging")).toEqual(["alb.aws_lb.this.name"]);
    expect(keysIn(si, "production")).toEqual(["alb.aws_lb.this.idle_timeout", "alb.aws_lb.this.name"]);
  });

  // A snapshot nobody scoped would keep every key it holds — the state plan's
  // extra rows arriving unannounced in one environment only, which is the
  // confusion the field exists to remove.
  it("refuses to scope only some of the environments", () => {
    expect(() => two({ staging: "create.staging.json" })).toThrow(/also has a snapshot for production/);
  });

  // …and an environment this sheet does not have scopes nothing.
  it("refuses an environment the sheet does not have", () => {
    expect(() =>
      two({ staging: "create.staging.json", production: "create.production.json", qa: "create.staging.json" })
    ).toThrow(/rows_from names qa/);
  });
});
