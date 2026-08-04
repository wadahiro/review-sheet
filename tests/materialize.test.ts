// materialize: expand a bound product dictionary into a sheet as
// `origin: "default"` rows, so the sheet is the exhaustive ledger of the
// product's parameters and not just the subset the project happens to set.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { assembleSheets, assembleSheetsWithReport, type AssembleOpts, type SheetDictionaryBinding, type SheetInputs } from "../src/assemble";
import type { Parameter, ParameterSheetInput, SimpleParameter } from "../src/types";

// The metadata provider registry is a process-wide singleton (see
// assemble.test.ts for the full rationale).
beforeEach(stubNonBuiltInProviders);

// Dictionary bindings are per-sheet (AssembleOpts.dictionaries), not part of
// the project metadata file — see providers/project.ts. `categories:` (P7) IS
// part of the project metadata, alongside `params:`, below.
const PROJECT_YAML = `
categories: [Tuning]
params:
  db_max_conn:
    category: Tuning
  db_alias_key:
    category: Tuning
    dict_key: aliased
  standalone:
    category: Tuning
  work_mem:
    category: Tuning
    out_of_scope:
      reason: 別チーム管理のため
      owner: DBA
  # No dict_key: covered by bind.ts's leaf tier (the last identity-bearing
  # segment of the structural path), not by an alias — see the "REPEATED
  # (indexed) key" test below.
  "listen_directive[0]":
    category: Tuning
  "listen_directive[1]":
    category: Tuning
`;

// Covered three different ways (raw key, key_prefix strip, dict_key alias) plus
// three genuinely unset ones — one of which the project metadata marks
// out_of_scope, and one with no `group`.
const DICT_YAML = `
product: demodb
version: "1"
provenance: extracted
coverage: full
parameters:
  max_conn:
    description: { en: Maximum connections }
    default: 100
    group: Connections
  aliased:
    description: { en: An aliased setting }
    default: "on"
    group: Connections
  standalone:
    description: { en: Keyed exactly as the project keys it }
    default: "1"
    group: Connections
  work_mem:
    description: { en: Working memory per sort }
    default: 4MB
    group: Memory
  wal_level:
    description: { en: How much information is written to the WAL }
    default: replica
    group: Write-Ahead Log
  no_group_setting:
    description: { en: A setting the dictionary does not group }
    default: "off"
  listen_directive:
    description: { en: A directive that can appear more than once }
    default: ""
    group: Connections
  container_setting:
    description: { en: A syntax container, not a setting }
    group: Connections
    kind: container
`;

const files: Record<string, string> = {
  "project.yml": PROJECT_YAML,
  "meta/demodb@1.yml": DICT_YAML,
};
const readFile = (p: string): string | null => files[p] ?? null;

function sheetInputs(keys: string[]): SheetInputs[] {
  return [
    {
      name: "db",
      instances: [],
      layers: [
        {
          kind: "base",
          entries: new Map(keys.map((k) => [k, { value: "set", source: { file: "base.yml", line: 1 } }])),
        },
      ],
      embedded: [],
    },
  ];
}

// strictMetadata: false — most tests below exercise ONE sheetInputs subset
// against the full PROJECT_YAML fixture (db_alias_key/standalone/
// listen_directive[0]/[1] are declared for the handful of tests that
// actually set them), so the rest would otherwise trip the new
// unusedProjectParams build failure (see assemble.ts) over a fixture concern
// unrelated to what each test is actually checking.
//
// `materialize: true` (expand every group) is the default, matching the old
// top-level `materialize: [{ sheet: "db", product: "demodb", version: "1" }]`
// (no `groups` filter). Individual tests override `dictionaries.db` wholesale
// to narrow it.
function opts(overrides: Partial<AssembleOpts> = {}): AssembleOpts {
  return {
    projectPath: "project.yml",
    metadataDirs: ["meta"],
    readFile,
    dictionaries: { db: [{ product: "demodb", version: "1", key_prefix: "db_", materialize: true }] },
    strictMetadata: false,
    ...overrides,
  };
}

// Convenience for tests that only need to swap `dictionaries.db`'s
// `materialize` instruction, keeping product/version/key_prefix fixed.
function dictOpts(materialize: SheetDictionaryBinding["materialize"], overrides: Partial<AssembleOpts> = {}): AssembleOpts {
  return opts({
    dictionaries: { db: [{ product: "demodb", version: "1", key_prefix: "db_", materialize }] },
    ...overrides,
  });
}

// Materialized rows are filed two levels deep (a parent "defaults" category,
// then a subcategory per dictionary group — see fileDrafts in assemble.ts),
// so both helpers below recurse through `Category.categories`.
function paramsOf(cat: { params?: Parameter[]; categories?: unknown[] }): Parameter[] {
  const cats = (cat.categories ?? []) as Array<{ params?: Parameter[]; categories?: unknown[] }>;
  return [...(cat.params ?? []), ...cats.flatMap(paramsOf)];
}

function params(input: ParameterSheetInput): Parameter[] {
  return input.sheets.flatMap((s) => (s.categories ?? []).flatMap(paramsOf));
}

// The immediate (leaf-most) category name a key was filed under.
function categoryOf(input: ParameterSheetInput, key: string): string | undefined {
  function search(cat: { name: string; params?: Parameter[]; categories?: unknown[] }): string | undefined {
    if ((cat.params ?? []).some((p) => p.key === key)) return cat.name;
    for (const child of (cat.categories ?? []) as Array<{ name: string; params?: Parameter[]; categories?: unknown[] }>) {
      const found = search(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const cat of input.sheets[0].categories ?? []) {
    const found = search(cat as { name: string; params?: Parameter[]; categories?: unknown[] });
    if (found !== undefined) return found;
  }
  return undefined;
}

describe("materialize", () => {
  // The three ways a dictionary key can already be covered — all must be
  // recognized, or the sheet grows a duplicate row for a parameter it sets.
  it("adds only the dictionary keys the sheet does not already cover", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn", "db_alias_key", "standalone"]), opts());
    const all = params(input);

    expect(all.filter((p) => p.origin === "default").map((p) => p.key)).toEqual([
      "work_mem",
      "wal_level",
      "no_group_setting",
      "listen_directive",
    ]);
    // key_prefix strip, dict_key alias and the raw key each covered one.
    expect(all.filter((p) => p.key === "max_conn")).toEqual([]);
    expect(all.filter((p) => p.key === "aliased")).toEqual([]);
    expect(all.filter((p) => p.key === "standalone").length).toBe(1);
    expect(all.find((p) => p.key === "standalone")?.origin).toBe("common");
  });

  // A structural parser (httpd.ts, nginx.ts, ...) indexes a directive that
  // appears more than once in one file (`listen_directive[0]`,
  // `listen_directive[1]`) rather than emitting it once. Before bind.ts's
  // `leaf` tier, materialize's `covered` set only ever saw the
  // exact indexed strings, never the bare directive name — so a directive the
  // project genuinely sets (twice) would ALSO come back as an unreviewed
  // `origin: "default"` row, telling the reviewer "this project never sets
  // listen_directive" while two rows right above it say otherwise.
  it("does not re-materialize a directive already covered by a REPEATED (indexed) key", () => {
    const input = assembleSheets(
      sheetInputs(["db_max_conn", "db_alias_key", "standalone", "listen_directive[0]", "listen_directive[1]"]),
      opts()
    );
    const all = params(input);

    // Both occurrences kept, each documented from the dictionary via the
    // index-stripped fallback (strict metadata would otherwise fail the build).
    expect(all.filter((p) => p.key === "listen_directive[0]" || p.key === "listen_directive[1]").length).toBe(2);
    for (const p of all) {
      if (p.key === "listen_directive[0]" || p.key === "listen_directive[1]") {
        expect(p.description).toEqual({ en: "A directive that can appear more than once" });
      }
    }
    // No third, bare "listen_directive" default row.
    expect(all.some((p) => p.key === "listen_directive")).toBe(false);
    expect(all.filter((p) => p.origin === "default").map((p) => p.key)).toEqual([
      "work_mem",
      "wal_level",
      "no_group_setting",
    ]);
  });

  it("materialized rows carry the product default as their value, and no source", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn", "db_alias_key", "standalone"]), opts());
    const wal = params(input).find((p) => p.key === "wal_level") as SimpleParameter;

    expect(wal.value).toBe("replica");
    expect(wal.source).toBeUndefined();
    expect(wal.origin).toBe("default");
    // enrich filled the documentation from the same dictionary entry, so strict
    // metadata passes with nothing hand-authored.
    expect(wal.description).toEqual({ en: "How much information is written to the WAL" });
    expect(wal.default).toBe("replica");
  });

  it("files materialized rows by the dictionary's group, project category winning", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts());

    expect(categoryOf(input, "wal_level")).toBe("Write-Ahead Log"); // dictionary group
    expect(categoryOf(input, "no_group_setting")).toBe("Uncategorized"); // no group
    expect(categoryOf(input, "work_mem")).toBe("Tuning"); // project metadata wins
    expect(categoryOf(input, "db_max_conn")).toBe("Tuning");
    // A project-declared category stays a single, flat, top-level tab.
    // Materialized rows nest under ONE parent (so a large dictionary doesn't
    // flatten into dozens of top-level tabs) — see fileDrafts in assemble.ts.
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual(["Tuning", "Product defaults (unused)"]);
    const tuning = input.sheets[0].categories!.find((c) => c.name === "Tuning")!;
    expect(tuning.categories).toBeUndefined(); // never nested
    const defaults = input.sheets[0].categories!.find((c) => c.name === "Product defaults (unused)")!;
    expect(defaults.params).toBeUndefined(); // the parent carries no rows of its own
    expect((defaults.categories ?? []).map((c) => c.name)).toEqual([
      "Connections",
      "Write-Ahead Log",
      "Uncategorized",
    ]);
  });

  it("names the materialize parent category in Japanese when opts.lang is ja", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts({ lang: "ja" }));
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toContain("既定値（未使用）");
  });

  it("honors a per-binding defaultsCategory override", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), dictOpts({ defaultsCategory: "Unreviewed" }));
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual(["Tuning", "Unreviewed"]);
  });

  it("applies the project metadata's out_of_scope to a materialized row", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts());
    const workMem = params(input).find((p) => p.key === "work_mem");

    expect(workMem?.origin).toBe("default");
    expect(workMem?.out_of_scope).toEqual({ reason: "別チーム管理のため", owner: "DBA" });
  });

  it("does not weaken the category rule for parameters the project sets", () => {
    // `db_unknown` is set by the project but absent from sheet.yml — still a
    // hard error, materialize or not.
    expect(() => assembleSheets(sheetInputs(["db_max_conn", "db_unknown"]), opts())).toThrow(/db_unknown/);
  });

  it("reports a bound dictionary whose file is missing", () => {
    expect(() => assembleSheets(sheetInputs(["db_max_conn"]), opts({ metadataDirs: ["elsewhere"] }))).toThrow(
      /dictionary not found: demodb@1/
    );
  });

  it("reports a dictionaries entry naming a sheet this build has no sheet for", () => {
    expect(() =>
      assembleSheets(sheetInputs(["db_max_conn"]), opts({ dictionaries: { typo: [{ product: "demodb", version: "1" }] } }))
    ).toThrow(/no sheet for/);
  });

  it("leaves a sheet alone when nothing names it", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts({ dictionaries: undefined }));
    expect(params(input).map((p) => p.key)).toEqual(["db_max_conn"]);
  });

  // A dictionary entry marked `kind: container` (a syntax element like
  // Apache's <IfModule>, not a setting) must never become an `origin:
  // "default"` row — there is no default value to assert. Skipped, never
  // silently dropped: assembleSheetsWithReport() must report the skip (see
  // the next test).
  it("does not materialize a kind: container dictionary entry", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn", "db_alias_key", "standalone"]), opts());
    const all = params(input);

    expect(all.some((p) => p.key === "container_setting")).toBe(false);
  });

  it("reports how many dictionary entries were skipped as containers", () => {
    const { materializeReports } = assembleSheetsWithReport(
      sheetInputs(["db_max_conn", "db_alias_key", "standalone"]),
      opts()
    );

    expect(materializeReports).toEqual([
      {
        sheet: "db",
        product: "demodb",
        version: "1",
        total: 8, // every key in DICT_YAML's parameters, covered or not
        containerSkipped: 1, // container_setting only
        materialized: 4, // work_mem, wal_level, no_group_setting, listen_directive
        groupExcluded: 0, // no groups filter set
        unknownGroups: [],
        noDefault: 0, // every DICT_YAML entry declares a default
        noDefaultKeys: [],
      },
    ]);
  });
});

// The `groups` include-list (DictionaryMaterialize's `groups`): the fix for a
// large dictionary (httpd@2.4's 729 directives across 100+ modules)
// materializing every module a product COULD load, not just the ones a
// deployment actually uses.
describe("materialize groups filter", () => {
  it("materializes only entries whose group is in the list", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), dictOpts({ groups: ["Write-Ahead Log"] }));
    const all = params(input);

    expect(all.filter((p) => p.origin === "default").map((p) => p.key)).toEqual(["wal_level"]);
    // An ungrouped entry never matches a named filter — excluded like any
    // group that wasn't listed.
    expect(all.some((p) => p.key === "no_group_setting")).toBe(false);
    // The parent category still exists, but only holds the one named group —
    // no empty "Connections"/"Memory"/"Uncategorized" subcategories.
    const defaults = input.sheets[0].categories!.find((c) => c.name === "Product defaults (unused)")!;
    expect((defaults.categories ?? []).map((c) => c.name)).toEqual(["Write-Ahead Log"]);
  });

  it("counts entries the filter excluded", () => {
    const { materializeReports } = assembleSheetsWithReport(
      sheetInputs(["db_max_conn"]),
      dictOpts({ groups: ["Write-Ahead Log"] })
    );
    const [report] = materializeReports;
    expect(report.materialized).toBe(1); // wal_level
    // 8 total - 1 covered (max_conn, via key_prefix) - 1 container_setting = 6
    // candidates; of those, 1 materialized (wal_level) and 5 excluded by the
    // filter (aliased, standalone, work_mem, no_group_setting, listen_directive).
    expect(report.groupExcluded).toBe(5);
    expect(report.unknownGroups).toEqual([]);
  });

  it("reports a named group that matches nothing in the dictionary (typo guard)", () => {
    const { materializeReports } = assembleSheetsWithReport(
      sheetInputs(["db_max_conn"]),
      dictOpts({ groups: ["Write-Ahead Log", "Wrte-Ahead Log"] })
    );
    expect(materializeReports[0].unknownGroups).toEqual(["Wrte-Ahead Log"]);
  });

  it("does not fail the build over an unknown group name — it's a warning, not an error", () => {
    expect(() =>
      assembleSheets(sheetInputs(["db_max_conn"]), dictOpts({ groups: ["totally-not-a-group"] }))
    ).not.toThrow();
  });

  it("omitted groups keeps the historical behavior: every group materialized", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts());
    const defaults = input.sheets[0].categories!.find((c) => c.name === "Product defaults (unused)")!;
    expect((defaults.categories ?? []).map((c) => c.name)).toEqual([
      "Connections",
      "Write-Ahead Log",
      "Uncategorized",
    ]);
  });
});

// The gate: `coverage` decides whether a dictionary may be materialized at
// all. `full` (the demodb fixture above, and every other test in this file)
// must keep working; `partial` — and the omitted case, which defaults to
// `partial` — must fail loudly instead of quietly producing a fake inventory.
describe("materialize coverage gate", () => {
  const PARTIAL_DICT_YAML = `
product: demodb
version: "1"
provenance: official
coverage: partial
parameters:
  max_conn:
    description: { en: Maximum connections }
    default: 100
`;

  const UNDECLARED_DICT_YAML = `
product: demodb
version: "1"
provenance: official
parameters:
  max_conn:
    description: { en: Maximum connections }
    default: 100
`;

  it("refuses to materialize a dictionary declared coverage: partial", () => {
    const filesPartial: Record<string, string> = { "project.yml": PROJECT_YAML, "meta/demodb@1.yml": PARTIAL_DICT_YAML };
    const readFilePartial = (p: string): string | null => filesPartial[p] ?? null;

    expect(() => assembleSheets(sheetInputs(["db_max_conn"]), opts({ readFile: readFilePartial }))).toThrow(
      /coverage is "partial"/
    );
  });

  it("refuses to materialize a dictionary with no coverage declared (defaults to partial)", () => {
    const filesUndeclared: Record<string, string> = { "project.yml": PROJECT_YAML, "meta/demodb@1.yml": UNDECLARED_DICT_YAML };
    const readFileUndeclared = (p: string): string | null => filesUndeclared[p] ?? null;

    expect(() => assembleSheets(sheetInputs(["db_max_conn"]), opts({ readFile: readFileUndeclared }))).toThrow(
      /defaults to "partial"/
    );
  });

  it("names the sheet and dictionary, and points to the fix, in the error", () => {
    const filesPartial: Record<string, string> = { "project.yml": PROJECT_YAML, "meta/demodb@1.yml": PARTIAL_DICT_YAML };
    const readFilePartial = (p: string): string | null => filesPartial[p] ?? null;

    expect(() => assembleSheets(sheetInputs(["db_max_conn"]), opts({ readFile: readFilePartial }))).toThrow(
      /sheet "db".*demodb@1.*coverage: full/s
    );
  });

  it("allows materializing a dictionary declared coverage: full", () => {
    // DICT_YAML (the outer describe's fixture) declares coverage: full — this
    // is the same assembly every other test in this file already exercises,
    // stated here explicitly as the positive case of the gate.
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts());
    expect(params(input).some((p) => p.origin === "default")).toBe(true);
  });
});

// P5: `origin: "default"` asserts "the product default applies here" — false
// for a dictionary entry that carries no `default` at all, so materialize
// excludes those by default (DictionaryMaterialize.includeNoDefault opts a
// binding back in). The exclusion must never be silent: measured against real
// dictionaries, some no-default entries (httpd's AcceptFilter/ErrorDocument/
// Protocol) DO have a real behavior the dictionary just failed to record, so
// the skip has to be countable AND auditable (see MaterializeReport.noDefault/
// noDefaultKeys), not just a quiet drop.
describe("materialize no-default gate", () => {
  const NO_DEFAULT_DICT_YAML = `
product: demodb
version: "1"
provenance: extracted
coverage: full
parameters:
  max_conn:
    description: { en: Maximum connections }
    default: 100
    group: Connections
  accept_filter:
    description: { en: OS-specific accept filter — no documented default }
    group: Connections
  error_document:
    description: { en: Custom error page — no documented default }
    group: Connections
`;
  const files2: Record<string, string> = { "project.yml": PROJECT_YAML, "meta/demodb@1.yml": NO_DEFAULT_DICT_YAML };
  const readFile2 = (p: string): string | null => files2[p] ?? null;

  function noDefaultOpts(materialize: SheetDictionaryBinding["materialize"] = true): AssembleOpts {
    return opts({
      readFile: readFile2,
      dictionaries: { db: [{ product: "demodb", version: "1", key_prefix: "db_", materialize }] },
    });
  }

  it("excludes a dictionary entry with no default from the materialized ledger", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), noDefaultOpts());
    const all = params(input);

    expect(all.some((p) => p.key === "accept_filter")).toBe(false);
    expect(all.some((p) => p.key === "error_document")).toBe(false);
    expect(all.some((p) => p.key === "max_conn")).toBe(false); // covered by db_max_conn
  });

  it("counts and names the excluded no-default keys in the report", () => {
    const { materializeReports } = assembleSheetsWithReport(sheetInputs(["db_max_conn"]), noDefaultOpts());
    const [report] = materializeReports;

    expect(report.noDefault).toBe(2);
    expect(report.noDefaultKeys.sort()).toEqual(["accept_filter", "error_document"]);
    expect(report.materialized).toBe(0); // max_conn is covered; the other two are no-default
  });

  it("includeNoDefault opts a binding back into materializing no-default entries", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), noDefaultOpts({ includeNoDefault: true }));
    const all = params(input);

    expect(all.some((p) => p.key === "accept_filter")).toBe(true);
    expect(all.some((p) => p.key === "error_document")).toBe(true);
    // No default to assert, so the value falls back to empty (unchanged
    // behavior from before this gate existed).
    expect((all.find((p) => p.key === "accept_filter") as SimpleParameter).value).toBe("");
  });

  it("reports zero skipped when includeNoDefault is set", () => {
    const { materializeReports } = assembleSheetsWithReport(sheetInputs(["db_max_conn"]), noDefaultOpts({ includeNoDefault: true }));
    const [report] = materializeReports;

    expect(report.noDefault).toBe(0);
    expect(report.noDefaultKeys).toEqual([]);
    expect(report.materialized).toBe(2); // accept_filter, error_document
  });
});
