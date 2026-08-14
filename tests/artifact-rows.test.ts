// `rows: artifact` — a row is a LINE of the deployed file, not the variable
// behind it.
//
// The assertion here is the whole point of the axis, and it is deliberately
// made against a RENDERED artifact rather than against a hand-written list of
// expected keys: the sheet's claim is "this is what the file says", so the test
// says the same thing. `tests/fixtures/artifact-rows/rendered.conf` is what
// `app.conf.j2` produces with `defaults.yml`; if either drifts from the other,
// or the recipe stops reproducing it, this fails.
//
// The fixture carries every shape the axis exists for, because each of them was
// a real loss under the variable axis, measured on a real project:
//   - a line mixing a variable and literal text (`"{{ x }}" combined`), whose
//     trailing word simply vanished;
//   - one variable driving four directives (ProxyPass/ProxyPassReverse twice),
//     of which the sheet showed none — it showed the variable instead;
//   - a filter (`| lower`);
//   - a directive inside a container, which has to be addressed the way the
//     file addresses it (`IfModule.StartServers`) or two blocks with the same
//     directive collide.

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { getRecipe } from "../src/recipe";
import { resolveParser, getParser } from "../src/parser";
import "../src/recipes/index.js";
import "../src/parsers/index.js";
import { extractFile } from "../src/extract";
import type { RecipeIO } from "../src/recipe";

beforeEach(stubNonBuiltInProviders);

const DIR = resolve(import.meta.dir, "fixtures/artifact-rows");
const io: RecipeIO = {
  readFile: (p) => {
    try {
      return readFileSync(p, "utf-8");
    } catch {
      return null;
    }
  },
  specDir: DIR,
  resolve: (p) => resolve(DIR, p.split("/").pop()!),
  instances: [],
};

function rowsFromRecipe(): Map<string, string> {
  const r = getRecipe("ansible");
  if (!r) throw new Error("ansible recipe is not registered");
  const si = r.load(
    {
      name: "app",
      recipe: "ansible",
      rows: "artifact",
      defaults: "defaults.yml",
      template: "app.conf.j2",
      deployed_path: "/etc/app/app.conf",
    },
    io
  );
  const base = si.layers.find((l) => l.kind === "base")!;
  return new Map([...base.entries].map(([k, v]) => [k, v.value]));
}

function rowsFromRenderedFile(): Map<string, string> {
  const file = resolve(DIR, "rendered.conf");
  const out = new Map<string, string>();
  for (const e of extractFile(readFileSync(file, "utf-8"), file)) out.set(e.source.path ?? e.key, e.value);
  return out;
}

describe("rows: artifact reproduces the rendered artifact", () => {
  it("has exactly the file's directives, under the file's own names", () => {
    expect([...rowsFromRecipe().keys()].sort()).toEqual([...rowsFromRenderedFile().keys()].sort());
  });

  it("has exactly the file's values", () => {
    const sheet = rowsFromRecipe();
    const file = rowsFromRenderedFile();
    const differ = [...file].filter(([k, v]) => sheet.get(k) !== v).map(([k, v]) => `${k}: sheet=${sheet.get(k)} file=${v}`);
    expect(differ).toEqual([]);
  });

  // The three losses, named individually, so a failure says WHICH shape broke
  // rather than only that something did.
  it("keeps the literal text a template puts around a variable", () => {
    expect(rowsFromRecipe().get("CustomLog")).toBe('"/var/log/app/access_log" combined');
  });

  it("gives one row per directive when a variable drives several", () => {
    const rows = rowsFromRecipe();
    expect(rows.get("ProxyPass[1]")).toBe('"/" "http://127.0.0.1:8080/"');
    expect(rows.get("ProxyPassReverse[1]")).toBe('"/" "http://127.0.0.1:8080/"');
  });

  it("addresses a directive inside a container the way the file does", () => {
    expect(rowsFromRecipe().has("IfModule.StartServers")).toBe(true);
    expect(rowsFromRecipe().has("StartServers")).toBe(false);
  });

  it("applies a pure filter", () => {
    expect(rowsFromRecipe().get("LogLevel")).toBe("warn");
  });

  // The variable is still reachable — it moved to the under_key column, and it
  // is what apply and verify resolve against.
  it("keeps the variable behind each row", () => {
    const r = getRecipe("ansible")!;
    const si = r.load(
      { name: "app", recipe: "ansible", rows: "artifact", defaults: "defaults.yml", template: "app.conf.j2" },
      io
    );
    const byBound = new Map((si.keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect(byBound.get("CustomLog")).toBe("app_access_log");
    expect(byBound.get("ProxyPass[1]")).toBe("app_backend");
    const base = si.layers.find((l) => l.kind === "base")!;
    // …and the row says its value was composed, so verify checks containment
    // and apply holds instead of writing a whole line into a variable.
    expect(base.entries.get("CustomLog")!.source.substituted).toBe(true);
  });
});

// The same assertion for a file whose CONTAINER is templated, and whose format
// synthesises values rather than reading them off the line.
//
// A rotation policy is both at once: the block is addressed by the log path it
// rotates, which is `{{ app_log_dir }}/*.log` in the template and a real path in
// the deployed file; one of its directives IS a variable (`{{ app_rotate_frequency
// }}` renders to `daily`); and a bare flag has no argument at all, so its value
// is its presence. Each of those was a way the sheet could quietly stop matching
// the file — a row identified by an internal mask token, a heading naming a
// directory nobody has, a flag verified by searching the text for the word
// "true" — and each is asserted below against a committed rendered artifact.
const POLICY_DIR = resolve(import.meta.dir, "fixtures/artifact-rows-policy");
const policyIo: RecipeIO = { ...io, specDir: POLICY_DIR, resolve: (p) => resolve(POLICY_DIR, p.split("/").pop()!) };

function policySheet() {
  const r = getRecipe("ansible");
  if (!r) throw new Error("ansible recipe is not registered");
  return r.load(
    {
      name: "os",
      recipe: "ansible",
      rows: "artifact",
      defaults: "defaults.yml",
      // `templates:` (plural) so the rows carry a component, which is the shape
      // a sheet covering several deployed artifacts has.
      templates: [{ path: "logrotate-app.j2", component: "logrotate-app", deployed_path: "/etc/logrotate.d/app" }],
    },
    policyIo
  );
}

function policyRows(): Map<string, string> {
  return new Map(policySheet().embedded.map((e) => [e.key, e.value]));
}

function renderedPolicy(): Map<string, string> {
  const file = resolve(POLICY_DIR, "logrotate-app");
  const out = new Map<string, string>();
  for (const e of extractFile(readFileSync(file, "utf-8"), file)) out.set(e.source.path ?? e.key, e.value);
  return out;
}

describe("rows: artifact reproduces an artifact whose container is templated", () => {
  it("has exactly the file's directives, under the file's own names", () => {
    expect([...policyRows().keys()].sort()).toEqual([...renderedPolicy().keys()].sort());
  });

  it("has exactly the file's values", () => {
    const sheet = policyRows();
    const differ = [...renderedPolicy()]
      .filter(([k, v]) => sheet.get(k) !== v)
      .map(([k, v]) => `${k}: sheet=${sheet.get(k)} file=${v}`);
    expect(differ).toEqual([]);
  });

  it("renders the container into the row's heading, not just its key", () => {
    for (const e of policySheet().embedded) expect(e.categoryPath).toEqual(["/var/log/app/*.log"]);
  });

  it("names a directive that is itself a variable by what it renders to", () => {
    expect(policyRows().has("/var/log/app/*.log.daily")).toBe(true);
  });

  it("sources a row from the variable its VALUE came from, never its key", () => {
    const byKey = new Map(policySheet().embedded.map((e) => [e.key, e.source]));
    // `su` reads a variable, so it points at that variable's definition site.
    expect(byKey.get("/var/log/app/*.log.su")!.substituted).toBe(true);
    // `copytruncate` reads none — the only variable in its key is the block's,
    // and pointing there would claim the log directory IS this row's value.
    expect(byKey.get("/var/log/app/*.log.copytruncate")!.substituted).toBeUndefined();
  });

  it("verifies a synthesised value by asking the format, not by searching the text", () => {
    const parser = resolveParser("logrotate-app.j2", "");
    expect(parser?.name).toBe("jinja2");
    const template = readFileSync(resolve(POLICY_DIR, "logrotate-app.j2"), "utf-8");
    const source = policySheet().embedded.find((e) => e.key === "/var/log/app/*.log.copytruncate")!.source;
    expect(parser!.locate(template, source, "true")).toEqual({ value: "true" });
    // And the line+anchor fallback genuinely cannot: the flag's value is its
    // presence, so there is no `true` on the line to match. That is the whole
    // reason the delegation exists, so the test states both halves.
    expect(getParser("generic")!.locate(template, source, "true")).toHaveProperty("error");
  });
});

// A line whose PRESENCE depends on a `{% if %}`.
//
// The row exists for the instances that render it and not for the ones that do
// not, which is what Pattern B already expresses for a value. Before this the
// line was left out of every environment, including the one whose deployed file
// has it — so a unit's two `Environment=` lines were on no sheet at all while
// sitting in the file the reviewer was holding.
//
// Asserted against TWO committed rendered artifacts, one per environment,
// because the claim is per-environment.
const COND_DIR = resolve(import.meta.dir, "fixtures/artifact-rows-conditional");
const condIo: RecipeIO = {
  ...io,
  specDir: COND_DIR,
  resolve: (p) => resolve(COND_DIR, p.split("/").pop()!),
  instances: ["local", "prod"],
};

function condSheet() {
  const r = getRecipe("ansible");
  if (!r) throw new Error("ansible recipe is not registered");
  return r.load(
    {
      name: "os",
      recipe: "ansible",
      rows: "artifact",
      defaults: "defaults.yml",
      overlays: { local: "local.yml", prod: "prod.yml" },
      templates: [{ path: "app.service.j2", component: "app.service", deployed_path: "/etc/systemd/system/app.service" }],
    },
    condIo
  );
}

function renderedUnit(which: string): Map<string, string> {
  // Read as a unit, not by the fixture's own name: `rendered.local` resolves to
  // no format, and what is being compared is what systemd will parse.
  const file = resolve(COND_DIR, "app.service");
  const out = new Map<string, string>();
  for (const e of extractFile(readFileSync(resolve(COND_DIR, `rendered.${which}`), "utf-8"), file)) {
    out.set(e.source.path ?? e.key, e.value);
  }
  return out;
}

function condRows(instance: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of condSheet().embedded) {
    if (e.instances === undefined) out.set(e.key, e.value);
    else {
      const hit = e.instances.find((i) => i.name === instance);
      if (hit) out.set(e.key, hit.value);
    }
  }
  return out;
}

describe("rows: artifact renders a conditional line for the instances that have it", () => {
  for (const which of ["local", "prod"]) {
    it(`reproduces the ${which} artifact exactly`, () => {
      const sheet = condRows(which);
      const file = renderedUnit(which);
      expect([...sheet.keys()].sort()).toEqual([...file.keys()].sort());
      expect([...file].filter(([k, v]) => sheet.get(k) !== v)).toEqual([]);
    });
  }

  it("gives an instance-specific row its own instance's definition site", () => {
    const row = condSheet().embedded.find((e) => e.key === "Service.Environment[1]")!;
    expect(row.instances?.map((i) => i.name)).toEqual(["local"]);
    // Not the defaults file: the value being shown is the one local sets, and
    // that is what apply and verify have to resolve against.
    const source = row.instances![0].source!;
    expect(source.file).toContain("local.yml");
    expect(source.substituted).toBe(true);
  });

  it("leaves an unconditional row single-valued when no instance differs", () => {
    const rows = condSheet().embedded;
    expect(rows.find((e) => e.key === "Unit.Description")?.instances).toBeUndefined();
    // …and gives one the instance axis as soon as an overlay moves it, which a
    // component's rows could not show at all before.
    const user = rows.find((e) => e.key === "Service.User")!;
    expect(user.instances?.map((i) => `${i.name}=${i.value}`)).toEqual(["local=appsvc", "prod=prodsvc"]);
  });
});

// A sheet with COMPONENTS gets the under_key column too.
//
// It did not, and nothing said so: `keyMap` was pushed under `if (only &&
// !scoped)`, so declaring `component:` on a template silently turned the whole
// mechanism off. `Draft.variable` is the only source of both the under_key
// column and `fileCategory`'s "is this line part of the artifact" test, so a
// scoped sheet lost the column outright AND, under `group_by: file`, filed
// every overlay-driven row under the GROUP_VARS file it was overridden in
// rather than the artifact it is a line of. The one test that covered keyMap
// used `template:` (singular), which is unscoped, so nothing caught it.
describe("rows: artifact keeps the variable behind a row on a sheet with components", () => {
  it("emits keyMap for a scoped sheet", () => {
    const byBound = new Map((policySheet().keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect(byBound.get("/var/log/app/*.log.rotate")).toBe("app_rotate_keep");
    expect(byBound.get("/var/log/app/*.log.su")).toBe("app_user");
  });

  // The row's VALUE variable, never the one that only spells its key. This
  // fixture is the case that tells them apart: the block is addressed
  // `{{ app_log_dir }}/*.log`, so a row inside it has `app_log_dir` first in
  // `vars` while its value came from something else entirely. Naming the row
  // after the directory it happens to live in would be wrong in the one column
  // whose whole job is "which variable do I edit to change this".
  it("names the value's variable, not the key's", () => {
    const byBound = new Map((policySheet().keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect([...byBound.values()]).not.toContain("app_log_dir");
  });

  // A line whose value is a bare flag (`missingok`) came from no variable at
  // all, and gets no entry rather than borrowing the block's.
  it("leaves a row no variable backs out of keyMap", () => {
    const byBound = new Map((policySheet().keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect(byBound.has("/var/log/app/*.log.missingok")).toBe(false);
  });

  // An overlay-only variable is still the answer to "which variable backs this
  // line" even though there is no base definition site for `apply` to edit —
  // the two questions are separate, and resolving them from one lookup meant a
  // variable a group_vars file alone sets showed no under_key anywhere.
  it("names a variable only an overlay sets", () => {
    const byBound = new Map((condSheet().keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect(byBound.get("Service.Environment[1]")).toBe("app_extra_env");
  });

  it("carries the variable onto the row itself", () => {
    const row = condSheet().embedded.find((e) => e.key === "Service.User")!;
    expect(row).toBeDefined();
    const byBound = new Map((condSheet().keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect(byBound.get("Service.User")).toBe("app_user");
  });
});

// Two components, one row key, two variables — no honest single answer.
//
// keyMap is one flat table per sheet (assemble builds `boundToVariable` from it
// with no component), so `Service.User` backed by `app_user` in one unit and
// `other_user` in another cannot be shown correctly under both. Dropped and
// reported, the same way this module already drops one variable that backs
// several directives, rather than silently showing whichever was read last.
describe("rows: artifact refuses an ambiguous under_key across components", () => {
  function twoUnits() {
    const r = getRecipe("ansible")!;
    return r.load(
      {
        name: "os",
        recipe: "ansible",
        rows: "artifact",
        defaults: "defaults.yml",
        overlays: { local: "local.yml", prod: "prod.yml" },
        templates: [
          { path: "app.service.j2", component: "app.service", deployed_path: "/etc/systemd/system/app.service" },
          { path: "other.service.j2", component: "other.service", deployed_path: "/etc/systemd/system/other.service" },
        ],
      },
      condIo
    );
  }

  it("drops the entry rather than picking one", () => {
    const byBound = new Map((twoUnits().keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect(byBound.has("Service.User")).toBe(false);
  });

  it("says which key and which variables", () => {
    const warnings: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
    try {
      twoUnits();
    } finally {
      console.warn = real;
    }
    const hit = warnings.find((w) => w.includes("Service.User"));
    expect(hit).toBeDefined();
    expect(hit).toContain("app_user");
    expect(hit).toContain("other_user");
    expect(hit).toContain("other.service");
  });

  // A key only ONE component has is unaffected — the ambiguity rule is per key,
  // not a switch the presence of a second component throws.
  it("keeps an unambiguous key on the same sheet", () => {
    const byBound = new Map((twoUnits().keyMap ?? []).map((m) => [m.boundKey, m.variable]));
    expect(byBound.get("Service.Environment[1]")).toBe("app_extra_env");
  });
});
