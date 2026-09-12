// The sheet set as markdown — the artifact a recipient maintains.
//
// Two things are being pinned. The LAYOUT: one file per sheet, the chapter tree
// as directories, named rather than numbered, with an index that carries the
// order. And the ADDRESSES: every link in the set resolves to a file that is
// really there, checked against a whole fixture project rather than a handful
// of constructed rows — a link that opens nothing is the failure this column
// exists to prevent, and it fails silently.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve as resolvePath } from "path";
import { toMarkdownSet, slug } from "../src/md-set";
import type { SheetData } from "../src/prompt";

const work = mkdtempSync(join(tmpdir(), "review-sheet-md-set-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sheet = (name: string, group?: string): SheetData["sheets"][number] =>
  ({
    name,
    ...(group === undefined ? {} : { group }),
    categories: [{ name: "c", params: [{ key: "k", value: "v", description: "d" }] }],
  }) as unknown as SheetData["sheets"][number];

const doc = (): SheetData =>
  ({
    metadata: { title: "t", project: "p" },
    groups: [
      { name: "design", label: { ja: "基本設計" }, display: "基本設計" },
      { name: "build", display: "構築", groups: [{ name: "os", display: "OS" }] },
    ],
    // A bracket in a name is ordinary — `Keycloak (realm)` — and a markdown
    // link destination ends at the first `)`, so an unencoded one opens
    // nothing. Measured on a real document: 33 entries, silently.
    sheets: [sheet("overview (all)", "design"), sheet("httpd", "os"), sheet("loose")],
  }) as unknown as SheetData;

describe("where each sheet lands", () => {
  it("mirrors the chapter tree as directories, one file per sheet", () => {
    const { files } = toMarkdownSet(doc(), "ja");
    expect(files.map((f) => f.path)).toEqual([
      "README.md",
      "基本設計/overview (all).md",
      "構築/OS/httpd.md",
      "loose.md",
    ]);
  });

  // The numbers are derived from the declared order and move the moment a
  // chapter is inserted. A numbered path would rename every file below it for a
  // change that altered nothing, and take the history and every link with it.
  it("names the directories, and does not number them", () => {
    const { files } = toMarkdownSet(doc(), "ja");
    expect(files.every((f) => !/(^|\/)\d+[-.]/.test(f.path))).toBe(true);
  });

  // A sheet naming a chapter the document does not have would otherwise be in
  // the model and in no file.
  it("keeps a sheet whose chapter is not in the tree, and says so", () => {
    const d = doc();
    (d.sheets as unknown as { group?: string }[])[0]!.group = "nowhere";
    const { files, problems } = toMarkdownSet(d, "ja");
    expect(files.map((f) => f.path)).toContain("overview (all).md");
    expect(problems.join(" ")).toContain('names chapter "nowhere"');
  });

  // Two names a filesystem cannot tell apart: `a/b` and `a:b` both have to lose
  // the character, and then they are one path. Sheet names are unique in a
  // model, so this is the only way a collision can arise — and the survivor
  // would otherwise be whichever came last.
  it("gives the second of two names that spell one path a path of its own, and says so", () => {
    const d = doc();
    const sheets = d.sheets as unknown as { name: string; group?: string }[];
    sheets[0]!.name = "a/b";
    sheets[1]!.name = "a:b";
    sheets[1]!.group = "design";
    const { files, problems } = toMarkdownSet(d, "ja");
    const under = files.filter((f) => f.path.startsWith("基本設計/"));
    expect(under).toHaveLength(2);
    expect(new Set(under.map((f) => f.path)).size).toBe(2);
    expect(problems.join(" ")).toContain("both spell");
  });

  // The name is what the reader and the assistant refer to; transliterating it
  // would invent a second name for the same chapter. Only what breaks a path
  // is replaced.
  it("keeps the name in the path, and replaces only what a path cannot hold", () => {
    expect(slug("基本設計")).toBe("基本設計");
    expect(slug("a/b:c")).toBe("a-b-c");
    expect(slug("  ..  ")).toBe("sheet");
  });
});

describe("the index", () => {
  it("lists the chapters in the order the document declares, as links", () => {
    const { files } = toMarkdownSet(doc(), "ja");
    const readme = files[0]!.text;
    expect(files[0]!.path).toBe("README.md");
    expect(readme.indexOf("基本設計")).toBeLessThan(readme.indexOf("構築"));
    // Every bracket encoded: the destination must not end where the NAME has a
    // closing bracket of its own.
    expect(readme).toContain("[overview (all)](%E5%9F%BA%E6%9C%AC%E8%A8%AD%E8%A8%88/overview%20%28all%29.md)");
  });

  // One stamp, in one place. A stamp on every file is a stamp to forget on one
  // of them, and what it identifies is the SET.
  it("carries the model's stamp, and no sheet file does", () => {
    const { files } = toMarkdownSet(doc(), "ja", { stamp: "abc123" });
    expect(files[0]!.text).toContain("<!-- review-sheet:model abc123 -->");
    expect(files.slice(1).some((f) => f.text.includes("review-sheet:model"))).toBe(false);
  });
});

// The whole point of the address column, checked the only way it can be: over a
// real project, by opening what every link points at.
describe("every address in a generated set resolves", () => {
  const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-keycloak");
  const out = join(work, "set");

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const at = join(dir, e);
      return statSync(at).isDirectory() ? walk(at) : at.endsWith(".md") ? [at] : [];
    });

  it("opens every file it names", () => {
    const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync(["bun", "run", cli, "generate", "-i", "input.json", "--format", "md", "-o", out], {
      cwd: project,
    });
    expect(r.exitCode, r.stderr.toString().slice(0, 500)).toBe(0);

    const files = walk(out);
    expect(files.length).toBeGreaterThan(1);
    const broken: string[] = [];
    let checked = 0;
    for (const f of files) {
      for (const m of readFileSync(f, "utf-8").matchAll(/\]\(([^)]+)\)/g)) {
        const raw = m[1]!;
        // Not every link in the file is one this projection wrote: a
        // dictionary's description carries the product's own documentation
        // links, and those are the product's to be right about. What is checked
        // here is the addresses this tool composed — the relative ones.
        if (/^[a-z][a-z0-9+.-]*:/.test(raw) || raw.startsWith("/")) continue;
        const href = decodeURI(raw.split("#")[0]!);
        checked += 1;
        // A sheet link is relative to the set; a source link climbs out of it
        // and is relative to the project the set was generated in. Both are
        // resolved the same way — from the file the link is written in.
        if (!existsSync(join(dirname(f), href))) broken.push(`${f} -> ${href}`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(broken).toEqual([]);
  });
});
