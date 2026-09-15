// The sheet set as markdown — the artifact a recipient maintains.
//
// Two things are being pinned. The LAYOUT: one file per sheet, the chapter tree
// as directories, named rather than numbered, with an index that carries the
// order. And the ADDRESSES: every link in the set resolves to a file that is
// really there, checked against a whole fixture project rather than a handful
// of constructed rows — a link that opens nothing is the failure this column
// exists to prevent, and it fails silently.

import { describe, it, expect, afterAll } from "bun:test";
import { carriedDocuments } from "../src/md-documents";
import type { ArtifactPreview } from "../src/types";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, dirname, resolve as resolvePath } from "path";
import { toMarkdownSet, slug } from "../src/md-set";
import { addressOf, type CarriedDocument } from "../src/md-documents";
import { SET_DIR } from "../src/set-block";
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
        { id: "x", sheet: "httpd", path: "artifacts/etc/httpd/conf/httpd.conf", text: "Listen 80\n" },
        { id: "x", sheet: "loose", path: "evidence/local/web01/etc/hosts", text: "127.0.0.1\n" },
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

  // The set used to open every page with a list of them. It stopped being the
  // way in — a row carries the address of the line it is written at and a
  // verdict the address of the bytes it was read from — so the list became 65
  // of 65 files something already reached, above the content on every page.
  // Measured on a real delivery.
  //
  // It also mattered that the two readings of one document looked the SAME. The
  // list was written into the markdown, so it appeared on the page read back
  // out of a folder and nowhere else: one document with two appearances,
  // decided by which half of the delivery the reader happened to open.
  it("does not open the page with a list of them", () => {
    const page = carried().files.find((f) => f.path === "構築/OS/httpd.md")!;
    expect(page.text).not.toContain("このシートが記述するファイル");
    expect(page.text.split("\n")[0]).toBe("# httpd");
  });

  // What the list also did, silently, was make an unreachable file look
  // reachable — so the thing it was hiding is said instead.
  it("says when nothing on any page can reach one", () => {
    const { problems } = carried();
    expect(problems.join(" ")).toContain("no page linking to them");
    expect(problems.join(" ")).toContain("artifacts/etc/httpd/conf/httpd.conf");
  });

  it("keeps the first of two documents written at one path, and says so", () => {
    const { problems } = toMarkdownSet(doc(), "ja", {
      documents: [
        { id: "x", sheet: "httpd", path: "artifacts/a", text: "one" },
        { id: "x", sheet: "httpd", path: "artifacts/a", text: "two" },
      ],
    });
    expect(problems.join(" ")).toContain("two documents are written at");
  });
});

// A sheet whose model is a DOCUMENT, not rows.
//
// `toMarkdownSheet` projects categories and a prose document has none, so such
// a sheet was written as its title and nothing else. Measured on a real
// delivery: four sheets, including two test records, gone with no error and no
// warning — and the HTML carried them the whole time, which is what made it
// invisible. The two shapes are one model; only one of them was reading this
// half of it.
describe("a sheet that is a document", () => {
  const prose = [
    "# Acceptance record",
    "",
    "What this record covers.",
    "",
    "## Items",
    "",
    "| No. | Subject | Result |",
    "| --- | --- | --- |",
    "| 1 | Listen | pass |",
    "",
  ].join("\n");
  const doc = (): SheetData =>
    ({
      metadata: { title: "t" },
      groups: [{ name: "record", display: "Records" }],
      sheets: [
        {
          name: "acceptance",
          display: "Acceptance",
          group: "record",
          categories: [],
          document: { html: "<p>…</p>", markdown: prose },
        },
      ],
    }) as unknown as SheetData;

  it("writes the document, not just the sheet's name", () => {
    const { files, problems } = toMarkdownSet(doc(), "ja");
    const page = files.find((f) => f.path === "Records/Acceptance.md")!;
    expect(page.text).toContain("## Items");
    expect(page.text).toContain("| 1 | Listen | pass |");
    expect(problems).toEqual([]);
  });

  // The page already shows the sheet's heading, which carries the label in the
  // reader's language where a markdown h1 carries one — the same reason the
  // renderer drops it (markdown.ts).
  it("heads it with the sheet's title, in place of the document's own", () => {
    const page = toMarkdownSet(doc(), "ja").files.find((f) => f.path === "Records/Acceptance.md")!;
    expect(page.text.split("\n")[0]).toBe("# Acceptance");
    expect(page.text).not.toContain("# Acceptance record");
  });

  // The shape of the bug, as a check: a sheet is made of rows or of prose, and
  // a file with neither is a sheet that did not travel — which looks exactly
  // like a sheet that is simply short.
  it("reports a sheet that came out as its title and nothing else", () => {
    const empty = doc();
    delete (empty.sheets[0] as { document?: unknown }).document;
    const { problems } = toMarkdownSet(empty, "ja");
    expect(problems.join("\n")).toContain("title and nothing else");
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
    expect(readme).toContain("1ファイルで保存");
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
    // …and which LANGUAGE it was written in, beside it: the file names are
    // resolved per language, so `verify --md` has to project the model the
    // same way to know which files to expect.
    expect(files[0]!.text).toContain("<!-- review-sheet:model abc123 lang=ja -->");
    expect(files.slice(1).some((f) => f.text.includes("review-sheet:model"))).toBe(false);
  });
});

// The whole point of the address column, checked the only way it can be: over a
// real project, by opening what every link points at.
// Which copy of a file a row's link names, when the file differs by environment.
describe("the address under a row's key", () => {
  const doc = (path: string, at: Record<string, number>): CarriedDocument =>
    ({ id: path, path, text: "", sheet: "s", lineOf: (k: string) => at[k] }) as CarriedDocument;

  it("names the line, in the copy it resolved to", () => {
    expect(addressOf([doc("artifacts/staging/x.conf", { Listen: 12 })], "Listen")).toBe("artifacts/staging/x.conf#L12");
  });

  // The case a single copy cannot answer: a `{% if %}` line one environment
  // renders and another does not. The line is not written into the copy that
  // does not render it — the file on disk has no such line — so a link built
  // from that copy alone opens the file at the top and shows the reader
  // nothing. Measured on a real delivery: three rows, one of them the
  // `<LocationMatch>` the admin console sits behind.
  it("falls through to a copy that renders the line", () => {
    const staging = doc("artifacts/staging/httpd.conf", {});
    const production = doc("artifacts/production/httpd.conf", { LocationMatch: 392 });
    expect(addressOf([staging, production], "LocationMatch")).toBe("artifacts/production/httpd.conf#L392");
  });

  // A branch no environment takes. There is no line anywhere to send anyone
  // to, so the file is named and nothing is claimed about where in it.
  it("names the file alone where no copy renders the row", () => {
    expect(addressOf([doc("artifacts/staging/s.sh", {}), doc("artifacts/production/s.sh", {})], "AWS_ACCESS_KEY_ID")).toBe(
      "artifacts/staging/s.sh"
    );
  });
});

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
        // Every address this set carries now points INSIDE it — a sheet, a
        // chapter, or the deployed file a row is a line of — so all of them
        // resolve from the file the link is written in. The one kind that used
        // to climb out (the repository line a value is written on) is gone; it
        // was dead in the hands of the recipient this set is for.
        if (!existsSync(join(dirname(f), href))) broken.push(`${f} -> ${href}`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(broken).toEqual([]);
  });

  // The link under a row's key, end to end: it names a file this set really
  // carries, and the line it names is the line that holds the value.
  //
  // Both halves matter and only the second can be wrong quietly. A link to a
  // file that is not there fails the check above; a link to the WRONG LINE of
  // the right file opens, scrolls, and shows the reader a different setting.
  it("points at the line of the carried file that holds the value", () => {
    const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync(["bun", "run", cli, "generate", "-i", "input.json", "--format", "md", "-o", out], {
      cwd: project,
    });
    expect(r.exitCode, r.stderr.toString().slice(0, 500)).toBe(0);

    const sheetFile = join(out, SET_DIR, "keycloak configuration.md");
    const text = readFileSync(sheetFile, "utf-8");
    // One word on every row that has one — never the file name, which the
    // heading above the rows already says.
    const links = [...text.matchAll(/\| `([^`]+)`<br>\[([^\]]+)\]\(([^)]+)\)/g)];
    expect(links.length).toBeGreaterThan(5);
    expect(new Set(links.map((m) => m[2]))).toEqual(new Set(["プレビュー"]));

    let checked = 0;
    for (const [, key, , dest] of links) {
      const [path = "", frag = ""] = decodeURI(dest!).split("#");
      const at = /^L(\d+)$/.exec(frag);
      expect(at, `${key}: no line in ${dest}`).not.toBeNull();
      const lines = readFileSync(join(dirname(sheetFile), path), "utf-8").split("\n");
      // The line is 1-based and the key is written on it. Read off the file the
      // link points at rather than off the model, because the file is what the
      // reader opens — and it is not the preview line for line (a line this
      // environment does not render is not written out at all).
      expect(lines[Number(at![1]) - 1], `${key} -> ${dest}`).toContain(key);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(5);
  });
});

// A committed markdown set is read for months, and nothing about it says it has
// stopped describing the configuration: a value moves in a file, the sheet is
// regenerated for the HTML, and the markdown goes on looking exactly as correct
// as the day it was written.
// One sheet, two different files. The ordinary Ansible shape — a rendered
// template beside a committed `files/` fragment — and the case a link cannot
// get away with being approximately right about.
//
// Their previews share an id (neither producer passes `previewId` a file
// discriminator), which the viewer survives: it opens the id and the reader
// gets tabs. A link into a delivered set has to name ONE file on disk, so
// resolving a row by id picked whichever preview came first and sent every row
// of the template to the fragment — with no line at all, since the fragment has
// no line for them. Resolved by the PREVIEW instead (`artifact-index.ts`).
describe("a sheet whose rows are spread over two files", () => {
  const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-basic");
  const out = join(work, "two-files");

  it("sends each row to the file that actually holds its line", () => {
    const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync(["bun", "run", cli, "generate", "-i", "input.json", "--format", "md", "-o", out], {
      cwd: project,
    });
    expect(r.exitCode, r.stderr.toString().slice(0, 500)).toBe(0);

    const sheetFile = join(out, SET_DIR, "nginx configuration.md");
    const text = readFileSync(sheetFile, "utf-8");
    const dest = (key: string): string =>
      new RegExp(`\\| \`${key.replace(/[[\]]/g, "\\$&")}\`<br>\\[[^\\]]+\\]\\(([^)]+)\\)`).exec(text)?.[1] ?? "";

    // A row of the template, and a row of the committed fragment.
    expect(dest("server_name")).toMatch(/nginx\.conf#L\d+$/);
    expect(dest("server_tokens")).toMatch(/security\.conf#L\d+$/);

    // …and every one of them lands on the line that holds it.
    for (const [, key, address] of text.matchAll(/\| `([^`]+)`<br>\[[^\]]+\]\(([^)]+)\)/g)) {
      const [path = "", frag = ""] = decodeURI(address!).split("#");
      const at = /^L(\d+)$/.exec(frag);
      expect(at, `${key}: no line in ${address}`).not.toBeNull();
      const lines = readFileSync(join(dirname(sheetFile), path), "utf-8").split("\n");
      // The row's own leaf: a key is a structural address (`http.sendfile`) and
      // the line holds the directive (`sendfile on;`).
      const leaf = key!.replace(/\[\d+\]$/, "").split(".").pop()!;
      expect(lines[Number(at![1]) - 1], `${key} -> ${address}`).toContain(leaf);
    }
  });
});

describe("a committed set that no longer describes the model", () => {
  const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-keycloak");
  const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");
  const set = join(work, "stale");

  const run = (...args: string[]): { code: number | null; out: string } => {
    const r = Bun.spawnSync(["bun", "run", cli, ...args], { cwd: project });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  };
  const write = (text: string): void => writeFileSync(join(set, SET_DIR, "README.md"), text, "utf-8");

  it("passes while the set is the model's own", () => {
    expect(run("generate", "-i", "input.json", "--format", "md", "-o", set).code).toBe(0);
    const r = run("verify", "-i", "input.json", "--md", set);
    expect(r.code).toBe(0);
    expect(r.out).toContain("describes this model");
  });

  // What the stamp deliberately cannot see.
  //
  // It is taken over the MODEL so it survives the editing this set exists for
  // — a value corrected, a remark reworded, a row struck out — which left it
  // blind to the set's contents entirely: a sheet cut down to its heading, or
  // a document sheet that never carried its prose, passed with "describes this
  // model". Both happened, and the second shipped in a delivery.
  describe("a page that is gone rather than edited", () => {
    const sheetFile = (name: string): string => join(set, SET_DIR, `${name}.md`);

    it("names a sheet left holding nothing but its heading", () => {
      run("generate", "-i", "input.json", "--format", "md", "-o", set);
      const f = sheetFile("keycloak configuration");
      writeFileSync(f, `${readFileSync(f, "utf-8").split("\n")[0]}\n`, "utf-8");
      const r = run("verify", "-i", "input.json", "--md", set);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("keycloak configuration.md — its heading and nothing else");
    });

    it("names a sheet whose file is not there", () => {
      run("generate", "-i", "input.json", "--format", "md", "-o", set);
      rmSync(sheetFile("keycloak realm"));
      const r = run("verify", "-i", "input.json", "--md", set);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("keycloak realm.md — no such file");
    });

    // THE DESIGN PIN. Everything this check refuses to look at, done at once.
    // A set is MEANT to be maintained by hand, and `markdown-changes.ts` has
    // `row-removed` as a first-class edit — so a check that compared contents,
    // or counted rows, would fail on the flow it is supposed to protect. The
    // next person tempted to turn this into a content hash should see this go
    // red first.
    it("stays silent about a set somebody edited", () => {
      run("generate", "-i", "input.json", "--format", "md", "-o", set);
      const f = sheetFile("keycloak configuration");
      const text = readFileSync(f, "utf-8");
      const rows = text.split("\n").filter((l) => l.startsWith("| `"));
      expect(rows.length).toBeGreaterThan(4);
      const edited = text
        .replace(rows[0]!, rows[0]!.replace(/\| ([^|]+) \|$/, "| a different value |"))
        .replace(rows[1]!, `${rows[1]!.replace(/\|\s*$/, "")} a reworded remark |`)
        .replace(`${rows[2]!}\n`, "")
        .replace(rows[3]!, `${rows[3]!}\n| \`a row somebody added\` |  |  |  |`);
      writeFileSync(f, edited, "utf-8");
      const r = run("verify", "-i", "input.json", "--md", set);
      expect(r.out).not.toContain("are gone or empty");
      expect(r.code).toBe(0);
    });

    // A set written before the stamp carried the language. Its file names were
    // resolved in one of them and this does not know which, so both are tried
    // — a page found under either spelling is a page that is there.
    it("still finds the pages of a set whose stamp predates lang=", () => {
      run("generate", "-i", "input.json", "--format", "md", "-o", set);
      const readme = join(set, SET_DIR, "README.md");
      writeFileSync(readme, readFileSync(readme, "utf-8").replace(/ lang=(ja|en)/, ""), "utf-8");
      const r = run("verify", "-i", "input.json", "--md", set);
      expect(r.out).not.toContain("are gone or empty");
      expect(r.code).toBe(0);
    });
  });

  it("fails, naming both models, once they are not the same one", () => {
    run("generate", "-i", "input.json", "--format", "md", "-o", set);
    const readme = readFileSync(join(set, SET_DIR, "README.md"), "utf-8");
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
    const readme = readFileSync(join(set, SET_DIR, "README.md"), "utf-8");
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
    expect(readFileSync(join(narrowed, SET_DIR, "README.md"), "utf-8")).toContain("instances=production");
    const r = run("verify", "-i", "input.json", "--md", narrowed);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(production)");
  });

  it("says so when the directory holds no set at all", () => {
    const r = run("verify", "-i", "input.json", "--md", join(work, "nothing-here"));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("no set under");
  });
});

// WHICH environments a carried file is for is always a level of its own.
describe("the environment level under artifacts/", () => {
  const preview = (over: Record<string, unknown>): ArtifactPreview =>
    ({
      id: String(over.id ?? "a"),
      sheet: "web",
      source_file: String(over.deployed_path ?? "x"),
      lines: [{ text: String(over.text ?? "x"), kind: "verbatim" as const }],
      ...over,
    }) as ArtifactPreview;

  it("says `common` for a file that is the same everywhere", () => {
    const docs = carriedDocuments([preview({ deployed_path: "/etc/chrony.conf" })], ["staging", "production"]);
    expect(docs[0]!.path).toBe("artifacts/common/etc/chrony.conf");
  });

  it("names the environments for a file that differs", () => {
    const docs = carriedDocuments([preview({ deployed_path: "/etc/x.conf", instances: ["staging"] })], ["staging", "production"]);
    expect(docs[0]!.path).toBe("artifacts/staging/etc/x.conf");
  });

  it("keeps a path that begins with an environment's own name apart", () => {
    // Without a level that is ALWAYS there, these two land on one path: a
    // repository laying its configuration out per environment has files at
    // `staging/…`, and so does the level itself.
    const docs = carriedDocuments(
      [
        preview({ id: "a", deployed_path: "app.conf", instances: ["staging"], text: "a" }),
        preview({ id: "b", deployed_path: "staging/app.conf", text: "b" }),
      ],
      ["staging", "production"]
    );
    expect(docs.map((d) => d.path)).toEqual(["artifacts/staging/app.conf", "artifacts/common/staging/app.conf"]);
  });
});

// A record's in-text evidence links, as addresses in the SET.
//
// `evidenceCell` writes them over the DOCUMENT's own id, which a page built
// from the model resolves and a set has no name for at all. Rewritten to the
// same kind of relative address every row already carries, so the record opens
// its evidence in a plain markdown reader and in the page that reads the folder
// back — both by the one name a set has for a document, its path.
describe("a record's evidence links in a set", () => {
  const ID = "observed local web01 /etc/hosts";
  const record = (dest: string): SheetData =>
    ({
      metadata: { title: "t" },
      groups: [{ name: "tests", display: "Unit tests" }],
      sheets: [{ name: "rec", group: "tests", instances: [], categories: [], document: { markdown: `# Record\n\nread [web01 /etc/hosts:3](${dest}) today\n` } }],
    }) as never as SheetData;
  const carried = [{ id: ID, sheet: "rec", path: "evidence/local/web01/etc/hosts", text: "127.0.0.1\n" }];
  const written = (dest: string, docs = carried) =>
    toMarkdownSet(record(dest), "ja", { documents: docs });
  const page = (out: ReturnType<typeof written>): string =>
    out.files.find((f) => f.path === "Unit tests/rec.md")!.text;

  it("names the file the set carries, and keeps the line", () => {
    const out = written(`rs-evidence:${encodeURIComponent(`${ID}#L3`)}`);
    expect(page(out)).toContain("](evidence/local/web01/etc/hosts#L3)");
    expect(page(out)).not.toContain("rs-evidence:");
    expect(out.problems).toEqual([]);
  });

  it("leaves a link to evidence this set does not carry, and says so", () => {
    // There is nothing to point it at. A path invented for it would be the
    // affordance-that-opens-nothing wearing a working link's clothes.
    const out = written(`rs-evidence:${encodeURIComponent("observed local web01 /etc/other")}`, carried);
    expect(page(out)).toContain("rs-evidence:");
    expect(out.problems.join(" ")).toContain("links to evidence this set does not carry");
  });
});
