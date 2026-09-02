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
import { MarkdownSheetBody, inlineMarkdown, rowIsUnset } from "../src/html/md-sheet";
import {
  parseMarkdownBlocks,
  tableShape,
  markdownToCategories,
  declaredInstances,
  withEnvironment,
  withoutEnvironment,
  renameEnvironment,
} from "../src/sheet-markdown";
import { navAnchorId, paramAnchorId } from "../src/html/anchors";
import { sheetToMarkdown, toFullEditInput } from "../src/full-edit";
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
});

function mount(markdown = MD, showDefaults = false): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(
    h(MarkdownSheetBody, {
      markdown,
      instances: ["staging", "production"],
      lang: "ja",
      sheetIndex: 0,
      hiddenInstances: new Set<string>(),
      showDefaults,
      t: getMessages("ja"),
    }),
    host
  );
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

  it("round-trips through its own parse", () => {
    const blocks = parseMarkdownBlocks(MD);
    const table = blocks.find((b) => b.kind === "table")!;
    // `Service` is DRAWN: the model has no row for a block whose opening
    // carries no argument, and an indent step nothing explains is worse than
    // no indent at all — the sheet's own viewer draws it the same way.
    expect(table.kind === "table" && table.rows.map((r) => [r.indent, r.cells[0]])).toEqual([
      [0, "`Unit`"],
      [1, "`Description`"],
      [0, "`Service`"],
      [1, "`Restart`"],
      [1, "`Nice`"],
    ]);
  });
});

describe("the sheet as markdown, rendered", () => {
  it("lays the columns out as the sheet does", () => {
    const host = mount();
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
  it("freezes the key column, and lets it go", async () => {
    const host = mount();
    expect(host.querySelector("table")?.className).toContain("rs-freeze-1");
    (host.querySelector(".rs-pin") as HTMLElement).click();
    // Preact batches, so the class is on the next tick, not this one.
    await new Promise((r) => setTimeout(r, 40));
    expect(host.querySelector("table")?.className).toContain("rs-freeze-0");
  });

  it("carries the indent onto the key cell, as a depth", () => {
    const host = mount();
    const keys = [...host.querySelectorAll("td.rs-col-key")].map((e) => [
      (e as HTMLElement).style.getPropertyValue("--rs-block-depth"),
      e.textContent,
    ]);
    expect(keys).toEqual([
      ["0", "Unit"],
      ["1", "Description"],
      ["0", "Service"],
      ["1", "Restart"],
    ]);
  });

  it("hides the rows nobody set, and shows them when asked", () => {
    expect(mount(MD, false).textContent).not.toContain("Nice");
    expect(mount(MD, true).textContent).toContain("Nice");
  });

  // A block has no value of its own — `Unit`, `<Directory>` — so the "hide what
  // nobody set" rule would take it and leave its contents indented under
  // nothing. It stays for as long as anything under it does, and goes when
  // everything under it is gone.
  it("keeps a block for as long as it holds something", () => {
    const host = mount();
    expect(host.textContent).toContain("Unit");
    const allUnset = MD.replace("| Keycloak | Keycloak |", "|  |  |").replace("| always | always |", "|  |  |");
    expect(mount(allUnset).textContent).not.toContain("Unit");
  });

  // A heading is a category heading, with the sheet's own sticky depth.
  it("renders a heading as the sheet's category header", () => {
    const host = mount();
    const head = host.querySelector(".rs-category-header");
    expect(head?.textContent).toBe("keycloak.service");
    expect(head?.closest(".rs-category")?.className).toContain("rs-depth-1");
  });

  // A column the reviewer adds by hand is a column: the header row is what says
  // what a table has.
  it("shows a column somebody added", () => {
    const edited = MD.replace("| staging | production |", "| staging | production | 備考 |")
      .replace("| --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- | --- |")
      .replace("| `Unit` | ユニット |  |  |  |", "| `Unit` | ユニット |  |  |  | 要確認 |");
    const host = mount(edited);
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
    expect(origins).toEqual([
      ["Unit", undefined],
      ["Unit.Description", undefined],
      ["Service", undefined],
      ["Service.Restart", undefined],
      ["Service.Nice", "default"],
    ]);
  });

  it("keeps a paragraph as the section's note", () => {
    const withNote = MD.replace("## keycloak.service\n", "## keycloak.service\n\nこの節は本番だけ効く。\n");
    expect(markdownToCategories(withNote, ["staging", "production"], "ja")[0].note).toBe("この節は本番だけ効く。");
  });
});

// The preview panel is a LENS on the file a row's line lives in, and a document
// keeps it: `row_keys` says which model row each document row was written from,
// so the affordance survives the model going away. A row somebody wrote
// themselves is in no such map and gets none — a button that opens nothing is
// worse than no button.
describe("the file a row's line is in", () => {
  const opened: string[][] = [];
  const artifact = {
    idFor: (sheet: string, category: string, key: string) =>
      sheet === "os" && category === "keycloak.service" && key === "Unit.Description" ? "preview-1" : undefined,
    open: (id: string, key: string) => opened.push([id, key]),
  };
  const rowKeys = { "keycloak.service Unit.Description": "Unit.Description" };

  it("is offered on the row it has a line for, and on no other", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(MarkdownSheetBody, {
        markdown: MD,
        instances: ["staging", "production"],
        lang: "ja",
        sheetIndex: 0,
        hiddenInstances: new Set<string>(),
        showDefaults: false,
        rowKeys,
        sheetName: "os",
        artifact,
        t: getMessages("ja"),
      }),
      host
    );
    const chips = [...host.querySelectorAll(".rs-artifact-chip")];
    expect(chips).toHaveLength(1);
    (chips[0] as HTMLElement).click();
    expect(opened).toEqual([["preview-1", "Unit.Description"]]);
  });
});

// A wide table scrolls inside itself, where a CSS sticky header has nothing to
// stick to — so the header is lifted out of the table and kept aligned with the
// body's horizontal scroll, exactly as the sheet's own tables do it.
describe("the header that follows a wide table", () => {
  it("splits the header from the body on a sheet with environments", () => {
    const host = mount();
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
  it("leaves a narrow table in one piece", () => {
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
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(MarkdownSheetBody, {
        markdown: narrow,
        instances: [],
        lang: "ja",
        sheetIndex: 0,
        hiddenInstances: new Set<string>(),
        showDefaults: true,
        t: getMessages("ja"),
      }),
      host
    );
    expect(host.querySelector(".rs-table-split")).toBeNull();
    expect(host.querySelector("thead")).not.toBeNull();
  });
});

// A section's heading sticks below its parent's, which the sheet's layout reads
// off `--rs-depth` on the ANCESTOR — so a nested section has to be inside its
// parent's element, not beside it.
describe("how the sections nest", () => {
  it("puts a section inside the one it belongs to", () => {
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
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(MarkdownSheetBody, {
        markdown: nested,
        instances: [],
        lang: "ja",
        sheetIndex: 0,
        hiddenInstances: new Set<string>(),
        showDefaults: true,
        t: getMessages("ja"),
      }),
      host
    );
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
  it("puts the same ids on a heading and a row that the index expects", () => {
    const host = mount(MD, true);
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
// in the place the author put it. It used to fall between the roles and be
// rendered nowhere, while the document still held it.
describe("a column nobody predicted", () => {
  it("is shown, in the order the document writes it", () => {
    const md = MD.replace("| 設定項目 | 説明 | デフォルト値 |", "| 設定項目 | 説明 | 出荷時 | デフォルト値 |")
      .replace("| --- | --- | --- | --- | --- |", "| --- | --- | --- | --- | --- | --- |")
      .replace(/^\|(\s*)`([^`]*)` \|/gm, "|$1`$2` | 旧 |");
    const host = mount(md, true);
    const heads = [...host.querySelectorAll("th")].map((e) => (e.querySelector("span") ?? e).textContent);
    expect(heads).toEqual(["設定項目", "説明", "出荷時", "デフォルト値", "staging", "production"]);
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

  it("goes with them, heading and all", () => {
    expect(headings(mount(md, false))).toEqual(["SELinux"]);
    expect(headings(mount(md, true))).toEqual(["SELinux", "製品既定のみ"]);
  });

  // A section that holds only a paragraph is not empty: what it has to show is
  // the paragraph.
  it("stays when it holds a note", () => {
    const noted = md.replace("## 製品既定のみ\n", "## 製品既定のみ\n\n本番のみ有効。\n");
    expect(headings(mount(noted, false))).toEqual(["SELinux", "製品既定のみ"]);
  });

  // …and a heading whose own table is empty but whose CHILD has rows stays,
  // because the child is under it.
  it("stays when something under it does", () => {
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
    expect(headings(mount(nested, false))).toEqual(["親", "子"]);
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

  const mountMd = (): HTMLElement => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(MarkdownSheetBody, {
        markdown: md,
        instances: ["staging", "production"],
        lang: "ja",
        sheetIndex: 0,
        hiddenInstances: new Set<string>(),
        showDefaults: true,
        t: getMessages("ja"),
      }),
      host
    );
    return host;
  };

  // "Nothing is set here" and "set to nothing" are different facts, and an empty
  // cell says the second unless it is told to say the first. The sheet's own
  // cells have always said it; the document's did not.
  it("says that a row nobody set uses the default", () => {
    const host = mountMd();
    const row = [...host.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes("unset"))!;
    expect([...row.querySelectorAll("td.rs-col-value")].map((e) => e.textContent)).toEqual([
      getMessages("ja").usesDefault,
      getMessages("ja").usesDefault,
    ]);
  });

  // …and a value somebody wrote that happens to equal the default is NOT that:
  // writing it was a decision, and a sheet that shows the two alike hides it.
  it("shows a written value that equals the default as the value it is", () => {
    const host = mountMd();
    const row = [...host.querySelectorAll("tbody tr")].find((r) => (r.textContent ?? "").includes("same"))!;
    expect([...row.querySelectorAll("td.rs-col-value")].map((e) => e.textContent)).toEqual(["off", "off"]);
  });

  it("marks a value of its own, one that equals the default, and one nobody set", () => {
    const host = mountMd();
    expect(cellsOf(host, "own")).toEqual(["rs-changed", "rs-changed"]);
    expect(cellsOf(host, "same")).toEqual(["rs-same-as-default", "rs-same-as-default"]);
    expect(cellsOf(host, "unset")).toEqual(["rs-cell-unset", "rs-cell-unset"]);
  });

  // Copying a value is worth as much in a document as on a sheet, and it is the
  // one cell action a document can offer.
  it("offers the value to be copied", () => {
    const host = mountMd();
    const cell = [...host.querySelectorAll("td.rs-col-value")].find((e) => (e.textContent ?? "").trim() === "on")!;
    let shown: unknown = null;
    setCellToolSetter((c) => (shown = c));
    (cell as HTMLElement).dispatchEvent(new Event("mouseenter", { bubbles: false }));
    setCellToolSetter(null);
    expect(shown).toMatchObject({ canCopy: true, effectiveValue: "on", reviewEnabled: false, editEnabled: false });
  });
});

describe("a cell is inline markdown, and nothing else", () => {
  it("renders a code span and escapes the rest", () => {
    expect(inlineMarkdown("`a<b>`")).toBe("<code>a&lt;b&gt;</code>");
    expect(inlineMarkdown("<script>")).toBe("&lt;script&gt;");
    expect(inlineMarkdown("**強調**")).toBe("<strong>強調</strong>");
  });
});

describe("what full-edit mode hands over", () => {
  it("turns every sheet with rows into markdown, and leaves a document sheet alone", () => {
    const input = {
      metadata: { title: "t" },
      sheets: [
        SHEET as never,
        { name: "doc", categories: [], document: { html: "<p>x</p>", markdown: "# doc" } },
      ],
    } as unknown as ParameterSheetInput;
    const out = toFullEditInput(input, "ja");
    expect(out.sheets[0].document?.mode).toBe("sheet");
    expect(out.sheets[0].categories).toEqual([]);
    expect(out.sheets[0].document?.markdown).toContain("`Unit`");
    // A page that was already prose stays prose.
    expect(out.sheets[1].document?.mode).toBeUndefined();
  });
});

describe("which column is which", () => {
  it("finds the value columns by name, whatever precedes them", () => {
    const shape = tableShape(["設定項目", "説明", "デフォルト値", "staging", "production", "備考"], ["staging", "production"]);
    expect(shape).toEqual({ key: 0, description: 1, default: 2, values: [3, 4], rest: [5] });
  });

  it("reads a table with no description column", () => {
    const shape = tableShape(["設定項目", "デフォルト値", "staging"], ["staging"]);
    expect(shape).toMatchObject({ description: -1, default: 1, values: [2] });
  });

  it("is unset when every value cell is empty", () => {
    expect(rowIsUnset(["k", "d", "0", "", ""], [3, 4])).toBe(true);
    expect(rowIsUnset(["k", "d", "0", "", "1"], [3, 4])).toBe(false);
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
