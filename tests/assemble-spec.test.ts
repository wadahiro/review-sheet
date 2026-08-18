// The escape hatch between a declarative build.yml and a hand-written
// converter: assembleFromSpec()/buildFromSpecFile() (src/assemble-spec.ts) —
// the composition `import --spec` itself runs — plus the AssembleHooks
// (src/assemble.ts) a project uses to fix the one detail its recipe doesn't
// cover, without leaving the spec.

import { describe, it, expect, beforeEach } from "bun:test";
import { readdirSync } from "fs";
import { join } from "path";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { assembleFromSpec, buildFromSpecFile } from "../src/assemble-spec";
import { loadBuildSpec } from "../src/spec";
import { registerRecipe, type SheetRecipe, type RecipeIO } from "../src/recipe";
import type { AssembleHooks, SheetInputs, ExtractedMap } from "../src/assemble";
import { extractFile } from "../src/extract";
import type { Parameter, ParameterSheetInput, SimpleParameter } from "../src/types";

// The metadata provider registry is a process-wide singleton (see
// assemble.test.ts for the full rationale) — neutralize any non-core provider
// so the strict-metadata assertions here don't depend on test file order.
beforeEach(stubNonBuiltInProviders);

// A recipe standing in for a real one: a base layer with two keys, one
// per-instance overlay, and one embedded literal — enough for hooks to be
// observed on all three param kinds.
const fixtureRecipe: SheetRecipe = {
  name: "hooks-fixture",
  schema: { type: "object", properties: {} },
  load(sheetSpec, io: RecipeIO): SheetInputs {
    return {
      name: String(sheetSpec.name),
      instances: io.instances,
      layers: [
        {
          kind: "base",
          entries: new Map([
            ["raw_host", { value: "db.internal", source: { file: io.resolve("base.yml"), line: 1 } }],
            ["raw_port", { value: "5432", source: { file: io.resolve("base.yml"), line: 2 } }],
          ]),
        },
        {
          kind: "overlay",
          instance: "production",
          entries: new Map([["raw_port", { value: "6432", source: { file: io.resolve("prod.yml"), line: 1 } }]]),
        },
      ],
      embedded: [{ key: "raw_literal", value: "on", source: { file: io.resolve("base.yml"), line: 3 } }],
    };
  },
};
registerRecipe(fixtureRecipe);

const SPEC_PATH = "/project/build.yml";

const BUILD_YML = `
version: 1
metadata:
  title: Hooks fixture
instances: [staging, production]
enrich:
  project: sheet.yml
sheets:
  - name: app
    recipe: hooks-fixture
`;

// Keyed by the POST-hook keys (host/port/literal): the project metadata is
// looked up with a parameter's final identity, which is the contract `keyFor`
// has to honour.
const PROJECT_YML = `
params:
  host:
    category: Database
    description: Database host
  port:
    category: Database
    description: Database port
  literal:
    category: Misc
    description: An embedded literal
`;

const files: Record<string, string> = {
  [SPEC_PATH]: BUILD_YML,
  "/project/sheet.yml": PROJECT_YML,
};
const readFile = (p: string): string | null => files[p] ?? null;

// Strip the "raw_" prefix a recipe happens to emit.
const stripRaw: AssembleHooks["keyFor"] = (ctx) => ctx.key.replace(/^raw_/, "");

function build(hooks?: AssembleHooks, strictMetadata?: boolean): ParameterSheetInput {
  const spec = loadBuildSpec(SPEC_PATH, { readFile });
  return assembleFromSpec(spec, { readFile, specDir: "/project", hooks, strictMetadata });
}

function params(input: ParameterSheetInput): Parameter[] {
  return input.sheets.flatMap((s) => (s.categories ?? []).flatMap((c) => c.params ?? []));
}

describe("assembleFromSpec", () => {
  it("runs the spec's recipes and enriches, with no hooks", () => {
    // Without keyFor the raw keys have no category -> the same assembly error
    // the CLI would print, proving the hook is what bridges the two vocabularies.
    expect(() => build()).toThrow(/raw_port/);
  });

  it("resolves recipe paths against specDir, overridable by `resolve`", () => {
    const seen: string[] = [];
    const spec = loadBuildSpec(SPEC_PATH, { readFile });
    assembleFromSpec(spec, {
      readFile,
      specDir: "/project",
      resolve: (p) => {
        seen.push(p);
        return `rel/${p}`;
      },
      hooks: { keyFor: stripRaw },
    });
    expect(seen).toContain("base.yml");

    const input = build({ keyFor: stripRaw });
    const host = params(input).find((p) => p.key === "host") as SimpleParameter;
    expect(host.source?.file).toBe("/project/base.yml"); // default: absolute against specDir
  });

  it("buildFromSpecFile loads the spec and assembles in one call", () => {
    const { input, report } = buildFromSpecFile(SPEC_PATH, { readFile, hooks: { keyFor: stripRaw } });
    expect(input.metadata?.title).toBe("Hooks fixture");
    expect(params(input).map((p) => p.key)).toEqual(["host", "port", "literal"]);
    expect(report.byProvider).toEqual({ project: 3 });
  });
});

describe("AssembleHooks", () => {
  it("keyFor rewrites identity for every param kind, and routes metadata lookup", () => {
    const input = build({ keyFor: stripRaw });
    const all = params(input);

    expect(all.map((p) => [p.key, p.origin])).toEqual([
      ["host", "common"],
      ["port", "overlay"],
      ["literal", "embedded"],
    ]);
    // Category + description were found under the renamed key.
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual(["Database", "Misc"]);
    expect(all.find((p) => p.key === "port")?.description).toBe("Database port");
  });

  it("keyFor sees the pre-hook key and the backing variable", () => {
    const seen: string[] = [];
    build({
      keyFor: (ctx) => {
        seen.push(`${ctx.sheet}:${ctx.key}:${ctx.variable ?? "-"}`);
        return stripRaw!(ctx);
      },
    });
    expect(seen).toEqual(["app:raw_host:-", "app:raw_port:-", "app:raw_literal:-"]);
  });

  it("mapParam adjusts a parameter and can drop one by returning null", () => {
    // strictMetadata: false — mapParam deliberately drops "literal" below, so
    // the project metadata's own "literal" entry goes legitimately unused
    // (see assemble.ts's unusedProjectParams build failure).
    const input = build(
      {
        keyFor: stripRaw,
        mapParam: (param, ctx) => {
          if (ctx.key === "literal") return null; // drop artifact noise
          if (ctx.key === "host") param.remarks = "added by mapParam";
          return param;
        },
      },
      false
    );

    const all = params(input);
    expect(all.map((p) => p.key)).toEqual(["host", "port"]);
    expect(all.find((p) => p.key === "host")?.remarks).toBe("added by mapParam");
  });

  it("a dropped parameter's category disappears with it", () => {
    const input = build({ keyFor: stripRaw, mapParam: (p, ctx) => (ctx.key === "literal" ? null : p) }, false);
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual(["Database"]);
  });

  it("finalize sees the assembled model before enrich fills it in", () => {
    let sawDescription: unknown = "unset";
    const input = build({
      keyFor: stripRaw,
      finalize: (model) => {
        const first = (model.sheets[0].categories ?? [])[0].params![0];
        sawDescription = first.description; // enrich has not run yet
        first.description = "set by finalize";
        return model;
      },
    });

    expect(sawDescription).toBeUndefined();
    // enrich is fill-only, so what finalize set survives; the rest is enriched.
    expect(params(input).find((p) => p.key === "host")?.description).toBe("set by finalize");
    expect(params(input).find((p) => p.key === "port")?.description).toBe("Database port");
  });

  it("cannot hide a strict-metadata failure: a param finalize adds still needs a description", () => {
    expect(() =>
      build({
        keyFor: stripRaw,
        finalize: (model) => {
          (model.sheets[0].categories ?? [])[0].params!.push({ key: "undocumented", value: "x" });
          return model;
        },
      })
    ).toThrow(/undocumented/);
  });
});

// This is the concrete case ExtractOptions threading exists for: a
// build.yml's `id_fields` reaches extraction as data, through
// `RecipeIO.extractOptions` (built by assembleFromSpecWithReport), with no
// process-wide state involved at all — the mechanism that would have
// silently failed to reach a DIFFERENT loaded copy of extract.ts. This
// recipe calls the real extractFile() (not a stand-in) with
// `io.extractOptions`, so the test exercises the actual production path end
// to end.
const idFieldsFixtureRecipe: SheetRecipe = {
  name: "id-fields-fixture",
  schema: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const file = io.resolve(String(sheetSpec.file));
    const content = io.readFile(file);
    if (content === null) throw new Error(`id-fields-fixture: not found: ${file}`);
    const entries = extractFile(content, file, undefined, io.extractOptions);
    const map: ExtractedMap = new Map();
    for (const e of entries) {
      const key = e.source.path ?? e.key;
      map.set(key, { value: e.value, source: { ...e.source, file } });
    }
    return {
      name: String(sheetSpec.name),
      instances: io.instances,
      layers: [{ kind: "base", entries: map }],
      embedded: [],
    };
  },
};
registerRecipe(idFieldsFixtureRecipe);

describe("assembleFromSpecWithReport — id_fields reaches extraction via RecipeIO.extractOptions, not a global", () => {
  const ID_SPEC_PATH = "/idfields/build.yml";
  const CLIENTS_PATH = "/idfields/clients.yml";
  const PROJECT_PATH = "/idfields/sheet.yml";

  const clientsYaml = "clients:\n  - clientId: poc-oidc\n    enabled: true\n  - clientId: poc-saml\n    enabled: false\n";
  const projectYaml = [
    "params:",
    '  "clients[clientId=poc-oidc].enabled":',
    "    category: General",
    "    description: whether the oidc client is enabled",
    '  "clients[clientId=poc-saml].enabled":',
    "    category: General",
    "    description: whether the saml client is enabled",
  ].join("\n");
  const specYaml = [
    "version: 1",
    "instances: [prod]",
    "id_fields: [clientId]",
    "enrich:",
    "  project: sheet.yml",
    "sheets:",
    "  - name: demo",
    "    recipe: id-fields-fixture",
    "    file: clients.yml",
  ].join("\n");

  const map: Record<string, string> = {
    [ID_SPEC_PATH]: specYaml,
    [CLIENTS_PATH]: clientsYaml,
    [PROJECT_PATH]: projectYaml,
  };
  const readFile = (p: string): string | null => map[p] ?? null;

  it("addresses clients by clientId, carried entirely through RecipeIO.extractOptions", () => {
    const spec = loadBuildSpec(ID_SPEC_PATH, { readFile });
    const input = assembleFromSpec(spec, { readFile, specDir: "/idfields" });

    const keys = params(input).map((p) => p.key);
    expect(keys).toEqual([
      "clients[clientId=poc-oidc].enabled",
      "clients[clientId=poc-saml].enabled",
    ]);
  });
});

// Sheet-level `instances`: before this, a
// build.yml's `instances` was spec-wide only, forcing a project to split into
// multiple specs whenever two sheets genuinely covered different environment
// sets (e.g. Terraform run only in [staging, production] next to an
// Ansible-rendered config in [local, staging, production]). See spec.ts's
// BuildSpec.sheets[].instances for the subset-of-spec-instances rule and
// per-sheet-order rationale.
describe("sheet-level instances", () => {
  const PROJECT_PATH = "/sheet-instances/sheet.yml";
  const projectYaml = `
params:
  host:
    category: Database
    description: Database host
  port:
    category: Database
    description: Database port
  literal:
    category: Misc
    description: An embedded literal
`;

  it("a sheet with no `instances` inherits the spec's default, an overriding sheet gets its own", () => {
    const SPEC_PATH_2 = "/sheet-instances/build.yml";
    const specYaml = `
version: 1
instances: [staging, production]
enrich:
  project: sheet.yml
sheets:
  - name: app-full
    recipe: hooks-fixture
  - name: app-narrow
    recipe: hooks-fixture
    instances: [production]
`;
    const map: Record<string, string> = { [SPEC_PATH_2]: specYaml, [PROJECT_PATH]: projectYaml };
    const readFile = (p: string): string | null => map[p] ?? null;

    const spec = loadBuildSpec(SPEC_PATH_2, { readFile });
    const input = assembleFromSpec(spec, { readFile, specDir: "/sheet-instances", hooks: { keyFor: stripRaw } });

    expect(input.sheets[0].name).toBe("app-full");
    expect(input.sheets[0].instances).toEqual(["staging", "production"]);
    expect(input.sheets[1].name).toBe("app-narrow");
    expect(input.sheets[1].instances).toEqual(["production"]);
  });

  it("overlay-instance validation runs against the sheet's OWN (narrowed) instances, not the spec's", () => {
    const SPEC_PATH_3 = "/sheet-instances/build-conflict.yml";
    // hooks-fixture always overlays instance "production" — narrowing this
    // sheet to [staging] must make that overlay invalid, the same error
    // assembleSheets already raises for a spec-wide mismatch.
    const specYaml = `
version: 1
instances: [staging, production]
enrich:
  project: sheet.yml
sheets:
  - name: app-conflict
    recipe: hooks-fixture
    instances: [staging]
`;
    const map: Record<string, string> = { [SPEC_PATH_3]: specYaml, [PROJECT_PATH]: projectYaml };
    const readFile = (p: string): string | null => map[p] ?? null;

    const spec = loadBuildSpec(SPEC_PATH_3, { readFile });
    expect(() =>
      assembleFromSpec(spec, { readFile, specDir: "/sheet-instances", hooks: { keyFor: stripRaw } })
    ).toThrow(/app-conflict.*overlay instance "production" is not in instances/);
  });

  it("loadBuildSpec rejects a sheet instances entry the spec never declared", () => {
    const SPEC_PATH_4 = "/sheet-instances-bad/build.yml";
    const specYaml = `
version: 1
instances: [staging, production]
sheets:
  - name: app
    recipe: hooks-fixture
    instances: [staging, local]
`;
    const map: Record<string, string> = { [SPEC_PATH_4]: specYaml };
    const readFile = (p: string): string | null => map[p] ?? null;
    expect(() => loadBuildSpec(SPEC_PATH_4, { readFile })).toThrow(/local/);
  });
});

// A recipe standing in for one whose SUBJECT is a directory (a Terraform
// module's *.tf, an Ansible role's tasks/) rather than one named file — the
// case RecipeIO.listDir exists for. Reports what it saw as embedded params so
// the test can assert on the assembled model, the same style every other
// fixture recipe in this file uses.
const listDirFixtureRecipe: SheetRecipe = {
  name: "listdir-fixture",
  schema: { type: "object", required: ["dir"], properties: { dir: { type: "string" } } },
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const dir = io.resolve(String(sheetSpec.dir));
    const entries = io.listDir?.(dir) ?? null;
    const missing = io.listDir?.(`${dir}-does-not-exist`) ?? null;
    return {
      name: String(sheetSpec.name),
      instances: io.instances,
      layers: [{ kind: "base", entries: new Map() }],
      embedded: [
        { key: "entries", value: JSON.stringify(entries === null ? null : [...entries].sort()), source: { file: dir, line: 1 } },
        { key: "missing", value: JSON.stringify(missing), source: { file: dir, line: 2 } },
      ],
    };
  },
};
registerRecipe(listDirFixtureRecipe);

describe("RecipeIO.listDir — a recipe whose subject is a directory", () => {
  // specDir points at a REAL, already-committed fixture directory (not the
  // in-memory readFile map every other test in this file uses) precisely so
  // io.listDir hits actual readdirSync — this is meant to catch a wiring bug
  // an in-memory stand-in couldn't.
  const FIXTURE_DIR = join(import.meta.dir, "fixtures", "artifact-rows");
  const SPEC_PATH = "/listdir/build.yml";
  const PROJECT_PATH = "/listdir/sheet.yml";

  const specYaml = [
    "version: 1",
    "instances: [prod]",
    "enrich:",
    "  project: sheet.yml",
    "sheets:",
    "  - name: dir-sheet",
    "    recipe: listdir-fixture",
    '    dir: "."',
  ].join("\n");
  const projectYaml = [
    "params:",
    "  entries:",
    "    category: Files",
    "    description: directory entries seen by the recipe",
    "  missing:",
    "    category: Files",
    "    description: probe of a directory that does not exist",
  ].join("\n");
  const map: Record<string, string> = { [SPEC_PATH]: specYaml, [PROJECT_PATH]: projectYaml };
  const readFile = (p: string): string | null => map[p] ?? null;
  // The real implementation (mirrors what src/cli.ts wires up): readdirSync
  // throws on both a missing path and a non-directory one, so one catch
  // covers both "not there" cases the contract asks for.
  const listDir = (path: string): string[] | null => {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  };

  it("sees a real fixture directory's entries; a missing directory yields null", () => {
    const spec = loadBuildSpec(SPEC_PATH, { readFile });
    const input = assembleFromSpec(spec, { readFile, listDir, specDir: FIXTURE_DIR });

    const all = params(input);
    const entries = all.find((p) => p.key === "entries") as SimpleParameter;
    expect(JSON.parse(String(entries.value))).toEqual(["app.conf.j2", "defaults.yml", "rendered.conf"]);
    const missing = all.find((p) => p.key === "missing") as SimpleParameter;
    expect(JSON.parse(String(missing.value))).toBeNull();
  });

  it("a caller that hands in no listDir at all leaves io.listDir undefined, not throwing", () => {
    const spec = loadBuildSpec(SPEC_PATH, { readFile });
    // No `listDir` in opts — the field is optional (RecipeIO.listDir?), so a
    // caller that never constructs one (an out-of-tree recipe user, most
    // existing tests) keeps compiling and behaves as "directory unavailable".
    const input = assembleFromSpec(spec, { readFile, specDir: FIXTURE_DIR });
    const all = params(input);
    expect(JSON.parse(String(all.find((p) => p.key === "entries")?.value))).toBeNull();
  });
});

// A recipe can answer "which component is this row of" per ENTRY rather than
// by building a componentOf map — `templates[].component` becomes
// EmbeddedEntry.component. Reading an absent map as "this sheet has no
// components" then gave every key the SHEET'S OWN NAME as a second component
// beside the real ones, and the rows with no entry-level component — a
// variable no template interpolates — came out under a category level named
// after the sheet, above their own.
describe("assembleFromSpec: components carried on the entries", () => {
  const recipe: SheetRecipe = {
    name: "entry-components",
    schema: { type: "object", properties: {} },
    load(_sheetSpec, io: RecipeIO): SheetInputs {
      return {
        name: "apache",
        instances: io.instances,
        // Two real components, declared per entry, and no componentOf at all —
        // which is what a recipe produces when no row needs one.
        layers: [
          {
            kind: "base",
            entries: new Map([["overlay_only", { value: "false", source: { file: "d.yml", line: 1 } }]]),
          },
        ],
        embedded: [
          { key: "ServerTokens", value: "Prod", source: { file: "a.j2", line: 1 }, component: "httpd.conf" },
          { key: "LoadModule", value: "x", source: { file: "b.j2", line: 1 }, component: "00-mpm.conf" },
        ],
      };
    },
  };

  const files: Record<string, string> = {
    "/s/build.yml":
      "version: 1\ninstances: [production]\nenrich:\n  project: sheet.yml\nsheets:\n  - name: apache\n    recipe: entry-components\n",
    "/s/sheet.yml":
      "sheets:\n  apache:\n    params:\n      overlay_only: { category: Access, description: { en: d } }\n" +
      "      ServerTokens: { category: General, description: { en: d } }\n" +
      "      LoadModule: { category: General, description: { en: d } }\n",
  };

  const build = () => {
    registerRecipe(recipe);
    const spec = loadBuildSpec("/s/build.yml", { readFile: (p) => files[p] ?? null });
    return assembleFromSpec(spec, {
      readFile: (p) => files[p] ?? null,
      specDir: "/s",
      resolve: (p) => `/s/${p}`,
      strictMetadata: false,
    });
  };

  const pathsOf = (input: ParameterSheetInput): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (cats: { name: string; params?: { key: string }[]; categories?: unknown }[], path: string[]): void => {
      for (const c of cats) {
        for (const p of c.params ?? []) out[p.key] = [...path, c.name].join(" > ");
        walk((c.categories ?? []) as never[], [...path, c.name]);
      }
    };
    walk(input.sheets[0].categories as never[], []);
    return out;
  };

  it("does not wrap a componentless row in a level named after the sheet", () => {
    expect(pathsOf(build()).overlay_only).toBe("Access");
  });

  it("leaves the entries' own components alone", () => {
    const paths = pathsOf(build());
    expect(paths.ServerTokens).toBe("httpd.conf > General");
    expect(paths.LoadModule).toBe("00-mpm.conf > General");
  });
});

// A sheet built from SEVERAL recipes. A page of an incumbent parameter sheet is
// a host — its sysctl settings, then its logrotate policy — and which of those
// this tool reads as variables and which as lines of a rendered artifact is an
// accident of the build. It used to decide the tab layout.
describe("a sheet composed from several recipes", () => {
  const partA: SheetRecipe = {
    name: "compose-a",
    schema: { type: "object", properties: { from: { type: "string" } }, additionalProperties: false },
    load: (sheetSpec, io) => ({
      name: String(sheetSpec.name),
      instances: io.instances,
      layers: [{ kind: "base", entries: new Map([["a_key", { value: "1", source: { file: io.resolve("a.yml"), line: 1 } }]]) }],
      embedded: [],
      componentOf: new Map([["a_key", "/etc/one.conf"]]),
      componentFiles: new Map([["/etc/one.conf", { filePath: "/etc/one.conf" }]]),
      componentOrder: ["/etc/one.conf"],
    }),
  };
  const partB: SheetRecipe = {
    name: "compose-b",
    schema: { type: "object", properties: {}, additionalProperties: false },
    load: (sheetSpec, io) => ({
      name: String(sheetSpec.name),
      instances: io.instances,
      layers: [{ kind: "base", entries: new Map([["b_key", { value: "2", source: { file: io.resolve("b.yml"), line: 1 } }]]) }],
      embedded: [],
      componentOf: new Map([["b_key", "/etc/two.conf"]]),
      componentFiles: new Map([["/etc/two.conf", { filePath: "/etc/two.conf" }]]),
      componentOrder: ["/etc/two.conf"],
    }),
  };
  registerRecipe(partA);
  registerRecipe(partB);

  const spec = (parts: string) => `
version: 1
instances: [production]
enrich:
  project: sheet.yml
sheets:
  - name: host
${parts}
`;
  const PARTS = `    parts:
      - recipe: compose-a
      - recipe: compose-b
`;
  const project = `
params:
  a_key: { category: One, description: A }
  b_key: { category: Two, description: B }
`;

  const buildWith = (specYml: string): ParameterSheetInput => {
    const f: Record<string, string> = { "/p/build.yml": specYml, "/p/sheet.yml": project };
    const s = loadBuildSpec("/p/build.yml", { readFile: (p) => f[p] ?? null });
    return assembleFromSpec(s, { readFile: (p) => f[p] ?? null, specDir: "/p" });
  };

  // Rows sit under their component, so this walks the tree rather than
  // flattening one level as the fixture above does.
  const allKeys = (input: ParameterSheetInput): string[] => {
    const out: string[] = [];
    const walk = (cats: { params?: Parameter[]; categories?: unknown[] }[]): void => {
      for (const c of cats) {
        for (const p of c.params ?? []) out.push(p.key);
        walk((c.categories ?? []) as { params?: Parameter[]; categories?: unknown[] }[]);
      }
    };
    for (const s of input.sheets) walk(s.categories ?? []);
    return out;
  };

  it("produces ONE sheet holding every part's rows", () => {
    const input = buildWith(spec(PARTS));
    expect(input.sheets).toHaveLength(1);
    expect(input.sheets[0].name).toBe("host");
    expect(allKeys(input)).toEqual(["a_key", "b_key"]);
  });

  it("keeps each part's components, in the order the parts are written", () => {
    const input = buildWith(spec(PARTS));
    const cats = (input.sheets[0].categories ?? []).map((c) => c.name);
    expect(cats).toEqual(["/etc/one.conf", "/etc/two.conf"]);
  });

  it("refuses a sheet that declares both a recipe and parts", () => {
    expect(() => buildWith(spec(`    recipe: compose-a\n${PARTS}`))).toThrow(/both "recipe" and "parts"/);
  });

  it("refuses a sheet that declares neither", () => {
    expect(() => buildWith(spec("    instances: [production]\n"))).toThrow(/neither "recipe" nor "parts"/);
  });

  // Each part's own recipe fields are checked against ITS recipe's schema, and
  // the error says which part — a typo in the second part reported against the
  // first one's contract would send the reader to the wrong place.
  // A component that IS a file names it as the project wrote it
  // (`/etc/logrotate.d/x`), while the category names it as the sheet displays
  // it. Comparing the two forms directly meant the level named after the file
  // was never folded away, and every such row opened a heading holding one
  // heading of the same name.
  it("does not open a level named after the file inside one named after the file", () => {
    const filePart = (name: string, key: string): SheetRecipe => ({
      name,
      schema: { type: "object", properties: {}, additionalProperties: false },
      load: (sheetSpec, io) => ({
        name: String(sheetSpec.name),
        instances: io.instances,
        layers: [{ kind: "base", entries: new Map([[key, { value: "1", source: { file: io.resolve(`${key}.j2`), line: 1 } }]]) }],
        embedded: [],
        componentOf: new Map([[key, `/etc/logrotate.d/${key}`]]),
        // Both halves, as the ansible recipe supplies them: the row is a line
        // of the DEPLOYED file, written in the template — which is what makes
        // it belong to the artifact rather than to the .j2 it came from.
        componentFiles: new Map([
          [`/etc/logrotate.d/${key}`, { filePath: `/etc/logrotate.d/${key}`, sourceFile: io.resolve(`${key}.j2`) }],
        ]),
        componentOrder: [`/etc/logrotate.d/${key}`],
      }),
    });
    registerRecipe(filePart("compose-file-a", "postgresql"));
    registerRecipe(filePart("compose-file-b", "netstat"));

    const f: Record<string, string> = {
      "/p/build.yml": `
version: 1
instances: [production]
enrich:
  project: sheet.yml
sheets:
  - name: host
    parts:
      - recipe: compose-file-a
      - recipe: compose-file-b
`,
      "/p/sheet.yml": `
sheets:
  host:
    group_by: file
    params:
      postgresql: { description: A }
      netstat: { description: B }
`,
    };
    const input = assembleFromSpec(loadBuildSpec("/p/build.yml", { readFile: (p) => f[p] ?? null }), {
      readFile: (p) => f[p] ?? null,
      specDir: "/p",
    });
    const top = (input.sheets[0].categories ?? []).map((c) => c.name);
    expect(top).toEqual(["/etc/logrotate.d/postgresql", "/etc/logrotate.d/netstat"]);
    // The rows sit directly under it: no second level of the same name.
    expect((input.sheets[0].categories ?? []).map((c) => (c.categories ?? []).length)).toEqual([0, 0]);
    expect((input.sheets[0].categories ?? [])[0].params?.map((p) => p.key)).toEqual(["postgresql"]);
  });

  // The same fold, for a component that is a short ALIAS of the file rather
  // than the path itself — `keycloak.conf` deploying
  // `/opt/keycloak/conf/keycloak.conf`. Two earlier attempts compared NAMES
  // (the raw component against the category, then their display forms) and each
  // worked for the spelling in front of it and broke on the next. The question
  // is whether the component names the same FILE, which componentFiles answers.
  it("folds a level whose component is a short name for the same file", () => {
    const aliasPart = (name: string, alias: string, deployed: string, key: string): SheetRecipe => ({
      name,
      schema: { type: "object", properties: {}, additionalProperties: false },
      load: (sheetSpec, io) => ({
        name: String(sheetSpec.name),
        instances: io.instances,
        layers: [{ kind: "base", entries: new Map([[key, { value: "1", source: { file: io.resolve(`${key}.j2`), line: 1 } }]]) }],
        embedded: [],
        componentOf: new Map([[key, alias]]),
        componentFiles: new Map([[alias, { filePath: deployed, sourceFile: io.resolve(`${key}.j2`) }]]),
        componentOrder: [alias],
      }),
    });
    registerRecipe(aliasPart("alias-a", "keycloak.conf", "/opt/keycloak/conf/keycloak.conf", "hostname"));
    registerRecipe(aliasPart("alias-b", "quarkus.properties", "/opt/keycloak/conf/quarkus.properties", "httpport"));

    const f: Record<string, string> = {
      "/p/build.yml": `
version: 1
instances: [production]
enrich:
  project: sheet.yml
sheets:
  - name: sso
    parts:
      - recipe: alias-a
      - recipe: alias-b
`,
      "/p/sheet.yml": `
sheets:
  sso:
    group_by: file
    params:
      hostname: { description: A }
      httpport: { description: B }
`,
    };
    const input = assembleFromSpec(loadBuildSpec("/p/build.yml", { readFile: (p) => f[p] ?? null }), {
      readFile: (p) => f[p] ?? null,
      specDir: "/p",
    });
    const cats = input.sheets[0].categories ?? [];
    // The component keeps its own short name as the heading...
    expect(cats.map((c) => c.name)).toEqual(["keycloak.conf", "quarkus.properties"]);
    // ...and does not open a second level named after the file it deploys.
    expect(cats.map((c) => (c.categories ?? []).length)).toEqual([0, 0]);
    expect(cats[0].params?.map((p) => p.key)).toEqual(["hostname"]);
  });

  it("validates each part against its own recipe's schema", () => {
    expect(() => buildWith(spec(`    parts:\n      - recipe: compose-a\n        nosuch: 1\n      - recipe: compose-b\n`)))
      .toThrow(/part 1 \(recipe "compose-a"\)/);
  });
});
