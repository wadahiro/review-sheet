import { describe, it, expect } from "bun:test";
import { enrich, ScaffoldableBuildError, renderScaffold, formatProvenance } from "../src/enrich";
import { getMetadataProvider } from "../src/metadata";
import type { SimpleParameter } from "../src/types";
import "../src/providers/index";
import { parse as parseYaml } from "yaml";
import type { ParameterSheetInput } from "../src/types";

// Dictionary bindings are no longer part of the project metadata file (see
// providers/project.ts) — enrich() called standalone (not via assembleSheets)
// takes them as an explicit `dictionaries` option instead (see opts() below).
const PROJECT_YAML = `
params:
  nginx_listen_port:
    dict_key: listen
  nginx_server_name:
    remarks: Per-environment FQDN
`;

const ARGUMENT_SPECS_YAML = `
argument_specs:
  main:
    options:
      pg_max_connections:
        type: int
        description: Maximum concurrent connections (from argument_specs).
`;

const NGINX_DICT_YAML = `
product: nginx
version: "1.26"
provenance: official
parameters:
  listen:
    description: Listen port
    default: 80
    docs_url: https://nginx.org/en/docs/http/ngx_http_core_module.html#listen
  worker_connections:
    description: Max connections per worker
    default: 512
`;

const PG_DICT_YAML = `
product: postgresql
version: "16"
provenance: extracted
parameters:
  max_connections:
    description: Maximum concurrent connections (from dictionary, should lose to argument_specs).
    default: 100
  work_mem:
    description: Memory for sort/hash operations.
    default: 4MB
  replicas:
    description: Number of replica instances.
`;

const files: Record<string, string> = {
  "sheet.yml": PROJECT_YAML,
  "roles/postgresql/meta/argument_specs.yml": ARGUMENT_SPECS_YAML,
  "metadata/nginx@1.26.yml": NGINX_DICT_YAML,
  "metadata/postgresql@16.yml": PG_DICT_YAML,
};
const readFile = (p: string): string | null => files[p] ?? null;

function baseInput(): ParameterSheetInput {
  return {
    sheets: [
      {
        name: "nginx",
        categories: [
          {
            name: "Network",
            params: [
              { key: "nginx_listen_port", value: "8080", source: { file: "defaults.yml", line: 1 } },
              {
                key: "nginx_server_name",
                value: "example.com",
                description: "preset description",
                default: "preset-default",
              },
            ],
          },
          {
            name: "Performance",
            params: [{ key: "nginx_worker_connections", value: "1024" }],
          },
          {
            name: "Fixed",
            out_of_scope: { reason: "role-managed" },
            params: [{ key: "nginx_undocumented_fixed_thing", value: "on" }],
          },
        ],
      },
      {
        name: "postgresql",
        categories: [
          {
            name: "Tunables",
            params: [
              { key: "pg_max_connections", value: "200" },
              { key: "pg_work_mem", value: "4MB" },
              {
                key: "pg_replicas",
                instances: [
                  { name: "staging", value: "1" },
                  { name: "production", value: "3" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const providers = [
  getMetadataProvider("project")!,
  getMetadataProvider("argument-specs")!,
  getMetadataProvider("dictionary")!,
];

function opts(overrides: Partial<Parameters<typeof enrich>[1]> = {}) {
  return {
    readFile,
    project: "sheet.yml",
    metadataDirs: ["metadata"],
    argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"],
    dictionaries: [
      { product: "nginx", version: "1.26", key_prefix: "nginx_" },
      { product: "postgresql", version: "16", key_prefix: "pg_" },
    ],
    providers,
    ...overrides,
  };
}

describe("enrich", () => {
  it("merges project metadata + argument-specs + dictionary end-to-end via dict_key routing", () => {
    const { input } = enrich(baseInput(), opts());
    const nginxNet = input.sheets[0].categories[0].params![0];
    expect(nginxNet.description).toBe("Listen port");
    expect(nginxNet.default).toBe("80");
    expect(nginxNet.extra?.docs_url).toBe(
      "https://nginx.org/en/docs/http/ngx_http_core_module.html#listen"
    );
    expect(nginxNet.extra?.provenance).toBe("official");
  });

  it("resolves a plain-prefix key via dictionary without a project metadata override", () => {
    const { input } = enrich(baseInput(), opts());
    const worker = input.sheets[0].categories[1].params![0];
    expect(worker.description).toBe("Max connections per worker");
    expect(worker.default).toBe("512");
    expect(worker.extra?.provenance).toBe("official");
  });

  it("prefers argument-specs description over dictionary (priority order), dictionary still fills default", () => {
    const { input } = enrich(baseInput(), opts());
    const pgMax = input.sheets[1].categories[0].params![0];
    // argument-specs (priority 50) is a native English channel — it now
    // returns { en: ... } (see providers/argument-specs.ts), so it wins the
    // `en` slot outright but does not lock the whole field the way a bare
    // string used to. The dictionary (priority 30) still gets consulted for
    // any language key argument-specs left open; its own description is a
    // plain string (no `ja` of its own either), which per mergeLangField's
    // documented trade-off fills the still-missing `ja` slot with that same
    // English text rather than leaving it empty.
    expect(pgMax.description).toEqual({
      en: "Maximum concurrent connections (from argument_specs).",
      ja: "Maximum concurrent connections (from dictionary, should lose to argument_specs).",
    });
    expect(pgMax.default).toBe("100");
    // `en` truthfully traces to argument-specs (community) and `ja` to the
    // dictionary (extracted) — a genuine two-provider split, not the old
    // "whichever provider filled the field first" approximation, which
    // would have wrongly reported the whole thing as "community".
    expect(pgMax.extra?.provenance).toBe("en: community / ja: extracted");
  });

  it("nativeLang: 'ja' routes argument-specs' text into the ja slot instead of en", () => {
    const { input } = enrich(baseInput(), opts({ nativeLang: "ja" }));
    const pgMax = input.sheets[1].categories[0].params![0];
    // With nativeLang: "ja", argument-specs' text is tagged { ja: ... } (see
    // MetadataContext.nativeLang), so it claims the `ja` slot and the
    // dictionary's plain-string description (still the only source with a
    // shot at `en`) fills the still-missing `en` slot instead.
    expect(pgMax.description).toEqual({
      ja: "Maximum concurrent connections (from argument_specs).",
      en: "Maximum concurrent connections (from dictionary, should lose to argument_specs).",
    });
  });

  it("resolves a second dictionary-only param with extracted provenance", () => {
    const { input } = enrich(baseInput(), opts());
    const pgWorkMem = input.sheets[1].categories[0].params![1];
    expect(pgWorkMem.description).toBe("Memory for sort/hash operations.");
    expect(pgWorkMem.extra?.provenance).toBe("extracted");
  });

  it("never overwrites a preset description/default, and sets no extra.provenance for it", () => {
    const { input } = enrich(baseInput(), opts());
    const serverName = input.sheets[0].categories[0].params![1];
    expect(serverName.description).toBe("preset description");
    expect(serverName.default).toBe("preset-default");
    expect(serverName.extra?.provenance).toBeUndefined();
    // remarks was unset, so the project metadata's remarks IS filled in
    expect(serverName.remarks).toBe("Per-environment FQDN");
  });

  it("leaves value/source untouched and never mutates the original input (purity)", () => {
    const original = baseInput();
    const before = JSON.stringify(original);
    const { input } = enrich(original, opts());
    expect(JSON.stringify(original)).toBe(before);

    // Parameter is SimpleParameter | InstanceParameter and only the former
    // carries `source`; this row is a simple one by construction above.
    const nginxNet = input.sheets[0].categories[0].params![0] as SimpleParameter;
    expect(nginxNet.value).toBe("8080");
    expect(nginxNet.source).toEqual({ file: "defaults.yml", line: 1 });
  });

  it("fills InstanceParameter base fields but leaves instances[] untouched", () => {
    const { input } = enrich(baseInput(), opts());
    const replicas = input.sheets[1].categories[0].params![2];
    expect(replicas.description).toBe("Number of replica instances.");
    expect(replicas.instances).toEqual([
      { name: "staging", value: "1" },
      { name: "production", value: "3" },
    ]);
  });

  it("skips out-of-scope params entirely (no metadata query, exempt from strict)", () => {
    const { input, report } = enrich(baseInput(), opts());
    const fixed = input.sheets[0].categories[2].params![0];
    expect(fixed.description).toBeUndefined();
    expect(fixed.extra).toBeUndefined();
    expect(report.missing.some((m) => m.key === "nginx_undocumented_fixed_thing")).toBe(false);
  });

  it("throws in strict mode (default) listing offenders as 'sheet > category > key'", () => {
    expect(() =>
      enrich(baseInput(), opts({ project: undefined, argumentSpecs: [], metadataDirs: [], dictionaries: [] }))
    ).toThrow(/nginx > Network > nginx_listen_port/);
  });

  it("returns without throwing when strict:false, with report.missing populated", () => {
    const { report } = enrich(
      baseInput(),
      opts({ project: undefined, argumentSpecs: [], metadataDirs: [], dictionaries: [], strict: false })
    );
    expect(report.missing.length).toBeGreaterThan(0);
    expect(report.missing.some((m) => m.sheet === "nginx" && m.category === "Network" && m.key === "nginx_listen_port")).toBe(
      true
    );
  });

  it("reports byProvider contribution counts and filled count", () => {
    const { report } = enrich(baseInput(), opts());
    expect(report.byProvider.dictionary).toBeGreaterThan(0);
    expect(report.byProvider["argument-specs"]).toBeGreaterThan(0);
    expect(report.byProvider.project).toBeGreaterThan(0);
    // 3 nginx params + 2 pg params get filled (pg_replicas has no metadata source, excluded)
    expect(report.filled).toBeGreaterThanOrEqual(4);
  });
});

// Regression (S2 + argument_specs.yml): a row whose key was renamed away from
// its Ansible variable (assemble.ts's keyMap — e.g. pg_max_connections's row
// is now keyed "max_connections") used to make its argument_specs.yml entry
// permanently unreachable, since the provider only ever matched query.key.
// EnrichOptions.variables (built by assembleSheets from Draft.variable) lets
// enrich() pass the row's ORIGINAL variable name through as a fallback — see
// metadata.ts's MetadataQuery.variable and providers/argument-specs.ts.
describe("enrich: EnrichOptions.variables (argument_specs.yml reachable after a keyMap rename)", () => {
  function renamedInput(): ParameterSheetInput {
    return {
      sheets: [
        {
          name: "postgresql",
          categories: [
            {
              name: "Tunables",
              // Renamed by keyMap: the row's key is now the product's own
              // pg_settings name, not the Ansible variable argument_specs.yml
              // documents it under.
              params: [{ key: "max_connections", value: "200" }],
            },
          ],
        },
      ],
    };
  }

  it("without `variables`, the row falls through to the dictionary (argument_specs.yml unreachable)", () => {
    const { input } = enrich(renamedInput(), opts());
    const param = input.sheets[0].categories[0].params![0];
    expect(param.description).toBe("Maximum concurrent connections (from dictionary, should lose to argument_specs).");
    expect(param.extra?.provenance).toBe("extracted");
  });

  it("with `variables`, argument_specs.yml's entry (keyed by the original variable) wins again", () => {
    const variables = new Map([["postgresql", new Map([["max_connections", "pg_max_connections"]])]]);
    const { input } = enrich(renamedInput(), opts({ variables }));
    const param = input.sheets[0].categories[0].params![0];
    expect(param.description).toEqual({
      en: "Maximum concurrent connections (from argument_specs).",
      ja: "Maximum concurrent connections (from dictionary, should lose to argument_specs).",
    });
    // Same truthful split as the non-renamed case above: en/community from
    // argument-specs, ja/extracted from the dictionary.
    expect(param.extra?.provenance).toBe("en: community / ja: extracted");
  });

  it("a `variables` entry for a DIFFERENT sheet has no effect (per-sheet, not global)", () => {
    const variables = new Map([["some other sheet", new Map([["max_connections", "pg_max_connections"]])]]);
    const { input } = enrich(renamedInput(), opts({ variables }));
    const param = input.sheets[0].categories[0].params![0];
    expect(param.extra?.provenance).toBe("extracted");
  });
});

// T5: the missing-description strict failure is the SECOND round of a real
// project's discovered scaffold workflow (assemble.test.ts covers the first — no
// category). Unlike that one, a key here is already filed under a category,
// so the scaffold only needs to add `description:`.
describe("scaffold: missing-description strict failure", () => {
  it("throws a ScaffoldableBuildError with a description-only entry for an unbound key", () => {
    const input: ParameterSheetInput = {
      sheets: [{ name: "app", categories: [{ name: "Misc", params: [{ key: "mystery_thing", value: "x" }] }] }],
    };
    let caught: unknown;
    try {
      enrich(input, { readFile: () => null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScaffoldableBuildError);
    const err = caught as ScaffoldableBuildError;
    expect(err.entries).toEqual([
      { sheet: "app", key: "mystery_thing", needsCategory: false, needsDescription: true, binding: undefined },
    ]);
    expect(err.shape).toBe("flat"); // no project file to match — single sheet, flat default

    const scaffold = renderScaffold(err.entries, err.shape);
    expect(scaffold).toContain('"mystery_thing":');
    expect(scaffold).not.toContain("category:"); // already filed — only description is missing
    const parsed = parseYaml(scaffold) as { params: Record<string, { description: { en: string; ja: string } }> };
    expect(parsed.params.mystery_thing.description).toEqual({ en: "TODO", ja: "TODO" });
  });

  it("names the binding when a bound key resolves, but the DICTIONARY entry itself has no description", () => {
    const dictFiles: Record<string, string> = {
      "sheet.yml": `
params:
  widget_mystery:
    category: Tuning
`,
      "metadata/widget@1.yml": `
product: widget
version: "1"
parameters:
  mystery:
    default: 1
`,
    };
    const input: ParameterSheetInput = {
      sheets: [{ name: "app", categories: [{ name: "Tuning", params: [{ key: "widget_mystery", value: "1" }] }] }],
    };
    let caught: unknown;
    try {
      enrich(input, {
        readFile: (p) => dictFiles[p] ?? null,
        project: "sheet.yml",
        metadataDirs: ["metadata"],
        dictionaries: [{ product: "widget", version: "1", key_prefix: "widget_" }],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ScaffoldableBuildError);
    const err = caught as ScaffoldableBuildError;
    expect(err.entries[0].binding).toMatchObject({ product: "widget", version: "1", dictKey: "mystery", method: "prefix" });
    expect(err.shape).toBe("flat"); // sheet.yml on disk is flat — matches its shape

    const scaffold = renderScaffold(err.entries, err.shape);
    expect(scaffold).toContain("# binds: widget@1 mystery (prefix)");
    expect(scaffold).toContain("the dictionary entry has no description");
    // Still valid, paste-able YAML.
    const parsed = parseYaml(scaffold) as { params: Record<string, unknown> };
    expect(Object.keys(parsed.params)).toEqual(["widget_mystery"]);
  });
});

// formatProvenance: the string form written into extra.provenance (a plain
// string field — see the doc comment in src/enrich.ts). Covers every shape
// LangProvenance can take, independent of the full enrich() pipeline above.
describe("formatProvenance", () => {
  it("a scalar passes through unchanged — today's output, for every unmigrated dictionary", () => {
    expect(formatProvenance("official")).toBe("official");
    expect(formatProvenance("community")).toBe("community");
  });

  it("a map where both languages agree collapses to the bare token", () => {
    expect(formatProvenance({ en: "extracted", ja: "extracted" })).toBe("extracted");
  });

  it("a map with only one language present renders that language's bare token", () => {
    expect(formatProvenance({ en: "official" })).toBe("official");
    expect(formatProvenance({ ja: "community" })).toBe("community");
  });

  it("a genuinely split map renders the fixed-order joined string", () => {
    expect(formatProvenance({ en: "official", ja: "community" })).toBe("en: official / ja: community");
    // Fixed order (en before ja) regardless of key insertion order.
    expect(formatProvenance({ ja: "community", en: "official" })).toBe("en: official / ja: community");
  });
});

// End-to-end proof that the overlay merge (T3, findDictionary in
// providers/dictionary.ts) reaches a materialized/enriched row with NO change
// to enrich() itself — findDictionary is the one function loadBindSources
// (which this standalone bind pass runs through) loads a whole dictionary
// with, so the merge already happened before the dictionary provider (or
// enrich) ever sees this key.
describe("enrich: overlay-merged dictionary text reaches the sheet unchanged by consumer", () => {
  const WIDGET_BASE = `
product: widget
version: "1"
provenance: extracted
parameters:
  db:
    description: The database vendor.
    default: dev-file
`;
  const WIDGET_OVERLAY = `
product: widget
version: "1"
provenance: community
parameters:
  db:
    description:
      ja: 使用するデータベースベンダー。
`;
  const overlayFiles: Record<string, string> = {
    "sheet.yml": "params:\n  widget_db: {}\n",
    "metadata/widget@1.yml": WIDGET_BASE,
    "metadata/widget@1.overlay.yml": WIDGET_OVERLAY,
  };
  const overlayReadFile = (p: string): string | null => overlayFiles[p] ?? null;

  it("a materialized row carries the overlay's ja text and split provenance", () => {
    const input: ParameterSheetInput = {
      sheets: [
        {
          name: "widget",
          categories: [{ name: "General", params: [{ key: "widget_db", value: "postgresql", source: { file: "x.yml", line: 1 } }] }],
        },
      ],
    };
    const { input: out } = enrich(input, {
      readFile: overlayReadFile,
      project: "sheet.yml",
      metadataDirs: ["metadata"],
      dictionaries: [{ product: "widget", version: "1", key_prefix: "widget_" }],
      providers: [getMetadataProvider("project")!, getMetadataProvider("dictionary")!],
    });
    const row = out.sheets[0].categories[0].params![0];
    expect(row.description).toEqual({ en: "The database vendor.", ja: "使用するデータベースベンダー。" });
    // en falls through to the doc's own "extracted"; ja is the overlay's
    // "community" gap-fill — exactly the split provenance the design exists
    // to make representable, reaching the sheet with no enrich.ts change.
    expect(row.extra?.provenance).toBe("en: extracted / ja: community");
  });
});
