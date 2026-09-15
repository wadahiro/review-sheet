// A sheet whose model is its markdown, rendered as the sheet.
//
// The point of full-edit mode is that the artifact stays a parameter sheet to
// look at while being text to maintain — so what is asserted here is the LOOK:
// the sheet's own columns, in the sheet's own order, with the parent/child
// indent a paper sheet has.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root } from "../src/html/app";
import { inlineMarkdown } from "../src/html/inline-markdown";
import { rowIsUnset } from "../src/sheet-markdown";
import {
  parseMarkdownBlocks,
  tableShape,
  markdownToCategories,
  liftMarkdownSheet,
  declaredInstances,
  withEnvironment,
  withoutEnvironment,
  renameEnvironment,
} from "../src/sheet-markdown";
import { navAnchorId, paramAnchorId } from "../src/html/anchors";
import { sheetToMarkdown } from "../src/sheet-markdown";
import { getMessages } from "../src/html/i18n";
import { setCellToolSetter } from "../src/html/cell-tool";
import { customStyles } from "../src/html/styles";
import type { SheetData } from "../src/prompt";
import type { ParameterSheetInput } from "../src/types";

const SHEET = {
  name: "os",
  instances: ["staging", "production"],
  categories: [
    {
      name: "keycloak.service",
      params: [
        { key: "Unit", container: { name: "Unit" }, value: "", origin: "embedded", description: { ja: "ユニット" } },
        { key: "Unit.Description", container_path: [{ path: "Unit" }], value: "Keycloak", origin: "embedded" },
        { key: "Service.Restart", container_path: [{ path: "Service" }], value: "always", origin: "embedded" },
        // Nobody set this one: the product's own default applies.
        { key: "Service.Nice", container_path: [{ path: "Service" }], value: "0", default: "0", origin: "default" },
      ],
    },
  ],
} as unknown as SheetData["sheets"][number];

const MD = sheetToMarkdown(SHEET as never, "ja");

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

// The reader's own control for the rows nobody set — reached the way a reader
// reaches it, since the page is the sheet's own now and the toggle is the
// sheet's own too.
async function showUnsetRows(host: HTMLElement): Promise<void> {
  const menu = [...host.querySelectorAll("button")].find((b) => /絞り込み/.test(b.textContent ?? ""));
  (menu as HTMLElement | undefined)?.click();
  await Promise.resolve();
  const check = [...host.querySelectorAll(".rs-menu-check")].find((l) => /未設定の行を表示/.test(l.textContent ?? ""));
  // Absent when the page has no unset row to show — which is what a reader
  // meets too, so it is not a failure, it is nothing to do.
  if (!check) {
    (menu as HTMLElement | undefined)?.click();
    return;
  }
  (check.querySelector("input") as HTMLInputElement).click();
  await Promise.resolve();
}

// Mounted through the REAL page, because there is no second renderer to mount:
// a sheet whose model is markdown is lifted into categories and drawn by the
// sheet's own table (`liftMarkdownSheet`), which is the whole reason the two
// readings of a delivery look alike. So what these assert is what a reader
// meets, reached the way a reader reaches it.
async function mount(markdown = MD, showDefaults = false): Promise<HTMLElement> {
  localStorage.clear();
  location.hash = "#1";
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    h(Root as never, {
      payload: {
        metadata: { title: "t" },
        versions: [
          {
            version: "current",
            sheets: [{ name: "os", instances: ["staging", "production"], categories: [], document: { html: "", markdown, mode: "sheet" } }],
          },
        ],
      },
      reviewEnabled: false,
      initialLang: "ja",
      server: false,
    } as never),
    host
  );
  if (showDefaults) await showUnsetRows(host);
  return host;
}


// The same page, for a case that needs its own markdown, environments or
// artifacts. One door in, because there is one renderer.
async function mountPage(opts: {
  markdown: string;
  instances?: string[];
  showDefaults?: boolean;
  artifacts?: unknown[];
}): Promise<HTMLElement> {
  localStorage.clear();
  location.hash = "#1";
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    h(Root as never, {
      payload: {
        metadata: { title: "t" },
        versions: [
          {
            version: "current",
            sheets: [{ name: "os", instances: opts.instances ?? [], categories: [], document: { html: "", markdown: opts.markdown, mode: "sheet" } }],
            ...(opts.artifacts === undefined ? {} : { artifacts: opts.artifacts }),
          },
        ],
      },
      reviewEnabled: false,
      initialLang: "ja",
      server: false,
    } as never),
    host
  );
  if (opts.showDefaults === true) await showUnsetRows(host);
  return host;
}

describe("the sheet as markdown, written", () => {
  it("indents a row under the block that holds it, and names it by its leaf", () => {
    expect(MD).toContain("| `Unit` |");
    expect(MD).toContain("|   `Description` |");
    expect(MD).toContain("|   `Restart` |");
  });

  // The row nobody set: an empty value cell, and the default column carrying
  // what applies. It is what a paper sheet does, and it is the only thing a
  // document can say once there is no `origin` behind it.
  it("leaves the value empty on a row nobody set", () => {
    const line = MD.split("\n").find((l) => l.includes("`Nice`"))!;
    expect(line).toBe("|   `Nice` |  | 0 |  |  |");
  });

  // WHERE each block is written. A double click on the page opens the editor
  // there, so this is the number the whole jump rests on — counted while
  // parsing, never searched for afterwards.
  it("says which line every block starts on", () => {
    const md = ["# S", "", "本文。", "", "## C", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", ""].join("\n");
    const blocks = parseMarkdownBlocks(md);
    expect(blocks.map((b) => [b.kind, b.line])).toEqual([
      ["heading", 1],
      ["prose", 3],
      ["heading", 5],
      ["table", 7],
    ]);
    const table = blocks.find((b) => b.kind === "table")!;
    expect(table.kind === "table" && table.rows.map((r) => r.line)).toEqual([9, 10]);
  });

  it("round-trips through its own parse", () => {
    const blocks = parseMarkdownBlocks(MD);
    const table = blocks.find((b) => b.kind === "table")!;
    // `Service` is DRAWN: the model has no row for a block whose opening
    // carries no argument, and an indent step nothing explains is worse than
    // no indent at all — the sheet's own viewer draws it the same way.
    expect(table.kind === "table" && table.rows.map((r) => [r.indent, r.cells[0]])).toEqual([
      [0, "`Unit`"],
      [1, "`Description`"],
      // …and says beside itself that it is the opening and not a row.
      [0, "`Service`<!-- rs:block= -->"],
      [1, "`Restart`"],
      [1, "`Nice`"],
    ]);
  });
});

describe("the sheet as markdown, rendered", () => {
  it("lays the columns out as the sheet does", async () => {
    const host = await mount();
    // The leading columns carry the pin control, so their class says whether
    // they are currently frozen — the text is what is compared here.
    const heads = [...host.querySelectorAll("th")].map((e) => [
      e.className.split(" ")[0],
      (e.querySelector("span") ?? e).textContent,
    ]);
    expect(heads).toEqual([
      ["rs-col-key", "設定項目"],
      ["rs-col-description", "説明"],
      ["rs-col-default", "デフォルト値"],
      ["rs-col-value", "staging"],
      ["rs-col-value", "production"],
    ]);
  });

  // Freezing the leading columns is the sheet's own control, on the sheet's own
  // classes — a document is read the same way a sheet is.
  // Two columns to begin with, not one: the key and the description beside it,
  // which is what the SHEET freezes by default when the table has a description
  // at all — a key alone scrolls away from the sentence saying what it is. The
  // two readings of one document are held to each other by `set-parity`.
  it("freezes the key and its description, and lets them go", async () => {
    const host = await mount();
    expect(host.querySelector("table")?.className).toContain("rs-freeze-2");
    const tick = async (): Promise<void> => {
      (host.querySelector(".rs-pin") as HTMLElement).click();
      // Preact batches, so the class is on the next tick, not this one.
      await new Promise((r) => setTimeout(r, 40));
    };
    await tick();
    expect(host.querySelector("table")?.className).toContain("rs-freeze-1");
    await tick();
    expect(host.querySelector("table")?.className).toContain("rs-freeze-0");
  });

  // On the ROW, which is where the sheet's own table carries it — the document
  // says the depth with an indent and the page says it with this, and a row
  // holding others shows its kind rather than its address.
  it("carries the indent onto the row, as a depth", async () => {
    const host = await mount();
    const keys = [...host.querySelectorAll("tr.rs-param-row")].map((r) => [
      (r as HTMLElement).style.getPropertyValue("--rs-block-depth") || "0",
      r.querySelector("td.rs-col-key")?.textContent,
    ]);
    // `Service` is there, and is NOT a row: the model has that block only as
    // the indent of the row inside it, and the sheet draws the heading from
    // that chain. The projection writes an opening for it because a table has
    // no other way to put a row under something — and says so beside it, so the
    // page draws its own heading rather than reading the opening as a row the
    // model never had.
    expect(keys).toEqual([
      ["0", "Unit"],
      ["1", "Description"],
      ["0", "Service"],
      ["1", "Restart"],
    ]);
  });

  it("hides the rows nobody set, and shows them when asked", async () => {
    expect((await mount(MD, false)).textContent).not.toContain("Nice");
    expect((await mount(MD, true)).textContent).toContain("Nice");
  });

  // A block has no value of its own — `Unit`, `<Directory>` — so the "hide what
  // nobody set" rule would take it and leave its contents indented under
  // nothing. It stays for as long as anything under it does, and goes when
  // everything under it is gone.
  it("keeps a block for as long as it holds something", async () => {
    const host = await mount();
    expect(host.textContent).toContain("Unit");
    const allUnset = MD.replace("| Keycloak | Keycloak |", "|  |  |").replace("| always | always |", "|  |  |");
    expect((await mount(allUnset)).textContent).not.toContain("Unit");
  });

  // A heading is a category heading, with the sheet's own sticky depth.
  it("renders a heading as the sheet's category header", async () => {
    const host = await mount();
    const head = host.querySelector(".rs-category-header");
    expect(head?.textContent).toBe("keycloak.service");
    expect(head?.closest(".rs-category")?.className).toContain("rs-depth-1");
  });

  // A column the reviewer adds by hand is a column: the header row is what says
  // what a table has.
  it("shows a column somebody added", async () => {
    const edited = MD.replace("| staging | production |", "| staging | production | 備考 |")
      .replace("| --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- | --- |")
      .replace("| `Unit` | ユニット |  |  |  |", "| `Unit` | ユニット |  |  |  | 要確認 |");
    const host = await mount(edited);
    expect([...host.querySelectorAll("th")].map((e) => e.textContent)).toContain("備考");
    expect(host.querySelector("td.rs-col-remarks")?.textContent).toBe("要確認");
  });
});

// The toolbar's "hide what nobody set" count, the outline and the search are
// all built from the categories DERIVED from this text — one index, not two —
// and the rule for "unset" there has to be the one the body hides by, or a
// container ends up counted as a hidden row while it is plainly on screen.
describe("the rows the derived index states", () => {
  const cats = () => markdownToCategories(MD, ["staging", "production"], "ja");

  it("marks the row nobody set, and only that one", () => {
    const origins = cats()[0].params!.map((p) => [p.key, p.origin]);
    // `Service` is the projection's own block opening, not a row — see above.
    expect(origins).toEqual([
      ["Unit", undefined],
      ["Unit.Description", undefined],
      ["Service.Restart", undefined],
      ["Service.Nice", "default"],
    ]);
  });

  it("keeps a paragraph as the section's note", () => {
    const withNote = MD.replace("## keycloak.service\n", "## keycloak.service\n\nこの節は本番だけ効く。\n");
    expect(markdownToCategories(withNote, ["staging", "production"], "ja")[0].note).toBe("この節は本番だけ効く。");
  });
});

// The preview panel is a LENS on the file a row's line lives in, and a set
// carries that address under the row's key — so the affordance survives the
// model going away. A row nothing has a line for gets none: a button that opens
// nothing is worse than no button.
//
// Reached through the artifact index, exactly as a modelled sheet reaches it:
// the page is drawn by the sheet's own renderer either way, so there is nothing
// here that only a markdown page does.
describe("the file a row's line is in", () => {
  const PREVIEWS = [
    {
      id: "preview-1",
      sheet: "os",
      component: "keycloak.service",
      source_file: "/etc/systemd/system/keycloak.service",
      lines: [
        { text: "[Unit]", kind: "verbatim" },
        { text: "Description=Keycloak", kind: "substituted", key: "Unit.Description" },
      ],
    },
  ];

  it("is offered on the row it has a line for, and on no other", async () => {
    const host = await mountPage({ markdown: MD, instances: ["staging", "production"], artifacts: PREVIEWS });
    const chips = [...host.querySelectorAll(".rs-artifact-chip")];
    expect(chips).toHaveLength(1);
    (chips[0] as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 30));
    expect(host.querySelector(".rs-artifact-panel"), "the chip opened nothing").not.toBeNull();
    const here = host.querySelector(".rs-artifact-line.rs-here");
    expect(here?.textContent).toContain("Description=Keycloak");
  });
});

// A wide table scrolls inside itself, where a CSS sticky header has nothing to
// stick to — so the header is lifted out of the table and kept aligned with the
// body's horizontal scroll, exactly as the sheet's own tables do it.
describe("the header that follows a wide table", () => {
  it("splits the header from the body on a sheet with environments", async () => {
    const host = await mount();
    expect(host.querySelector(".rs-table-split")).not.toBeNull();
    expect(host.querySelector(".rs-sticky-head thead")).not.toBeNull();
    expect(host.querySelector(".rs-split-body tbody")).not.toBeNull();
    // The two halves have the SAME columns, in the same order, and both are
    // laid out from fixed widths — a column with no width of its own takes
    // what is left, and what is left differs between a table that scrolls and
    // a header lifted out of it.
    const [head, body] = [...host.querySelectorAll(".rs-table-split table")];
    expect([...head.querySelectorAll("th")].map((e) => e.className.split(" ")[0])).toEqual(
      [...body.querySelectorAll("tbody tr:first-child td")].map((e) => e.className.split(" ")[0])
    );
    expect([head.className, body.className].every((c) => c.includes("rs-param-table-fixed"))).toBe(true);
    // …and every column class a split table can carry has a width of its own.
    const css = customStyles;
    for (const col of ["rs-col-key", "rs-col-description", "rs-col-default", "rs-col-value", "rs-col-remarks"]) {
      expect(css).toContain(`.rs-param-table-fixed.rs-param-table-wide .${col} {`);
    }
  });

  // A sheet with no environments is narrow enough to stay in flow, where the
  // CSS sticky header works and a lifted one would only be a second mechanism.
  it("leaves a narrow table in one piece", async () => {
    const narrow = [
      "# s",
      "",
      "## c",
      "",
      "| 設定項目 | デフォルト値 | 設定値 |",
      "| --- | --- | --- |",
      "| `k` |  | 1 |",
      "",
    ].join("\n");
    const host = await mountPage({ markdown: narrow, showDefaults: true });
    expect(host.querySelector(".rs-table-split")).toBeNull();
    expect(host.querySelector("thead")).not.toBeNull();
  });
});

// A section's heading sticks below its parent's, which the sheet's layout reads
// off `--rs-depth` on the ANCESTOR — so a nested section has to be inside its
// parent's element, not beside it.
describe("how the sections nest", () => {
  it("puts a section inside the one it belongs to", async () => {
    const nested = [
      "# s",
      "",
      "## parent",
      "",
      "### child",
      "",
      "| 設定項目 | デフォルト値 | 設定値 |",
      "| --- | --- | --- |",
      "| `k` |  | 1 |",
      "",
    ].join("\n");
    const host = await mountPage({ markdown: nested, showDefaults: true });
    const child = [...host.querySelectorAll(".rs-category")].find((e) => (e.textContent ?? "").startsWith("child"))!;
    expect(child.className).toContain("rs-depth-2");
    expect(child.parentElement?.className).toContain("rs-depth-1");
  });
});

// The outline and the search palette are built from categories DERIVED from
// this same text (`markdownToCategories`), and they jump by id. If the body
// numbered its headings and rows differently, every entry would point at
// nothing — so both sides use anchors.ts and this is the check that they do.
describe("what the outline jumps to", () => {
  it("puts the same ids on a heading and a row that the index expects", async () => {
    const host = await mount(MD, true);
    const cats = markdownToCategories(MD, ["staging", "production"], "ja");
    expect(host.querySelector(`#${CSS?.escape ? CSS.escape(navAnchorId(0, cats[0].name)) : navAnchorId(0, cats[0].name)}`)).not.toBeNull();
    const first = cats[0].params![0];
    const rowId = paramAnchorId(0, cats[0].name, first.key);
    expect([...host.querySelectorAll("tr")].map((e) => e.id)).toContain(rowId);
  });
});

// Which column is which is decided by NAME — the environment names the sheet
// declares — and everything else follows from where they start. What matters
// most is the other half of that rule: a column no role claims is still shown,
// under its own heading, rather than folded into a neighbour's.
//
// At the END, which is what changed when the page stopped having a renderer of
// its own: the sheet's table lays a declared column out where the model can put
// one (`place: "trailing"`), and the model has no way to say "between the
// description and the default". The heading and every value survive; the
// position does not, and that is the cost of one renderer rather than two.
describe("a column nobody predicted", () => {
  it("is shown, under its own heading", async () => {
    const md = MD.replace("| 設定項目 | 説明 | デフォルト値 |", "| 設定項目 | 説明 | 出荷時 | デフォルト値 |")
      .replace("| --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- | --- |")
      .replace(/^\|(\s*)`([^`]*)` \|/gm, "|$1`$2` | 旧 |");
    const host = await mount(md, true);
    const heads = [...host.querySelectorAll("th")].map((e) => (e.querySelector("span") ?? e).textContent);
    expect(heads).toEqual(["設定項目", "説明", "デフォルト値", "staging", "production", "出荷時"]);
    expect(host.querySelector("tbody tr")?.textContent).toContain("旧");
  });
});

// A heading over nothing reads as a rendering fault — and the outline, built
// from the same text by the same rule, has already dropped it, so the heading
// left behind is one nothing can jump to. The sheet's own view has always
// hidden such a category; this is the same rule in the document.
describe("a section whose rows are all hidden", () => {
  const md = [
    "# os",
    "",
    "## SELinux",
    "",
    "| 設定項目 | デフォルト値 | 設定値 |",
    "| --- | --- | --- |",
    "| `state` |  | enforcing |",
    "",
    "## 製品既定のみ",
    "",
    "| 設定項目 | デフォルト値 | 設定値 |",
    "| --- | --- | --- |",
    "| `unused` | 0 |  |",
    "",
  ].join("\n");

  const headings = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-category-header")].map((e) => (e.textContent ?? "").trim());

  it("goes with them, heading and all", async () => {
    expect(headings(await mount(md, false))).toEqual(["SELinux"]);
    expect(headings(await mount(md, true))).toEqual(["SELinux", "製品既定のみ"]);
  });

  // A section that holds only a paragraph is not empty: what it has to show is
  // the paragraph.
  it("stays when it holds a note", async () => {
    const noted = md.replace("## 製品既定のみ\n", "## 製品既定のみ\n\n本番のみ有効。\n");
    expect(headings(await mount(noted, false))).toEqual(["SELinux", "製品既定のみ"]);
  });

  // …and a heading whose own table is empty but whose CHILD has rows stays,
  // because the child is under it.
  it("stays when something under it does", async () => {
    const nested = [
      "# os",
      "",
      "## 親",
      "",
      "| 設定項目 | デフォルト値 | 設定値 |",
      "| --- | --- | --- |",
      "| `unused` | 0 |  |",
      "",
      "### 子",
      "",
      "| 設定項目 | デフォルト値 | 設定値 |",
      "| --- | --- | --- |",
      "| `set` |  | 1 |",
      "",
    ].join("\n");
    expect(headings(await mount(nested, false))).toEqual(["親", "子"]);
  });
});

// The three things a value cell says, on the sheet and here alike: nothing is
// set, it is set to what the default already says, or it is a decision of this
// project's own. Read off the TEXT here — the two cells are side by side in the
// same row — which is all a document has.
describe("what a value cell says about itself", () => {
  const md = [
    "# s",
    "",
    "## c",
    "",
    "| 設定項目 | デフォルト値 | staging | production |",
    "| --- | --- | --- | --- |",
    "| `own` | off | on | on |",
    "| `same` | off | off | off |",
    "| `unset` | off |  |  |",
    "",
  ].join("\n");

  const cellsOf = (host: HTMLElement, key: string): string[] => {
    const row = [...host.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes(key))!;
    return [...row.querySelectorAll("td.rs-col-value")].map((e) => e.className.replace("rs-col-value", "").trim());
  };

  const mountMd = async (): Promise<HTMLElement> => {
    const host = await mountPage({ markdown: md, instances: ["staging", "production"], showDefaults: true });
    return host;
  };

  // "Nothing is set here" and "set to nothing" are different facts, and an empty
  // cell says the second unless it is told to say the first. The sheet's own
  // cells have always said it; the document's did not.
  it("says that a row nobody set uses the default", async () => {
    const host = await mountMd();
    const row = [...host.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes("unset"))!;
    expect([...row.querySelectorAll("td.rs-col-value")].map((e) => e.textContent)).toEqual([
      getMessages("ja").usesDefault,
      getMessages("ja").usesDefault,
    ]);
  });

  // …and a value somebody wrote that happens to equal the default is NOT that:
  // writing it was a decision, and a sheet that shows the two alike hides it.
  it("shows a written value that equals the default as the value it is", async () => {
    const host = await mountMd();
    const row = [...host.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes("same"))!;
    expect([...row.querySelectorAll("td.rs-col-value")].map((e) => e.textContent)).toEqual(["off", "off"]);
  });

  it("marks a value of its own, one that equals the default, and one nobody set", async () => {
    const host = await mountMd();
    // `rs-cell-common` beside it: one value repeated across every environment
    // is what `origin: "common"` asserts, and the sheet marks it. A set carries
    // no origin by design, so it is read off the table — see md-sheet.ts.
    expect(cellsOf(host, "own")).toEqual(["rs-changed rs-cell-common", "rs-changed rs-cell-common"]);
    expect(cellsOf(host, "same")).toEqual(["rs-same-as-default", "rs-same-as-default"]);
    expect(cellsOf(host, "unset")).toEqual(["rs-cell-unset", "rs-cell-unset"]);
  });

  // Copying a value is worth as much in a document as on a sheet, and it is the
  // one cell action a document can offer.
  it("offers the value to be copied", async () => {
    const host = await mountMd();
    const cell = [...host.querySelectorAll("td.rs-col-value")].find((e) => (e.textContent ?? "").trim() === "on")!;
    let shown: unknown = null;
    setCellToolSetter((c) => (shown = c));
    (cell as HTMLElement).dispatchEvent(new Event("mouseenter", { bubbles: false }));
    setCellToolSetter(null);
    expect(shown).toMatchObject({ canCopy: true, effectiveValue: "on", reviewEnabled: false });
  });
});

// The address a delivered set writes under a row's key, as the page reads it.
//
// It shares the cell with the row's IDENTITY, which is the whole hazard: every
// reader of that cell has to split it first, and the copy button is the one
// that shows up in a reviewer's clipboard rather than in a diff.
//
// What the reader MEETS is the key and, where the page also holds the file, the
// sheet's own chip — the address itself is carried out of the cell by the lift
// (`liftMarkdownSheet`) and spent on the artifact index, which is what makes a
// dropped set's rows open their files (tests/viewer.test.ts). A page holding no
// such file shows no affordance at all rather than one that opens nothing.
describe("the address under a row's key", () => {
  const md = [
    "# os",
    "",
    "## httpd.conf",
    "",
    "| 設定項目 | デフォルト値 | staging | production |",
    "| --- | --- | --- | --- |",
    "| `Listen`<br>[プレビュー](artifacts/staging/httpd.conf#L34) |  | 80 | 8080 |",
    "",
  ].join("\n");

  const mount = async (): Promise<HTMLElement> =>
    await mountPage({ markdown: md, instances: ["staging", "production"] });

  it("is taken out of the cell, which says the key and nothing else", async () => {
    const cell = (await mount()).querySelector("td.rs-col-key")!;
    expect(cell.querySelector("code")!.textContent).toBe("Listen");
    expect(cell.textContent).not.toContain("プレビュー");
    expect(cell.querySelector("a")).toBeNull();
  });

  it("is what the lift hands out, so something can still open the file", () => {
    expect(liftMarkdownSheet(md, ["staging", "production"], "ja").addresses).toEqual([
      { key: "Listen", href: "artifacts/staging/httpd.conf#L34" },
    ]);
  });

  // What the cell SAYS is the key. A copied key with a markdown link stuck to
  // the end of it is not a key.
  it("offers the key to be copied, and not the address with it", async () => {
    const cell = (await mount()).querySelector("td.rs-col-key")! as HTMLElement;
    let shown: unknown = null;
    setCellToolSetter((c) => (shown = c));
    cell.dispatchEvent(new Event("mouseenter", { bubbles: false }));
    setCellToolSetter(null);
    expect(shown).toMatchObject({ effectiveValue: "Listen" });
  });

  // The row is the row the model wrote, whatever is under its key — the
  // document's anchors and its change set are both built from this name.
  it("names the row by its key alone", async () => {
    expect((await mount()).querySelector("tr.rs-param-row")!.id).toBe(paramAnchorId(0, "httpd.conf", "Listen"));
  });

  // A cell somebody typed into, so the address no longer stands alone. It is
  // not an address any more and is not read as one — the whole cell is the
  // key, which is what a document nobody generated has always meant.
  it("reads a cell with writing after the link as all key", async () => {
    const host = await mountPage({ markdown: md.replace("#L34)", "#L34) and then some"), instances: ["staging", "production"] });
    expect(host.querySelectorAll("tr.rs-param-row")).toHaveLength(1);
  });
});

describe("a cell is inline markdown, and nothing else", () => {
  it("renders a code span and escapes the rest", () => {
    expect(inlineMarkdown("`a<b>`")).toBe("<code>a&lt;b&gt;</code>");
    expect(inlineMarkdown("<script>")).toBe("&lt;script&gt;");
    expect(inlineMarkdown("**強調**")).toBe("<strong>強調</strong>");
  });
});

// Adding an environment to a hand-maintained sheet.
//
// The declaration at the top and every table have to move together, or the
// document disagrees with itself about what its axis is — and a column across
// 300 rows is not an edit anybody makes by hand. So the tool performs it, and
// the result is ordinary text: the next reader sees a column, and the change
// report sees an environment.
describe("the environments a document declares", () => {
  // The TABLE says which columns are environments, and nothing else does: a
  // column is one unless it is a column this projection writes for something
  // else. There is no declaration beside the table, so there is nothing for a
  // header row to disagree with.
  it("reads them off the header row, with no declaration to keep", () => {
    expect(MD).not.toContain("環境:");
    expect(declaredInstances(MD)).toEqual(["staging", "production"]);
  });

  // Said out loud rather than hidden: a column added for something that is not
  // an environment reads as one. Naming it `備考` — the projection's own word
  // for a column of prose — is how a reader says it is not an axis.
  it("takes a column it did not write as an environment, and a 備考 as prose", () => {
    const withOwner = MD.replace("| staging | production |", "| staging | production | 担当者 |");
    expect(declaredInstances(withOwner)).toEqual(["staging", "production", "担当者"]);
    const withRemarks = MD.replace("| staging | production |", "| staging | production | 備考 |");
    expect(declaredInstances(withRemarks)).toEqual(["staging", "production"]);
  });

  it("adds a column to the declaration and to every table at once", () => {
    const next = withEnvironment(MD, "dr");
    expect(declaredInstances(next)).toEqual(["staging", "production", "dr"]);
    const table = parseMarkdownBlocks(next).find((b) => b.kind === "table")!;
    expect(table.kind === "table" && table.head).toEqual(["設定項目", "説明", "デフォルト値", "staging", "production", "dr"]);
    // Every row grew a cell, so no row's values shifted under the wrong header.
    expect(table.kind === "table" && table.rows.every((r) => r.cells.length === 6)).toBe(true);
    // …and the new column reads as an environment, not as a stray column.
    const shape = tableShape(table.kind === "table" ? table.head : [], declaredInstances(next) ?? [], "ja");
    expect(shape.values.map((n) => (table.kind === "table" ? table.head[n] : ""))).toEqual([
      "staging",
      "production",
      "dr",
    ]);
  });

  it("puts it where the reader asked for it", () => {
    expect(declaredInstances(withEnvironment(MD, "dr", "staging"))).toEqual(["staging", "dr", "production"]);
  });

  it("takes one out again, leaving the document as it was", () => {
    expect(withoutEnvironment(withEnvironment(MD, "dr"), "dr")).toBe(MD);
  });

  it("renames one in the declaration and in the header", () => {
    const next = renameEnvironment(MD, "staging", "stg");
    expect(declaredInstances(next)).toEqual(["stg", "production"]);
    expect(next).toContain("| stg | production |");
  });
});
