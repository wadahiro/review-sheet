// Reading a hand-maintained sheet back into the repository.
//
// The browser maps nothing in full-edit mode; this is where the mapping lives,
// and its contract is deliberately weak: whatever lines up with a row becomes
// an ordinary source-mapped edit, and whatever does not is stated as a diff.
// So what is asserted here is BOTH halves — that a value change reaches the
// model, and that everything else is still reported rather than lost.

import { describe, it, expect } from "bun:test";
import { fullEditChanges, documentEditRange, modelRowIndex } from "../src/full-edit-apply";
import { unifiedDiff } from "../src/diff-text";
import { renderMarkdownChanges } from "../src/markdown-changes";
import { sheetToMarkdown } from "../src/full-edit";
import { buildPromptText } from "../src/prompt";
import { planFromEdits, promptItemsFromPlan } from "../src/edits";
import type { SheetData, ReviewItem } from "../src/prompt";

const SHEET = {
  name: "os",
  instances: ["staging", "production"],
  categories: [
    {
      name: "keycloak.service",
      params: [
        // A block with no row of its own: the projection draws it, and the
        // rows under it are addressed through it.
        { key: "Service.Restart", container_path: [{ path: "Service" }], value: "on-failure", origin: "embedded" },
        {
          key: "Service.LimitNOFILE",
          container_path: [{ path: "Service" }],
          origin: "overlay",
          instances: [
            { name: "staging", value: "1024" },
            { name: "production", value: "4096" },
          ],
        },
      ],
    },
  ],
} as unknown as SheetData["sheets"][number];

const MD = sheetToMarkdown(SHEET as never, "ja");
const AT = "2026-09-02T00:00:00Z";
const change = (after: string) => fullEditChanges(SHEET, MD, after, "ja", AT);

// The value columns of one row, as the document writes them.
const setCells = (text: string, key: string, values: string[]): string => {
  const line = text.split("\n").find((l) => l.includes(`\`${key}\``))!;
  // `| key | default | staging | production |` — split on the pipes, so the
  // first and last pieces are the row's own delimiters.
  const cells = line.split("|").slice(1, -1);
  values.forEach((v, i) => (cells[2 + i] = ` ${v} `));
  return text.replace(line, `|${cells.join("|")}|`);
};

describe("a value typed into the delivered document", () => {
  it("reaches the row it belongs to, by the model's own key", () => {
    const d = change(setCells(MD, "Restart", ["always", "always"]));
    expect(d.edits).toHaveLength(1);
    expect(d.edits[0].target).toMatchObject({
      sheet: "os",
      category: "keycloak.service",
      param: "Service.Restart",
      field: "value",
    });
    expect(d.edits[0].changes).toEqual([{ field: "value", current: "on-failure", suggested: "always" }]);
    expect(d.residue).toEqual([]);
  });

  it("names the environment on a per-environment row", () => {
    const d = change(setCells(MD, "LimitNOFILE", ["2048", "4096"]));
    expect(d.edits.map((e) => [e.target.instance, e.changes?.[0].suggested])).toEqual([["staging", "2048"]]);
  });

  // A shared row is ONE value in every column. Changing one of them asks for a
  // line that does not exist yet — a structural change no source map can make —
  // so it is reported as text rather than applied to the shared line, which
  // would move every environment at once.
  it("refuses to move a shared value from one column alone", () => {
    const d = change(setCells(MD, "Restart", ["always", "on-failure"]));
    expect(d.edits).toEqual([]);
    expect(d.residue.map((c) => c.kind)).toEqual(["cell"]);
  });
});

describe("what no row can carry", () => {
  it("keeps a section the reader wrote, as the diff it is", () => {
    const d = change(`${MD}\n## 運用メモ\n\n再起動ポリシーは見直した。\n`);
    expect(d.edits).toEqual([]);
    expect(renderMarkdownChanges(d.residue)).toContain("+ section 運用メモ");
    expect(renderMarkdownChanges(d.residue)).toContain("再起動ポリシーは見直した。");
    // Nothing was left unexplained, so no diff is printed at all.
    expect(d.unaccounted).toBe("");
  });

  it("counts a row that was added and one that was removed", () => {
    const added = change(MD.replace("|   `Restart`", "|   `NewOne` |  | 1 | 1 |\n|   `Restart`"));
    expect(renderMarkdownChanges(added.residue)).toContain("+ row keycloak.service > Service.NewOne");
    const removed = change(MD.split("\n").filter((l) => !l.includes("`Restart`")).join("\n"));
    expect(renderMarkdownChanges(removed.residue)).toContain("- row keycloak.service > Service.Restart");
  });
});

describe("the document as it was handed over", () => {
  const edit = (id: string, current: string, suggested: string, at: string): ReviewItem =>
    ({
      id,
      target: { sheet: "os", field: "document" },
      changes: [{ field: "document", current, suggested }],
      status: "applied",
      at,
    }) as ReviewItem;

  // Three rewrites are ONE change: from what was delivered to what it says now.
  // Taking the newest item's own `current` would take the second rewrite's
  // starting point and call everything before it unchanged.
  it("is the first edit's own starting point, however many followed", () => {
    const range = documentEditRange([
      edit("a", "delivered", "first", "2026-09-01T00:00:00Z"),
      edit("b", "first", "second", "2026-09-02T00:00:00Z"),
      edit("c", "second", "third", "2026-09-03T00:00:00Z"),
    ]);
    expect(range.get("os")).toEqual({ before: "delivered", after: "third" });
  });
});

describe("the diff that carries the rest", () => {
  it("shows what changed, with the lines around it, and not the whole document", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 20", "line 20 changed");
    const patch = unifiedDiff(before, after);
    expect(patch).toContain("-line 20");
    expect(patch).toContain("+line 20 changed");
    expect(patch).toContain(" line 17");
    expect(patch).not.toContain("line 5");
    expect(patch.split("\n").length).toBeLessThan(12);
  });
});

describe("how a row is addressed", () => {
  it("is the heading path and the chain of names that leads to it", () => {
    expect([...modelRowIndex(SHEET).keys()]).toEqual([
      "keycloak.service Service.Restart",
      "keycloak.service Service.LimitNOFILE",
    ]);
  });
});

// What the BROWSER hands to an AI when the document was edited as text.
//
// The whole page was the wrong answer: for a sheet handed over as markdown it
// is hundreds of lines nobody touched, and "replace the source file" names a
// file that does not exist — the sheet was rendered from the model, not from a
// markdown somebody keeps.
describe("the prompt a rewritten sheet produces", () => {
  const rows = Array.from({ length: 30 }, (_, i) => `| \`k${i}\` |  | ${i} |`);
  const before = ["# os", "", "## c", "", "| 設定項目 | デフォルト値 | 設定値 |", "| --- | --- | --- |", ...rows, ""].join("\n");
  const after = before.replace("| `k20` |  | 20 |", "| `k20` |  | 99 |") + "\n## 運用メモ\n\n見直した。\n";
  const data = {
    sheets: [{ name: "os", instances: [], categories: [], document: { html: "", markdown: before, mode: "sheet" } }],
  } as unknown as SheetData;

  const item = (current: string, suggested: string, at: string): ReviewItem =>
    ({
      id: `rev_${at}`,
      target: { sheet: "os", field: "document" },
      changes: [{ field: "document", current, suggested }],
      status: "applied",
      at,
    }) as ReviewItem;

  const promptFor = (...items: ReviewItem[]): string =>
    buildPromptText(
      promptItemsFromPlan(planFromEdits(items), { added: "A", struck: "S", document: "D" }, data.sheets),
      data
    );

  // Per CHANGE, not per line: the reader is a model with a budget, and a row's
  // description shares a line with its value, so a line diff reprints a
  // paragraph to move one word.
  it("states each change, and nothing that did not change", () => {
    const text = promptFor(item(before, after, "2026-09-02T00:00:00Z"));
    expect(text).toContain('~ c > k20 [設定値]: "20" -> "99"');
    expect(text).toContain("+ section 運用メモ");
    expect(text).toContain("見直した。");
    // Not the rows around it, and not the page.
    expect(text).not.toContain("k18");
    expect(text).not.toContain("k5");
  });

  it("says where the deterministic half of the work is done", () => {
    expect(promptFor(item(before, after, "2026-09-02T00:00:00Z"))).toContain("review-sheet apply");
  });

  // Three rewrites are ONE change, from what was DELIVERED — otherwise the diff
  // starts at the second rewrite and everything before it reads as unchanged.
  it("diffs from the document as it was handed over", () => {
    const mid = before.replace("| `k3` |  | 3 |", "| `k3` |  | 7 |");
    const last = mid.replace("| `k20` |  | 20 |", "| `k20` |  | 99 |");
    const text = promptFor(item(before, mid, "2026-09-01T00:00:00Z"), item(mid, last, "2026-09-02T00:00:00Z"));
    expect(text).toContain('~ c > k3 [設定値]: "3" -> "7"');
    expect(text).toContain('~ c > k20 [設定値]: "20" -> "99"');
  });
});
