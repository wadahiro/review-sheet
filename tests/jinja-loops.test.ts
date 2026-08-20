// A loop is the one Jinja shape that turns ONE template line into several lines
// of the deployed file. Read here so the recipe can expand it; the stance is the
// conditions' — support the plain shape and REPORT the rest, because a guess
// puts lines on the sheet that the deployed file does not have.

import { describe, it, expect } from "bun:test";
import { jinjaLoops } from "../src/jinja2";
import { getRecipe, type RecipeIO } from "../src/recipe";
import "../src/recipes/index.js";

const at = (content: string, line: number) => jinjaLoops(content).get(line);

describe("jinjaLoops", () => {
  it("reads the plain shape, and says what each line repeats over", () => {
    const t = "{% for s in ntp_servers %}\nserver {{ s }} iburst\n{% endfor %}\n";
    expect(at(t, 2)).toEqual({ supported: true, variable: "s", list: "ntp_servers" });
  });

  it("says nothing about lines outside any loop", () => {
    const t = "driftfile /var/lib/chrony/drift\n{% for s in ntp %}\nserver {{ s }}\n{% endfor %}\nrtcsync\n";
    expect(at(t, 1)).toBeUndefined();
    expect(at(t, 5)).toBeUndefined();
    expect(at(t, 3)).toMatchObject({ supported: true });
  });

  // Each of these would need an evaluator this one is not: a filter changes the
  // sequence, tuple unpacking binds two names, and a nested loop repeats a line
  // over two axes at once while a row is addressed by one index.
  it("refuses a filter, tuple unpacking and a nested loop", () => {
    expect(at("{% for s in ntp | sort %}\nx {{ s }}\n{% endfor %}\n", 2)).toMatchObject({ supported: false });
    expect(at("{% for k, v in items %}\nx {{ k }}\n{% endfor %}\n", 2)).toMatchObject({ supported: false });
    expect(at("{% for a in xs %}\n{% for b in ys %}\nx {{ b }}\n{% endfor %}\n{% endfor %}\n", 3)).toMatchObject({ supported: false });
  });

  // The arm's own membership is a negation this deliberately does not compute —
  // the same rule the conditions follow for `{% else %}`.
  it("refuses a loop with an else arm", () => {
    expect(at("{% for s in ntp %}\nx {{ s }}\n{% else %}\ny\n{% endfor %}\n", 2)).toMatchObject({ supported: false });
  });
});

// The expansion end to end. A loop renders ONE template line as several lines
// of the deployed file, and each of them belongs to one element of a vars file
// — which is where a reviewer changes it, so that is where the row points.
describe("ansible recipe: a template line inside a {% for %}", () => {
  const FILES: Record<string, string> = {
    "/vars.yml": "ntp:\n  - a.example.invalid\n  - b.example.invalid\n",
    "/chrony.conf.j2": "{% for s in ntp %}\nserver {{ s }} iburst\n{% endfor %}\ndriftfile /var/lib/chrony/drift\n",
  };
  const io: RecipeIO = { readFile: (p) => FILES[p] ?? null, specDir: "/", resolve: (p) => p, instances: [] };
  const load = () =>
    getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: [{ path: "/vars.yml", key: { from: "path" } }],
        templates: [{ path: "/chrony.conf.j2", component: "chrony", deployed_path: "/etc/chrony.conf", format: "space" }],
      } as never,
      io
    );
  type Emb = { key: string; value: string; source: { file?: string; line?: number; path?: string; substituted?: boolean } };
  const embedded = () => (load().embedded ?? []) as Emb[];

  it("renders one row per member, named by the directive the line writes", () => {
    expect(embedded().map((e) => e.key)).toEqual(["server", "server[1]", "driftfile"]);
  });

  it("gives each row the line it renders to, not the variable behind it", () => {
    expect(embedded()[0].value).toBe("a.example.invalid iburst");
    expect(embedded()[1].value).toBe("b.example.invalid iburst");
  });

  // The point of expanding at all. The template holds the structure; the value
  // a reviewer would change is the element, in another file.
  it("points each row at its own element of the vars file", () => {
    const [first, second] = embedded();
    expect(first.source).toMatchObject({ file: "/vars.yml", path: "ntp[0]", substituted: true });
    expect(second.source).toMatchObject({ file: "/vars.yml", path: "ntp[1]", substituted: true });
  });

  // Left in the base map as well, each element would be a second row for one
  // setting: one under the file it renders into, one under the variable.
  it("does not also leave the elements as variable rows", () => {
    const base = [...(load().layers[0] as { entries: Map<string, unknown> }).entries.keys()];
    expect(base.filter((k) => k.startsWith("ntp["))).toEqual([]);
  });
});
