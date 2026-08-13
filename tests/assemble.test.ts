import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { assembleSheets, assembleSheetsWithReport, type AssembleOpts, type ExtractedEntry, type ExtractedMap, type SheetInputs } from "../src/assemble";
import { ScaffoldableBuildError, renderScaffold } from "../src/enrich";
import { buildSourceIndex } from "../src/prompt";
import { parse as parseYaml } from "yaml";
import type { InstanceParameter, SimpleParameter } from "../src/types";

// The metadata provider registry (src/metadata.ts) is a process-wide
// singleton, not isolated per test file. Other test files (metadata.test.ts)
// register throwaway providers ("test-a"/"test-b") inside `it()` bodies with
// no cleanup, and since bun runs all test files in one process those linger
// for the rest of the run. assembleSheets has no `providers` override to
// enrich() (its opts are fixed by spec), so — unlike enrich.test.ts, which
// dodges this by passing an explicit providers: [...] allowlist — we neutralize
// any non-core provider before each test here so strict-metadata assertions
// don't depend on cross-file test execution order.
beforeEach(stubNonBuiltInProviders);

const PROJECT_YAML = `
params:
  db_host:
    category: Database
    description: Database host
  db_port:
    category: Database
    description: Database port
  bound_key_mapped:
    category: Database
    description: Bound key via keyMap
  kc_unmapped_thing:
    category: Database
    description: Unmapped bound variable
  embedded_literal:
    category: Embedded
    description: An embedded literal value
  scoped_out_param:
    category: Database
    out_of_scope:
      reason: role-managed, not reviewed
  no_desc_param:
    category: Database
  cat_zebra_1:
    category: Zebra
    description: first zebra
  cat_apple_1:
    category: Apple
    description: first apple
  cat_zebra_2:
    category: Zebra
    description: second zebra
  cat_mango_1:
    category: Mango
    description: first mango
`;

const files: Record<string, string> = { "project.yml": PROJECT_YAML };
const readFile = (p: string): string | null => files[p] ?? null;

// strictMetadata: false by default — PROJECT_YAML above declares far more
// params than any single test's `inputs` sets (they share the fixture), and
// assembleSheetsWithReport now fails the build over an unused project-
// metadata param when strict (see assemble.ts). Individual tests that care
// about strict behavior itself (see "enrich strict (default)" below)
// override it back on explicitly.
function baseOpts(overrides: Partial<AssembleOpts> = {}): AssembleOpts {
  return { projectPath: "project.yml", readFile, strictMetadata: false, ...overrides };
}

function entry(value: string, file = "base.yml", line = 1): ExtractedEntry {
  return { value, source: { file, line } };
}

function map(entries: [string, ExtractedEntry][]): ExtractedMap {
  return new Map(entries);
}

describe("assembleSheets", () => {
  it("classifies Pattern A (common) vs Pattern B (overlay), filling a partial overlay from base", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: ["staging", "production"],
        layers: [
          { kind: "base", entries: map([["db_host", entry("localhost")], ["db_port", entry("5432")]]) },
          { kind: "overlay", instance: "staging", entries: map([["db_host", entry("staging-db", "staging.yml")]]) },
          {
            kind: "overlay",
            instance: "production",
            entries: map([
              ["db_host", entry("prod-db", "prod.yml")],
              ["db_port", entry("5433", "prod.yml")],
            ]),
          },
        ],
        embedded: [],
      },
    ];

    const result = assembleSheets(inputs, baseOpts());
    const params = result.sheets[0].categories[0].params!;
    const dbHost = params.find((p) => p.key === "db_host") as InstanceParameter;
    const dbPort = params.find((p) => p.key === "db_port") as InstanceParameter;

    // db_host: overridden by both overlays -> Pattern B, both instances distinct.
    expect(dbHost.origin).toBe("overlay");
    expect(dbHost.instances).toEqual([
      { name: "staging", value: "staging-db", source: { file: "staging.yml", line: 1 } },
      { name: "production", value: "prod-db", source: { file: "prod.yml", line: 1 } },
    ]);

    // db_port: only production overrides it -> Pattern B, staging falls back to base.
    expect(dbPort.origin).toBe("overlay");
    expect(dbPort.instances).toEqual([
      { name: "staging", value: "5432", source: { file: "base.yml", line: 1 } },
      { name: "production", value: "5433", source: { file: "prod.yml", line: 1 } },
    ]);
  });

  it("keeps a key untouched in any overlay as Pattern A (common)", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: ["staging"],
        layers: [
          { kind: "base", entries: map([["db_host", entry("localhost")]]) },
          { kind: "overlay", instance: "staging", entries: map([]) },
        ],
        embedded: [],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    const dbHost = result.sheets[0].categories[0].params![0] as SimpleParameter;
    expect(dbHost.origin).toBe("common");
    expect(dbHost.value).toBe("localhost");
    expect(dbHost.instances).toBeUndefined();
  });

  it("orders Pattern B instances by SheetInputs.instances, not layer declaration order", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: ["production", "staging"],
        layers: [
          { kind: "base", entries: map([["db_host", entry("localhost")]]) },
          { kind: "overlay", instance: "staging", entries: map([["db_host", entry("staging-db")]]) },
          { kind: "overlay", instance: "production", entries: map([["db_host", entry("prod-db")]]) },
        ],
        embedded: [],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    const dbHost = result.sheets[0].categories[0].params![0] as InstanceParameter;
    expect(dbHost.instances.map((i) => i.name)).toEqual(["production", "staging"]);
  });

  it("keyMap: a mapped variable takes the bound key (and the under_key extra); an unmapped row keeps its own name with no extra at all", () => {
    // under_key is declared in the project metadata (sheet.yml), not on
    // SheetInputs (P7) — a dedicated fixture, since baseOpts()'s shared
    // PROJECT_YAML backs many keyMap-less tests that must not suddenly grow
    // an under_key column.
    //
    // S2: there is no sheet-wide "keying" switch — kc_unmapped_thing has no
    // keyMap entry, so it is just an ordinary row named by its own extracted
    // key, same as any non-templated sheet; tagging it with a redundant
    // under_key entry (equal to its own key) would only repeat the same
    // string in both columns.
    const boundProjectFiles: Record<string, string> = {
      "bound-project.yml": `
under_key:
  id: ansible_var
  label: { en: "Ansible variable", ja: "Ansible 変数" }
params:
  bound_key_mapped:
    category: Database
    description: Bound key via keyMap
  kc_unmapped_thing:
    category: Database
    description: Unmapped, no keyMap entry
`,
    };
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [
          {
            kind: "base",
            entries: map([
              ["kc_db_url", entry("jdbc:postgresql://localhost/kc")],
              ["kc_unmapped_thing", entry("some-value")],
            ]),
          },
        ],
        embedded: [],
        keyMap: [{ boundKey: "bound_key_mapped", variable: "kc_db_url" }],
      },
    ];
    const result = assembleSheets(inputs, {
      projectPath: "bound-project.yml",
      readFile: (p) => boundProjectFiles[p] ?? null,
      strictMetadata: false,
    });
    const params = result.sheets[0].categories[0].params! as SimpleParameter[];

    const mapped = params.find((p) => p.key === "bound_key_mapped")!;
    expect(mapped.value).toBe("jdbc:postgresql://localhost/kc");
    expect(mapped.extra?.ansible_var).toBe("kc_db_url");

    const unmapped = params.find((p) => p.key === "kc_unmapped_thing")!;
    expect(unmapped.value).toBe("some-value");
    expect(unmapped.extra?.ansible_var).toBeUndefined();

    expect(result.columns).toEqual([
      { field: "ansible_var", header: "Ansible variable", header_lang: { ja: "Ansible 変数", en: "Ansible variable" }, place: "under_key" },
    ]);
  });

  it("keyMap: a renamed row's argument_specs.yml entry (keyed by its ORIGINAL variable) still resolves via enrich()", () => {
    // Regression: assembleSheets must thread each keyMap-derived row's
    // backing variable through to enrich() (EnrichOptions.variables), not
    // just into the under_key display column — otherwise a role's
    // argument_specs.yml entry, still written under the Ansible variable
    // name, becomes permanently unreachable once the row is renamed to the
    // product's own key. See src/providers/argument-specs.ts's
    // query.key-then-query.variable fallback.
    const boundProjectFiles: Record<string, string> = {
      "bound-project.yml": `
under_key:
  id: ansible_var
  label: { en: "Ansible variable", ja: "Ansible 変数" }
params:
  max_connections:
    category: Database
`,
      "argument_specs.yml": `
argument_specs:
  main:
    options:
      pg_max_connections:
        type: int
        description: Maximum number of concurrent connections.
`,
    };
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["pg_max_connections", entry("200")]]) }],
        embedded: [],
        keyMap: [{ boundKey: "max_connections", variable: "pg_max_connections" }],
      },
    ];
    const result = assembleSheets(inputs, {
      projectPath: "bound-project.yml",
      readFile: (p) => boundProjectFiles[p] ?? null,
      argumentSpecs: ["argument_specs.yml"],
      strictMetadata: false,
    });
    const params = result.sheets[0].categories[0].params! as SimpleParameter[];
    const param = params.find((p) => p.key === "max_connections")!;
    expect(param.description).toEqual({ en: "Maximum number of concurrent connections." });
    expect(param.extra?.provenance).toBe("community");
  });

  it("a sheet with any keyMap entry and no under_key declared in the project metadata is a hard error", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["kc_db_url", entry("v")]]) }],
        embedded: [],
        keyMap: [{ boundKey: "bound_key_mapped", variable: "kc_db_url" }],
      },
    ];
    expect(() => assembleSheets(inputs, baseOpts())).toThrow(/"app".*keyMap.*under_key/);
  });

  it("appends embedded entries after base-derived params, as Pattern A/embedded", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["db_host", entry("localhost")]]) }],
        embedded: [{ key: "embedded_literal", value: "on", source: { file: "template.j2", line: 3 } }],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    const categoryNames = result.sheets[0].categories.map((c) => c.name);
    expect(categoryNames).toEqual(["Database", "Embedded"]);
    const embedded = result.sheets[0].categories[1].params![0] as SimpleParameter;
    expect(embedded.key).toBe("embedded_literal");
    expect(embedded.origin).toBe("embedded");
    expect(embedded.value).toBe("on");
  });

  it("orders categories by first appearance across the emission order", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [
          {
            kind: "base",
            entries: map([
              ["cat_zebra_1", entry("z1")],
              ["cat_apple_1", entry("a1")],
              ["cat_zebra_2", entry("z2")],
              ["cat_mango_1", entry("m1")],
            ]),
          },
        ],
        embedded: [],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    expect(result.sheets[0].categories.map((c) => c.name)).toEqual(["Zebra", "Apple", "Mango"]);
    const zebra = result.sheets[0].categories[0];
    expect(zebra.params!.map((p) => p.key)).toEqual(["cat_zebra_1", "cat_zebra_2"]);
  });

  it("throws listing every offender when a key has no project metadata category", () => {
    const inputs: SheetInputs[] = [
      {
        name: "ghostsheet",
        instances: [],
        layers: [{ kind: "base", entries: map([["ghost_one", entry("1")], ["ghost_two", entry("2")]]) }],
        embedded: [],
      },
    ];
    expect(() => assembleSheets(inputs, baseOpts())).toThrow(/ghostsheet > ghost_one[\s\S]*ghostsheet > ghost_two/);
  });

  it("throws when a sheet has more than one base layer", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [
          { kind: "base", entries: map([["db_host", entry("1")]]) },
          { kind: "base", entries: map([["db_port", entry("2")]]) },
        ],
        embedded: [],
      },
    ];
    expect(() => assembleSheets(inputs, baseOpts())).toThrow(/exactly one base layer/);
  });

  it("throws when an overlay references an instance not in instances", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: ["staging"],
        layers: [
          { kind: "base", entries: map([["db_host", entry("1")]]) },
          { kind: "overlay", instance: "qa", entries: map([["db_host", entry("2")]]) },
        ],
        embedded: [],
      },
    ];
    expect(() => assembleSheets(inputs, baseOpts())).toThrow(/qa/);
  });

  it("propagates an out_of_scope object from the project metadata to the param", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["scoped_out_param", entry("x")]]) }],
        embedded: [],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    const param = result.sheets[0].categories[0].params![0];
    expect(param.out_of_scope).toEqual({ reason: "role-managed, not reviewed" });
  });

  it("enrich strict (default) throws for an undocumented in-scope param while an out_of_scope one is exempt", () => {
    // A dedicated, exact-match project metadata (not the shared PROJECT_YAML,
    // which declares far more params than this test's two-key `inputs` —
    // baseOpts() defaults strictMetadata off precisely to dodge that mismatch,
    // but THIS test wants strict genuinely on, so it needs a fixture with no
    // unused param of its own to trip over).
    const strictFiles: Record<string, string> = {
      "strict-project.yml": `
params:
  no_desc_param:
    category: Database
  scoped_out_param:
    category: Database
    out_of_scope:
      reason: role-managed, not reviewed
`,
    };
    const strictReadFile = (p: string): string | null => strictFiles[p] ?? null;
    const strictOpts = (overrides: Partial<AssembleOpts> = {}): AssembleOpts => ({
      projectPath: "strict-project.yml",
      readFile: strictReadFile,
      ...overrides,
    });

    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [
          {
            kind: "base",
            entries: map([
              ["no_desc_param", entry("x")],
              ["scoped_out_param", entry("y")],
            ]),
          },
        ],
        embedded: [],
      },
    ];
    expect(() => assembleSheets(inputs, strictOpts())).toThrow(/no_desc_param/);
    try {
      assembleSheets(inputs, strictOpts());
      throw new Error("expected assembleSheets to throw");
    } catch (e) {
      expect(String(e)).not.toMatch(/scoped_out_param/);
    }

    // strictMetadata:false lets it through, leaving description unset.
    const result = assembleSheets(inputs, strictOpts({ strictMetadata: false }));
    const noDesc = result.sheets[0].categories[0].params!.find((p) => p.key === "no_desc_param")!;
    expect(noDesc.description).toBeUndefined();
  });
});

// The counterpart to the strict-metadata gate: that one catches a parameter with
// no description, this one catches a description with no parameter. A recipe's
// normalization filter that matches nothing (the PoC's case: filtering on
// `Entry.key`, the leaf name, when the address lives in `Entry.source.path`)
// removes rows with no other symptom — the sheet is simply shorter.
describe("assembleSheetsWithReport — project metadata that no sheet used", () => {
  const oneSheet = (keys: string[]): SheetInputs[] => [
    {
      name: "app",
      instances: [],
      layers: [{ kind: "base", entries: map(keys.map((k) => [k, entry("v")] as [string, ExtractedEntry])) }],
      embedded: [],
    },
  ];

  it("reports each described key that never appeared", () => {
    const { unusedProjectParams } = assembleSheetsWithReport(oneSheet(["db_host"]), baseOpts());
    expect(unusedProjectParams).toContain("db_port");
    expect(unusedProjectParams).not.toContain("db_host");
  });

  it("does not report a key some OTHER sheet in the same build used", () => {
    const inputs: SheetInputs[] = [
      ...oneSheet(["db_host"]),
      { name: "other", instances: [], layers: [{ kind: "base", entries: map([["db_port", entry("v")]]) }], embedded: [] },
    ];
    const { unusedProjectParams } = assembleSheetsWithReport(inputs, baseOpts());
    expect(unusedProjectParams).not.toContain("db_host");
    expect(unusedProjectParams).not.toContain("db_port");
  });

  it("counts an out-of-scope row as used (it is on the sheet, just excluded)", () => {
    const { unusedProjectParams } = assembleSheetsWithReport(oneSheet(["db_host", "scoped_out_param"]), baseOpts());
    expect(unusedProjectParams).not.toContain("scoped_out_param");
  });

  it("is empty when every described key is assembled", () => {
    const all = ["db_host", "db_port", "bound_key_mapped", "kc_unmapped_thing", "embedded_literal",
      "scoped_out_param", "no_desc_param", "cat_zebra_1", "cat_apple_1", "cat_zebra_2", "cat_mango_1"];
    const { unusedProjectParams } = assembleSheetsWithReport(oneSheet(all), baseOpts({ strictMetadata: false }));
    expect(unusedProjectParams).toEqual([]);
  });
});

// unusedProjectParams promoted from a report-only field (above, exercised
// with strictMetadata: false) to a build failure under strict — the default
// everywhere except this test file's own baseOpts() (see its comment).
describe("unusedProjectParams strict: warning promoted to a build failure", () => {
  const oneSheet = (keys: string[]): SheetInputs[] => [
    {
      name: "app",
      instances: [],
      layers: [{ kind: "base", entries: map(keys.map((k) => [k, entry("v")] as [string, ExtractedEntry])) }],
      embedded: [],
    },
  ];

  it("fails the build, naming every unused key, when strictMetadata is on", () => {
    expect(() => assembleSheets(oneSheet(["db_host"]), baseOpts({ strictMetadata: true }))).toThrow(/db_port/);
  });

  it("suggests the nearest assembled key for a likely typo/rename", () => {
    // "db_port" is one edit away from "db_host", the only key actually
    // assembled — close enough that the hint should fire.
    try {
      assembleSheets(oneSheet(["db_host"]), baseOpts({ strictMetadata: true }));
      throw new Error("expected assembleSheets to throw");
    } catch (e) {
      expect(String(e)).toMatch(/db_port \(did you mean "db_host"\?\)/);
    }
  });

  it("does not throw, and still reports, when strictMetadata is off", () => {
    const { unusedProjectParams } = assembleSheetsWithReport(oneSheet(["db_host"]), baseOpts({ strictMetadata: false }));
    expect(unusedProjectParams).toContain("db_port");
  });
});

// T2: binding moved to a single phase (bind.ts), running on every draft
// before materialize and before filing — the group fallback below is the
// asymmetry that phase closes (previously only materialize's own rows read
// a dictionary's `group`; every other row had to hand-write `category:` even
// when it was already bound to a dictionary entry that carries one).
describe("bind integration: group-category fallback", () => {
  const DICT_YAML = `
product: widget
version: "1"
coverage: full
parameters:
  max_size:
    description: { en: Maximum size }
    group: Tuning
  ungrouped_setting:
    description: { en: No group of its own }
`;
  // No `params:` at all by default — dictionary bindings stay an AssembleOpts
  // field (see opts() below); `categories:` (P7) is now part of the project
  // metadata file itself, so each test below states its own via
  // `projectYaml()`.
  const PROJECT_YAML_NO_CATEGORY = ``;
  const projectYaml = (categories: string[] | undefined, extra = ""): string =>
    (categories ? `categories: [${categories.join(", ")}]\n` : "") + (extra || "params: {}\n");
  const files: Record<string, string> = {
    "project.yml": PROJECT_YAML_NO_CATEGORY,
    "meta/widget@1.yml": DICT_YAML,
  };
  const readFile = (p: string): string | null => files[p] ?? null;

  function opts(overrides: Partial<AssembleOpts> = {}): AssembleOpts {
    return {
      projectPath: "project.yml",
      metadataDirs: ["meta"],
      readFile,
      dictionaries: { app: [{ product: "widget", version: "1" }] },
      ...overrides,
    };
  }

  function oneSheet(keys: string[]): SheetInputs[] {
    return [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map(keys.map((k) => [k, entry("v")] as [string, ExtractedEntry])) }],
        embedded: [],
      },
    ];
  }

  it("files a row with no project category under its bound dictionary entry's group — no hand-written category needed", () => {
    const result = assembleSheets(
      oneSheet(["max_size"]),
      opts({ readFile: (p) => (p === "project.yml" ? projectYaml(["Tuning"]) : files[p] ?? null) })
    );
    expect(result.sheets[0].categories.map((c) => c.name)).toEqual(["Tuning"]);
    expect(result.sheets[0].categories[0].params!.map((p) => p.key)).toEqual(["max_size"]);
  });

  it("without a declared categories: list, a group-derived category is free to appear, in first-appearance order", () => {
    // No `categories:` declared at all — a sheet that never states one stays
    // exactly as free as before the P7 ghost-tab guard existed.
    const result = assembleSheets(oneSheet(["max_size", "ungrouped_setting"]), opts());
    expect(result.sheets[0].categories.map((c) => c.name)).toEqual(["Tuning", "Uncategorized"]);
  });

  it("bound entry with no `group` of its own still resolves (Uncategorized), never an error, when nothing is declared", () => {
    const result = assembleSheets(oneSheet(["ungrouped_setting"]), opts());
    expect(result.sheets[0].categories.map((c) => c.name)).toEqual(["Uncategorized"]);
  });

  // P7/P10: the ghost-tab guard. Once a sheet declares its tab list, a
  // PROJECT-WRITTEN category (a hand-typed `category:` in sheet.yml) that
  // isn't on it is a hard, named error — the fix for the real, observed bug
  // (a typo'd `category:` silently producing a new tab, no error, no
  // warning: "verify: 2 ok, 0 warn, 0 error / tabs: ['General', 'Generl']").
  it("declaring categories: turns a used-but-undeclared PROJECT category into a hard, named ghost-tab error", () => {
    const typoProject = `
categories: [Tuning]
params:
  totally_unbound_key:
    category: Tunning
    description: typo'd category, unrelated to any dictionary
`;
    const result = (): unknown =>
      assembleSheets(
        oneSheet(["totally_unbound_key"]),
        opts({ readFile: (p) => (p === "project.yml" ? typoProject : files[p] ?? null) })
      );
    expect(result).toThrow(/app > totally_unbound_key/);
    expect(result).toThrow(/"Tunning"/);
    expect(result).toThrow(/Tuning/);
  });

  // P10 bug 2: an undeclared category reached ONLY through a bound
  // dictionary entry's own `group` fallback (no hand-written `category:`) is
  // a fact about the PRODUCT, not something the project typed — it can never
  // be a project typo, so declaring `categories:` on a sheet must not force
  // enumerating every dictionary group a bound param happens to fall into.
  // This warns (and still builds), unlike the project-typed case above.
  it("an undeclared category reached only via a dictionary group fallback warns, but does not fail the build", () => {
    const { input, categoryWarnings } = assembleSheetsWithReport(
      oneSheet(["max_size", "ungrouped_setting"]),
      opts({ readFile: (p) => (p === "project.yml" ? projectYaml(["Tuning"]) : files[p] ?? null) })
    );
    expect(input.sheets[0].categories.map((c) => c.name)).toEqual(["Tuning", "Uncategorized"]);
    expect(categoryWarnings).toHaveLength(1);
    expect(categoryWarnings[0]).toMatch(/app > ungrouped_setting/);
    expect(categoryWarnings[0]).toMatch(/"Uncategorized"/);
    expect(categoryWarnings[0]).toMatch(/Tuning/);
  });

  it("a project category still wins over the group fallback", () => {
    const withCategory = `
categories: [Sizing]
params:
  max_size:
    category: Sizing
`;
    const result = assembleSheets(
      oneSheet(["max_size"]),
      opts({ readFile: (p) => (p === "project.yml" ? withCategory : files[p] ?? null) })
    );
    expect(result.sheets[0].categories.map((c) => c.name)).toEqual(["Sizing"]);
  });

  it("a key with no project category AND no binding is still a hard error", () => {
    expect(() => assembleSheets(oneSheet(["totally_unbound_key"]), opts())).toThrow(/totally_unbound_key/);
  });
});

// T2: the BindingReport assembleSheetsWithReport now returns — the whole
// build's key resolution against its bound dictionaries, by tier (see
// bind.ts's BindMethod), plus a raw row per bound draft.
describe("bind integration: BindingReport", () => {
  const DICT_YAML = `
product: widget
version: "1"
coverage: full
parameters:
  max_size:
    description: { en: Maximum size }
    group: Tuning
  MaxRetries:
    description: { en: Retry cap }
    group: Tuning
`;
  const PROJECT_YAML = `
categories: [Tuning]
params:
  widget_max_retries:
    category: Tuning
    dict_key: MaxRetries
`;
  const files: Record<string, string> = {
    "project.yml": PROJECT_YAML,
    "meta/widget@1.yml": DICT_YAML,
  };
  const readFile = (p: string): string | null => files[p] ?? null;
  const opts: AssembleOpts = {
    projectPath: "project.yml",
    metadataDirs: ["meta"],
    readFile,
    dictionaries: { app: [{ product: "widget", version: "1" }] },
  };

  it("reports one row per bound draft, with its method, product and dictKey", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["max_size", entry("v")], ["widget_max_retries", entry("v")]]) }],
        embedded: [],
      },
    ];
    const { binding } = assembleSheetsWithReport(inputs, opts);
    expect(binding.rows).toEqual([
      { sheet: "app", key: "max_size", dictKey: "max_size", method: "exact", product: "widget", version: "1" },
      { sheet: "app", key: "widget_max_retries", dictKey: "MaxRetries", method: "alias", product: "widget", version: "1" },
    ]);
    expect(binding.byMethod.exact).toBe(1);
    expect(binding.byMethod.alias).toBe(1);
    expect(binding.byMethod.normalized).toBe(0);
  });

  it("a project-metadata-described key that is never drafted is simply absent from the report, not an error", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["max_size", entry("v")]]) }],
        embedded: [],
      },
    ];
    // widget_max_retries isn't set here, so only max_size's row should appear
    // (and widget_max_retries itself goes unused — not this test's concern).
    const { binding } = assembleSheetsWithReport(inputs, { ...opts, strictMetadata: false });
    expect(binding.rows.map((r) => r.key)).toEqual(["max_size"]);
  });

  it('a drafted key that matches no dictionary entry gets a "none" row — reported, not silently omitted', () => {
    const projectYaml = `
categories: [Tuning]
params:
  stray_key:
    category: Tuning
`;
    const localFiles: Record<string, string> = { "project.yml": projectYaml, "meta/widget@1.yml": DICT_YAML };
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["max_size", entry("v")], ["stray_key", entry("v")]]) }],
        embedded: [],
      },
    ];
    const { binding } = assembleSheetsWithReport(inputs, {
      projectPath: "project.yml",
      metadataDirs: ["meta"],
      readFile: (p) => localFiles[p] ?? null,
      dictionaries: { app: [{ product: "widget", version: "1" }] },
      strictMetadata: false,
    });
    expect(binding.rows).toEqual([
      { sheet: "app", key: "max_size", dictKey: "max_size", method: "exact", product: "widget", version: "1" },
      { sheet: "app", key: "stray_key", method: "none" },
    ]);
    expect(binding.byMethod.none).toBe(1);
    expect(binding.byMethod.exact).toBe(1);
  });

  it("an ambiguous bind fails the build unconditionally, even with strictMetadata off", () => {
    const collidingDict = `
product: widget
version: "1"
coverage: full
parameters:
  foo-bar: { description: { en: kebab spelling } }
  FooBar: { description: { en: PascalCase spelling } }
`;
    const collidingFiles: Record<string, string> = {
      "project.yml": `
categories: [Tuning]
params:
  foo_bar:
    category: Tuning
`,
      "meta/widget@1.yml": collidingDict,
    };
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["foo_bar", entry("v")]]) }],
        embedded: [],
      },
    ];
    expect(() =>
      assembleSheets(inputs, {
        projectPath: "project.yml",
        metadataDirs: ["meta"],
        readFile: (p) => collidingFiles[p] ?? null,
        dictionaries: { app: [{ product: "widget", version: "1" }] },
        strictMetadata: false,
      })
    ).toThrow(/ambiguous/);
  });
});

// T5: formalizing a workflow a PoC clean-room user invented on their own —
// run the build once against an empty `params:`, transcribe the exact key
// list the error printed straight into sheet.yml. assembleSheets now throws
// a ScaffoldableBuildError (instead of a plain Error) for exactly this
// failure, carrying the paste-able fragment's raw material.
describe("scaffold: paste-able params: snippet on a strict failure", () => {
  it("round-trips: pasting the generated snippet for a no-category/no-binding failure lets the build pass", () => {
    const scaffoldFiles: Record<string, string> = {
      "scaffold-project.yml": `
params: {}
`,
    };
    const scaffoldOpts = (): AssembleOpts => ({
      projectPath: "scaffold-project.yml",
      readFile: (p) => scaffoldFiles[p] ?? null,
    });

    // Three keys with no project category and no dictionary counterpart at
    // all (no `dictionaries:` declared) — the exact shape of the PoC's T5
    // static_files fallout (long structural-path keys nobody wrote down yet).
    const inputs: SheetInputs[] = [
      {
        name: "demo",
        instances: [],
        layers: [{ kind: "base", entries: map([]) }],
        embedded: [
          { key: "kc_db_secret_name", value: "kc-secret", source: { file: "x.j2", line: 1 } },
          { key: "kc_db_secret_region", value: "us-east-1", source: { file: "x.j2", line: 2 } },
          { key: "kc_aws_endpoint_url", value: "", source: { file: "x.j2", line: 3 } },
        ],
      },
    ];

    let caught: unknown;
    try {
      assembleSheets(inputs, scaffoldOpts());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScaffoldableBuildError);
    const err = caught as ScaffoldableBuildError;
    expect(err.entries.map((e) => e.key)).toEqual(["kc_db_secret_name", "kc_db_secret_region", "kc_aws_endpoint_url"]);
    expect(err.entries.every((e) => e.needsCategory && e.needsDescription && e.binding === undefined)).toBe(true);
    expect(err.shape).toBe("flat"); // scaffold-project.yml on disk is flat

    const scaffold = renderScaffold(err.entries, err.shape);
    expect(scaffold).toContain("params:");

    // The one non-negotiable constraint on the fragment: it must be valid,
    // paste-able YAML, not just plausible-looking text.
    const parsed = parseYaml(scaffold) as { params: Record<string, unknown> };
    expect(Object.keys(parsed.params).sort()).toEqual(["kc_aws_endpoint_url", "kc_db_secret_name", "kc_db_secret_region"]);

    // Paste it in — replace the empty params: {} with the generated block,
    // same as the PoC anecdote's starting point.
    scaffoldFiles["scaffold-project.yml"] = scaffold;

    // Rebuild: no further manual edits — the build now passes outright.
    const result = assembleSheets(inputs, scaffoldOpts());
    expect(result.sheets[0].categories).toHaveLength(1);
    expect(result.sheets[0].categories[0].name).toBe("TODO");
    const params = result.sheets[0].categories[0].params ?? [];
    expect(params.map((p) => p.key).sort()).toEqual(["kc_aws_endpoint_url", "kc_db_secret_name", "kc_db_secret_region"]);
    for (const p of params) {
      expect(p.description).toEqual({ en: "TODO", ja: "TODO" });
    }
  });

  it("round-trips a sheet whose components share a key, which a flat fragment could not even parse", () => {
    // Two rendered artifacts on one sheet, both with a Description= line. Keys
    // are unique WITHIN a component, not across them, so a fragment that lists
    // both at the sheet level repeats the same map key — YAML rejects that
    // outright, and the reader is handed a fragment they cannot paste. It is
    // also two different parameters: one description cannot be true of both.
    const scaffoldFiles: Record<string, string> = { "p.yml": `sheets:\n  demo:\n    params: {}\n` };
    const scaffoldOpts = (): AssembleOpts => ({ projectPath: "p.yml", readFile: (f) => scaffoldFiles[f] ?? null });
    const inputs: SheetInputs[] = [
      {
        name: "demo",
        instances: [],
        layers: [{ kind: "base", entries: map([]) }],
        embedded: [
          { key: "Unit.Description", value: "the server", source: { file: "a.j2", line: 1 }, component: "a.service" },
          { key: "Unit.Description", value: "its secrets", source: { file: "b.j2", line: 1 }, component: "b.service" },
        ],
      },
    ];

    let caught: unknown;
    try {
      assembleSheets(inputs, scaffoldOpts());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScaffoldableBuildError);
    const err = caught as ScaffoldableBuildError;
    expect(err.entries.map((e) => e.component)).toEqual(["a.service", "b.service"]);

    const scaffold = renderScaffold(err.entries, err.shape);
    const parsed = parseYaml(scaffold) as {
      sheets: Record<string, { components: Record<string, { params: Record<string, unknown> }> }>;
    };
    expect(Object.keys(parsed.sheets.demo.components)).toEqual(["a.service", "b.service"]);
    for (const c of ["a.service", "b.service"]) {
      expect(Object.keys(parsed.sheets.demo.components[c]!.params)).toEqual(["Unit.Description"]);
    }

    // And it is paste-able: the build passes with no further edits, each
    // component keeping its own entry.
    scaffoldFiles["p.yml"] = scaffold;
    const result = assembleSheets(inputs, scaffoldOpts());
    const components = result.sheets[0].categories.map((c) => c.name);
    expect(components).toEqual(["a.service", "b.service"]);
  });

  it("quotes a key with structural-path characters ([, ], .) so the fragment stays valid YAML", () => {
    const entries = [
      {
        sheet: "realm",
        key: 'clients[0].attributes["saml.client.signature"]',
        needsCategory: true,
        needsDescription: true,
      },
    ];
    const scaffold = renderScaffold(entries, "flat");
    const parsed = parseYaml(scaffold) as { params: Record<string, unknown> };
    expect(Object.keys(parsed.params)).toEqual(['clients[0].attributes["saml.client.signature"]']);
  });

  it("an unused project param also throws a ScaffoldableBuildError, rendered as a comment checklist (not an addable entry)", () => {
    const files: Record<string, string> = {
      "unused-project.yml": `
params:
  db_host:
    category: Database
    description: Database host
  db_por:
    category: Database
    description: A likely typo of db_port
`,
    };
    const inputs: SheetInputs[] = [
      { name: "app", instances: [], layers: [{ kind: "base", entries: map([["db_host", entry("v")]]) }], embedded: [] },
    ];
    let caught: unknown;
    try {
      assembleSheets(inputs, { projectPath: "unused-project.yml", readFile: (p) => files[p] ?? null, strictMetadata: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScaffoldableBuildError);
    const err = caught as ScaffoldableBuildError;
    expect(err.entries).toEqual([{ sheet: "", key: "db_por", needsCategory: false, needsDescription: false, unused: true, hint: undefined }]);
    expect(err.shape).toBe("flat");

    const scaffold = renderScaffold(err.entries, err.shape);
    expect(scaffold).toContain("#   db_por");
    // A comment-only document is still valid YAML (parses to nothing worth
    // acting on) — no top-level `params:` key to accidentally merge in.
    expect(parseYaml(scaffold)).toBeNull();
  });
});

// P4: sheet.yml's `params:` used to be ONE namespace for the whole spec.
// assemble.ts looked keys up with a bare `projectMeta.params[d.key]` — no
// sheet in the lookup at all — so two sheets sharing a key (typically two
// Ansible roles reading the same group_vars file) shared whatever category/
// description that key had, regardless of which sheet actually declared it.
// The PoC's own incident: `httpd_server_name` leaked into the "keycloak
// configuration" sheet's drafts and picked up the httpd sheet's `category:
// General` — no error, nothing to notice. These tests reproduce that shape
// directly against assemble.ts and confirm a `sheets:`-namespaced project
// metadata doc closes it: a leaked key finds nothing under ITS sheet's own
// table and trips the ordinary "no category" gate instead.
describe("sheet-namespaced project metadata closes cross-sheet leakage (P4)", () => {
  function twoSheets(sheetAKey: string, sheetBKey: string): SheetInputs[] {
    return [
      { name: "sheet a", instances: [], layers: [{ kind: "base", entries: map([[sheetAKey, entry("a-value")]]) }], embedded: [] },
      { name: "sheet b", instances: [], layers: [{ kind: "base", entries: map([[sheetBKey, entry("b-value")]]) }], embedded: [] },
    ];
  }

  it("BEFORE the fix's shape (a flat doc): a key declared for one sheet quietly documents the SAME key drafted by an unrelated sheet", () => {
    const files: Record<string, string> = {
      "flat.yml": `
params:
  shared_key:
    category: General
    description: declared for sheet a only, in intent
`,
    };
    // Both sheets happen to draft "shared_key" (e.g. a shared group_vars file
    // with no exclude filter) — under a flat doc there is exactly one params
    // table, so BOTH sheets resolve the same category/description, and the
    // build passes with no error at all. This is the bug P4 exists to close.
    const result = assembleSheets(twoSheets("shared_key", "shared_key"), {
      projectPath: "flat.yml",
      readFile: (p) => files[p] ?? null,
      strictMetadata: false,
    });
    const catA = result.sheets[0].categories[0];
    const catB = result.sheets[1].categories[0];
    expect(catA.name).toBe("General");
    expect(catB.name).toBe("General"); // leaked in, undetected
  });

  it("names the declared project metadata file when it does not exist (a typo must not read as 'these params need a category')", () => {
    let caught: unknown;
    try {
      assembleSheets(twoSheets("shared_key", "shared_key"), {
        projectPath: "sheeeet.yml", // typo: nothing at this path
        readFile: () => null,
        strictMetadata: false,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScaffoldableBuildError);
    // The build deliberately continues past a missing file so a FIRST build gets
    // a scaffold rather than a hard stop — but then the path has to reach the
    // output, or pasting into the sheet.yml one actually has changes nothing.
    expect((caught as ScaffoldableBuildError).missingProjectPath).toBe("sheeeet.yml");
    const scaffold = renderScaffold(
      (caught as ScaffoldableBuildError).entries,
      (caught as ScaffoldableBuildError).shape,
      (caught as ScaffoldableBuildError).missingProjectPath
    );
    expect(scaffold).toContain("sheeeet.yml");
    expect(scaffold).toContain("does not exist");
  });

  it("AFTER the fix (a sheets: doc): the same shape fails strict — the leaked key has no category under its OWN sheet", () => {
    const files: Record<string, string> = {
      "sheeted.yml": `
sheets:
  "sheet a":
    params:
      shared_key:
        category: General
        description: declared for sheet a
  "sheet b":
    params: {}
`,
    };
    let caught: unknown;
    try {
      assembleSheets(twoSheets("shared_key", "shared_key"), {
        projectPath: "sheeted.yml",
        readFile: (p) => files[p] ?? null,
        strictMetadata: false,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScaffoldableBuildError);
    expect((caught as Error).message).toContain("sheet b > shared_key");

    // P6: the failure spans only ONE sheet ("sheet b") — but the target file
    // on disk is `sheets:`-shaped, so the scaffold must match THAT, not the
    // failure's own (single-sheet) span. Before the fix, renderScaffold chose
    // its shape from how many sheets appeared among the failing entries, so a
    // single-sheet failure against a sheets: doc rendered an unpasteable flat
    // params: fragment.
    const err = caught as ScaffoldableBuildError;
    expect(err.shape).toBe("sheets");
    const scaffold = renderScaffold(err.entries, err.shape);
    const parsed = parseYaml(scaffold) as { sheets: Record<string, { params: Record<string, unknown> }> };
    expect(Object.keys(parsed.sheets)).toEqual(["sheet b"]);
    expect(Object.keys(parsed.sheets["sheet b"].params)).toEqual(["shared_key"]);
  });

  it("two sheets may use the same key for two genuinely different parameters, each resolved from its own sheet's table", () => {
    const files: Record<string, string> = {
      "sheeted.yml": `
sheets:
  "sheet a":
    params:
      shared_key:
        category: A-category
        description: meaning in sheet a
  "sheet b":
    params:
      shared_key:
        category: B-category
        description: meaning in sheet b
`,
    };
    const result = assembleSheets(twoSheets("shared_key", "shared_key"), {
      projectPath: "sheeted.yml",
      readFile: (p) => files[p] ?? null,
      strictMetadata: false,
    });
    expect(result.sheets[0].categories[0].name).toBe("A-category");
    expect(result.sheets[1].categories[0].name).toBe("B-category");
    const paramA = result.sheets[0].categories[0].params![0];
    const paramB = result.sheets[1].categories[0].params![0];
    expect(paramA.description).toBe("meaning in sheet a");
    expect(paramB.description).toBe("meaning in sheet b");
  });

  it("unusedProjectParams is scoped per sheet: a key declared for sheet A stays unused for A even when sheet B independently drafts the same key name", () => {
    const files: Record<string, string> = {
      "sheeted.yml": `
sheets:
  "sheet a":
    params:
      only_in_a:
        category: General
        description: declared here, but sheet a never produces it
  "sheet b":
    params:
      only_in_a:
        category: Other
        description: sheet b's own, unrelated parameter of the same name
`,
    };
    // sheet a produces nothing at all; sheet b produces a draft named
    // "only_in_a" (coincidentally the same spelling sheet.yml used under
    // sheet a). A build-wide "was this key used anywhere" check would wrongly
    // call sheet a's declaration used; the per-sheet check must not.
    const inputs: SheetInputs[] = [
      { name: "sheet a", instances: [], layers: [{ kind: "base", entries: map([]) }], embedded: [] },
      { name: "sheet b", instances: [], layers: [{ kind: "base", entries: map([["only_in_a", entry("b-value")]]) }], embedded: [] },
    ];
    const { unusedProjectParams } = assembleSheetsWithReport(inputs, {
      projectPath: "sheeted.yml",
      readFile: (p) => files[p] ?? null,
      strictMetadata: false,
    });
    expect(unusedProjectParams).toEqual(["sheet a > only_in_a"]);
  });

  it("a sheets: doc naming a sheet this build has no SheetInputs for fails the build (stale name / typo)", () => {
    const files: Record<string, string> = {
      "sheeted.yml": `
sheets:
  "typo sheet name":
    params: {}
`,
    };
    const inputs: SheetInputs[] = [
      { name: "real sheet", instances: [], layers: [{ kind: "base", entries: map([]) }], embedded: [] },
    ];
    expect(() =>
      assembleSheets(inputs, { projectPath: "sheeted.yml", readFile: (p) => files[p] ?? null, strictMetadata: false })
    ).toThrow(/typo sheet name/);
  });
});

// T5: SheetInputs.referenceSites — a recipe's substitution scan (src/substitution.ts)
// hands assembleSheets() a variable-keyed list of reference sites, and
// buildDrafts() attaches them (as `additional_sources`) to whatever row that
// variable ends up producing. Uses a `ref: string` marker on each site so
// verify/apply (T2/T3) can tell it apart from a same-value additional source
// — irrelevant to attachment itself, so these fixtures just carry `ref` for
// realism, not because assemble.ts inspects it.
describe("SheetInputs.referenceSites: attaching additional_sources from a substitution scan", () => {
  const refSite = (file: string, ref: string) => ({ file, line: 3, anchor: ref, path: ref, ref });

  it("a Pattern A row (base-only key) carries the sites", () => {
    const sites = [refSite("poc.yml", "$(env:DB_HOST)")];
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["db_host", entry("localhost")]]) }],
        embedded: [],
        referenceSites: [{ variable: "db_host", sites }],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    const dbHost = result.sheets[0].categories[0].params!.find((p) => p.key === "db_host") as SimpleParameter;
    expect(dbHost.origin).toBe("common");
    expect(dbHost.additional_sources).toEqual(sites);
  });

  it("a Pattern B row (base + overlay) carries the sites", () => {
    const sites = [refSite("poc.yml", "$(env:DB_HOST)")];
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: ["staging"],
        layers: [
          { kind: "base", entries: map([["db_host", entry("localhost")]]) },
          { kind: "overlay", instance: "staging", entries: map([["db_host", entry("staging-db")]]) },
        ],
        embedded: [],
        referenceSites: [{ variable: "db_host", sites }],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    const dbHost = result.sheets[0].categories[0].params!.find((p) => p.key === "db_host") as InstanceParameter;
    expect(dbHost.origin).toBe("overlay");
    expect(dbHost.additional_sources).toEqual(sites);
  });

  it("an overlay-only key (never in base) carries the sites too", () => {
    const sites = [refSite("poc.yml", "$(env:DB_PORT)")];
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: ["staging"],
        layers: [
          { kind: "base", entries: map([]) },
          { kind: "overlay", instance: "staging", entries: map([["db_port", entry("5432")]]) },
        ],
        embedded: [],
        referenceSites: [{ variable: "db_port", sites }],
      },
    ];
    const result = assembleSheets(inputs, baseOpts());
    const dbPort = result.sheets[0].categories[0].params!.find((p) => p.key === "db_port") as InstanceParameter;
    expect(dbPort.additional_sources).toEqual(sites);
  });

  it("a referenceSites entry naming a variable that produces no draft at all is a hard error", () => {
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["db_host", entry("localhost")]]) }],
        embedded: [],
        referenceSites: [{ variable: "no_such_variable", sites: [refSite("poc.yml", "$(env:X)")] }],
      },
    ];
    expect(() => assembleSheets(inputs, baseOpts())).toThrow(/no_such_variable.*produced no draft/);
  });

  it("a keyMap'd row still gets BOTH the under_key extra and the sites", () => {
    const boundProjectFiles: Record<string, string> = {
      "bound-project.yml": `
under_key:
  id: ansible_var
  label: { en: "Ansible variable", ja: "Ansible 変数" }
params:
  bound_key_mapped:
    category: Database
    description: Bound key via keyMap
`,
    };
    const sites = [refSite("poc.yml", "$(env:KC_DB_URL)")];
    const inputs: SheetInputs[] = [
      {
        name: "app",
        instances: [],
        layers: [{ kind: "base", entries: map([["kc_db_url", entry("jdbc:postgresql://localhost/kc")]]) }],
        embedded: [],
        keyMap: [{ boundKey: "bound_key_mapped", variable: "kc_db_url" }],
        referenceSites: [{ variable: "kc_db_url", sites }],
      },
    ];
    const result = assembleSheets(inputs, {
      projectPath: "bound-project.yml",
      readFile: (p) => boundProjectFiles[p] ?? null,
      strictMetadata: false,
    });
    const mapped = result.sheets[0].categories[0].params!.find((p) => p.key === "bound_key_mapped") as SimpleParameter;
    expect(mapped.extra?.ansible_var).toBe("kc_db_url");
    expect(mapped.additional_sources).toEqual(sites);
  });
});

// A category was one level, and the second level of a path was always the
// component. `Tokens / Access tokens` looked like nesting and was one name with
// a slash in it — the dictionary's own group. A project can now say the path.
describe("nested categories", () => {
  const files: Record<string, string> = {};
  const opts = (): AssembleOpts => ({ projectPath: "p.yml", readFile: (f) => files[f] ?? null });
  const inputs = (component?: string): SheetInputs[] => [
    {
      name: "realm",
      instances: [],
      layers: [{ kind: "base", entries: map([]) }],
      embedded: [
        { key: "accessTokenLifespan", value: "60", source: { file: "r.yml", line: 1 }, ...(component ? { component } : {}) },
        { key: "refreshTokenMaxReuse", value: "0", source: { file: "r.yml", line: 2 }, ...(component ? { component } : {}) },
        ...(component ? [{ key: "other", value: "x", source: { file: "r.yml", line: 3 }, component: "second" }] : []),
      ],
    },
  ];
  const pathsOf = (input: ReturnType<typeof assembleSheets>, key: string): string[][] => {
    const out: string[][] = [];
    const walk = (cats: { name: string; params?: { key: string }[]; categories?: unknown[] }[] | undefined, trail: string[]): void => {
      for (const c of cats ?? []) {
        for (const p of c.params ?? []) if (p.key === key) out.push([...trail, c.name]);
        walk(c.categories as typeof cats, [...trail, c.name]);
      }
    };
    walk(input.sheets[0].categories, []);
    return out;
  };

  it("files a row under the whole path", () => {
    files["p.yml"] = `
categories: [Tokens]
params:
  accessTokenLifespan: { category: [Tokens, Access tokens], description: d }
  refreshTokenMaxReuse: { category: [Tokens, Refresh tokens], description: d }
`;
    const input = assembleSheets(inputs(), opts());
    expect(pathsOf(input, "accessTokenLifespan")).toEqual([["Tokens", "Access tokens"]]);
    expect(pathsOf(input, "refreshTokenMaxReuse")).toEqual([["Tokens", "Refresh tokens"]]);
    // One parent, shared: the two paths must not have produced two "Tokens".
    expect(input.sheets[0].categories.map((c) => c.name)).toEqual(["Tokens"]);
  });

  it("only the first segment is a tab, so only it has to be declared", () => {
    // "Access tokens" is NOT in categories: and must not be reported as a ghost
    // tab — it is not a tab. Declaring every inner level would make one fact
    // declarable in two places, which is how the two drift apart.
    files["p.yml"] = `
categories: [Tokens]
params:
  accessTokenLifespan: { category: [Tokens, Access tokens], description: d }
  refreshTokenMaxReuse: { category: Tokens, description: d }
`;
    const warnings: string[] = [];
    const spy = console.warn;
    console.warn = (m: string) => void warnings.push(String(m));
    try {
      assembleSheets(inputs(), opts());
    } finally {
      console.warn = spy;
    }
    expect(warnings.join("\n")).not.toContain("Access tokens");
  });

  it("nests underneath the component, which stays outermost", () => {
    files["p.yml"] = `
sheets:
  realm:
    categories: [Tokens]
    params:
      accessTokenLifespan: { category: [Tokens, Access tokens], description: d }
      refreshTokenMaxReuse: { category: [Tokens, Access tokens], description: d }
      other: { category: Tokens, description: d }
`;
    const input = assembleSheets(inputs("poc"), opts());
    expect(pathsOf(input, "accessTokenLifespan")).toEqual([["poc", "Tokens", "Access tokens"]]);
  });

  it("treats a one-element list exactly like the bare string", () => {
    files["p.yml"] = `
categories: [Tokens]
params:
  accessTokenLifespan: { category: [Tokens], description: d }
  refreshTokenMaxReuse: { category: Tokens, description: d }
`;
    const input = assembleSheets(inputs(), opts());
    expect(pathsOf(input, "accessTokenLifespan")).toEqual([["Tokens"]]);
    expect(pathsOf(input, "refreshTokenMaxReuse")).toEqual([["Tokens"]]);
  });

  it("is reachable as a review target, so apply can find the row", () => {
    // Nesting that only existed in the rendering would be a trap: a finding
    // filed against the row would name a category nothing indexes. The target
    // path is the segments joined, at any depth.
    files["p.yml"] = `
categories: [Tokens]
params:
  accessTokenLifespan: { category: [Tokens, Access tokens], description: d }
  refreshTokenMaxReuse: { category: Tokens, description: d }
`;
    const input = assembleSheets(inputs(), opts());
    const index = buildSourceIndex({ sheets: input.sheets });
    expect([...index.keys()]).toContain("realm::Tokens/Access tokens::accessTokenLifespan");
    expect([...index.keys()]).toContain("realm::Tokens::refreshTokenMaxReuse");
  });

  it("refuses an empty list, which is one spelling away from `category: null`", () => {
    files["p.yml"] = `
categories: [Tokens]
params:
  accessTokenLifespan: { category: [], description: d }
`;
    expect(() => assembleSheets(inputs(), opts())).toThrow(
      /"accessTokenLifespan" has an empty category list.*category: null/s
    );
  });
});

// Sheet groups: display structure only, and checked both ways like every other
// declared list here.
describe("sheet groups", () => {
  const files: Record<string, string> = {};
  const opts = (): AssembleOpts => ({ projectPath: "p.yml", readFile: (f) => files[f] ?? null });
  const twoSheets = (): SheetInputs[] =>
    ["a", "b"].map((n) => ({
      name: n,
      instances: [],
      layers: [{ kind: "base", entries: map([]) }],
      embedded: [{ key: `${n}_key`, value: "v", source: { file: "f.yml", line: 1 } }],
    }));

  it("carries the declared groups and each sheet's own", () => {
    files["p.yml"] = `
groups:
  - name: infra
    label: { ja: 基盤, en: Infrastructure }
  - name: app
sheets:
  a: { group: infra, params: { a_key: { category: C, description: d } } }
  b: { group: app, params: { b_key: { category: C, description: d } } }
`;
    const input = assembleSheets(twoSheets(), opts());
    expect(input.groups).toEqual([{ name: "infra", label: { ja: "基盤", en: "Infrastructure" } }, { name: "app" }]);
    expect(input.sheets.map((s) => s.group)).toEqual(["infra", "app"]);
  });

  it("fails on a group no sheet belongs to, with the same discipline as a category nobody used", () => {
    files["p.yml"] = `
groups: [{ name: infra }, { name: app }, { name: forgotten }]
sheets:
  a: { group: infra, params: { a_key: { category: C, description: d } } }
  b: { group: app, params: { b_key: { category: C, description: d } } }
`;
    expect(() => assembleSheets(twoSheets(), opts())).toThrow(/declared sheet group\(s\) that no sheet belongs to: forgotten/);
  });

  it("fails on a sheet naming a group nobody declared, and suggests the near miss", () => {
    files["p.yml"] = `
groups: [{ name: infra }, { name: app }]
sheets:
  a: { group: infr, params: { a_key: { category: C, description: d } } }
  b: { group: app, params: { b_key: { category: C, description: d } } }
`;
    expect(() => assembleSheets(twoSheets(), opts())).toThrow(/not declared.*"infr".*did you mean.*infra/is);
  });

  it("fails on an ungrouped sheet once the document groups at all", () => {
    // A grouped header has nowhere to put it: neither a group of its own nor
    // inside one, and either choice would be an invention.
    files["p.yml"] = `
groups: [{ name: infra }]
sheets:
  a: { group: infra, params: { a_key: { category: C, description: d } } }
  b: { params: { b_key: { category: C, description: d } } }
`;
    expect(() => assembleSheets(twoSheets(), opts())).toThrow(/sheet\(s\) with no "group:".*b/s);
  });

  it("fails on a group declared nowhere at all, rather than inventing a heading", () => {
    files["p.yml"] = `
sheets:
  a: { group: infra, params: { a_key: { category: C, description: d } } }
  b: { params: { b_key: { category: C, description: d } } }
`;
    expect(() => assembleSheets(twoSheets(), opts())).toThrow(/declares no "groups:" list: a/);
  });

  it("leaves a document that declares none exactly as it was", () => {
    files["p.yml"] = `
sheets:
  a: { params: { a_key: { category: C, description: d } } }
  b: { params: { b_key: { category: C, description: d } } }
`;
    const input = assembleSheets(twoSheets(), opts());
    expect(input.groups).toBeUndefined();
    expect(input.sheets.every((s) => s.group === undefined)).toBe(true);
  });
});

// Reading order is a decision the spec makes; the order rows reach the
// assembler is not one.
describe("component order follows the declaration", () => {
  const files: Record<string, string> = { "p.yml": `sheets:\n  s:\n    params: {}\n` };
  const opts = (): AssembleOpts => ({ projectPath: "p.yml", readFile: (f) => files[f] ?? null });
  // "second" reaches the assembler first — the shape a shared layer produces
  // when one component's values arrive through it and another's are literal.
  const inputs = (order?: string[]): SheetInputs[] => [
    {
      name: "s",
      instances: [],
      layers: [{ kind: "base", entries: map([]) }],
      embedded: [
        { key: "a", value: "1", source: { file: "f", line: 1 }, component: "second" },
        { key: "a", value: "2", source: { file: "f", line: 2 }, component: "first" },
      ],
      ...(order ? { componentOrder: order } : {}),
    },
  ];

  it("puts the components in the order the spec lists them", () => {
    files["p.yml"] = `sheets:\n  s:\n    params:\n      a: { category: C, description: d }\n`;
    const input = assembleSheets(inputs(["first", "second"]), opts());
    expect(input.sheets[0].categories.map((c) => c.name)).toEqual(["first", "second"]);
  });

  it("falls back to first appearance when the spec declares no order", () => {
    files["p.yml"] = `sheets:\n  s:\n    params:\n      a: { category: C, description: d }\n`;
    const input = assembleSheets(inputs(), opts());
    expect(input.sheets[0].categories.map((c) => c.name)).toEqual(["second", "first"]);
  });
});
