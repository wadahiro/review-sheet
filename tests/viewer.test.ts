// DOM tests for the viewer: render the REAL component tree against a real
// document and assert on what a reviewer would see.
//
// Everything else in this suite is a pure function; these exist because the
// viewer's most costly bugs have been about which cell a finding lands on and
// what a control does — behaviour that only shows up once the tree is rendered.
// Layout (CSS cascade, hit areas, pseudo-elements) is still out of reach here
// and needs a real browser.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root } from "../src/html/app";
import type { ParameterSheetInput, ReviewDocument } from "../src/types";

const SHEET: ParameterSheetInput = {
  metadata: { title: "t" },
  sheets: [
    {
      name: "app",
      instances: ["staging", "production"],
      categories: [
        {
          name: "Tuning",
          params: [
            // Shared: one stored value shown in both environment columns.
            { key: "workers", value: "4", description: "Worker count", source: { file: "d.yml", line: 1, anchor: "workers:" } },
            // Per-environment.
            {
              key: "port",
              description: "Port",
              instances: [
                { name: "staging", value: "8080", source: { file: "s.yml", line: 1 } },
                { name: "production", value: "80", source: { file: "p.yml", line: 1 } },
              ],
            },
            // Not set anywhere; the product default applies.
            { key: "pool", value: "10", default: "10", origin: "default", description: "Pool size" },
            { key: "secret", value: "x", description: "A secret", out_of_scope: { reason: "vault" } },
          ],
        },
        // A category where NOTHING is per-environment — the shape that made 10
        // of keycloak's 16 categories render single-column before the sheet
        // carried its declared axis. Its rows must still get one column per
        // environment, or no per-environment finding can be written about them.
        {
          name: "Shared only",
          params: [{ key: "log_level", value: "info", description: "Log level" }],
        },
      ],
    },
  ],
};

const PAYLOAD = {
  metadata: SHEET.metadata,
  versions: [{ version: "current", sheets: SHEET.sheets }],
};

// The viewer opens on the overview tab when the document has metadata; the hash
// is how it restores a sheet tab, so tests use it to land on the sheet itself.
function openSheetTab(): void {
  location.hash = "#1";
}

// The viewer keys its localStorage by the embedded data, so tests share one key
// space; clear between cases.
beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

function mount(reviews: ReviewDocument["reviews"] = []): HTMLElement {
  openSheetTab();
  const host = document.createElement("div");
  document.body.appendChild(host);
  // Reviews are restored from localStorage on mount, so seeding every candidate
  // storage key is how a test sets up "a finding already exists on this cell"
  // without driving the modal.
  if (reviews.length > 0) {
    const payload = JSON.stringify(reviews);
    for (const k of storageKeys()) localStorage.setItem(k, payload);
  }
  render(h(Root, { payload: PAYLOAD, reviewEnabled: true, initialLang: "ja", server: false }), host);
  return host;
}

// Mirrors getStorageKey() in app.ts: project : version : generated_at. The
// payload here has only a version, so the key is deterministic.
function storageKeys(): string[] {
  return ["review-sheet::current:"];
}

// The value cells of one row, in environment order.
function valueCells(host: HTMLElement, key: string): HTMLElement[] {
  const rows = [...host.querySelectorAll("tbody tr")];
  const row = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === key);
  if (!row) throw new Error(`row not found: ${key}`);
  return [...row.querySelectorAll("td.rs-col-value")] as HTMLElement[];
}

describe("viewer: environment columns", () => {
  it("renders one column per DECLARED environment, even for shared-only rows", () => {
    const host = mount();
    // Every row gets both columns — including `workers`, which stores one value,
    // and `pool`, which stores none. Without the sheet's declared axis these
    // would collapse to a single column and no per-environment finding could be
    // written about them.
    expect(valueCells(host, "workers").length).toBe(2);
    expect(valueCells(host, "pool").length).toBe(2);
    expect(valueCells(host, "port").length).toBe(2);
    // The regression that matters: this row's category contains no per-
    // environment value at all, so the columns can only come from the sheet's
    // declared `instances`.
    expect(valueCells(host, "log_level").length).toBe(2);
  });

  it("shows the not-set label on a row nothing sets", () => {
    const host = mount();
    for (const cell of valueCells(host, "pool")) {
      expect(cell.querySelector(".rs-unset-label")?.textContent).toBe("デフォルト値を利用");
    }
  });
});

describe("viewer: where a finding lands", () => {
  const suggestion = (instance: string | undefined, param: string) => [
    {
      id: "rev_1",
      status: "pending" as const,
      target: { sheet: "app", category: "Tuning", param, ...(instance ? { instance } : {}), field: "value" },
      changes: [{ field: "value", current: "4", suggested: "16" }],
    },
  ];

  it("keeps a per-environment finding on a shared row in that column only", () => {
    const [staging, production] = valueCells(mount(suggestion("staging", "workers")), "workers");
    expect(staging.textContent).toContain("16");
    expect(production.textContent).not.toContain("16");
  });

  it("shows a shared-scope finding in every environment column", () => {
    // No `instance` on the target = "change the shared value", which affects
    // every environment and must therefore be visible in each.
    const [staging, production] = valueCells(mount(suggestion(undefined, "workers")), "workers");
    expect(staging.textContent).toContain("16");
    expect(production.textContent).toContain("16");
  });

  it("keeps a per-environment finding on a Pattern B row in its own column", () => {
    const [staging, production] = valueCells(mount(suggestion("staging", "port")), "port");
    expect(staging.textContent).toContain("16");
    expect(production.textContent).not.toContain("16");
  });
});

describe("viewer: check column", () => {
  it("offers a checkbox on every row, out-of-scope included", () => {
    const host = mount();
    // Being out of review scope is a fact on another axis: "this should not be
    // out of scope" is itself a finding, so the row is still checkable.
    for (const key of ["workers", "port", "pool", "secret"]) {
      const row = [...host.querySelectorAll("tbody tr")].find(
        (r) => r.querySelector(".rs-col-key code")?.textContent === key
      );
      expect(row?.querySelector("td.rs-col-check input[type=checkbox]")).toBeTruthy();
    }
  });

  it("counts progress over every row and updates as rows are ticked", async () => {
    const host = mount();
    const progress = () => host.querySelector(".rs-decision-progress")?.textContent ?? "";
    // The denominator is every row in the sheet: an exhaustive ledger is only
    // useful if you can see how much of it is still unlooked-at.
    expect(progress()).toContain("0 / 5");

    const box = host.querySelector("td.rs-col-check input") as HTMLInputElement;
    box.click();
    // Preact re-renders on a microtask, so let it settle before asserting.
    await Promise.resolve();
    expect(progress()).toContain("1 / 5");
  });
});

// Version history + Compare. Nothing in the repo exercised this before: there
// is no example with two snapshots, so the version bar and the diff overlay had
// never been rendered outside a browser — including after the diff summary and
// its filter were moved into the version bar.
describe("viewer: compare two versions", () => {
  const at = (workers: string) => ({
    version: workers === "4" ? "1.0" : "1.1",
    date: workers === "4" ? "2026-01-01" : "2026-02-01",
    sheets: [
      {
        name: "app",
        instances: ["staging", "production"],
        categories: [
          {
            name: "Tuning",
            params: [
              { key: "workers", value: workers, description: "Worker count" },
              { key: "steady", value: "same", description: "Unchanged" },
            ],
          },
        ],
      },
    ],
  });

  function mountVersions(): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: { metadata: { title: "t" }, versions: [at("4"), at("16")] },
        reviewEnabled: true,
        initialLang: "ja",
        server: false,
      }),
      host
    );
    return host;
  }

  it("offers the version bar only when there is more than one version", () => {
    expect(mount().querySelector(".rs-version-bar")).toBeNull();
    expect(mountVersions().querySelector(".rs-version-bar")).toBeTruthy();
  });

  it("puts the diff summary and its filter in the version bar, not the tab bar", async () => {
    const host = mountVersions();
    const bar = host.querySelector(".rs-version-bar") as HTMLElement;
    const compare = [...bar.querySelectorAll("button")].find((b) => b.textContent?.includes("比較"));
    compare!.click();
    await Promise.resolve();

    // The controls belong next to the selectors that produced the comparison.
    const barNow = host.querySelector(".rs-version-bar") as HTMLElement;
    expect(barNow.querySelector(".rs-diff-summary")).toBeTruthy();
    expect(barNow.querySelector(".rs-diff-changed-only")).toBeTruthy();
    expect(host.querySelector(".rs-tabs-right .rs-diff-summary")).toBeNull();
  });

  it("marks the changed row and leaves the unchanged one alone", async () => {
    const host = mountVersions();
    const bar = host.querySelector(".rs-version-bar") as HTMLElement;
    [...bar.querySelectorAll("button")].find((b) => b.textContent?.includes("比較"))!.click();
    await Promise.resolve();

    const rowOf = (key: string) =>
      [...host.querySelectorAll("tbody tr")].find((r) => r.querySelector(".rs-col-key code")?.textContent === key);
    expect(rowOf("workers")?.textContent).toContain("16");
    expect(rowOf("workers")?.querySelector(".rs-diff-badge, .rs-diff-cell-changed")).toBeTruthy();
    expect(rowOf("steady")?.querySelector(".rs-diff-badge, .rs-diff-cell-changed")).toBeFalsy();
  });
});
