// `baseline:` (ansible recipe, rows: artifact only) — the delta from a
// vendor's shipped file, for the common infrastructure practice of taking the
// RPM's config, editing some values, and commenting out the rest.
//
// `tests/fixtures/baseline-rows/vendor.conf` is what the RPM shipped;
// `app.conf.j2` is this project's template, derived from it: `ServerRoot` is
// kept as shipped, `Listen` is changed (via `app_port`), `ExtraDirective` is
// new (the vendor never had it), and `KeepAlive` is gone (commented out /
// removed here, present only in the vendor's file). Those are the four row
// shapes the design exists to state: inherited unchanged, changed, added, and
// "the vendor shipped this and we do not have it".

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { getRecipe } from "../src/recipe";
import "../src/recipes/index.js";
import "../src/parsers/index.js";
import type { RecipeIO, JsonValue } from "../src/recipe";

beforeEach(stubNonBuiltInProviders);

const DIR = resolve(import.meta.dir, "fixtures/baseline-rows");
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

function load(sheetSpec: Record<string, JsonValue>) {
  const r = getRecipe("ansible");
  if (!r) throw new Error("ansible recipe is not registered");
  return r.load(sheetSpec, io);
}

const BASE_SHEET = {
  name: "web",
  recipe: "ansible",
  rows: "artifact",
  defaults: "defaults.yml",
  template: "app.conf.j2",
  deployed_path: "/etc/httpd/conf/httpd.conf",
};

describe("ansible recipe: baseline", () => {
  it("rejects baseline without rows: artifact", () => {
    expect(() =>
      load({
        name: "web",
        recipe: "ansible",
        defaults: "defaults.yml",
        template: "app.conf.j2",
        baseline: { file: "vendor.conf" },
      })
    ).toThrow(/baseline.*valid only with rows: artifact/);
  });

  it("errors naming the path when the baseline file is missing", () => {
    expect(() => load({ ...BASE_SHEET, baseline: { file: "does-not-exist.conf" } })).toThrow(
      /baseline file not found/
    );
  });

  it("records the vendor's value on a row both sides have, unchanged or changed", () => {
    const si = load({ ...BASE_SHEET, baseline: { file: "vendor.conf" } });
    const base = si.layers.find((l) => l.kind === "base")!;

    // ServerRoot: same value in both files.
    const serverRoot = base.entries.get("ServerRoot")!;
    expect(serverRoot.value).toBe('"/etc/httpd"');
    expect(serverRoot.baseline).toBe('"/etc/httpd"');

    // Listen: vendor shipped 80, this project runs it on 8080.
    const listen = base.entries.get("Listen")!;
    expect(listen.value).toBe("8080");
    expect(listen.baseline).toBe("80");
  });

  it("leaves a row the vendor never had with no baseline field", () => {
    const si = load({ ...BASE_SHEET, baseline: { file: "vendor.conf" } });
    const base = si.layers.find((l) => l.kind === "base")!;
    const extra = base.entries.get("ExtraDirective")!;
    expect(extra.value).toBe("on");
    expect(extra.baseline).toBeUndefined();
  });

  it("files a vendor key this deliverable does not have as a new origin: baseline row", () => {
    const si = load({ ...BASE_SHEET, baseline: { file: "vendor.conf" } });
    const missing = (si.embedded ?? []).find((e) => e.key === "KeepAlive");
    expect(missing).toBeDefined();
    expect(missing!.origin).toBe("baseline");
    expect(missing!.value).toBe("Off"); // extraction-time carrier; buildDrafts moves this onto `baseline`
    expect(missing!.source).toEqual({ file: expect.stringContaining("vendor.conf") } as never);
    // Not also present in the base layer under its own key.
    const base = si.layers.find((l) => l.kind === "base")!;
    expect(base.entries.has("KeepAlive")).toBe(false);
  });

  it("reports the four counts", () => {
    const warn = mock((..._args: unknown[]) => {});
    const orig = console.warn;
    console.warn = warn;
    try {
      load({ ...BASE_SHEET, baseline: { file: "vendor.conf" } });
    } finally {
      console.warn = orig;
    }
    const summary = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("inherited unchanged"));
    expect(summary).toBeDefined();
    expect(summary).toContain("1 inherited unchanged");
    expect(summary).toContain("1 changed");
    expect(summary).toContain("1 added");
    expect(summary).toContain("1 the vendor ships");
  });

  it("warns loudly when the baseline shares no keys with the deployed artifact", () => {
    const warn = mock((..._args: unknown[]) => {});
    const orig = console.warn;
    console.warn = warn;
    try {
      load({ ...BASE_SHEET, baseline: { file: "unrelated.conf" } });
    } finally {
      console.warn = orig;
    }
    const message = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes("shares NO keys"));
    expect(message).toBeDefined();
    expect(message).toContain("almost certainly the wrong file");
  });

  it("rejects baseline on a sheet with several templates/components", () => {
    expect(() =>
      load({
        name: "web",
        recipe: "ansible",
        rows: "artifact",
        defaults: "defaults.yml",
        templates: [{ path: "app.conf.j2" }],
        baseline: { file: "vendor.conf" },
      })
    ).toThrow(/several templates\/components/);
  });
});
