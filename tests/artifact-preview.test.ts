// An artifact preview is the whole deployed file, rendered by review-sheet's
// own substitution engine so a reviewer can read a value IN ITS PLACE.
//
// The assertion is the same one the artifact ROWS get, and for the same reason:
// against a committed RENDERED artifact, not a hand-written expectation. If the
// engine stops reproducing the file, this fails.
//
// What makes the preview cheap is worth stating as a test rather than a
// comment: a line with no Jinja on it IS the deployed line, by identity, so
// every comment and every blank line arrives untouched. That is most of a real
// config file and the part that explains the rest of it — and it is exactly
// what a row-by-row reconstruction cannot produce, since no parser extracts a
// comment.

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { getRecipe } from "../src/recipe";
import "../src/recipes/index.js";
import "../src/parsers/index.js";
import type { RecipeIO } from "../src/recipe";
import type { ArtifactPreview } from "../src/types";
import { MAX_PREVIEW_BYTES } from "../src/preview";

beforeEach(stubNonBuiltInProviders);

function io(dir: string, instances: string[]): RecipeIO {
  return {
    readFile: (p) => {
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    },
    specDir: dir,
    resolve: (p) => resolve(dir, p.split("/").pop()!),
    instances,
  };
}

// Same as `io`, but a named file reads as `overrides[name]` instead of the
// real fixture — for a case where the interesting input (an oversized
// template) is impractical to commit as its own fixture file.
function ioWithOverride(dir: string, instances: string[], overrides: Record<string, string>): RecipeIO {
  return {
    ...io(dir, instances),
    readFile: (p) => {
      const base = p.split("/").pop()!;
      if (base in overrides) return overrides[base];
      try {
        return readFileSync(p, "utf-8");
      } catch {
        return null;
      }
    },
  };
}

const POLICY = resolve(import.meta.dir, "fixtures/artifact-rows-policy");
const COND = resolve(import.meta.dir, "fixtures/artifact-rows-conditional");

function previews(dir: string, instances: string[], spec: Record<string, unknown>): ArtifactPreview[] {
  const r = getRecipe("ansible");
  if (!r) throw new Error("ansible recipe is not registered");
  return r.load({ name: "os", recipe: "ansible", ...spec } as never, io(dir, instances)).artifacts ?? [];
}

const policy = () =>
  previews(POLICY, [], {
    rows: "artifact",
    defaults: "defaults.yml",
    templates: [{ path: "logrotate-app.j2", component: "logrotate-app", deployed_path: "/etc/logrotate.d/app" }],
  });

const conditional = () =>
  previews(COND, ["local", "prod"], {
    rows: "artifact",
    defaults: "defaults.yml",
    overlays: { local: "local.yml", prod: "prod.yml" },
    templates: [{ path: "app.service.j2", component: "app.service", deployed_path: "/etc/systemd/system/app.service" }],
  });

describe("an artifact preview is the whole file", () => {
  it("reproduces the rendered artifact byte for byte", () => {
    const [p] = policy();
    const rendered = readFileSync(resolve(POLICY, "logrotate-app"), "utf-8");
    // The fixture keeps the ONE line the toolchain fills in per host in its
    // template form, because a line the engine cannot finish is shown as
    // written rather than half-rendered — half-rendered looks rendered and is
    // wrong, which is the outcome the preview exists to avoid.
    expect(p.lines.map((l) => l.text).join("\n")).toBe(rendered);
  });

  it("carries the comments and blank lines no row could", () => {
    const [p] = policy();
    const verbatim = p.lines.filter((l) => l.kind === "verbatim").map((l) => l.text);
    expect(verbatim).toContain("# Rotation policy for the app's own logs.");
    expect(verbatim).toContain("");
    // …while the lines that ARE rows say so, both ways round.
    const su = p.lines.find((l) => l.text.trim().startsWith("su "))!;
    expect(su.kind).toBe("substituted");
    expect(su.key).toBe("/var/log/app/*.log.su");
  });

  it("names where the file comes from and where it lands", () => {
    const [p] = policy();
    expect(p.id).toBe("os::logrotate-app");
    expect(p.deployed_path).toBe("/etc/logrotate.d/app");
    expect(p.source_file).toContain("logrotate-app.j2");
  });
});

describe("an artifact preview is per instance", () => {
  it("reproduces each instance's own rendered artifact", () => {
    for (const which of ["local", "prod"]) {
      const p = conditional().find((a) => a.instances?.includes(which))!;
      const rendered = readFileSync(resolve(COND, `rendered.${which}`), "utf-8");
      // The absent lines are the ones this instance does not render, so they
      // are excluded from the text and kept in the model — see below.
      expect(p.lines.filter((l) => l.kind !== "absent").map((l) => l.text).join("\n")).toBe(rendered);
    }
  });

  it("keeps a line an instance does NOT render, greyed rather than dropped", () => {
    const prod = conditional().find((a) => a.instances?.includes("prod"))!;
    const absent = prod.lines.filter((l) => l.kind === "absent");
    expect(absent.map((l) => l.text.trim())).toEqual(["Environment=APP_CONSOLE=1", "Environment={{ app_extra_env }}"]);
    // …saying WHICH condition did not hold, so the reader can act on it.
    expect(absent[0].reason).toBe("app_debug_console");
    // "this line exists only in local" is review information; dropping it would
    // be this project losing a line in silence.
    expect(absent.map((l) => l.key)).toEqual(["Service.Environment[0]", "Service.Environment[1]"]);
  });

  it("emits one preview per DISTINCT rendering, not one per instance", () => {
    // app.service differs (the conditional block and the user), so two.
    expect(conditional().length).toBe(2);
    // The policy has no per-environment difference and no instances at all: one.
    expect(policy().length).toBe(1);
  });
});

describe("an artifact preview tells a gap from a deploy-time value", () => {
  it("does not call a variable the toolchain injects a gap", () => {
    const [p] = policy();
    // `template_host` is the machine Ansible RAN on. No vars file could hold
    // it, nothing is missing — so the line is left unrendered and NOT counted
    // as the sheet admitting incompleteness. Counting this class made the panel
    // warn on every file in a real project without once pointing at a setting,
    // which is worse than not warning: it buried the case that matters.
    const line = p.lines.find((l) => l.text.includes("template_host"))!;
    expect(line.kind).toBe("unrendered");
    expect(line.cause).toBe("deploy-time");
    expect(p.lines.filter((l) => l.kind === "unrendered" && l.cause !== "deploy-time")).toEqual([]);
  });

  it("renders ansible_managed, because that one IS knowable", () => {
    // Ansible's own documented default (`ansible-config dump` calls it
    // DEFAULT_MANAGED_STR), or whatever ansible.cfg states. It is the FIRST
    // line of every generated file, so leaving it raw put a `{{ }}` at the top
    // of every preview for a value the product publishes.
    const [p] = policy();
    expect(p.lines[1].text).toContain("Ansible managed");
  });

  it("still calls an unresolved PROJECT variable a gap", () => {
    // The allowance is narrow and named. A typo'd variable, or a vars file the
    // sheet was never pointed at, is exactly the mis-wired-sheet case that must
    // not go quiet.
    const r = getRecipe("ansible")!;
    const a = (r.load(
      {
        name: "os",
        recipe: "ansible",
        rows: "artifact",
        defaults: "defaults.yml",
        templates: [{ path: "unresolved.j2", component: "x" }],
      } as never,
      io(POLICY, [])
    ).artifacts ?? [])[0];
    const gap = a.lines.find((l) => l.kind === "unrendered")!;
    expect(gap.cause).toBe("engine");
    expect(gap.reason).toContain("app_nonexistent");
  });
});

describe("an artifact preview enforces the size gate", () => {
  // Ansible templates never had this gate before the recipe moved onto the
  // shared preview engine (src/preview.ts) — this pins the one intentional
  // behaviour change that move made: a template too large to preview now
  // warns and is skipped, instead of being rendered into the sheet regardless
  // of size.
  it("a template over MAX_PREVIEW_BYTES warns and produces no preview", () => {
    const r = getRecipe("ansible");
    if (!r) throw new Error("ansible recipe is not registered");
    const big = "x".repeat(MAX_PREVIEW_BYTES + 1);
    const warnings: string[] = [];
    const spy = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    let result;
    try {
      result = r.load(
        {
          name: "os",
          recipe: "ansible",
          rows: "artifact",
          defaults: "defaults.yml",
          templates: [{ path: "logrotate-app.j2", component: "logrotate-app" }],
        } as never,
        ioWithOverride(POLICY, [], { "logrotate-app.j2": big })
      );
    } finally {
      console.warn = spy;
    }
    expect(result.artifacts ?? []).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("logrotate-app.j2");
    expect(warnings[0]).toContain(`${Math.round(MAX_PREVIEW_BYTES / 1024)} KB`);
  });
});

// A preview line names the row it IS — and a recipe builds previews before the
// assembler has finished deciding which rows survive. A dictionary's
// `ui: "absent"` drops a row the product's own console does not have; a
// project's filter removes another. The line must not be left naming it.
describe("a preview line never names a row the sheet does not have", () => {
  it("drops the key when the row did not survive assembly", async () => {
    const { assembleSheets } = await import("../src/assemble");
    const meta = 'params:\n  kept:\n    category: C\n    description: d\n';
    const out = assembleSheets(
      [
        {
          name: "s",
          instances: [],
          layers: [{ kind: "base", entries: new Map([["kept", { value: "1", source: { file: "f", line: 1 } }]]) }],
          embedded: [],
          artifacts: [
            {
              id: "s",
              sheet: "s",
              source_file: "f",
              lines: [
                { text: "kept = 1", kind: "verbatim", key: "kept" },
                { text: "gone = 2", kind: "verbatim", key: "gone" },
              ],
            },
          ],
        },
      ],
      { projectPath: "sheet.yml", readFile: (p) => (p === "sheet.yml" ? meta : null) }
    );
    const lines = out.artifacts![0].lines;
    expect(lines[0].key).toBe("kept");
    // The row was never assembled — the line keeps its TEXT (it is still a line
    // of the file) and loses the claim to be a row.
    expect(lines[1].key).toBeUndefined();
    expect(lines[1].text).toBe("gone = 2");
  });
});
