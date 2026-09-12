// The sheet set as markdown — the artifact a recipient maintains.
//
// Two things are being pinned. The LAYOUT: one file per sheet, the chapter tree
// as directories, named rather than numbered, with an index that carries the
// order. And the ADDRESSES: every link in the set resolves to a file that is
// really there, checked against a whole fixture project rather than a handful
// of constructed rows — a link that opens nothing is the failure this column
// exists to prevent, and it fails silently.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
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

// The set is READ, and the two names a reader sees for one sheet have to be
// the same name: the file is named by the label, so a page headed by the
// identity reads as the wrong file.
describe("what a sheet's page is headed by", () => {
  it("is the name its file carries", () => {
    const d = doc();
    (d.sheets as unknown as { display?: string }[])[1]!.display = "OS基本情報";
    const { files } = toMarkdownSet(d, "ja");
    const page = files.find((f) => f.path.endsWith("OS基本情報.md"));
    expect(page).toBeDefined();
    expect(page!.text.split("\n")[0]).toBe("# OS基本情報");
  });

  it("is the identity where a sheet has no label of its own", () => {
    const { files } = toMarkdownSet(doc(), "ja");
    expect(files.find((f) => f.path === "loose.md")!.text.split("\n")[0]).toBe("# loose");
  });
});

describe("the documents a sheet carries", () => {
  const carried = () =>
    toMarkdownSet(doc(), "ja", {
      documents: [
        { sheet: "httpd", path: "artifacts/etc/httpd/conf/httpd.conf", text: "Listen 80\n", label: "/etc/httpd/conf/httpd.conf" },
        { sheet: "loose", path: "evidence/local/web01/etc/hosts", text: "127.0.0.1\n", label: "web01 /etc/hosts" },
      ],
    });

  // Beside the chapter that describes them, not in a bucket at the root: the
  // document already has a structure and a second, type-shaped one laid over it
  // is one the reader has to leave the chapter to follow.
  it("writes them under the sheet's own directory", () => {
    const paths = carried().files.map((f) => f.path);
    expect(paths).toContain("構築/OS/artifacts/etc/httpd/conf/httpd.conf");
    expect(paths).toContain("evidence/local/web01/etc/hosts");
  });

  it("lists them under the sheet's title, linked from where the sheet is", () => {
    const page = carried().files.find((f) => f.path === "構築/OS/httpd.md")!;
    expect(page.text).toContain("- [/etc/httpd/conf/httpd.conf](artifacts/etc/httpd/conf/httpd.conf)");
    // Before the first section: this is about the whole sheet, and a heading
    // here would become one of its categories.
    expect(page.text.indexOf("artifacts/etc")).toBeLessThan(page.text.indexOf("## c"));
  });

  it("keeps the first of two documents written at one path, and says so", () => {
    const { problems } = toMarkdownSet(doc(), "ja", {
      documents: [
        { sheet: "httpd", path: "artifacts/a", text: "one", label: "a" },
        { sheet: "httpd", path: "artifacts/a", text: "two", label: "a" },
      ],
    });
    expect(problems.join(" ")).toContain("two documents are written at");
  });
});

describe("the index", () => {
  // The recipient has no toolchain and did not ask for one. If it is not
  // obvious in three lines what to edit, what to read it with and what not to
  // touch, the folder loses to the spreadsheet it replaced — not on any
  // argument about formats, but because nobody could tell what it was for.
  it("says what to do with the folder, before the contents", () => {
    const readme = toMarkdownSet(doc(), "ja").files[0]!.text;
    expect(readme).toContain("直すのはこのフォルダの `.md`");
    expect(readme).toContain("viewer.html");
    expect(readme.indexOf("この文書の使い方")).toBeLessThan(readme.indexOf("## 目次"));
  });

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

// A committed markdown set is read for months, and nothing about it says it has
// stopped describing the configuration: a value moves in a file, the sheet is
// regenerated for the HTML, and the markdown goes on looking exactly as correct
// as the day it was written.
describe("a committed set that no longer describes the model", () => {
  const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-keycloak");
  const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");
  const set = join(work, "stale");

  const run = (...args: string[]): { code: number | null; out: string } => {
    const r = Bun.spawnSync(["bun", "run", cli, ...args], { cwd: project });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const write = (text: string): void => writeFileSync(join(set, "README.md"), text, "utf-8");

  it("passes while the set is the model's own", () => {
    expect(run("generate", "-i", "input.json", "--format", "md", "-o", set).code).toBe(0);
    const r = run("verify", "-i", "input.json", "--md", set);
    expect(r.code).toBe(0);
    expect(r.out).toContain("describes this model");
  });

  it("fails, naming both models, once they are not the same one", () => {
    run("generate", "-i", "input.json", "--format", "md", "-o", set);
    const readme = readFileSync(join(set, "README.md"), "utf-8");
    write(readme.replace(/model [0-9a-f]+/, "model deadbeefdeadbeef"));
    const r = run("verify", "-i", "input.json", "--md", set);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("deadbeefdeadbeef");
    expect(r.out).toContain("generate --format md");
  });

  // Not an error: a set written before the stamp existed is not wrong, it is
  // unanswerable — and saying which is the difference between a check somebody
  // acts on and one they learn to pass.
  it("warns rather than fails when the index carries no stamp", () => {
    run("generate", "-i", "input.json", "--format", "md", "-o", set);
    const readme = readFileSync(join(set, "README.md"), "utf-8");
    write(readme.replace(/<!--[\s\S]*?-->\n\n/, ""));
    const r = run("verify", "-i", "input.json", "--md", set);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no model stamp");
  });

  // A DELIVERY covers some environments and is stamped over that model. Handed
  // the whole one, the check would compute a different hash and call a set that
  // is perfectly current stale — so the set records what it was narrowed to and
  // the check narrows the same way.
  it("narrows the same way a delivery was narrowed", () => {
    const narrowed = join(work, "delivery");
    expect(run("generate", "-i", "input.json", "--instances", "production", "--format", "md", "-o", narrowed).code).toBe(0);
    expect(readFileSync(join(narrowed, "README.md"), "utf-8")).toContain("instances=production");
    const r = run("verify", "-i", "input.json", "--md", narrowed);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(production)");
  });

  it("says so when the directory holds no set at all", () => {
    const r = run("verify", "-i", "input.json", "--md", join(work, "nothing-here"));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("is not there");
  });
});
