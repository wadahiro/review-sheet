// A written-out set, read back — the other half of the delivery.
//
// The recipient edits markdown and then has to LOOK at it, and markdown in a
// plain reader is a wall of pipe characters. The viewer already lays a markdown
// table out as the sheet it is; what is pinned here is the step before that,
// which turns a folder into the shape it renders.

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { SET_DIR } from "../src/set-block";
import { join, resolve as resolvePath } from "path";
import { readMarkdownSet, orderOf, rebase, documentPreviews, type SetFile } from "../src/md-read";
import { toMarkdownSet } from "../src/md-set";
import type { SheetData } from "../src/prompt";

const page = (title: string, body = ""): string => `# ${title}\n\n${body}`;

const table = (envs: string[], rows: [string, string][]): string =>
  [
    `| 設定項目 | デフォルト値 | ${envs.join(" | ")} |`,
    `| --- | --- | ${envs.map(() => "---").join(" | ")} |`,
    ...rows.map(([k, v]) => `| \`${k}\` |  | ${envs.map(() => v).join(" | ")} |`),
    "",
  ].join("\n");

const set = (): SetFile[] => [
  {
    path: "README.md",
    text: ["# The document", "", "- 詳細設計", "  - [OS](%E8%A9%B3%E7%B4%B0%E8%A8%AD%E8%A8%88/OS.md)", "- [まえがき](%E3%81%BE%E3%81%88%E3%81%8C%E3%81%8D.md)", ""].join("\n"),
  },
  { path: "詳細設計/OS.md", text: page("OS", `## ネットワーク\n\n${table(["staging", "production"], [["Listen", "80"]])}`) },
  { path: "まえがき.md", text: page("まえがき", "この文書について。\n") },
];

describe("reading a folder back as a document", () => {
  it("takes the chapters from the folders", () => {
    const r = readMarkdownSet(set());
    expect(r.groups.map((g) => g.display)).toEqual(["詳細設計"]);
    expect(r.sheets.find((s) => s.display === "OS")!.group).toBe("詳細設計");
    expect(r.sheets.find((s) => s.display === "まえがき")!.group).toBeUndefined();
  });

  // What an index entry SAYS can be reworded — and an assistant asked to tidy a
  // document will — so the order is read by following the links, and the
  // chapters are read from where the files actually are.
  it("takes the order from the index, by following its links", () => {
    const r = readMarkdownSet(set());
    expect(r.sheets.map((s) => s.display)).toEqual(["OS", "まえがき"]);
    const reworded = set();
    reworded[0]!.text = reworded[0]!.text.replace("[まえがき]", "[Foreword]").replace(/- 詳細設計[\s\S]*?\n(?=- )/, "");
    const flipped = readMarkdownSet([reworded[0]!, reworded[2]!, reworded[1]!]);
    expect(flipped.sheets.map((s) => s.display)).toEqual(["まえがき", "OS"]);
  });

  it("names each page by its own title, and keeps its path as the identity", () => {
    const r = readMarkdownSet(set());
    const os = r.sheets.find((s) => s.display === "OS")!;
    expect(os.name).toBe("詳細設計/OS");
  });

  // Two chapters holding a sheet with the same title is ordinary — a design
  // chapter and a migration one both have a `Keycloak (realm)`. Keyed by title
  // they would be one sheet, and the second would overwrite the first.
  it("keeps two pages with one title apart", () => {
    const two = [
      ...set(),
      { path: "移行差分/OS.md", text: page("OS", `## ネットワーク\n\n${table(["staging"], [["Listen", "8080"]])}`) },
    ];
    const r = readMarkdownSet(two);
    expect(r.sheets.filter((s) => s.display === "OS")).toHaveLength(2);
    expect(r.problems).toEqual([]);
  });

  it("reads the environments off the table, and the rows under their headings", () => {
    const os = readMarkdownSet(set()).sheets.find((s) => s.display === "OS")!;
    expect(os.instances).toEqual(["staging", "production"]);
    expect(os.categories).toHaveLength(1);
    expect((os.categories[0] as { name: string }).name).toBe("ネットワーク");
  });

  // Prose without a table is a page too — a foreword, an architecture note. It
  // has no rows and must not be mistaken for an empty sheet.
  it("keeps a page that is prose and no table", () => {
    const r = readMarkdownSet(set());
    const fore = r.sheets.find((s) => s.display === "まえがき")!;
    expect(fore.categories).toHaveLength(0);
    expect(fore.document.markdown).toContain("この文書について");
  });

  it("says what it cannot answer rather than guessing", () => {
    expect(readMarkdownSet([]).problems.join(" ")).toContain("holds no sheet");
    expect(readMarkdownSet(set().slice(1)).problems.join(" ")).toContain("their order is not");
  });

  // The viewer is ONE page for the whole set, so an address written relative to
  // a sheet resolves against the viewer — off by the sheet's own depth, and
  // silently: the link is there, it looks right, and it opens nothing.
  it("rebases a page's links on the set, so the viewer resolves them", () => {
    const deep: SetFile[] = [
      { path: "README.md", text: "# d\n\n- [x](%E8%A9%B3%E7%B4%B0%E8%A8%AD%E8%A8%88/a/x.md)\n" },
      {
        path: "詳細設計/a/x.md",
        text: "# x\n\n- [conf](../../../roles/x/templates/y.j2#L4)\n- [art](artifacts/etc/y)\n- [web](https://e/x)\n- [abs](/a/b)\n",
      },
    ];
    const page = readMarkdownSet(deep).sheets[0]!.document.markdown;
    // Two directories deep, three levels up: one climb is left, and it is the
    // one that leaves the set for the repository the addresses point into.
    expect(page).toContain("](../roles/x/templates/y.j2#L4)");
    expect(page).toContain("](%E8%A9%B3%E7%B4%B0%E8%A8%AD%E8%A8%88/a/artifacts/etc/y)");
    // A scheme, a root-relative path and a bare fragment are already absolute
    // against something that is not this page.
    expect(page).toContain("](https://e/x)");
    expect(page).toContain("](/a/b)");
  });

  it("leaves a page at the top level alone", () => {
    expect(rebase("[a](b/c.md)", "")).toBe("[a](b/c.md)");
  });

  // A set written INSIDE the repository it describes is the ordinary case, and
  // its addresses point at the real configuration — which is above the set. A
  // climb with nothing left to pop is kept; swallowing it turned every source
  // link into a path inside the set, pointing at nothing.
  it("keeps a climb that leaves the set", () => {
    expect(rebase("[a](../../../x/y.j2)", "詳細設計/OS")).toBe("[a](../x/y.j2)");
    expect(rebase("[a](../../../../x)", "a/b")).toBe("[a](../../x)");
  });

  it("follows only the links that name a page of the set", () => {
    expect(orderOf("[a](a.md) [b](https://x/y.md) [c](/abs/c.md) [d](d.md#L2)")).toEqual(["a.md", "d.md"]);
  });
});

// The two halves against each other, over a whole project: what is written out
// is what comes back.
describe("a generated set, read back", () => {
  const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-keycloak");

  const written = (): SetFile[] => {
    const model = JSON.parse(readFileSync(join(project, "input.json"), "utf-8")) as {
      metadata?: unknown;
      sheets: unknown[];
      groups?: unknown[];
    };
    const { files } = toMarkdownSet(model as unknown as SheetData, "ja");
    return files.filter((f) => f.path.endsWith(".md"));
  };

  it("brings every sheet back, with its rows", () => {
    const files = written();
    const back = readMarkdownSet(files);
    // The index is not a sheet; everything else is.
    expect(back.sheets).toHaveLength(files.length - 1);
    expect(back.problems).toEqual([]);
    const rows = (c: { params?: unknown[]; categories?: unknown[] }): number =>
      (c.params?.length ?? 0) + (c.categories ?? []).reduce((n: number, x) => n + rows(x as never), 0);
    const total = back.sheets.reduce((n, s) => n + (s.categories as never[]).reduce((m, c) => m + rows(c), 0), 0);
    expect(total).toBeGreaterThan(100);
  });
});

// The link under a row's key, from the other end.
//
// A set is written with the addresses relative to the sheet they are in, and
// the viewer is ONE page for the whole set — so the address only reaches the
// panel if rebasing it lands on exactly the string a carried document is
// identified by. Equality IS the mechanism (`app.ts`'s delegated link handler
// compares the href against every preview's id), so nothing about it degrades
// gracefully: a path off by one level, or a fragment lost on the way, is a link
// that is there, looks right, and opens nothing.
describe("a row's link, after the folder is read back", () => {
  const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-basic");
  const out = join(mkdtempSync(join(tmpdir(), "review-sheet-md-read-")), "set");

  it("resolves to a document the page is holding, at a line of it", () => {
    const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");
    const r = Bun.spawnSync(["bun", "run", cli, "generate", "-i", "input.json", "--format", "md", "-o", out], {
      cwd: project,
    });
    expect(r.exitCode, r.stderr.toString().slice(0, 500)).toBe(0);

    // What a drop hands the page: every file under the set, by its path within
    // it (`drop-set.ts`), sheets and carried documents alike.
    const root = join(out, SET_DIR);
    const walk = (at: string, prefix: string): SetFile[] =>
      readdirSync(at, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walk(join(at, e.name), prefix === "" ? e.name : `${prefix}/${e.name}`)
          : [{ path: prefix === "" ? e.name : `${prefix}/${e.name}`, text: readFileSync(join(at, e.name), "utf-8") }]
      );
    const read = readMarkdownSet(walk(root, ""));
    const ids = new Set(documentPreviews(read.documents).map((a) => a.id));
    expect(ids.size).toBeGreaterThan(1);

    let checked = 0;
    for (const sheet of read.sheets) {
      const text = (sheet.document as { markdown: string }).markdown;
      for (const [, address] of text.matchAll(/`<br>\[[^\]]+\]\(([^)]+)\)/g)) {
        const [path = "", frag = ""] = decodeURI(address!).split("#");
        expect(ids, `${sheet.name}: ${address}`).toContain(path);
        expect(frag, `${sheet.name}: ${address}`).toMatch(/^L\d+$/);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
