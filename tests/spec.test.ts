import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { dirname } from "node:path";
import { loadBuildSpec, type BuildSpec } from "../src/spec";
import { registerRecipe, getRecipe, listRecipes, type SheetRecipe, type RecipeIO } from "../src/recipe";
import { assembleSheets, type AssembleOpts, type SheetInputs } from "../src/assemble";
import { validateInput } from "../src/validate";
import "../src/recipes/index"; // registers the real built-in recipes (layered/ansible/snapshot)

// The metadata provider registry is a process-wide singleton (see
// assemble.test.ts for the full rationale) — neutralize any non-core provider
// before each test so the end-to-end enrich() run here doesn't depend on
// cross-file test execution order.
beforeEach(stubNonBuiltInProviders);

const SPEC_PATH = "/project/build.yml";
const PROJECT_META_PATH = "/project/sheet.yml";

// A minimal recipe: one required field ("value"), producing a single base-layer
// key ("dummy_key") whose source file is resolved through the RecipeIO it is
// given — enough to exercise loadBuildSpec -> recipe.load -> assembleSheets.
const dummyRecipe: SheetRecipe = {
  name: "dummy",
  schema: {
    type: "object",
    required: ["value"],
    properties: { value: { type: "string" } },
  },
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const value = String(sheetSpec.value);
    return {
      name: String(sheetSpec.name),
      instances: [],
      layers: [
        {
          kind: "base",
          entries: new Map([["dummy_key", { value, source: { file: io.resolve("dummy.txt"), line: 1 } }]]),
        },
      ],
      embedded: [],
    };
  },
};
registerRecipe(dummyRecipe);

function files(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [PROJECT_META_PATH]: `
params:
  dummy_key:
    category: General
    description: A dummy parameter
`,
    ...overrides,
  };
}

function readFileFrom(map: Record<string, string>): (p: string) => string | null {
  return (p: string) => map[p] ?? null;
}

function validSpecYaml(): string {
  return `
version: 1
instances: [prod]
enrich:
  project: sheet.yml
sheets:
  - name: demo
    recipe: dummy
    value: hello
`;
}

describe("loadBuildSpec", () => {
  it("parses a valid spec and resolves enrich paths to absolute against the spec dir", () => {
    const map = files({ [SPEC_PATH]: validSpecYaml() });
    const spec = loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) });
    expect(spec.version).toBe(1);
    expect(spec.sheets).toEqual([{ name: "demo", recipe: "dummy", value: "hello" }]);
    expect(spec.enrich?.project).toBe(PROJECT_META_PATH);
  });

  it("carries id_fields through (a property of the project's data, not of the command line)", () => {
    const yaml = `
version: 1
instances: [staging]
id_fields: [clientId, alias]
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) }).id_fields).toEqual(["clientId", "alias"]);
  });

  it("rejects a non-string id_fields entry", () => {
    const yaml = `
version: 1
instances: [staging]
id_fields: [1]
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/id_fields/);
  });

  it("resolves metadata_dirs and argument_specs against the spec dir too", () => {
    const yaml = `
version: 1
instances: [staging]
enrich:
  metadata_dirs: [metadata]
  argument_specs: [meta/argument_specs.yml]
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    const spec = loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) });
    expect(spec.enrich?.metadata_dirs).toEqual(["/project/metadata"]);
    expect(spec.enrich?.argument_specs).toEqual(["/project/meta/argument_specs.yml"]);
  });

  it("accepts enrich.native_lang and passes it through unresolved (not a path)", () => {
    const yaml = `
version: 1
instances: [staging]
enrich:
  native_lang: ja
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    const spec = loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) });
    expect(spec.enrich?.native_lang).toBe("ja");
  });

  it("rejects an invalid enrich.native_lang value", () => {
    const yaml = `
version: 1
instances: [staging]
enrich:
  native_lang: fr
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow();
  });

  it("rejects a spec missing version", () => {
    const yaml = `
instances: [prod]
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/version/);
  });

  it("rejects a spec missing instances", () => {
    const yaml = `
version: 1
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/instances/);
  });

  it("rejects a spec missing sheets", () => {
    const yaml = `
version: 1
instances: [prod]
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/sheets/);
  });

  it("rejects an empty sheets array", () => {
    const yaml = `
version: 1
instances: [prod]
sheets: []
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow();
  });

  it("rejects a sheet missing a recipe-required field", () => {
    const yaml = `
version: 1
instances: [prod]
sheets:
  - name: demo
    recipe: dummy
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/value/);
  });

  it("accepts a sheet that satisfies its recipe's schema", () => {
    const map = files({ [SPEC_PATH]: validSpecYaml() });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).not.toThrow();
  });

  it("accepts a sheet-level instances list that is a subset of the spec's", () => {
    const yaml = `
version: 1
instances: [staging, production]
sheets:
  - name: demo
    recipe: dummy
    value: hi
    instances: [staging]
`;
    const map = files({ [SPEC_PATH]: yaml });
    const spec = loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) });
    expect(spec.sheets[0]).toEqual({ name: "demo", recipe: "dummy", value: "hi", instances: ["staging"] });
  });

  it("rejects a sheet-level instances entry the spec never declared", () => {
    const yaml = `
version: 1
instances: [staging, production]
sheets:
  - name: demo
    recipe: dummy
    value: hi
    instances: [staging, local]
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/local/);
  });

  it("rejects an unknown recipe name, listing what IS registered", () => {
    const yaml = `
version: 1
instances: [prod]
sheets:
  - name: demo
    recipe: nonexistent-recipe
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/nonexistent-recipe/);
    try {
      loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) });
      throw new Error("expected loadBuildSpec to throw");
    } catch (e) {
      expect(String(e)).toMatch(/dummy/);
    }
  });
});

// P0 regression: a typo'd sheet field (or a field a recipe never had) used to
// pass through silently — `additionalProperties` was missing both on each
// recipe's own schema and, before that, common sheet-level fields
// (name/recipe/instances/dictionaries) had nowhere to strip to, so adding it
// to a recipe schema alone would have rejected every ordinary sheet. See
// src/spec.ts's COMMON_SHEET_FIELDS / recipe.schema's additionalProperties,
// and each of src/recipes/{layered,ansible,snapshot}.ts.
// A template with no `{{ … }}` in it — a fixed-value logrotate policy, a cron
// file — used to have to name a vars file it has no use for, because the ansible
// recipe required `defaults`. Naming one is not free: the part is then
// answerable for every variable in that file, so a required field manufactured
// an obligation the part did not have.
describe("loadBuildSpec: an ansible sheet needs no defaults", () => {
  it("accepts a templates-only sheet", () => {
    const map = files({
      [SPEC_PATH]: `
version: 1
instances: [prod]
sheets:
  - name: s
    recipe: ansible
    rows: artifact
    templates:
      - path: policy.j2
        component: /etc/logrotate.d/app
        deployed_path: /etc/logrotate.d/app
`,
    });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).not.toThrow();
  });
});

describe("loadBuildSpec: unknown-field rejection (P0)", () => {
  function layeredSpecYaml(extra: string): string {
    return `
version: 1
instances: [prod]
sheets:
  - name: s
    recipe: layered
    defaults: defaults.yml
${extra}
`;
  }

  it("rejects a typo'd sheet field and suggests the nearest real one", () => {
    const map = files({
      [SPEC_PATH]: layeredSpecYaml(`    overlayz:
      prod: prod.yml
`),
    });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/did you mean "overlays"/);
  });

  it("accepts the same sheet once the field is spelled correctly", () => {
    const map = files({
      [SPEC_PATH]: layeredSpecYaml(`    overlays:
      prod: prod.yml
`),
    });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).not.toThrow();
  });

  it("still accepts an ordinary sheet with no extra fields (no false positive)", () => {
    const map = files({ [SPEC_PATH]: layeredSpecYaml("") });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).not.toThrow();
  });

  it("rejects the removed sheet-wide `keying:` field on \"layered\" (S2 dropped it; it must not silently no-op again)", () => {
    const map = files({ [SPEC_PATH]: layeredSpecYaml("    keying: source\n") });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/additional property "keying"/);
  });

  it("rejects `keying:` on \"ansible\" too", () => {
    const yaml = `
version: 1
instances: [prod]
sheets:
  - name: s
    recipe: ansible
    defaults: defaults.yml
    keying: source
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/additional property "keying"/);
  });

  it("rejects an unknown top-level spec field with a hint", () => {
    const yaml = `
version: 1
instances: [prod]
capabilitites:
  apply: false
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/did you mean "capabilities"/);
  });

  it("rejects an unknown field nested under enrich:", () => {
    const yaml = `
version: 1
instances: [prod]
enrich:
  strictt: false
sheets:
  - name: demo
    recipe: dummy
    value: hi
`;
    const map = files({ [SPEC_PATH]: yaml });
    expect(() => loadBuildSpec(SPEC_PATH, { readFile: readFileFrom(map) })).toThrow(/did you mean "strict"/);
  });
});

describe("recipe registry", () => {
  it("registers, lists, and gets a recipe by name", () => {
    expect(getRecipe("dummy")).toBe(dummyRecipe);
    expect(listRecipes().map((r) => r.name)).toContain("dummy");
  });

  it("replace-by-name: re-registering the same name swaps the implementation", () => {
    const v2: SheetRecipe = { ...dummyRecipe, schema: { type: "object" } };
    registerRecipe(v2);
    expect(getRecipe("dummy")).toBe(v2);
    // restore, so later tests in this file keep using the original schema
    registerRecipe(dummyRecipe);
    expect(getRecipe("dummy")).toBe(dummyRecipe);
  });
});

describe("end-to-end: loadBuildSpec -> recipe.load -> assembleSheets -> validateInput", () => {
  it("produces a schema-valid ParameterSheetInput", () => {
    const map = files({ [SPEC_PATH]: validSpecYaml() });
    const readFile = readFileFrom(map);
    const spec: BuildSpec = loadBuildSpec(SPEC_PATH, { readFile });

    const specDir = dirname(SPEC_PATH);
    const io: RecipeIO = { readFile, specDir, resolve: (p: string) => `${specDir}/${p}`, instances: spec.instances };

    const inputs = spec.sheets.map((sheetSpec) => getRecipe(sheetSpec.recipe)!.load(sheetSpec, io));

    const opts: AssembleOpts = {
      readFile,
      projectPath: spec.enrich?.project,
      metadata: spec.metadata,
      capabilities: spec.capabilities,
    };
    const result = assembleSheets(inputs, opts);

    expect(() => validateInput(result)).not.toThrow();
    expect(result.sheets[0].name).toBe("demo");
    expect(result.sheets[0].categories[0].params![0]).toMatchObject({ key: "dummy_key", value: "hello" });
  });
});
