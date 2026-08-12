// materialize: expand a bound product dictionary into a sheet as
// `origin: "default"` rows, so the sheet is the exhaustive ledger of the
// product's parameters and not just the subset the project happens to set.

import { describe, it, expect, beforeEach } from "bun:test";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { assembleSheets, assembleSheetsWithReport, type AssembleOpts, type SheetDictionaryBinding, type SheetInputs } from "../src/assemble";
import { pickLang } from "../src/types";
import type { Category, Parameter, ParameterSheetInput, SimpleParameter } from "../src/types";

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
    // Every category is a flat, top-level tab, whatever the origin of the rows
    // in it. There is no parent segregating unset rows: a category is the
    // product's grouping of related settings, and a reviewer looking at
    // "Write-Ahead Log" wants the whole of it.
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual([
      "Tuning",
      "Connections",
      "Write-Ahead Log",
      "Uncategorized",
    ]);
    for (const c of input.sheets[0].categories ?? []) expect(c.categories).toBeUndefined();
  });

  // A materialized row is filed by the SAME rule as a row the project set: the
  // dictionary's own `group`. There is no parent category segregating rows by
  // origin, in any language — a category is the product's grouping of related
  // settings, and splitting it by whether this project happened to set a value
  // puts an ALB's two timeouts in two different trees.
  it("files a materialized row under its dictionary group, beside the rows the project set", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts());
    const tuning = (input.sheets[0].categories ?? []).find((c) => c.name === "Tuning")!;
    const keys = (tuning.params ?? []).map((p) => p.key);
    // db_max_conn is set by the project, work_mem is materialized: same category,
    // side by side, which is the whole point.
    expect(keys).toContain("db_max_conn");
    expect(keys).toContain("work_mem");
  });

  it("keeps origin as the only thing separating a materialized row from a set one", () => {
    const input = assembleSheets(sheetInputs(["db_max_conn"]), opts());
    const byKey = new Map(params(input).map((p) => [p.key, p]));
    expect(byKey.get("db_max_conn")?.origin).not.toBe("default");
    expect(byKey.get("work_mem")?.origin).toBe("default");
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
        unitAbsent: 0, // this dictionary declares no units — a single product
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
    // Only the named group's category appears — no empty
    // "Connections"/"Uncategorized" tabs conjured by a filter that excluded them.
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual(["Tuning", "Write-Ahead Log"]);
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
    expect((input.sheets[0].categories ?? []).map((c) => c.name)).toEqual([
      "Tuning",
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

// A component is the OUTERMOST level of a row's path: a row belongs first to
// the thing it was built for, and only then to the product's own taxonomy of
// settings. It does not out-rank the category — it contains it.
describe("recipe-derived component", () => {
  // Every path a key appears under. With one ledger per component, a key can
  // legitimately appear more than once — set by one component, materialized as
  // a default in another — so a helper returning "the" path would pick one of
  // them arbitrarily and the test would read as if the other did not exist.
  const pathsOf = (input: ParameterSheetInput, key: string, origin?: string): string[][] => {
    const out: string[][] = [];
    const walk = (cats: Category[] | undefined, trail: string[]): void => {
      for (const c of cats ?? []) {
        for (const p of c.params ?? []) {
          if (p.key === key && (origin === undefined || p.origin === origin)) out.push([...trail, c.name]);
        }
        walk(c.categories, [...trail, c.name]);
      }
    };
    walk(input.sheets[0].categories, []);
    return out;
  };
  const pathOf = (input: ParameterSheetInput, key: string): string[] => pathsOf(input, key)[0] ?? [];

  // The level appears only once there is something to tell apart. A sheet
  // covering ONE component IS that component, so naming it above every category
  // adds a level that says nothing — and makes every row's identity a level
  // deeper for no reader-visible gain.
  it("does not appear at all when the sheet has one component", () => {
    const si = sheetInputs(["wal_level", "work_mem"]);
    si[0].componentOf = new Map([
      ["wal_level", "primary database"],
      ["work_mem", "primary database"],
    ]);
    const input = assembleSheets(si, opts());
    expect(pathOf(input, "wal_level")).toEqual(["Write-Ahead Log"]);
    expect(pathOf(input, "work_mem")).toEqual(["Tuning"]);
  });

  it("nests the dictionary's own grouping underneath it once there are two", () => {
    const si = sheetInputs(["wal_level", "work_mem"]);
    si[0].componentOf = new Map([
      ["wal_level", "primary database"],
      ["work_mem", "replica"],
    ]);
    const input = assembleSheets(si, opts());
    expect(pathOf(input, "wal_level")).toEqual(["primary database", "Write-Ahead Log"]);
  });

  it("nests the project's own category: underneath it too", () => {
    const si = sheetInputs(["wal_level", "work_mem"]);
    si[0].componentOf = new Map([
      ["wal_level", "primary database"],
      ["work_mem", "replica"],
    ]);
    const input = assembleSheets(si, opts());
    // work_mem carries `category: Tuning` in the shared project fixture. It is
    // SET by the replica; `primary database` does not set it, so that component
    // materializes its own default row — which is the per-component ledger
    // working, not a stray duplicate.
    expect(pathsOf(input, "work_mem", "common")).toEqual([["replica", "Tuning"]]);
    expect(pathsOf(input, "work_mem", "default")).toEqual([["primary database", "Tuning"]]);
  });

  it("leaves a row with no component exactly where it was", () => {
    const si = sheetInputs(["wal_level"]);
    const input = assembleSheets(si, opts());
    expect(pathOf(input, "wal_level")).toEqual(["Write-Ahead Log"]);
  });

  // A row with NO project category and NO binding is a hard error — the one
  // discipline keeping project metadata honest. It used to be defeated by the
  // component level: the component was prepended BEFORE the empty-path check,
  // so the path came out length 1 and the row landed silently under the
  // component heading. The guard therefore held on a single-component sheet
  // (collapsed to length 0) and stopped holding the moment a second component
  // appeared — a build-breaking omission turning into a silent one because a
  // sibling was added elsewhere. Both sides are asserted so a future collapse
  // rule cannot quietly restore the hole on one of them.
  it("still fails a row with no category once a component level exists", () => {
    const si = sheetInputs(["orphan_key"]);
    si[0].componentOf = new Map([["orphan_key", "primary database"]]);
    si[0].layers[0].entries.set("second_component_row", { value: "set", source: { file: "base.yml", line: 2 } });
    si[0].componentOf.set("second_component_row", "replica");
    expect(() => assembleSheets(si, opts())).toThrow(/have no category/);
  });

  it("fails the same row when the sheet has a single component", () => {
    const si = sheetInputs(["orphan_key"]);
    si[0].componentOf = new Map([["orphan_key", "primary database"]]);
    expect(() => assembleSheets(si, opts())).toThrow(/have no category/);
  });

  // `category: null` is the project SAYING the row belongs to no category —
  // it is about the component as a whole (a Keycloak client's Enabled toggle
  // lives in the page header, above the tab strip). Distinct from an absent
  // `category:`, exactly as `dict_key: null` is distinct from an absent one:
  // the position has to be declared and can never be fallen into, which is
  // what the two tests above enforce.
  const NULL_CATEGORY_PROJECT = `
params:
  orphan_key:
    category: null
`;

  const nullCategoryOpts = (): AssembleOpts =>
    opts({
      projectPath: "null-category.yml",
      readFile: (path: string) => (path === "null-category.yml" ? NULL_CATEGORY_PROJECT : readFile(path)),
    });

  it("files a `category: null` row directly under its component, above every category", () => {
    const si = sheetInputs(["orphan_key"]);
    si[0].layers[0].entries.set("wal_level", { value: "set", source: { file: "base.yml", line: 2 } });
    si[0].componentOf = new Map([
      ["orphan_key", "primary database"],
      ["wal_level", "replica"],
    ]);
    const input = assembleSheets(si, nullCategoryOpts());

    expect(pathOf(input, "orphan_key")).toEqual(["primary database"]);
    // The sibling still nests under the component the ordinary way, so this is
    // a position ALONGSIDE categories, not a replacement for them. (Its `default`
    // twin under "primary database" is the per-component ledger, not a stray.)
    expect(pathsOf(input, "wal_level", "common")).toEqual([["replica", "Write-Ahead Log"]]);
  });

  // A sheet with one component IS that component, so the level is collapsed
  // and there is nothing above its categories — `Sheet.categories` holds every
  // row and a sheet root carries no params. Reported as its own message rather
  // than as an undeclared category, which the scaffold would offer to fix by
  // writing a name.
  it("rejects `category: null` on a sheet with no component level", () => {
    const si = sheetInputs(["orphan_key"]);
    si[0].componentOf = new Map([["orphan_key", "primary database"]]);
    expect(() => assembleSheets(si, nullCategoryOpts())).toThrow(/no component level to file it under/);
  });
});

// The failure this scoping exists for, reproduced. A sheet holding two
// components of the same product used ONE `covered` set, so either component
// setting an option marked it covered for both — and the other component's
// unset option vanished from the ledger with nothing reported. On a sheet whose
// point is "nothing is silently missing", that is the worst kind of bug: the
// row looks singular and correct.
describe("materialize: one ledger per component", () => {
  function twoComponents(): SheetInputs[] {
    return [
      {
        name: "db",
        instances: [],
        layers: [
          {
            kind: "base",
            entries: new Map([
              // Only the PRIMARY sets wal_level. The replica sets something else
              // entirely, so wal_level is unset FOR THE REPLICA.
              ["primary.wal_level", { value: "replica", source: { file: "b.yml", line: 1 } }],
              ["replica.work_mem", { value: "8MB", source: { file: "b.yml", line: 2 } }],
            ]),
          },
        ],
        embedded: [],
        componentOf: new Map([
          ["primary.wal_level", "primary"],
          ["replica.work_mem", "replica"],
        ]),
      },
    ];
  }

  it("materializes an option for the component that does not set it, even when another does", () => {
    const input = assembleSheets(twoComponents(), opts());
    const all = params(input);
    // wal_level is set on `primary` (so not materialized there) and unset on
    // `replica` (so materialized there). One sheet, two answers.
    const walRows = all.filter((p) => p.key === "wal_level" || p.key.endsWith(".wal_level"));
    expect(walRows.length).toBeGreaterThan(1);
    expect(walRows.some((p) => p.origin === "default")).toBe(true);
  });

  it("gives each component its own report, rather than one for the sheet", () => {
    const { materializeReports } = assembleSheetsWithReport(twoComponents(), opts());
    expect(materializeReports.length).toBe(2);
  });
});

// Two components of one product share their FIELD NAMES — two Keycloak clients
// both have `redirectUris[0]` — so a flat project table hands one component's
// remarks to the other, looking authored rather than leaked. Same leak
// `sheets:` closed one level up (providers/project.ts).
describe("project metadata: namespaced by component", () => {
  const PROJECT = `
sheets:
  db:
    params:
      wal_level:
        category: Tuning
        description: { en: What the write-ahead log records }
    components:
      replica:
        params:
          wal_level:
            remarks: { en: Higher on the replica, because it feeds the standby }
`;

  // Embedded entries, not base-map ones: a Map cannot hold two rows named
  // `wal_level`, which is exactly why a component travels ON the entry. This
  // is the shape a static file with a `key:` transform produces.
  function twoComponents(): SheetInputs[] {
    return [
      {
        name: "db",
        instances: [],
        layers: [{ kind: "base", entries: new Map() }],
        embedded: [
          { key: "wal_level", value: "replica", source: { file: "b.yml", line: 1 }, component: "primary" },
          { key: "wal_level", value: "logical", source: { file: "b.yml", line: 2 }, component: "replica" },
        ],
      },
    ];
  }

  function build(): ParameterSheetInput {
    return assembleSheets(twoComponents(), {
      ...opts(),
      readFile: (p: string) => (p === "/p/sheet.yml" ? PROJECT : opts().readFile(p)),
      projectPath: "/p/sheet.yml",
    });
  }

  it("gives the remark to the component that declared it, and to no other", () => {
    const rows = params(build()).filter((p) => p.key === "wal_level");
    expect(rows.length).toBe(2);
    const withRemark = rows.filter((r) => r.remarks !== undefined);
    expect(withRemark.length).toBe(1);
    expect(pickLang(withRemark[0].remarks, "en")).toContain("Higher on the replica");
  });

  it("still shares what is true of the field itself", () => {
    // The description lives in the sheet-wide table once; both rows get it.
    const rows = params(build()).filter((p) => p.key === "wal_level");
    expect(rows.every((r) => pickLang(r.description, "en") === "What the write-ahead log records")).toBe(true);
  });
});
