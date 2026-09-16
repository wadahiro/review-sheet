// A SHEET THAT COMPARES ITS COMPONENTS names them by what they ARE.
//
// The ansible recipe labels a component by the file it deploys, so an ordinary
// artifact sheet reads `/etc/logrotate.d/httpd` rather than `logrotate-httpd` —
// the thing being reviewed rather than the id it is filed under. That is right
// there and wrong on a sheet whose components are two RELEASES put side by
// side: the release is the whole of what such a sheet is about.
//
// And it went wrong asymmetrically, which is how it survived. The rule fires
// only for a component that deploys exactly ONE file, so a sheet whose old side
// is a static file and whose new side is a template read `19.0.2` against
// `/opt/keycloak/conf/keycloak.conf` — one side saying which release it is and
// the other saying which file, in a table whose only job is to tell the two
// releases apart.

import { describe, it, expect } from "bun:test";
import "../src/recipes/index.js";
import { getRecipe } from "../src/recipe";
import type { RecipeIO } from "../src/recipe";

const FILES: Record<string, string> = {
  "defaults.yml": "port: 8080\n",
  "old.j2": "listen={{ port }}\n",
  "new.j2": "listen={{ port }}\n",
};

const io: RecipeIO = {
  readFile: (p: string) => FILES[p.split("/").pop() ?? p] ?? null,
  specDir: "/spec",
  resolve: (p: string) => p,
  instances: [],
} as never;

const spec = (over: Record<string, unknown> = {}) => ({
  name: "upgrade",
  recipe: "ansible",
  rows: "artifact",
  defaults: "defaults.yml",
  templates: [
    { path: "old.j2", component: "19.0.2", deployed_path: "/etc/old/app.conf", format: "properties" },
    { path: "new.j2", component: "26.7.3", deployed_path: "/etc/new/app.conf", format: "properties" },
  ],
  ...over,
});

const labelsOf = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const out = getRecipe("ansible")!.load(spec(over) as never, io);
  return Object.fromEntries((out as { componentLabels?: Map<string, unknown> }).componentLabels ?? new Map());
};

describe("what a component is called", () => {
  // The ordinary sheet: the component is which FILE, and the file is what a
  // reader is reviewing.
  it("is the file it deploys, on a sheet that does not compare them", () => {
    expect(labelsOf()).toEqual({ "19.0.2": "/etc/old/app.conf", "26.7.3": "/etc/new/app.conf" });
  });

  // The comparison sheet: the component is which RELEASE, and naming it by a
  // path throws away the subject.
  it("is its own name on a sheet that compares them", () => {
    expect(labelsOf({ component_order: ["19.0.2", "26.7.3"] })).toEqual({});
  });

  // …and both sides, not one. The asymmetry is what made it survive.
  it("leaves neither side wearing a path", () => {
    const labels = labelsOf({ component_order: ["19.0.2", "26.7.3"] });
    expect(Object.values(labels)).not.toContain("/etc/old/app.conf");
    expect(Object.values(labels)).not.toContain("/etc/new/app.conf");
  });
});
