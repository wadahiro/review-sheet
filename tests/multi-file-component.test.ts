// A component that deploys MORE THAN ONE file.
//
// The shape is ordinary on a migration sheet: one component per release, each
// bringing the release's config file and its properties file. It broke in two
// halves that looked unrelated, and were the same mistake — a record keyed by
// COMPONENT, holding one file, written by whichever template was read last:
//
//   - the winner's rows lost their heading, because the fold that asks "does
//     this component already name this file" was asking that record;
//   - every other file's rows failed the "is this part of the artifact" test
//     (their source file was not the one the record remembered) and were filed
//     under a heading made of their own SOURCE path — `.../templates/a.conf`
//     beside rows that had no heading at all.
//
// The fix is not a better guess. Each row now carries the deployed path of the
// template it came from, which the recipe knew all along, and the per-component
// record is written only where a component HAS one file to name.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { getRecipe } from "../src/recipe";
import { assembleSheets } from "../src/assemble";
import "../src/recipes/index.js";
import "../src/parsers/index.js";

beforeEach(stubNonBuiltInProviders);

const FILES: Record<string, string> = {
  "/vars.yml": "port_a: 8080\nname_b: alpha\n",
  "/project.yml": "under_key: { id: ansible_var, label: { ja: 変数, en: variable } }\nparams: {}\n",
  "/v1/a.conf.j2": "listen {{ port_a }}\nmode strict\n",
  "/v1/b.properties.j2": "name={{ name_b }}\nlevel=INFO\n",
  "/v2/a.conf.j2": "listen {{ port_a }}\nmode lax\n",
  "/v2/b.properties.j2": "name={{ name_b }}\nlevel=DEBUG\n",
};

const io = {
  readFile: (p: string) => FILES[p] ?? null,
  specDir: "/",
  resolve: (p: string) => p,
  instances: [],
};

const template = (component: string, file: string, deployed: string, format?: string) => ({
  path: `/${component}/${file}`,
  component,
  deployed_path: deployed,
  ...(format ? { format } : {}),
});

function build(templates: unknown[], extra: Record<string, unknown> = {}) {
  const si = getRecipe("ansible")!.load(
    {
      name: "mig",
      recipe: "ansible",
      rows: "artifact",
      defaults: "/vars.yml",
      component_order: ["v1", "v2"],
      templates,
      ...extra,
    } as never,
    io as never
  );
  return assembleSheets([si as never], { projectPath: "/project.yml", readFile: io.readFile, strictMetadata: false });
}

type Cat = { name: string; params?: { key: string }[]; categories?: Cat[] };
const shape = (cats: Cat[]): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  const walk = (list: Cat[], path: string[]): void => {
    for (const c of list) {
      const here = [...path, c.name];
      if ((c.params ?? []).length > 0) out[here.join(" > ")] = (c.params ?? []).map((p) => p.key);
      walk(c.categories ?? [], here);
    }
  };
  walk(cats, []);
  return out;
};

describe("a component that deploys several files", () => {
  it("heads each file, under the component, by the path it lands on", () => {
    const out = build([
      template("v1", "a.conf.j2", "/etc/a.conf", "space"),
      template("v1", "b.properties.j2", "/etc/b.properties"),
      template("v2", "a.conf.j2", "/etc/a.conf", "space"),
      template("v2", "b.properties.j2", "/etc/b.properties"),
    ]);
    expect(shape(out.sheets[0].categories as never)).toEqual({
      "v1 > /etc/a.conf": ["listen", "mode"],
      "v1 > /etc/b.properties": ["name", "level"],
      "v2 > /etc/a.conf": ["listen", "mode"],
      "v2 > /etc/b.properties": ["name", "level"],
    });
  });

  // The half that produced the strange heading: a row whose template is not the
  // one the component's record remembered.
  it("never heads a row by the SOURCE path it was rendered from", () => {
    const out = build([
      template("v1", "a.conf.j2", "/etc/a.conf", "space"),
      template("v1", "b.properties.j2", "/etc/b.properties"),
    ]);
    for (const name of Object.keys(shape(out.sheets[0].categories as never))) {
      expect(name).not.toContain(".j2");
      expect(name).not.toContain("/v1/a.conf");
    }
  });

  // Unchanged where a component IS one file: its rows stay directly under it
  // rather than gaining a level that repeats what the component already says.
  it("still folds the level away for a component that deploys one file", () => {
    const out = build(
      [template("v1", "a.conf.j2", "/etc/a.conf", "space"), template("v2", "a.conf.j2", "/etc/a.conf", "space")],
      // No b.properties in this one, so its variable belongs to another sheet —
      // said, rather than left to arrive as a row of its own.
      { exclude: ["name_b"] }
    );
    expect(shape(out.sheets[0].categories as never)).toEqual({
      v1: ["listen", "mode"],
      v2: ["listen", "mode"],
    });
  });
});
