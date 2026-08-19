// What a grouped layout cost, said out loud.
//
// The author asked for the grouping, so the build does not refuse it — but a
// build that quietly pulled a configuration file's blocks apart would be the
// failure this project defines itself against. These are the facts it states;
// the judgement of whether the cost is worth it stays with the person who
// declared the layout.

import { describe, it, expect } from "bun:test";
import { splitContainerFamilies, mixedFileCategories, assembleSheetsWithReport } from "../src/assemble";

const child = (block: string, key: string, sub?: string[]) => ({
  key: `${block}.${key}`,
  value: "v",
  container_path: [{ path: block, name: "Directory" }],
  ...(sub ? { sub_category: sub } : {}),
});

describe("splitContainerFamilies", () => {
  // The measured case: Apache's dictionary files `Require` under
  // mod_authz_core because that module implements it, while the <Directory>
  // holding it is core. Nothing is wrong with either classification.
  it("names a family whose rows landed under different headings", () => {
    const out = splitContainerFamilies({
      name: "httpd",
      categories: [
        { name: "core", params: [{ key: 'Directory["/var/www"]', value: '"/var/www"', container: { name: "Directory" } }, child('Directory["/var/www"]', "AllowOverride")] },
        { name: "mod_authz_core", params: [child('Directory["/var/www"]', "Require")] },
      ],
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe('Directory["/var/www"]');
    expect(out[0].headings.sort()).toEqual(["core", "mod_authz_core"]);
  });

  // Every aggregate ships an exemplar: "1 family split" is unreviewable, and a
  // key from the family is what lets a reader go and look.
  it("carries a row from the family it names", () => {
    const out = splitContainerFamilies({
      name: "httpd",
      categories: [
        { name: "a", params: [child("Block", "one")] },
        { name: "b", params: [child("Block", "two")] },
      ],
    } as never);
    expect(out[0].example).toBe("Block.one");
  });

  it("says nothing about a family that stayed together", () => {
    expect(
      splitContainerFamilies({
        name: "httpd",
        categories: [{ name: "core", params: [child("Block", "one"), child("Block", "two")] }],
      } as never)
    ).toEqual([]);
  });

  // On a `file+categories` sheet every row shares the file as its category, so
  // comparing categories alone would report nothing at all — the split is one
  // level down, in the sub-heading.
  it("sees a split made by sub-headings, not only by categories", () => {
    const out = splitContainerFamilies({
      name: "httpd",
      categories: [
        {
          name: "/etc/httpd/conf/httpd.conf",
          params: [child("Block", "one", ["core"]), child("Block", "two", ["mod_authz_core"])],
        },
      ],
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].headings.sort()).toEqual([
      "/etc/httpd/conf/httpd.conf > core",
      "/etc/httpd/conf/httpd.conf > mod_authz_core",
    ]);
  });

  // A block's own row is part of its family: separated from its contents, it is
  // the most misleading row of all — the heading over the contents claims a
  // block that is not there.
  it("counts the block's own row as part of the family", () => {
    const out = splitContainerFamilies({
      name: "httpd",
      categories: [
        { name: "a", params: [{ key: "Block", value: "x", container: { name: "Directory" } }] },
        { name: "b", params: [child("Block", "one")] },
      ],
    } as never);
    expect(out).toHaveLength(1);
    expect(out[0].headings.sort()).toEqual(["a", "b"]);
  });

  it("says nothing about a sheet with no blocks at all", () => {
    expect(
      splitContainerFamilies({ name: "kc", categories: [{ name: "Database", params: [{ key: "db", value: "postgres" }] }] } as never)
    ).toEqual([]);
  });
});

describe("mixedFileCategories", () => {
  const row = (key: string, file?: string) => ({ key, value: "v", ...(file ? { deployed_file: file } : {}) });

  // A realm delivered across two import files is still one realm, and its
  // General group legitimately holds rows from both — the note is not an
  // accusation, it is the fact, so somebody can decide whether these are one
  // unit or two things that want components.
  it("names a heading holding rows from more than one file", () => {
    const out = mixedFileCategories({
      name: "realm",
      categories: [{ name: "General", params: [row("a", "realm-a.json"), row("b", "realm-b.json")] }],
    } as never);
    expect(out).toEqual([{ heading: "General", files: ["realm-a.json", "realm-b.json"] }]);
  });

  it("says nothing when one file supplies the whole heading", () => {
    expect(
      mixedFileCategories({ name: "realm", categories: [{ name: "General", params: [row("a", "r.json"), row("b", "r.json")] }] } as never)
    ).toEqual([]);
  });

  // A product default nobody set is written nowhere. Counting "no file" as a
  // file would report every ledger sheet as mixed.
  it("does not count a row with no file as a file of its own", () => {
    expect(
      mixedFileCategories({ name: "realm", categories: [{ name: "General", params: [row("a", "r.json"), row("b")] }] } as never)
    ).toEqual([]);
  });
});

// The advice a build gives about the shape it just produced. Written against
// the real pipeline rather than the pure helpers above, because the number it
// reports — how many groups the file heading displaced — exists nowhere else:
// the rows on the default layout do not carry it, and reconstructing it from
// the model would be the report guessing at its own subject.
describe("the advice on a file table long enough to be a wall", () => {
  const DICT = (n: number): string =>
    `product: demo\nversion: "1"\nprovenance: extracted\ncoverage: full\nparameters:\n` +
    Array.from({ length: n }, (_, i) => `  k${i}:\n    description: { en: d }\n    default: "0"\n    group: G${i % 8}\n`).join("");

  const build = (n: number, layout?: string) => {
    const files: Record<string, string> = {
      "p.yml": `sheets:\n  s:\n${layout ? `    layout: ${layout}\n` : ""}    params: {}\n`,
      "meta/demo@1.yml": DICT(n),
    };
    return assembleSheetsWithReport(
      [
        {
          name: "s",
          instances: [],
          layers: [{ kind: "base", entries: new Map(Array.from({ length: n }, (_, i) => [`k${i}`, { value: "1", source: { file: "vars.yml", line: 1 } }])) }],
          embedded: [],
        } as never,
      ],
      {
        projectPath: "p.yml",
        metadataDirs: ["meta"],
        readFile: (p: string) => files[p] ?? null,
        strictMetadata: false,
        dictionaries: { s: [{ product: "demo", version: "1", deployed_file: "/etc/demo.conf" }] },
      } as never
    );
  };

  it("says how many rows, how many groups, and what to declare", () => {
    const note = build(48).layoutNotes.find((n) => n.includes("/etc/demo.conf"));
    expect(note).toContain("48 rows");
    expect(note).toContain("8");
    expect(note).toContain("layout: file+categories");
  });

  it("says nothing about a table short enough to read", () => {
    expect(build(12).layoutNotes).toEqual([]);
  });

  // Advice, not a verdict: once the sheet declares the layout, the shape is
  // what its author chose and the build has nothing left to suggest.
  it("stops once the sheet declares that layout", () => {
    expect(build(48, "file+categories").layoutNotes).toEqual([]);
  });
});

// Advice that would earn its own warning is worse than silence: a file with
// blocks in it must not be told to group, because grouping files a block's
// settings away from the block — which is exactly what the split warning
// reports. Measured on Apache: `Require` binds to mod_authz_core while the
// <Directory> holding it binds to core, so the advice and the warning would
// arrive in the same build, about the same file, contradicting each other.
describe("the advice declines to recommend a layout it would then warn about", () => {
  const DICT = (n: number): string =>
    `product: demo\nversion: "1"\nprovenance: extracted\ncoverage: full\nparameters:\n` +
    Array.from({ length: n }, (_, i) => `  k${i}:\n    description: { en: d }\n    default: "0"\n    group: G${i % 8}\n`).join("");

  const build = (n: number, withBlocks: boolean) => {
    const files: Record<string, string> = { "p.yml": `sheets:\n  s:\n    params: {}\n`, "meta/demo@1.yml": DICT(n) };
    return assembleSheetsWithReport(
      [
        {
          name: "s",
          instances: [],
          layers: [{ kind: "base", entries: new Map() }],
          embedded: Array.from({ length: n }, (_, i) => ({
            key: `k${i}`,
            value: "1",
            source: { file: "demo.conf", line: i + 1 },
            ...(withBlocks && i === 0 ? { containers: [{ name: "Block", subject: '"x"', pathSeg: "Block", headings: ["Block"], line: 1 }] } : {}),
          })),
        } as never,
      ],
      {
        projectPath: "p.yml",
        metadataDirs: ["meta"],
        readFile: (p: string) => files[p] ?? null,
        strictMetadata: false,
        dictionaries: { s: [{ product: "demo", version: "1", deployed_file: "/etc/demo.conf" }] },
      } as never
    );
  };

  it("advises on a flat file of the same size", () => {
    expect(build(48, false).layoutNotes.some((n) => n.includes("layout: file+categories"))).toBe(true);
  });

  it("says nothing about a file that has a block in it", () => {
    expect(build(48, true).layoutNotes.some((n) => n.includes("layout: file+categories"))).toBe(false);
  });
});
