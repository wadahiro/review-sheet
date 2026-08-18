// Editing a DELIVERED document, rendered as the recipient sees it.
//
// The pure model is covered in edits.test.ts; what only shows up once the tree
// is rendered is whether the edited value actually reaches the cell, whether
// the cell says it is no longer the delivered value, and whether the affordance
// appears at all in a document that was not generated with editing on.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
// viewer.test.ts registers the same globals. Bun may share a process between
// files, and a second register() throws rather than being a no-op.
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root } from "../src/html/app";
import type { ParameterSheetInput, ReviewItem } from "../src/types";

const SHEET: ParameterSheetInput = {
  metadata: { title: "t" },
  sheets: [
    {
      name: "db",
      categories: [
        {
          name: "接続",
          params: [
            { key: "max_connections", value: "500", remarks: "納品時のまま", description: "上限" },
            { key: "shared_buffers", value: "4GB", description: "バッファ" },
          ],
        },
      ],
    },
  ],
};

const PAYLOAD = { metadata: SHEET.metadata, versions: [{ version: "current", sheets: SHEET.sheets }] };
const STORAGE_KEY = "review-sheet::current:";

const editItem = (id: string, suggested: string, at: string, by?: string, field = "value"): ReviewItem => ({
  id,
  target: { sheet: "db", category: "接続", param: "max_connections", field },
  changes: [{ field, suggested, lang: field === "remarks" ? "ja" : undefined }],
  status: "applied",
  at,
  by,
});

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

function mount(opts: { editEnabled: boolean; reviews?: ReviewItem[]; embedded?: ReviewItem[] }): HTMLElement {
  location.hash = "#1";
  const host = document.createElement("div");
  document.body.appendChild(host);
  if (opts.reviews?.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(opts.reviews));
  render(
    h(Root, {
      payload: PAYLOAD,
      // Review and edit are exclusive (see --allow), so an edit-mode document
      // is not also a review one. Mounting both would test a combination the
      // CLI refuses to produce.
      reviewEnabled: !opts.editEnabled,
      editEnabled: opts.editEnabled,
      initialLang: "ja",
      server: false,
      pristineHtml: "<!DOCTYPE html><html><body><div id=\"app\"></div></body></html>",
      embedded: { reviews: opts.embedded ?? [], saves: [] },
    }),
    host
  );
  return host;
}

function row(host: HTMLElement, key: string): HTMLElement {
  const rows = [...host.querySelectorAll("tbody tr")];
  const found = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === key);
  if (!found) throw new Error(`row not found: ${key}`);
  return found as HTMLElement;
}

describe("a delivered document with editing on", () => {
  it("shows the edited value in the cell, not the delivered one", () => {
    const host = mount({ editEnabled: true, reviews: [editItem("rev_a", "700", "2026-08-18T00:00:00Z", "田中")] });
    expect(row(host, "max_connections").querySelector(".rs-col-value")?.textContent).toContain("700");
  });

  it("marks the cell as no longer the value that was delivered", () => {
    const host = mount({ editEnabled: true, reviews: [editItem("rev_a", "700", "2026-08-18T00:00:00Z", "田中")] });
    expect(row(host, "max_connections").querySelector(".rs-cell-edited")).not.toBeNull();
    // An untouched row must NOT be marked — the marker is the only thing
    // separating a checked delivered value from one somebody has since changed.
    expect(row(host, "shared_buffers").querySelector(".rs-cell-edited")).toBeNull();
  });

  it("shows the last of a chain of edits", () => {
    const host = mount({
      editEnabled: true,
      reviews: [
        editItem("rev_a", "600", "2026-08-18T00:00:00Z", "田中"),
        editItem("rev_b", "700", "2026-09-02T00:00:00Z", "田中"),
      ],
    });
    const text = row(host, "max_connections").querySelector(".rs-col-value")?.textContent ?? "";
    expect(text).toContain("700");
    expect(text).not.toContain("600");
  });

  it("applies an edit to remarks", () => {
    const host = mount({ editEnabled: true, reviews: [editItem("rev_a", "増設のため変更", "2026-08-18T00:00:00Z", "田中", "remarks")] });
    expect(row(host, "max_connections").querySelector(".rs-col-remarks")?.textContent).toContain("増設のため変更");
  });

  it("offers a save control once something is unsaved", () => {
    const host = mount({ editEnabled: true, reviews: [editItem("rev_a", "700", "2026-08-18T00:00:00Z", "田中")] });
    const labels = [...host.querySelectorAll(".rs-btn-label")].map((e) => e.textContent);
    expect(labels.some((l) => l?.startsWith("保存"))).toBe(true);
  });

  // Reopening a saved file: its history came from the file, so there is nothing
  // unsaved and the count must not reappear.
  it("counts nothing as unsaved when the history came from the file", () => {
    const already = editItem("rev_a", "700", "2026-08-18T00:00:00Z", "田中");
    const host = mount({ editEnabled: true, embedded: [already] });
    const label = [...host.querySelectorAll(".rs-btn-label")].map((e) => e.textContent).find((l) => l?.startsWith("保存"));
    expect(label).toBe("保存");
    expect(row(host, "max_connections").querySelector(".rs-col-value")?.textContent).toContain("700");
  });
});

describe("a delivered document with editing off", () => {
  it("keeps the delivered value even if edits are sitting in storage", () => {
    const host = mount({ editEnabled: false, reviews: [editItem("rev_a", "700", "2026-08-18T00:00:00Z", "田中")] });
    expect(row(host, "max_connections").querySelector(".rs-col-value")?.textContent).toContain("500");
  });

  it("offers no save control", () => {
    const host = mount({ editEnabled: false });
    const labels = [...host.querySelectorAll(".rs-btn-label")].map((e) => e.textContent);
    expect(labels.some((l) => l?.startsWith("保存"))).toBe(false);
  });
});

// A row with one stored value shown in every environment column. The pure split
// is covered in edits.test.ts; what matters here is that the rendered sheet
// actually stops showing one value everywhere.
describe("editing one environment of a shared row", () => {
  const SHARED: ParameterSheetInput = {
    metadata: { title: "t" },
    sheets: [{
      name: "db",
      instances: ["本番", "検証"],
      categories: [{ name: "接続", params: [{ key: "max_connections", value: "500", source: { file: "common.yml", line: 1, anchor: "max" } }] }],
    }],
  };

  it("shows different values per environment once one of them is edited", () => {
    location.hash = "#1";
    const host = document.createElement("div");
    document.body.appendChild(host);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{
      id: "rev_x",
      target: { sheet: "db", category: "接続", param: "max_connections", instance: "本番", field: "value" },
      changes: [{ field: "value", suggested: "700" }],
      status: "applied",
      at: "2026-08-18T00:00:00Z",
      by: "田中",
    }]));
    render(
      h(Root, {
        payload: { metadata: SHARED.metadata, versions: [{ version: "current", sheets: SHARED.sheets }] },
        reviewEnabled: true, editEnabled: true, initialLang: "ja", server: false,
        pristineHtml: "<!DOCTYPE html><html><body><div id=\"app\"></div></body></html>",
        embedded: { reviews: [], saves: [] },
      }),
      host
    );
    const cells = [...row(host, "max_connections").querySelectorAll(".rs-col-value")].map((c) => c.textContent ?? "");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain("700");
    expect(cells[1]).toContain("500");
  });
});

describe("rows the recipient added", () => {
  const addRow = (param: string, value: string, category = "接続"): ReviewItem => ({
    id: `rev_add_${param}`,
    target: { sheet: "db", category, param, field: "value" },
    changes: [{ field: "value", suggested: value }],
    status: "applied",
    creates: true,
    at: "2026-08-18T00:00:00Z",
    by: "田中",
  });

  it("renders in its category with its value", () => {
    const host = mount({ editEnabled: true, reviews: [addRow("work_mem", "64MB")] });
    expect(row(host, "work_mem").querySelector(".rs-col-value")?.textContent).toContain("64MB");
  });

  // It has no source map and no config file behind it. If it looks like every
  // other row, the document quietly claims a provenance it does not have.
  it("is marked so it cannot be mistaken for an extracted row", () => {
    const host = mount({ editEnabled: true, reviews: [addRow("work_mem", "64MB")] });
    expect(row(host, "work_mem").className).toContain("rs-row-added");
    expect(row(host, "work_mem").querySelector(".rs-origin-tag")?.textContent).toBe("追加");
    expect(row(host, "max_connections").className).not.toContain("rs-row-added");
  });

  it("says so when its category is gone rather than dropping it", () => {
    const host = mount({ editEnabled: true, reviews: [addRow("work_mem", "64MB", "無い階層")] });
    const notice = host.querySelector(".rs-orphan-notice");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("work_mem");
  });

  it("offers no add control when editing is off", () => {
    const host = mount({ editEnabled: false });
    expect(host.querySelector(".rs-head-tool-add")).toBeNull();
  });

  it("offers an add control per category when editing is on", () => {
    const host = mount({ editEnabled: true });
    expect(host.querySelector(".rs-head-tool-add")).not.toBeNull();
  });
});

describe("striking a row out", () => {
  const strike = (deletes: boolean, at: string, id: string): ReviewItem => ({
    id,
    target: { sheet: "db", category: "接続", param: "max_connections" },
    status: "applied",
    deletes,
    at,
    by: "田中",
  });

  it("keeps the row on the sheet and marks it", () => {
    const host = mount({ editEnabled: true, reviews: [strike(true, "2026-08-18T00:00:00Z", "rev_d")] });
    const r = row(host, "max_connections");
    expect(r.className).toContain("rs-row-deleted");
    // Still readable: the value it used to hold is the point of keeping it.
    expect(r.querySelector(".rs-col-value")?.textContent).toContain("500");
  });

  it("leaves other rows alone", () => {
    const host = mount({ editEnabled: true, reviews: [strike(true, "2026-08-18T00:00:00Z", "rev_d")] });
    expect(row(host, "shared_buffers").className).not.toContain("rs-row-deleted");
  });

  it("comes back when a later entry restores it", () => {
    const host = mount({
      editEnabled: true,
      reviews: [strike(true, "2026-08-18T00:00:00Z", "rev_d"), strike(false, "2026-09-02T00:00:00Z", "rev_r")],
    });
    expect(row(host, "max_connections").className).not.toContain("rs-row-deleted");
  });

  it("marks nothing when editing is off", () => {
    const host = mount({ editEnabled: false, reviews: [strike(true, "2026-08-18T00:00:00Z", "rev_d")] });
    expect(row(host, "max_connections").className).not.toContain("rs-row-deleted");
  });
});

// Not everyone who maintains a sheet has the CLI, so the document can produce
// the prompt itself. What it must NOT offer is a JSON export: the document
// saves itself and `apply -r sheet.html` reads it, so a JSON of the same
// entries is a lesser copy that looks like an alternative to saving.
describe("getting the changes out of the document", () => {
  const labelsOf = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-btn-label, .rs-menu-item")].map((e) => e.textContent ?? "");

  it("offers the AI prompt in edit mode", () => {
    const host = mount({ editEnabled: true, reviews: [editItem("rev_a", "700", "2026-08-18T00:00:00Z", "田中")] });
    expect(labelsOf(host).some((l) => l.includes("AIプロンプト"))).toBe(true);
  });

  it("offers no JSON export in edit mode — the file itself is the artifact", () => {
    const host = mount({ editEnabled: true, reviews: [editItem("rev_a", "700", "2026-08-18T00:00:00Z", "田中")] });
    expect(labelsOf(host).some((l) => l.includes("エクスポート"))).toBe(false);
  });

  it("offers neither when the document is read-only", () => {
    const host = mount({ editEnabled: false });
    const labels = labelsOf(host);
    expect(labels.some((l) => l.includes("AIプロンプト"))).toBe(false);
    expect(labels.some((l) => l.includes("保存"))).toBe(false);
  });
});

// The per-cell chain records what changed and when. Only a save can record WHY,
// and the overview is where someone looks months later.
describe("the change log on the overview page", () => {
  const rec = (at: string, by: string, comment: string) => ({ at, by, comment, changes: 2 });

  function mountOverview(saves: { at: string; by?: string; comment?: string; changes: number }[], editEnabled = true): HTMLElement {
    location.hash = "#overview";
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: PAYLOAD, reviewEnabled: false, editEnabled, initialLang: "ja", server: false,
        pristineHtml: "<!DOCTYPE html><html><body><div id=\"app\"></div></body></html>",
        embedded: { reviews: [], saves },
      }),
      host
    );
    return host;
  }

  it("lists each save with its reason, newest first", () => {
    const host = mountOverview([rec("2026-08-18T00:00:00Z", "田中", "接続上限に達したため"), rec("2026-09-02T00:00:00Z", "佐藤", "切り戻し")]);
    const rows = [...host.querySelectorAll(".rs-changelog-table tbody tr")].map((r) => r.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("切り戻し");
    expect(rows[0]).toContain("佐藤");
    expect(rows[1]).toContain("接続上限に達したため");
  });

  it("shows nothing when the document has never been saved", () => {
    const host = mountOverview([]);
    expect(host.querySelector(".rs-changelog-table")).toBeNull();
  });

  it("shows nothing in a read-only document", () => {
    const host = mountOverview([rec("2026-08-18T00:00:00Z", "田中", "接続上限に達したため")], false);
    expect(host.querySelector(".rs-changelog-table")).toBeNull();
  });
});

describe("the AI prompt affordance", () => {
  const withPrompt = (promptEnabled: boolean): HTMLElement => {
    location.hash = "#1";
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: PAYLOAD, reviewEnabled: false, editEnabled: true, promptEnabled,
        initialLang: "ja", server: false,
        pristineHtml: "<!DOCTYPE html><html><body><div id=\"app\"></div></body></html>",
        embedded: { reviews: [], saves: [] },
      }),
      host
    );
    return host;
  };
  const has = (host: HTMLElement): boolean =>
    [...host.querySelectorAll(".rs-btn-label")].some((e) => (e.textContent ?? "").includes("AIプロンプト"));

  it("is absent when the document was built without it", () => {
    expect(has(withPrompt(false))).toBe(false);
  });

  it("is there when it was asked for", () => {
    expect(has(withPrompt(true))).toBe(true);
  });
});
