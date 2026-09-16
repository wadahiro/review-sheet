// EACH COMPONENT'S DEFAULTS ARE ITS OWN.
//
// A sheet that compares two releases takes each side's variables from that
// side's `defaults:` file. Merged into one key space they collide: both files
// define `app_host`, the last one read wins, and the first release's rows fall
// back to the SECOND release's value — with a source map pointing into the
// second release's file, which is where `apply` would write.
//
// It hides until two things coincide: the same variable in both components'
// defaults, and an environment with no overlay to override it. Give every
// environment an overlay, or let the two files share no variable, and the sheet
// is correct by accident.

import { describe, it, expect } from "bun:test";
import "../src/recipes/index.js";
import { getRecipe } from "../src/recipe";
import type { RecipeIO } from "../src/recipe";
import type { SheetInputs } from "../src/assemble";

const FILES: Record<string, string> = {
  "old-defaults.yml": "app_host: old-default.example.com\n",
  "new-defaults.yml": "app_host: new-default.example.com\n",
  "envA.yml": "app_host: a.example.com\n",
  "envC.yml": "app_host: c.example.com\n",
  "old.j2": "host={{ app_host }}\n",
  "new.j2": "host={{ app_host }}\n",
};

const io: RecipeIO = {
  readFile: (p: string) => FILES[p.split("/").pop() ?? p] ?? null,
  specDir: "/spec",
  resolve: (p: string) => p,
  // envA and envB belong to the old release, envC to the new one — the two
  // sides share no environment name, which is the case this whole shape is for.
  instances: ["envA", "envB", "envC"],
} as never;

const spec = (defaults: unknown) => ({
  name: "upgrade",
  recipe: "ansible",
  rows: "artifact",
  component_order: ["old", "new"],
  defaults,
  overlays: { envA: "envA.yml", envC: "envC.yml" },
  templates: [
    { path: "old.j2", component: "old", instances: ["envA", "envB"], deployed_path: "/etc/app.conf", format: "properties" },
    { path: "new.j2", component: "new", instances: ["envC"], deployed_path: "/etc/app.conf", format: "properties" },
  ],
});

const TAGGED = [
  { path: "old-defaults.yml", component: "old" },
  { path: "new-defaults.yml", component: "new" },
];
const UNTAGGED = [{ path: "old-defaults.yml" }, { path: "new-defaults.yml" }];

const rowIn = (defaults: unknown, component: string, instance: string) => {
  const out = getRecipe("ansible")!.load(spec(defaults) as never, io) as SheetInputs;
  const row = out.embedded.find((e) => e.component === component && e.key === "host");
  return (row?.instances ?? []).find((i) => i.name === instance);
};

describe("a component with no overlay for one of its environments", () => {
  // envB is the old release's environment and sets nothing of its own, so its
  // value comes from the defaults — the OLD ones.
  it("falls back to its own component's defaults", () => {
    expect(rowIn(TAGGED, "old", "envB")?.value).toBe("old-default.example.com");
  });

  // The half that makes it more than a display bug. `apply` and `verify` follow
  // this path, so an unnoticed collision sends a write at the other release's
  // repository file.
  it("points its source map at its own component's file", () => {
    expect(rowIn(TAGGED, "old", "envB")?.source?.file).toBe("old-defaults.yml");
  });

  // Untagged is the shape this was reported from, and it is still wrong — there
  // is nothing in the spec that says which file belongs to which side. It is
  // kept here as the record of what the tag buys, and is reported (below)
  // rather than silently decided.
  it("reads the wrong component's file when the defaults are untagged", () => {
    expect(rowIn(UNTAGGED, "old", "envB")?.value).toBe("new-default.example.com");
  });
});

describe("the environments that do set their own value", () => {
  // The overlay still wins over its component's defaults — the tag changes only
  // what "the defaults" means, never the precedence above them.
  it("keep the overlay, on either side", () => {
    expect(rowIn(TAGGED, "old", "envA")?.value).toBe("a.example.com");
    expect(rowIn(TAGGED, "old", "envA")?.source?.file).toBe("envA.yml");
    expect(rowIn(TAGGED, "new", "envC")?.value).toBe("c.example.com");
  });
});

describe("what the spec refuses to do quietly", () => {
  // A component name no template produces tags the file out of every view:
  // the row it was meant to answer for goes back to reading whichever file
  // happened to be last, which is the bug this field exists to fix.
  it("refuses a defaults file tagged with a component that is not there", () => {
    const bad = [{ path: "old-defaults.yml", component: "olde" }, { path: "new-defaults.yml", component: "new" }];
    expect(() => getRecipe("ansible")!.load(spec(bad) as never, io)).toThrow(/defaults declare component\(s\) olde/);
  });

  // Two untagged files sharing a variable on a comparison sheet cannot be told
  // apart from one component's layers (a role's defaults/ then its vars/, where
  // last-wins is Ansible's own precedence) — so it is reported, not refused.
  it("reports two untagged defaults files that define the same variable", () => {
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => said.push(String(m));
    try {
      getRecipe("ansible")!.load(spec(UNTAGGED) as never, io);
    } finally {
      console.warn = warn;
    }
    expect(said.join("\n")).toContain("app_host (old-defaults.yml, new-defaults.yml)");
  });

  // …and says nothing when there is nothing to say: one component's own layers,
  // both tagged, are a deliberate override.
  it("says nothing when the sharing files belong to the same component", () => {
    const said: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => said.push(String(m));
    try {
      getRecipe("ansible")!.load(spec(TAGGED) as never, io);
    } finally {
      console.warn = warn;
    }
    expect(said.join("\n")).not.toContain("more than one untagged defaults file");
  });
});
