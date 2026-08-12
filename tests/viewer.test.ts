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
            // WRITTEN, at a value that happens to equal the product default —
            // httpd's `ProxyRequests Off`, a line whose whole purpose is to say
            // this host is not a forward proxy. Not the same fact as `pool`.
            { key: "proxy_requests", value: "Off", default: "Off", origin: "embedded", description: "Forward proxy" },
            // A key nobody reads, and the name the product's own UI gives it.
            {
              key: 'attributes["saml.signature.algorithm"]',
              value: "RSA_SHA256",
              label: { ja: "署名アルゴリズム", en: "Signature algorithm" },
              description: "Signing algorithm",
            },
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
        // Nothing but unset rows: the category itself must disappear while they
        // are hidden — in the body and the outline together, or the outline
        // offers a jump to a heading that is not there.
        {
          name: "Defaults only",
          params: [{ key: "vault_url", value: "", default: "", origin: "default", description: "Vault URL" }],
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

// Unset rows (origin: "default") are hidden until the reader asks for them —
// they live in their ordinary category, so the toggle is document-wide rather
// than a category to open. Several tests below are ABOUT those rows, so they
// turn it on first.
async function showUnsetRows(host: HTMLElement): Promise<void> {
  const menu = [...host.querySelectorAll("button")].find((b) => /絞り込み/.test(b.textContent ?? ""));
  (menu as HTMLElement | undefined)?.click();
  await Promise.resolve();
  const check = [...host.querySelectorAll(".rs-menu-check")].find((l) =>
    /未設定の行を表示/.test(l.textContent ?? "")
  );
  if (!check) throw new Error("show-unset toggle not found");
  (check.querySelector("input") as HTMLInputElement).click();
  await Promise.resolve();
}

describe("viewer: environment columns", () => {
  it("renders one column per DECLARED environment, even for shared-only rows", async () => {
    const host = mount();
    await showUnsetRows(host);
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

  it("shows the not-set label on a row nothing sets", async () => {
    const host = mount();
    await showUnsetRows(host);
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
  it("offers a checkbox on every row, out-of-scope included", async () => {
    const host = mount();
    await showUnsetRows(host); // `pool` is unset, so it is hidden until asked for
    // Being out of review scope is a fact on another axis: "this should not be
    // out of scope" is itself a finding, so the row is still checkable.
    for (const key of ["workers", "port", "pool", "secret"]) {
      const row = [...host.querySelectorAll("tbody tr")].find(
        (r) => r.querySelector(".rs-col-key code")?.textContent === key
      );
      expect(row?.querySelector("td.rs-col-check input[type=checkbox]")).toBeTruthy();
    }
  });

  it("counts progress over every VISIBLE row and updates as rows are ticked", async () => {
    const host = mount();
    const progress = () => host.querySelector(".rs-decision-progress")?.textContent ?? "";
    // The denominator is what the sheet is showing, not what it holds: a row
    // hidden behind the unset toggle cannot be ticked, so counting it would
    // give a total the reader can never reach. SHEET has 8 rows, 2 of them
    // unset.
    expect(progress()).toContain("0 / 6");

    const box = host.querySelector("td.rs-col-check input") as HTMLInputElement;
    box.click();
    // Preact re-renders on a microtask, so let it settle before asserting.
    await Promise.resolve();
    expect(progress()).toContain("1 / 6");
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

// Preact's useEffect callbacks flush after paint (a race between rAF and
// preact/hooks' 35ms RAF_TIMEOUT), so the Cmd/Ctrl+K listener the App registers
// in one is not attached the instant render() returns. A real timer, not a
// microtask, is what waits long enough under happy-dom.
function waitForEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

// "Nothing is set here" and "what is set equals the default" are different
// facts. Only the first is "デフォルト値を利用"; the second is a decision
// someone made, and blanking its cell hides the decision.
describe("viewer: set-to-the-default is not unset", () => {
  const cellsOf = (host: HTMLElement, key: string): HTMLElement[] => valueCells(host, key);

  it("shows the written value even when it equals the product default", async () => {
    const host = mount();
    await showUnsetRows(host); // `pool` is unset and hidden by default
    for (const cell of cellsOf(host, "proxy_requests")) {
      expect(cell.textContent).toContain("Off");
      expect(cell.querySelector(".rs-unset-label")).toBeNull();
    }
  });

  it("still labels a genuinely unset row", async () => {
    const host = mount();
    await showUnsetRows(host);
    for (const cell of cellsOf(host, "pool")) {
      expect(cell.querySelector(".rs-unset-label")?.textContent).toBe("デフォルト値を利用");
    }
  });

  it("marks it as equal to the default rather than as a change", async () => {
    const host = mount();
    await showUnsetRows(host);
    // Same-as-default gets its own muted class; only a value that DIFFERS from
    // the default earns the changed highlight.
    for (const cell of cellsOf(host, "proxy_requests")) {
      expect(cell.className).toContain("rs-same-as-default");
      expect(cell.className).not.toContain("rs-changed");
    }
  });
});

// Unset rows (origin: "default") live in their ORDINARY category, beside the
// settings they relate to — an ALB's idle_timeout and its client_keep_alive are
// two timeouts on one load balancer, and segregating one of them into a
// "Product defaults" tree of its own hid that. What separates them is the
// document-wide toggle below, not the taxonomy.
describe("viewer: unset rows are hidden, not segregated", () => {
  it("hides a row at the product default until the reader asks for it", async () => {
    const host = mount();
    const hasPool = () =>
      [...host.querySelectorAll("tbody tr")].some((r) => r.querySelector(".rs-col-key code")?.textContent === "pool");
    expect(hasPool()).toBe(false);
    await showUnsetRows(host);
    expect(hasPool()).toBe(true);
  });

  it("shows it in the same category as the rows the project set", async () => {
    const host = mount();
    await showUnsetRows(host);
    const rowKeysUnder = (category: string): string[] => {
      const sec = [...host.querySelectorAll(".rs-category")].find(
        (c) => c.querySelector(".rs-cat-label")?.textContent === category
      );
      if (!sec) throw new Error(`category not found: ${category}`);
      return [...sec.querySelectorAll("tbody tr")].map((r) => r.querySelector(".rs-col-key code")?.textContent ?? "");
    };
    // `pool` is unset; `port` and `workers` are set. One category, one table.
    const keys = rowKeysUnder("Tuning");
    expect(keys).toContain("pool");
    expect(keys).toContain("port");
  });

  it("counts every unset row in the toggle's own label, so the ledger claim survives hiding them", async () => {
    const host = mount();
    const menu = [...host.querySelectorAll("button")].find((b) => /絞り込み/.test(b.textContent ?? ""));
    (menu as HTMLElement).click();
    await Promise.resolve();
    const label = [...host.querySelectorAll(".rs-menu-check")]
      .map((l) => l.textContent ?? "")
      .find((t) => /未設定の行を表示/.test(t));
    expect(label).toContain("2"); // SHEET has two origin:default rows (pool, vault_url)
  });
});

// A category's `name` is identity (sheet::category::param — every review and
// apply target). `label` is what a reader sees, and it switches with the
// language toggle like any other prose. Splitting them is what lets a component
// be "Keycloak DB" in one language and "Keycloak database" in the other while
// both builds address the same rows.
describe("viewer: category label vs identity", () => {
  const LABELLED: ParameterSheetInput = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "infra",
        categories: [
          {
            name: "aurora",
            label: { ja: "Keycloak DB", en: "Keycloak database" },
            params: [{ key: "engine_version", value: "16.4", description: "d" }],
          },
        ],
      },
    ],
  };
  const PAYLOAD_L = { metadata: LABELLED.metadata, versions: [{ version: "current", sheets: LABELLED.sheets }] };

  function mountLabelled(lang: "ja" | "en"): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: PAYLOAD_L, reviewEnabled: true, initialLang: lang, server: false }), host);
    return host;
  }

  it("shows the label, not the id", () => {
    const host = mountLabelled("ja");
    expect(host.querySelector(".rs-cat-label")?.textContent).toBe("Keycloak DB");
  });

  it("shows the other language's label when the sheet is built in it", () => {
    const host = mountLabelled("en");
    expect(host.querySelector(".rs-cat-label")?.textContent).toBe("Keycloak database");
  });

  it("switches with the language toggle, live, without a rebuild", async () => {
    const host = mountLabelled("ja");
    expect(host.querySelector(".rs-cat-label")?.textContent).toBe("Keycloak DB");
    const toggle = [...host.querySelectorAll("button")].find((b) => /^(EN|JA)$/.test((b.textContent ?? "").trim()));
    if (!toggle) throw new Error("language toggle not found");
    (toggle as HTMLElement).click();
    await Promise.resolve();
    expect(host.querySelector(".rs-cat-label")?.textContent).toBe("Keycloak database");
  });

  it("keeps the ID in the anchor, so a review target survives a rewording", () => {
    const host = mountLabelled("ja");
    const anchored = [...host.querySelectorAll("[id]")].map((e) => e.id).join(" ");
    expect(anchored).toContain("aurora");
    expect(anchored).not.toContain("Keycloak");
  });
});

// The outline had no test of its own until it rendered blank: a refactor
// deleted its opening <button> tag, htm threw, and the whole app came up empty
// with every other test still green. A smoke test that mounts it and clicks a
// row is cheap and would have caught it outright.
describe("viewer: outline", () => {
  async function openOutlinePanel(host: HTMLElement): Promise<HTMLElement> {
    // Icon-only button: identified by its aria-label, like a reader using a
    // screen reader would.
    const btn = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
    if (!btn) throw new Error("outline button not found");
    (btn as HTMLElement).click();
    await Promise.resolve();
    const el = host.querySelector(".rs-outline") as HTMLElement | null;
    if (!el) throw new Error("outline did not open");
    return el;
  }

  it("renders one clickable entry per category", async () => {
    const host = mount();
    const outline = await openOutlinePanel(host);
    const labels = [...outline.querySelectorAll(".rs-outline-item")].map((b) => b.textContent?.trim());
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.join(" ")).toContain("Tuning");
  });

  it("navigates on click without throwing", async () => {
    const host = mount();
    const outline = await openOutlinePanel(host);
    const item = outline.querySelector(".rs-outline-item") as HTMLButtonElement;
    expect(() => item.click()).not.toThrow();
  });

  it("leaves out a category made only of unset rows, matching the body", async () => {
    const host = mount();
    const outline = await openOutlinePanel(host);
    // SHEET's "Defaults only" category holds nothing but origin:default rows.
    expect([...outline.querySelectorAll(".rs-outline-item")].map((b) => b.textContent).join(" "))
      .not.toContain("Defaults only");
  });
});

// A key is where a value lives; a label is what the product calls it. The row
// shows the label and keeps the key, because a reviewer needs both — one to
// recognise the setting, one to find it in the file (and verify/apply resolve
// by it).
describe("viewer: product display name", () => {
  const rowOf = (host: HTMLElement, key: string): HTMLElement => {
    const row = [...host.querySelectorAll("tbody tr")].find((r) => r.textContent?.includes(key));
    if (!row) throw new Error(`row not found: ${key}`);
    return row as HTMLElement;
  };

  it("heads the row with the label, not the key", () => {
    const host = mount();
    const cell = rowOf(host, "saml.signature.algorithm").querySelector(".rs-col-key");
    expect(cell?.textContent).toContain("署名アルゴリズム");
  });

  it("keeps the key visible, because that is what verify and apply resolve by", () => {
    const host = mount();
    const cell = rowOf(host, "saml.signature.algorithm").querySelector(".rs-col-key");
    expect(cell?.textContent).toContain('attributes["saml.signature.algorithm"]');
  });

  it("switches the label with the language toggle", async () => {
    const host = mount();
    const toggle = [...host.querySelectorAll("button")].find((b) => /^(EN|JA)$/.test((b.textContent ?? "").trim()));
    (toggle as HTMLElement).click();
    await Promise.resolve();
    const cell = rowOf(host, "saml.signature.algorithm").querySelector(".rs-col-key");
    expect(cell?.textContent).toContain("Signature algorithm");
  });

  it("falls back to the key for a setting the product does not name", () => {
    const host = mount();
    const cell = rowOf(host, "workers").querySelector(".rs-col-key");
    expect(cell?.textContent).toContain("workers");
  });
});

// Search sees what the reader sees, and says which scope it is in. A result for
// a row the document is not showing would be noise; a SILENT exclusion would be
// worse — "no match" reading as "this product has no such setting" when the
// setting is there at its default. Hence the scope chip, and Cmd/Ctrl+K to
// widen it without leaving the keyboard.
describe("viewer: search scope", () => {
  async function openPalette(host: HTMLElement): Promise<HTMLElement> {
    await waitForEffects();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await Promise.resolve();
    const palette = host.querySelector(".rs-palette") as HTMLElement | null;
    if (!palette) throw new Error("palette did not open");
    return palette;
  }

  function search(palette: HTMLElement, q: string): string[] {
    const input = palette.querySelector(".rs-palette-input") as HTMLInputElement;
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return [...palette.querySelectorAll(".rs-palette-name")].map((e) => e.textContent ?? "");
  }

  it("does not return unset rows while they are hidden", async () => {
    const host = mount();
    const palette = await openPalette(host);
    await Promise.resolve();
    expect(search(palette, "pool").join(" ")).not.toContain("pool");
  });

  it("says which scope it is searching, rather than leaving the omission silent", async () => {
    const host = mount();
    const palette = await openPalette(host);
    expect(palette.querySelector(".rs-palette-scope")?.textContent).toContain("設定済みのみ");
  });

  it("widens to unset rows on a second Cmd/Ctrl+K, and says so", async () => {
    const host = mount();
    const palette = await openPalette(host);
    const input = palette.querySelector(".rs-palette-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    await Promise.resolve();
    expect(host.querySelector(".rs-palette-scope")?.textContent).toContain("未設定を含む");
    expect(search(host.querySelector(".rs-palette") as HTMLElement, "pool").join(" ")).toContain("pool");
  });

  it("widening the search widens the document too, so the two never disagree", async () => {
    const host = mount();
    const palette = await openPalette(host);
    (palette.querySelector(".rs-palette-scope") as HTMLButtonElement).click();
    await Promise.resolve();
    const hasPool = [...host.querySelectorAll("tbody tr")].some(
      (r) => r.querySelector(".rs-col-key code")?.textContent === "pool"
    );
    expect(hasPool).toBe(true);
  });
});

