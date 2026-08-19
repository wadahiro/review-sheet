import { describe, it, expect } from "bun:test";
import { loadProjectMeta, paramsForSheet, checkProjectMetaSheets, compareComponentsForSheet, layoutForSheet, groupsByFile } from "../src/providers/project";
import { getMetadataProvider, type MetadataContext } from "../src/metadata";
import "../src/providers/project";

const PROJECT_YAML = `
params:
  nginx_listen_port:
    category: Network
    dict_key: listen
    description: Listen port
  nginx_server_name:
    category: Network
    description:
      en: Server name
      ja: サーバー名
    remarks: Per-environment FQDN
  nginx_gzip:
    category: Features
    out_of_scope:
      reason: role-managed
`;

function ctx(overrides: Partial<MetadataContext> = {}): MetadataContext {
  return {
    lang: "en",
    nativeLang: "en",
    readFile: () => null,
    argumentSpecs: [],
    terraformVariables: [],
    metadataDirs: [],
    dictionaries: [],
    cache: new Map(),
    ...overrides,
  };
}

describe("loadProjectMeta", () => {
  it("parses params", () => {
    const doc = loadProjectMeta("sheet.yml", () => PROJECT_YAML);
    expect(Object.keys(doc.params ?? {})).toHaveLength(3);
  });

  it("defaults missing params to {}", () => {
    const doc = loadProjectMeta("sheet.yml", () => "product: x\n");
    expect(doc.params).toEqual({});
  });

  it("throws when the file is not found", () => {
    expect(() => loadProjectMeta("missing.yml", () => null)).toThrow("project metadata not found: missing.yml");
  });
});

describe("project metadata provider", () => {
  const provider = getMetadataProvider("project")!;

  it("returns undefined when ctx.project is unset", () => {
    expect(provider.resolve({ key: "nginx_listen_port" }, ctx())).toBeUndefined();
  });

  it("returns undefined when the key is absent from params", () => {
    const c = ctx({ project: "sheet.yml", readFile: () => PROJECT_YAML });
    expect(provider.resolve({ key: "unknown_key" }, c)).toBeUndefined();
  });

  it("resolves description, provenance project, no category (dict_key is NOT in the result — read directly off ProjectMetaDoc by bind.ts)", () => {
    const c = ctx({ project: "sheet.yml", readFile: () => PROJECT_YAML });
    const result = provider.resolve({ key: "nginx_listen_port" }, c);
    expect(result).toEqual({
      description: "Listen port",
      remarks: undefined,
      out_of_scope: undefined,
      provenance: "project",
    });
    expect(result && "category" in result).toBe(false);
    expect(result && "dict_key" in result).toBe(false);
  });

  it("carries a LangText map through unresolved (viewer picks the language)", () => {
    const c = ctx({ project: "sheet.yml", readFile: () => PROJECT_YAML });
    const result = provider.resolve({ key: "nginx_server_name" }, c);
    expect(result?.description).toEqual({ en: "Server name", ja: "サーバー名" });
    expect(result?.remarks).toBe("Per-environment FQDN");
  });

  it("passes through out_of_scope flags", () => {
    const c = ctx({ project: "sheet.yml", readFile: () => PROJECT_YAML });
    const result = provider.resolve({ key: "nginx_gzip" }, c);
    expect(result?.out_of_scope).toEqual({ reason: "role-managed" });
  });

  it("caches the parsed project metadata per path", () => {
    let reads = 0;
    const c = ctx({
      project: "sheet.yml",
      readFile: () => {
        reads++;
        return PROJECT_YAML;
      },
    });
    provider.resolve({ key: "nginx_listen_port" }, c);
    provider.resolve({ key: "nginx_server_name" }, c);
    expect(reads).toBe(1);
  });
});

// P4: sheet.yml's `params:` used to be one namespace for the whole spec — two
// sheets sharing a key (e.g. two Ansible roles reading the same group_vars
// file) shared its category/description too, so a key that leaked from one
// sheet's extraction into another's (a missing `exclude:` filter) could come
// out looking legitimately documented under the WRONG sheet, with no error.
// `sheets:` namespaces `params:` per sheet so that can't happen silently.
const SHEETED_YAML = `
sheets:
  "sheet a":
    params:
      shared_key:
        category: A-category
        description: from sheet a
  "sheet b":
    params:
      shared_key:
        category: B-category
        description: from sheet b
      only_in_b:
        category: B-category
`;

describe("loadProjectMeta: sheets: namespace", () => {
  it("parses sheets into per-sheet params tables, leaving top-level params undefined", () => {
    const doc = loadProjectMeta("sheet.yml", () => SHEETED_YAML);
    expect(doc.params).toBeUndefined();
    expect(Object.keys(doc.sheets ?? {})).toEqual(["sheet a", "sheet b"]);
    expect(Object.keys(doc.sheets!["sheet b"].params)).toEqual(["shared_key", "only_in_b"]);
  });

  it("rejects a file that sets both top-level params: and sheets: (no flat fallback under sheets:)", () => {
    const mixed = `
params:
  x: { category: General }
sheets:
  "sheet a":
    params: {}
`;
    expect(() => loadProjectMeta("sheet.yml", () => mixed)).toThrow(/sheets.*params.*cannot both be set/);
  });

  it("a sheet named in sheets: with no params: defaults to {}", () => {
    const doc = loadProjectMeta("sheet.yml", () => 'sheets:\n  "sheet a": {}\n');
    expect(doc.sheets!["sheet a"].params).toEqual({});
  });
});

describe("paramsForSheet", () => {
  it("a sheets: doc: returns only that sheet's own table, {} for an unnamed/unknown sheet", () => {
    const doc = loadProjectMeta("sheet.yml", () => SHEETED_YAML);
    expect(Object.keys(paramsForSheet(doc, "sheet a"))).toEqual(["shared_key"]);
    expect(Object.keys(paramsForSheet(doc, "sheet b"))).toEqual(["shared_key", "only_in_b"]);
    expect(paramsForSheet(doc, "sheet a")["shared_key"].category).toBe("A-category");
    expect(paramsForSheet(doc, "sheet b")["shared_key"].category).toBe("B-category");
    expect(paramsForSheet(doc, "nonexistent sheet")).toEqual({});
    expect(paramsForSheet(doc, undefined)).toEqual({});
  });

  it("a flat doc: returns the same table regardless of sheet name (pre-existing, single-namespace behavior)", () => {
    const doc = loadProjectMeta("sheet.yml", () => PROJECT_YAML);
    expect(paramsForSheet(doc, "sheet a")).toEqual(doc.params!);
    expect(paramsForSheet(doc, "anything else")).toEqual(doc.params!);
    expect(paramsForSheet(doc, undefined)).toEqual(doc.params!);
  });
});

describe("checkProjectMetaSheets", () => {
  it("does nothing for a flat doc", () => {
    const doc = loadProjectMeta("sheet.yml", () => PROJECT_YAML);
    expect(() => checkProjectMetaSheets(doc, [])).not.toThrow();
  });

  it("passes when every sheets: key names a real sheet", () => {
    const doc = loadProjectMeta("sheet.yml", () => SHEETED_YAML);
    expect(() => checkProjectMetaSheets(doc, ["sheet a", "sheet b", "sheet c"])).not.toThrow();
  });

  it("throws naming the unknown sheet(s) when sheets: has a stale/typo'd name", () => {
    const doc = loadProjectMeta("sheet.yml", () => SHEETED_YAML);
    expect(() => checkProjectMetaSheets(doc, ["sheet a"])).toThrow(/sheet b/);
  });
});

describe("project metadata provider: sheet-scoped resolution (P4)", () => {
  const provider = getMetadataProvider("project")!;

  it("the SAME key in two sheets resolves to each sheet's OWN category/description, not a shared one", () => {
    const c = ctx({ project: "sheet.yml", readFile: () => SHEETED_YAML });
    const fromA = provider.resolve({ key: "shared_key", sheet: "sheet a" }, c);
    const fromB = provider.resolve({ key: "shared_key", sheet: "sheet b" }, c);
    expect(fromA?.description).toBe("from sheet a");
    expect(fromB?.description).toBe("from sheet b");
  });

  it("a key declared only under one sheet does not resolve when queried under a different sheet", () => {
    const c = ctx({ project: "sheet.yml", readFile: () => SHEETED_YAML });
    expect(provider.resolve({ key: "only_in_b", sheet: "sheet b" }, c)).toBeDefined();
    expect(provider.resolve({ key: "only_in_b", sheet: "sheet a" }, c)).toBeUndefined();
    expect(provider.resolve({ key: "only_in_b" }, c)).toBeUndefined(); // no sheet at all
  });
});

// sheet.yml -> Sheet.compare_components. A comparison sheet declares that it
// opens side by side and stays there; the plain boolean keeps its toggle.
describe("compare_components: always", () => {
  const load = (mode: string) =>
    loadProjectMeta("sheet.yml", () => `sheets:\n  s:\n    compare_components: ${mode}\n    params: {}\n`);

  it("carries the string through, distinct from true", () => {
    expect(compareComponentsForSheet(load("always"), "s")).toBe("always");
    expect(compareComponentsForSheet(load("true"), "s")).toBe(true);
  });

  it("is false when the sheet says nothing, so nothing opens pivoted by accident", () => {
    const doc = loadProjectMeta("sheet.yml", () => "sheets:\n  s:\n    params: {}\n");
    expect(compareComponentsForSheet(doc, "s")).toBe(false);
    expect(compareComponentsForSheet(doc, "no-such-sheet")).toBe(false);
  });
});

// What HEADS a sheet's rows. The file layout became the default when it turned
// out that grouping by anything else can separate a row from the block it is
// written in — a dictionary files a directive by what implements it, which has
// nothing to do with where the directive sits — so the two grouped layouts are
// declarations, and this is where a declaration is read or refused.
describe("layout:", () => {
  const load = (yaml: string) => loadProjectMeta("sheet.yml", () => yaml);

  it("heads rows by their file when nothing is declared", () => {
    expect(layoutForSheet(load("sheets:\n  s:\n    params: {}\n"), "s")).toBe("file");
    // Also for a sheet the document never mentions: the default is the default,
    // not a property of being written down.
    expect(layoutForSheet(load("sheets:\n  s:\n    params: {}\n"), "other")).toBe("file");
  });

  it("reads each declared layout", () => {
    expect(layoutForSheet(load("sheets:\n  s:\n    layout: categories\n    params: {}\n"), "s")).toBe("categories");
    expect(layoutForSheet(load("sheets:\n  s:\n    layout: file+categories\n    params: {}\n"), "s")).toBe("file+categories");
  });

  // The flat form of this file is the single-sheet shorthand, so it has to be
  // able to say the same things; without this the shorthand would mean
  // something the long form does not.
  it("reads the flat form's document-level declaration", () => {
    expect(layoutForSheet(load("layout: categories\nparams: {}\n"), undefined)).toBe("categories");
    expect(layoutForSheet(load("params: {}\n"), undefined)).toBe("file");
  });

  it("lets a sheet override the document", () => {
    const doc = load("layout: categories\nsheets:\n  s:\n    layout: file+categories\n    params: {}\n  t:\n    params: {}\n");
    expect(layoutForSheet(doc, "s")).toBe("file+categories");
    expect(layoutForSheet(doc, "t")).toBe("categories");
  });

  // Only file grouping asks the file question; `file+categories` sub-heads that
  // file, it does not replace it.
  it("says which layouts head by file", () => {
    expect(groupsByFile(load("sheets:\n  s:\n    params: {}\n"), "s")).toBe(true);
    expect(groupsByFile(load("sheets:\n  s:\n    layout: file+categories\n    params: {}\n"), "s")).toBe(true);
    expect(groupsByFile(load("sheets:\n  s:\n    layout: categories\n    params: {}\n"), "s")).toBe(false);
  });

  // The old key asked for what is now the default, so a spec still carrying it
  // means the opposite of what its author wrote. Honouring it silently and
  // ignoring it silently are both worse than saying so.
  it("refuses group_by: file, and the message does the migration", () => {
    expect(() => load("sheets:\n  s:\n    group_by: file\n    params: {}\n")).toThrow(
      /"group_by: file", which no longer exists.*now the default — delete the line.*layout: file\+categories/s
    );
  });

  it("refuses a layout it does not have, listing the ones it does", () => {
    expect(() => load("sheets:\n  s:\n    layout: file\n    params: {}\n")).toThrow(/layout: file.*Write "categories".*"file\+categories".*omit it/s);
    expect(() => load("layout: nonsense\nparams: {}\n")).toThrow(/layout: nonsense/);
  });
});
