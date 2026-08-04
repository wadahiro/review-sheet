import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getParser, type ConfigParser } from "../src/parser";
import { getRecipe, type SheetRecipe } from "../src/recipe";
import { getMetadataProvider, type MetadataProvider } from "../src/metadata";

// Reproduces the failure mode B-1 describes: a plugin's bare `import { ... }
// from "review-sheet"` resolves from the PLUGIN's location, so when the CLI is
// running from a different checkout the plugin loads a SECOND COPY of
// parser.ts/recipe.ts/metadata.ts. ES module identity is by resolved file path,
// so before the shared registry those copies each had their own array and
// registration was a silent no-op.
//
// Copying the registry modules into a temp dir and importing them from there
// creates exactly that second copy — genuinely different resolved paths, not a
// simulation. Everything these three modules import at RUNTIME is copied along;
// their other imports (assemble.js in recipe.ts, types.js in parser.ts) are
// `import type` and are erased before execution.
const REGISTRY_MODULES = ["registry.ts", "types.ts", "parser.ts", "recipe.ts", "metadata.ts"];

function copyOfSrc(): string {
  const dir = mkdtempSync(join(tmpdir(), "review-sheet-registry-"));
  const src = join(dir, "src");
  mkdirSync(src);
  for (const f of REGISTRY_MODULES) {
    copyFileSync(join(import.meta.dir, "..", "src", f), join(src, f));
  }
  return dir;
}

const copyDir = copyOfSrc();
afterAll(() => rmSync(copyDir, { recursive: true, force: true }));

describe("registries are shared across module copies", () => {
  it("sees a parser registered through a separately-resolved copy of parser.ts", async () => {
    const copy = (await import(join(copyDir, "src", "parser.ts"))) as typeof import("../src/parser");
    expect(copy.registerParser).not.toBe(
      // Sanity check on the premise: if these were the same module the test
      // would pass trivially and prove nothing.
      (await import("../src/parser")).registerParser
    );

    const plugin: ConfigParser = {
      name: "copy-registered-parser",
      detect: (file) => file.endsWith(".copytest"),
      extract: () => [],
      locate: () => ({ error: "n/a" }),
      edit: () => ({ status: "skipped" }),
    };
    copy.registerParser(plugin);

    expect(getParser("copy-registered-parser")).toBe(plugin);
  });

  it("sees a recipe registered through a separately-resolved copy of recipe.ts", async () => {
    const copy = (await import(join(copyDir, "src", "recipe.ts"))) as typeof import("../src/recipe");

    const plugin: SheetRecipe = {
      name: "copy-registered-recipe",
      schema: { type: "object" },
      load: () => ({ name: "x", instances: [], layers: [], embedded: [] }),
    };
    copy.registerRecipe(plugin);

    expect(getRecipe("copy-registered-recipe")).toBe(plugin);
  });

  it("sees a metadata provider registered through a separately-resolved copy of metadata.ts", async () => {
    const copy = (await import(join(copyDir, "src", "metadata.ts"))) as typeof import("../src/metadata");

    const plugin: MetadataProvider = {
      name: "copy-registered-provider",
      resolve: () => undefined,
    };
    copy.registerMetadataProvider(plugin);

    expect(getMetadataProvider("copy-registered-provider")).toBe(plugin);
  });
});

// T6 (legacy global removal): this file used to also test `sharedBox()`
// (registry.ts) and `setIdentityFields`/`getIdentityFields` (extract.ts), the
// process-wide mutable-configuration cell built on top of sharedRegistry's
// cross-copy mechanism. That cell is gone — `extract.ts`'s identity-fields
// override and `annotation.ts`'s marker are now threaded exclusively through
// `ExtractOptions` (see parser.ts), an ordinary argument, so there is no
// process-wide configuration left to test here. `sharedRegistry` itself
// (tested above) remains: it solves a different problem — plugin
// registration — that a pure-argument design cannot solve, since a plugin's
// `registerParser()` call has to land somewhere the CLI's `getParser()` will
// find it regardless of which copy of parser.ts each resolved. See extract.ts
// tests for `idFields` behavior via `ExtractOptions`.
