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
import { customStyles } from "../src/html/styles";
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


// Anchor ids used to be built by replacing every run of non-[a-zA-Z0-9] with a
// single "-". On the sheets this tool exists for, that is the entire category
// name: 「接続設定」, 「認証」 and 「メモリ」 all collapsed to `nav-1--`, so the
// nav highlighted three entries at once and a jump landed on whichever came
// first in the document. Nothing caught it, because every fixture until now was
// named in ASCII.
describe("viewer: anchor ids for non-ASCII names", () => {
  const cat = (name: string, key: string) => ({
    name,
    params: [{ key, value: "x", description: "d", source: { file: "d.yml", line: 1, anchor: "x" } }],
  });
  const JA = {
    metadata: { generated_at: "2026-01-01T00:00:00Z" },
    sheets: [
      {
        name: "設定",
        categories: [cat("接続設定", "host"), cat("認証", "user"), cat("メモリ", "heap")],
      },
    ],
  } as unknown as ParameterSheetInput;
  const PAYLOAD = { metadata: JA.metadata, versions: [{ version: "current", sheets: JA.sheets }] };

  function mount(): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: PAYLOAD, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }

  it("gives three Japanese categories three different ids", () => {
    const host = mount();
    const ids = [...host.querySelectorAll("[id^='nav-']")].map((e) => e.id);

    expect(ids.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("givesevery parameter row an id of its own", () => {
    const host = mount();
    const ids = [...host.querySelectorAll("tr[id]")].map((e) => e.id);

    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the name readable in the id rather than encoding it away", () => {
    const host = mount();
    const ids = [...host.querySelectorAll("[id^='nav-']")].map((e) => e.id);

    // Non-ASCII is legal in an HTML id and in a CSS identifier, and these ids
    // are resolved with getElementById and never put in a URL — so percent-
    // encoding a Japanese name would cost nine characters per character and buy
    // nothing.
    expect(ids.some((id) => id.includes("接続設定"))).toBe(true);
    expect(ids.every((id) => !/%/.test(id))).toBe(true);
  });

  it("escapes only what a selector would choke on, and reversibly", () => {
    const host = mount();
    for (const el of [...host.querySelectorAll("[id^='nav-']")] as HTMLElement[]) {
      expect(el.id).not.toMatch(/\s/);
      expect(host.querySelector(`#${el.id}`)).toBe(el);
      expect(document.getElementById(el.id)).toBe(el);
    }
  });
});

// A sheet's own name has the same identity/display split a category's does, and
// needed it for the same reason: "OS baseline" and "OS 設定" are one sheet, and
// the tab is the first thing a reviewer reads.
describe("viewer: sheet label", () => {
  const LABELLED_SHEET = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "os baseline",
        label: { ja: "OS 設定", en: "OS baseline" },
        categories: [{ name: "Host", params: [{ key: "hostname", value: "h", description: "d" }] }],
      },
      {
        name: "keycloak configuration",
        label: { ja: "Keycloak 設定", en: "Keycloak configuration" },
        categories: [{ name: "Database", params: [{ key: "db-url", value: "u", description: "d" }] }],
      },
    ],
  };
  const PAYLOAD_S = { metadata: LABELLED_SHEET.metadata, versions: [{ version: "current", sheets: LABELLED_SHEET.sheets }] };

  function mountSheets(lang: "ja" | "en"): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: PAYLOAD_S, reviewEnabled: true, initialLang: lang, server: false }), host);
    return host;
  }
  // `[data-sheet-idx]` excludes the overview tab, which is a .rs-tab too but is
  // not one of the document's sheets.
  const tabs = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-tab[data-sheet-idx]")].map((b) => (b.textContent ?? "").trim());

  it("names the tabs in the reader's language", () => {
    expect(tabs(mountSheets("ja"))).toEqual(["OS 設定", "Keycloak 設定"]);
    document.body.innerHTML = "";
    expect(tabs(mountSheets("en"))).toEqual(["OS baseline", "Keycloak configuration"]);
  });

  it("switches with the language toggle, live", async () => {
    const host = mountSheets("ja");
    const toggle = [...host.querySelectorAll("button")].find((b) => /^(EN|JA)$/.test((b.textContent ?? "").trim()));
    if (!toggle) throw new Error("language toggle not found");
    (toggle as HTMLElement).click();
    await Promise.resolve();
    expect(tabs(host)).toEqual(["OS baseline", "Keycloak configuration"]);
  });

  it("heads the sheet with the label too, not just the tab", () => {
    const host = mountSheets("ja");
    expect(host.querySelector(".rs-sheet-header h2")?.textContent).toContain("OS 設定");
  });

  it("falls back to the name when the sheet has no label", () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const bare = { metadata: { title: "t" }, versions: [{ version: "current", sheets: [{ name: "aws infrastructure", categories: LABELLED_SHEET.sheets[0].categories }] }] };
    render(h(Root, { payload: bare, reviewEnabled: true, initialLang: "ja", server: false }), host);
    expect(tabs(host)).toEqual(["aws infrastructure"]);
  });

  it("leaves the identity in the review target, so a rewording does not orphan a finding", () => {
    // The stored review names the sheet by `name`. If the viewer had started
    // keying targets by what it displays, translating a tab would detach every
    // finding filed against that sheet.
    const host = mountSheets("ja");
    const stored = Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? "").join("");
    expect(stored).not.toContain("OS 設定");
    const html = host.innerHTML;
    expect(html).toContain("OS 設定");
    expect(html).toContain("sheet-0");
  });
});

// A flat tab strip stops working somewhere around a dozen sheets, and an Excel
// migration brings a workbook's worth at once. Groups are the header's first
// row; the sheets of the active group are the second.
describe("viewer: sheet groups", () => {
  const cat = (n: string) => ({ name: n, params: [{ key: "k", value: "v", description: "d" }] });
  const GROUPED = {
    metadata: { title: "t" },
    groups: [
      { name: "infra", label: { ja: "AWS 基盤", en: "AWS" } },
      { name: "idp", label: { ja: "Keycloak", en: "Keycloak" } },
    ],
    sheets: [
      { name: "aws infrastructure", label: { ja: "AWS インフラ", en: "AWS infrastructure" }, group: "infra", categories: [cat("network")] },
      { name: "keycloak configuration", label: { ja: "Keycloak 設定", en: "Keycloak configuration" }, group: "idp", categories: [cat("Database")] },
      { name: "keycloak realm", label: { ja: "Keycloak レルム設定", en: "Keycloak realm" }, group: "idp", categories: [cat("General")] },
    ],
  };
  const payloadOf = (doc: typeof GROUPED) => ({
    metadata: doc.metadata,
    versions: [{ version: "current", sheets: doc.sheets, groups: doc.groups }],
  });

  function mountGrouped(payload: Parameters<typeof Root>[0]["payload"] = payloadOf(GROUPED)): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }
  const groupTabs = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-tabs-left .rs-tab[data-sheet-idx]")].map((b) => (b.textContent ?? "").trim());
  const sheetTabs = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-subtab")].map((b) => (b.textContent ?? "").trim());

  it("puts groups on the first row and the active group's sheets on the second", () => {
    const host = mountGrouped();
    expect(groupTabs(host)).toEqual(["AWS 基盤", "Keycloak"]);
    // Sheet 0 is active (hash #1), so its group's sheets are the second row.
    expect(sheetTabs(host)).toEqual(["AWS インフラ"]);
  });

  it("switches the second row when a group is chosen, landing on its first sheet", async () => {
    const host = mountGrouped();
    const idp = [...host.querySelectorAll(".rs-tabs-left .rs-tab")].find((b) => b.textContent?.trim() === "Keycloak");
    (idp as HTMLElement).click();
    await Promise.resolve();
    expect(sheetTabs(host)).toEqual(["Keycloak 設定", "Keycloak レルム設定"]);
    expect(host.querySelector(".rs-sheet-header h2")?.textContent).toContain("Keycloak 設定");
  });

  it("shows no second row on the overview, which belongs to no group", () => {
    // Filling it with the first group's sheets said "you are in 基盤" while the
    // reader was on the overview, with nothing in the row marked current.
    location.hash = "";
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: payloadOf(GROUPED), reviewEnabled: true, initialLang: "ja", server: false }), host);
    expect(host.querySelector(".rs-subtabs")).toBeNull();
  });

  it("keeps every sheet of the group on the row while reading, so it does not move mid-scroll", async () => {
    // The bar's height IS allowed to change (it is observed, and every sticky
    // offset follows it) — but not while reading a sheet, where the body is
    // full of sticky headings. Same group in, same row out.
    const host = mountGrouped();
    const before = sheetTabs(host);
    const second = [...host.querySelectorAll(".rs-tabs-left .rs-tab")].find((b) => b.textContent?.trim() === "Keycloak");
    (second as HTMLElement).click();
    await Promise.resolve();
    expect(before).toEqual(["AWS インフラ"]);
    expect(sheetTabs(host)).toEqual(["Keycloak 設定", "Keycloak レルム設定"]);
  });

  it("groups the outline as well, since it is the same navigation", async () => {
    const host = mountGrouped();
    const btn = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
    (btn as HTMLElement).click();
    await Promise.resolve();
    const names = [...host.querySelectorAll(".rs-outline-groupname")].map((e) => e.textContent?.trim());
    expect(names).toEqual(["AWS 基盤", "Keycloak"]);
    // Each sheet sits under its own group, not in a flat list beside them.
    const idpBlock = [...host.querySelectorAll(".rs-outline-group")][1]!;
    expect([...idpBlock.querySelectorAll(".rs-outline-sheetname")].map((e) => e.textContent?.trim().split(" ")[0])).toEqual([
      "Keycloak",
      "Keycloak",
    ]);
  });

  it("puts the second row after the toolbar, or the toolbar wraps onto a third line", () => {
    // The bar is a wrapping flex row and this row is full-width, so anything
    // after it in the DOM is pushed to a line of its own. Placed before the
    // toolbar it wrapped the toolbar — the exact breakage this ordering fixes.
    // Asserted on the DOM rather than on CSS `order` deliberately: `order`
    // would restore the picture and leave keyboard focus travelling through the
    // sheets before the toolbar drawn above them.
    const host = mountGrouped();
    const kids = [...host.querySelector(".rs-sheet-tabs")!.children].map((c) => c.className.split(" ")[0]);
    expect(kids.indexOf("rs-subtabs")).toBe(kids.length - 1);
    expect(kids.indexOf("rs-tabs-right")).toBeLessThan(kids.indexOf("rs-subtabs"));
  });

  it("stays a flat single row when the document declares no groups", () => {
    const flat = { metadata: { title: "t" }, versions: [{ version: "current", sheets: GROUPED.sheets.map(({ group, ...s }) => s) }] };
    const host = mountGrouped(flat);
    expect(host.querySelector(".rs-subtabs")).toBeNull();
    expect(groupTabs(host)).toEqual(["AWS インフラ", "Keycloak 設定", "Keycloak レルム設定"]);
  });
});

// The outline is the other half of the same navigation, so it has to follow the
// header: switching sheets there used to leave the panel showing a part of the
// document the reader had left.
describe("viewer: the outline follows the header", () => {
  async function openOutline(host: HTMLElement): Promise<HTMLElement> {
    const btn = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
    (btn as HTMLElement).click();
    await Promise.resolve();
    return host.querySelector(".rs-outline") as HTMLElement;
  }

  it("marks the sheet the header is on", async () => {
    const host = mount();
    const outline = await openOutline(host);
    const current = outline.querySelectorAll(".rs-outline-sheet-current");
    expect(current).toHaveLength(1);
  });

  it("gives every sheet block an address the scroll can find", async () => {
    // The effect scrolls by looking the active sheet's block up by this
    // attribute; without it the panel silently never moves.
    const host = mount();
    const outline = await openOutline(host);
    const blocks = [...outline.querySelectorAll("[data-sheet-nav]")];
    expect(blocks.length).toBe(host.querySelectorAll(".rs-tab[data-sheet-idx]").length);
  });
});


// A sheet with several environments is wide by construction, and a reviewer
// working on one of them is reading past the others on every row.
describe("viewer: filtering which environments are shown", () => {
  const ENV_DOC = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "app",
        instances: ["local", "staging", "production"],
        categories: [
          {
            name: "General",
            params: [
              {
                key: "timeout",
                description: "d",
                instances: [
                  { name: "local", value: "60" },
                  { name: "staging", value: "30" },
                  { name: "production", value: "10" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const payload = { metadata: ENV_DOC.metadata, versions: [{ version: "current", sheets: ENV_DOC.sheets }] };

  function mountEnv(): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }
  const headers = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-param-table th")].map((e) => (e.textContent ?? "").trim());
  async function openFilters(host: HTMLElement): Promise<void> {
    // The toolbar button TOGGLES, so clicking it while the menu is already open
    // closes it — the helper has to be idempotent or the second toggle in a
    // test silently operates on a closed menu.
    if (host.querySelector(".rs-menu-check")) return;
    const btn = [...host.querySelectorAll("button")].find((b) => /絞り込み/.test(b.textContent ?? ""));
    if (!btn) throw new Error("filter menu not found");
    (btn as HTMLElement).click();
    await Promise.resolve();
  }
  async function toggle(host: HTMLElement, name: string): Promise<void> {
    await openFilters(host);
    const item = [...host.querySelectorAll(".rs-menu-check")].find((l) => (l.textContent ?? "").trim() === name);
    if (!item) throw new Error(`no menu entry for ${name}`);
    (item.querySelector("input") as HTMLInputElement).click();
    await Promise.resolve();
  }

  it("lists every environment the document declares", async () => {
    const host = mountEnv();
    await openFilters(host);
    const labels = [...host.querySelectorAll(".rs-menu-check")].map((l) => (l.textContent ?? "").trim());
    expect(labels).toEqual(expect.arrayContaining(["local", "staging", "production"]));
  });

  it("drops the column when an environment is switched off", async () => {
    const host = mountEnv();
    expect(headers(host).join(" ")).toContain("local");
    await toggle(host, "local");
    expect(headers(host).join(" ")).not.toContain("local");
    expect(headers(host).join(" ")).toContain("production");
  });

  it("refuses to hide the last one, so the filter cannot empty the table", async () => {
    // A filter that can leave a row with no value column at all is a trap: the
    // reader is looking at keys with nothing to read and no obvious way back.
    const host = mountEnv();
    for (const name of ["local", "staging", "production"]) await toggle(host, name);
    const shown = headers(host).join(" ");
    expect(shown).toContain("production");
  });
});

// The checkboxes sit beside the columns they control, so a list in a different
// order than the table reads as a different list.
describe("viewer: the column filter follows the table's order", () => {
  const DOC = {
    metadata: { title: "t" },
    sheets: [
      // Declares only two, and in the document first — collecting from the top
      // put "staging, production" ahead of "local" and the menu disagreed with
      // every table below it.
      { name: "infra", instances: ["staging", "production"], categories: [{ name: "G", params: [{ key: "a", description: "d", instances: [{ name: "staging", value: "1" }, { name: "production", value: "2" }] }] }] },
      { name: "app", instances: ["local", "staging", "production"], categories: [{ name: "G", params: [{ key: "b", description: "d", instances: [{ name: "local", value: "1" }, { name: "staging", value: "2" }, { name: "production", value: "3" }] }] }] },
    ],
  };
  const payload = { metadata: DOC.metadata, versions: [{ version: "current", sheets: DOC.sheets }] };

  it("lists them in the active sheet's own order", async () => {
    location.hash = "#2"; // the second sheet: local, staging, production
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    const btn = [...host.querySelectorAll("button")].find((b) => /絞り込み/.test(b.textContent ?? ""));
    (btn as HTMLElement).click();
    await Promise.resolve();
    const envs = [...host.querySelectorAll(".rs-menu-check")]
      .map((l) => (l.textContent ?? "").trim())
      .filter((x) => ["local", "staging", "production"].includes(x));
    expect(envs).toEqual(["local", "staging", "production"]);
  });
});

// A sheet whose components are several of the same kind of thing is read to
// answer one question — where do they differ? — and stacked headings make that
// a scrolling exercise.
describe("viewer: components side by side", () => {
  const DOC = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "clients",
        // The sheet declares its components comparable; the viewer offers the
        // view on that statement, not on a count of overlapping rows.
        compare_components: true,
        categories: [
          {
            name: "client-a",
            categories: [
              {
                name: "Settings",
                params: [
                  { key: "protocol", value: "openid-connect", description: "d" },
                  { key: "publicClient", value: "false", description: "d" },
                  { key: "onlyHere", value: "1", description: "d" },
                ],
              },
            ],
          },
          {
            name: "client-b",
            categories: [
              {
                name: "Settings",
                params: [
                  { key: "protocol", value: "openid-connect", description: "d" },
                  { key: "publicClient", value: "true", description: "d" },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const payload = { metadata: DOC.metadata, versions: [{ version: "current", sheets: DOC.sheets }] };

  async function mountPivot(): Promise<HTMLElement> {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    const toggle = host.querySelector(".rs-compare-toggle input") as HTMLInputElement;
    if (!toggle) throw new Error("side-by-side toggle not offered");
    toggle.click();
    await Promise.resolve();
    return host;
  }

  it("puts one column per component", async () => {
    const host = await mountPivot();
    const heads = [...host.querySelectorAll(".rs-pivot th")].map((e) => (e.textContent ?? "").trim());
    expect(heads).toEqual(["設定項目", "client-a", "client-b"]);
  });

  it("marks the row where they disagree, and leaves the agreeing one unmarked", async () => {
    const host = await mountPivot();
    const rowOf = (key: string) =>
      [...host.querySelectorAll(".rs-pivot tbody tr")].find((tr) => (tr.querySelector(".rs-col-key")?.textContent ?? "").trim() === key);
    expect(rowOf("publicClient")?.className).toContain("rs-pivot-differs");
    expect(rowOf("protocol")?.className).not.toContain("rs-pivot-differs");
  });

  it("shows an absent parameter as an absence, not as an unset value", async () => {
    // "client-b has no such setting" and "client-b leaves it at the default"
    // are different findings; a blank cell would say neither.
    const host = await mountPivot();
    const row = [...host.querySelectorAll(".rs-pivot tbody tr")].find(
      (tr) => (tr.querySelector(".rs-col-key")?.textContent ?? "").trim() === "onlyHere"
    );
    expect(row?.querySelectorAll(".rs-pivot-absent")).toHaveLength(1);
  });

  it("is not offered on a sheet with a single component", () => {
    const one = { metadata: DOC.metadata, versions: [{ version: "current", sheets: [{ name: "solo", categories: [DOC.sheets[0].categories[0]] }] }] };
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: one, reviewEnabled: true, initialLang: "ja", server: false }), host);
    expect(host.querySelector(".rs-compare-toggle")).toBeNull();
  });
});

// A cell's sub-lines stack: a value's provenance, its origin marker, and — in
// the side-by-side view — one line per environment. As inline spans they ran
// together into a single unreadable line as soon as there were two.
describe("viewer: cell sub-lines stack", () => {
  it("gives each sub-line its own line", async () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const payload = {
      metadata: { title: "t" },
      versions: [
        {
          version: "current",
          sheets: [
            {
              name: "s",
              compare_components: true,
              categories: [
                { name: "c1", categories: [{ name: "G", params: [{ key: "k", description: "d", instances: [{ name: "local", value: "false" }, { name: "prod", value: "true" }] }] }] },
                { name: "c2", categories: [{ name: "G", params: [{ key: "k", value: "true", description: "d" }] }] },
              ],
            },
          ],
        },
      ],
    };
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    (host.querySelector(".rs-compare-toggle input") as HTMLInputElement).click();
    await Promise.resolve();
    const sublines = host.querySelectorAll(".rs-pivot .rs-key-subline");
    expect(sublines.length).toBeGreaterThanOrEqual(2);
    // happy-dom does not lay out, so the guarantee is asserted where it is
    // made: the rule that puts each on its own line.
    expect(customStyles).toContain("display: block");
  });
});

// Reading a sheet side by side changes its shape, and two things followed it
// out of the door: the component headings, and the outline that points at them.
describe("viewer: the side-by-side view keeps its bearings", () => {
  const DOC = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "realms",
        compare_components: true,
        categories: [
          { name: "poc", categories: [{ name: "Sessions", params: [{ key: "idle", value: "1", description: "d" }] }] },
          { name: "master", categories: [{ name: "Sessions", params: [{ key: "idle", value: "2", description: "d" }] }] },
        ],
      },
    ],
  };
  const payload = { metadata: DOC.metadata, versions: [{ version: "current", sheets: DOC.sheets }] };

  async function pivot(): Promise<HTMLElement> {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    (host.querySelector(".rs-compare-toggle input") as HTMLInputElement).click();
    await Promise.resolve();
    return host;
  }

  it("names the components it is comparing, since their headings are gone", async () => {
    const host = await pivot();
    // Rendered as the component heading it replaces, so it is found the same
    // way a component heading is.
    const heading = host.querySelector(".rs-pivot .rs-category-header .rs-cat-label");
    expect(heading?.textContent?.replace(/\s+/g, " ").trim()).toBe("poc / master");
  });

  it("gives its groups the anchors the outline points at", async () => {
    // The outline is rebuilt for the pivoted shape — component-less paths — so
    // its entries have to resolve to something on the page. They used to point
    // at ids that only exist in the stacked view, and clicking did nothing.
    const host = await pivot();
    const btn = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
    (btn as HTMLElement).click();
    await Promise.resolve();
    const items = [...host.querySelectorAll(".rs-outline-item")];
    expect(items.length).toBeGreaterThan(0);
    for (const el of [...host.querySelectorAll(".rs-outline-row")]) {
      const id = (el.querySelector("button") as HTMLElement | null)?.getAttribute("data-id");
      if (id) expect(host.querySelector(`#${CSS.escape(id)}`)).not.toBeNull();
    }
    // The entry names the category, not a component that is no longer a heading.
    expect(items.map((e) => e.textContent?.trim())).toContain("Sessions");
  });
});

// The side-by-side view renders through the same structure as the stacked one,
// which is what makes the outline, the sticky headings, the scroll offsets and
// the jump flash keep working. Flat groups broke all four at once.
describe("viewer: the side-by-side view keeps the stacked view's structure", () => {
  const DOC = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "realms",
        compare_components: true,
        categories: ["poc", "master"].map((c) => ({
          name: c,
          categories: [
            { name: "Tokens", categories: [{ name: "Access tokens", params: [{ key: "lifespan", value: c === "poc" ? "300" : "60", description: "d" }] }] },
          ],
        })),
      },
    ],
  };
  const payload = { metadata: DOC.metadata, versions: [{ version: "current", sheets: DOC.sheets }] };

  async function pivot(): Promise<HTMLElement> {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    (host.querySelector(".rs-compare-toggle input") as HTMLInputElement).click();
    await Promise.resolve();
    return host;
  }

  it("renders a heading per level, so a parent is somewhere to land", async () => {
    const host = await pivot();
    // The first label is the component heading (the components being compared);
    // the levels below it are the sheet's own categories.
    const heads = [...host.querySelectorAll(".rs-pivot .rs-cat-label")].map((e) => e.textContent?.replace(/\s+/g, " ").trim());
    expect(heads).toEqual(["poc / master", "Tokens", "Access tokens"]);
  });

  it("carries the anchor on the category, not on a box wrapping the whole table", async () => {
    // The flash lands on whatever holds the anchor. On a wrapper around the
    // heading AND the table that is every row at once, spilling past the table
    // — the jump is supposed to point at one heading.
    const host = await pivot();
    const anchored = host.querySelector(".rs-pivot [id]");
    expect(anchored?.className).toContain("rs-category");
    expect(anchored?.querySelector(".rs-category-header")).not.toBeNull();
  });

  it("lists both levels in the outline", async () => {
    const host = await pivot();
    const btn = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
    (btn as HTMLElement).click();
    await Promise.resolve();
    const items = [...host.querySelectorAll(".rs-outline-item")].map((e) => e.textContent?.trim());
    expect(items).toContain("Tokens");
    expect(items).toContain("Access tokens");
  });
});

// The components lose their headings when a sheet is read side by side, so the
// outline names them instead of leaving the reader to look back at the table.
describe("viewer: the outline names what is being compared", () => {
  const DOC = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "clients",
        compare_components: true,
        categories: ["poc", "master"].map((c) => ({
          name: c,
          categories: [{ name: "Settings", params: [{ key: "k", value: c, description: "d" }] }],
        })),
      },
    ],
  };
  const payload = { metadata: DOC.metadata, versions: [{ version: "current", sheets: DOC.sheets }] };

  async function outline(pivot: boolean): Promise<HTMLElement> {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    if (pivot) {
      (host.querySelector(".rs-compare-toggle input") as HTMLInputElement).click();
      await Promise.resolve();
    }
    const btn = [...host.querySelectorAll("button")].find((b) => /目次/.test(b.getAttribute("aria-label") ?? ""));
    (btn as HTMLElement).click();
    await Promise.resolve();
    return host;
  }

  it("lists the components as an ordinary entry, so it looks and behaves like the rest", async () => {
    const host = await outline(true);
    const items = [...host.querySelectorAll(".rs-outline-item")].map((e) => e.textContent?.trim());
    expect(items).toContain("poc / master");
  });

  it("points that entry at the heading on the page", async () => {
    // A caption in its own style went nowhere when clicked; an entry has to
    // resolve like every other one.
    const host = await outline(true);
    const entry = [...host.querySelectorAll(".rs-outline-item")].find((e) => e.textContent?.trim() === "poc / master");
    const row = entry?.closest(".rs-outline-row");
    expect(row).not.toBeNull();
    expect(host.querySelector(".rs-pivot .rs-category[id]")).not.toBeNull();
  });

  it("lists the components only while comparing", async () => {
    const host = await outline(false);
    const items = [...host.querySelectorAll(".rs-outline-item")].map((e) => e.textContent?.trim());
    expect(items).not.toContain("poc / master");
  });
});

// One component varying by environment beside one that does not: three labelled
// lines next to a bare value reads as the second having no per-environment
// value, when it has one — the same in each.
describe("viewer: side by side aligns the environments across a row", () => {
  const DOC = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "realms",
        compare_components: true,
        instances: ["local", "production"],
        categories: [
          {
            name: "master",
            categories: [{ name: "Sessions", params: [{ key: "maxLifespan", value: "28800", description: "d" }] }],
          },
          {
            name: "poc",
            categories: [
              {
                name: "Sessions",
                params: [
                  { key: "maxLifespan", description: "d", instances: [{ name: "local", value: "86400" }, { name: "production", value: "14400" }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const payload = { metadata: DOC.metadata, versions: [{ version: "current", sheets: DOC.sheets }] };

  it("labels both cells by environment when either one varies", async () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    (host.querySelector(".rs-compare-toggle input") as HTMLInputElement).click();
    await Promise.resolve();
    const row = [...host.querySelectorAll(".rs-pivot tbody tr")].find(
      (tr) => (tr.querySelector(".rs-col-key")?.textContent ?? "").trim() === "maxLifespan"
    )!;
    const cells = [...row.querySelectorAll("td")].slice(1).map((td) => (td.textContent ?? "").trim());
    // master repeats its one value per environment rather than showing it once
    // beside poc's three lines.
    expect(cells[0]).toContain("local: 28800");
    expect(cells[0]).toContain("production: 28800");
    expect(cells[1]).toContain("local: 86400");
    expect(cells[1]).toContain("production: 14400");
  });
});

// ---- the artifact panel -----------------------------------------------
//
// A value cannot be judged alone: `StartServers 2` is right or wrong depending
// on the `<IfModule mpm_event_module>` around it. A container is not a row, so
// the file goes beside the sheet rather than its brackets becoming parameters.
// These assert the two directions a reviewer moves — row to its place in the
// file, and a line back to the row that reviews it — and that a preview says
// what it could not compute rather than looking rendered and being wrong.

const WITH_ARTIFACT = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "web",
          categories: [
            {
              name: "httpd.conf",
              params: [
                { key: "IfModule.StartServers", value: "2", description: "Startup processes" },
                { key: "Listen", value: "80", description: "Port" },
                // Set here, but no line of the file is this one.
                { key: "ServerAdmin", value: "root@localhost", description: "Admin address" },
                // A product default: hidden until the reader asks for unset rows.
                { key: "Mutex", value: "default", origin: "default" as const, description: "Mutex" },
              ],
            },
          ],
        },
      ],
      artifacts: [
        {
          id: "web",
          sheet: "web",
          deployed_path: "/etc/httpd/conf/httpd.conf",
          source_file: "roles/httpd/templates/httpd.conf.j2",
          lines: [
            { text: "# managed by ansible", kind: "verbatim" as const },
            { text: "Listen 80", kind: "substituted" as const, key: "Listen" },
            { text: "", kind: "verbatim" as const },
            { text: "<IfModule mpm_event_module>", kind: "verbatim" as const },
            { text: "    StartServers 2", kind: "substituted" as const, key: "IfModule.StartServers" },
            { text: "    ServerLimit {{ a | weird }}", kind: "unrendered" as const, cause: "engine" as const, reason: "{{ a | weird }}" },
            // Written by the toolchain at deploy time — not a gap, and not
            // counted as one.
            { text: "# {{ ansible_managed }}", kind: "unrendered" as const, cause: "deploy-time" as const, reason: "{{ ansible_managed }}" },
            // A line whose row is a product default — hidden until asked for.
            { text: "Mutex default", kind: "verbatim" as const, key: "Mutex" },
            { text: "</IfModule>", kind: "verbatim" as const },
            { text: "LogLevel debug", kind: "absent" as const, reason: "httpd_debug" },
          ],
        },
      ],
    },
  ],
};

function mountArtifact(): HTMLElement {
  openSheetTab();
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(h(Root, { payload: WITH_ARTIFACT, reviewEnabled: true, initialLang: "ja", server: false }), host);
  return host;
}

function rowFor(host: HTMLElement, key: string): HTMLElement {
  const rows = [...host.querySelectorAll("tbody tr")];
  const row = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === key);
  if (!row) throw new Error(`row not found: ${key}`);
  return row as HTMLElement;
}

// Two components of one sheet share a key space by design, so a preview that
// names a component must not claim another component's row of the same name.
const TWO_COMPONENTS = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "realms",
          categories: [
            { name: "master", categories: [{ name: "Login", params: [{ key: "enabled", value: "true", description: "On" }] }] },
            { name: "poc", categories: [{ name: "Login", params: [{ key: "enabled", value: "true", description: "On" }] }] },
          ],
        },
      ],
      artifacts: [
        {
          id: "realms::poc",
          sheet: "realms",
          component: "poc",
          source_file: "config/poc.yml",
          lines: [{ text: "enabled: true", kind: "verbatim" as const, key: "enabled" }],
        },
      ],
    },
  ],
};

// The id contract: id identifies one previewed FILE. A Terraform module's rows
// span several files (main.tf, variables.tf) on the same sheet/component —
// those previews must get DIFFERENT ids, or the viewer would render them as
// bogus instance tabs of one "file". No viewer logic changes for this: the
// row->preview index is already keyed per LINE (sheet, component, key), so a
// row routes to whichever file actually holds its line.
const TWO_FILES_SAME_COMPONENT = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "tf",
          categories: [
            {
              name: "svc",
              categories: [
                { name: "Main", params: [{ key: "instance_type", value: "t3.micro", description: "Instance type" }] },
                { name: "Vars", params: [{ key: "region", value: "us-east-1", description: "Region" }] },
              ],
            },
          ],
        },
      ],
      artifacts: [
        {
          id: "tf::svc::main.tf",
          sheet: "tf",
          component: "svc",
          source_file: "modules/svc/main.tf",
          lines: [{ text: 'instance_type = "t3.micro"', kind: "verbatim" as const, key: "instance_type" }],
        },
        {
          id: "tf::svc::variables.tf",
          sheet: "tf",
          component: "svc",
          source_file: "modules/svc/variables.tf",
          lines: [{ text: 'variable "region" {}', kind: "verbatim" as const, key: "region" }],
        },
      ],
    },
  ],
};

// A `nature: "source"` preview is the AUTHORED file a deployed artifact was
// derived from — never rendered/deployed itself, so the header must not claim
// "Rendered from" over it.
const WITH_SOURCE_ARTIFACT = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "mod",
          categories: [{ name: "main.tf", params: [{ key: "instance_type", value: "t3.micro", description: "Instance type" }] }],
        },
      ],
      artifacts: [
        {
          id: "mod",
          sheet: "mod",
          source_file: "modules/ec2/main.tf",
          nature: "source" as const,
          lines: [{ text: 'instance_type = "t3.micro"', kind: "verbatim" as const, key: "instance_type" }],
        },
      ],
    },
  ],
};

describe("artifact panel", () => {
  it("does not offer one component's file to another component's row", () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: TWO_COMPONENTS, reviewEnabled: true, initialLang: "ja", server: false }), host);
    const rows = [...host.querySelectorAll("tbody tr")].filter(
      (r) => r.querySelector(".rs-col-key code")?.textContent === "enabled"
    );
    expect(rows.length).toBe(2);
    // Only the component the preview names. The other realm's `enabled` is a
    // different row and that file has no line for it.
    expect(rows.filter((r) => r.querySelector(".rs-artifact-chip")).length).toBe(1);
  });

  it("offers the file only on rows that are a line of it", () => {
    const host = mountArtifact();
    expect(rowFor(host, "IfModule.StartServers").querySelector(".rs-artifact-chip")).not.toBeNull();
    // A row the file has no line for gets none; an affordance that opens
    // nothing is worse than none.
    expect(rowFor(host, "ServerAdmin").querySelector(".rs-artifact-chip")).toBeNull();
  });

  it("opens at the row's own line, with the container around it", async () => {
    const host = mountArtifact();
    (rowFor(host, "IfModule.StartServers").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    const panel = host.querySelector(".rs-artifact-panel");
    expect(panel).not.toBeNull();
    const here = panel!.querySelector(".rs-here .rs-artifact-text");
    expect(here?.textContent).toBe("    StartServers 2");
    // The whole file, containers and comments and blank lines included — the
    // context the row alone cannot carry.
    const texts = [...panel!.querySelectorAll(".rs-artifact-text")].map((e) => e.textContent);
    expect(texts).toContain("<IfModule mpm_event_module>");
    expect(texts).toContain("</IfModule>");
    expect(texts).toContain("# managed by ansible");
    expect(panel!.querySelector(".rs-artifact-path")?.textContent).toBe("/etc/httpd/conf/httpd.conf");
  });

  it("marks a line it could not compute, and one this instance does not render", async () => {
    const host = mountArtifact();
    (rowFor(host, "Listen").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    const panel = host.querySelector(".rs-artifact-panel")!;
    const unrendered = panel.querySelector(".rs-kind-unrendered .rs-artifact-text");
    // Shown AS WRITTEN, not guessed at: a line that looks rendered and is wrong
    // is worse than one that says it could not be computed.
    expect(unrendered?.textContent).toBe("    ServerLimit {{ a | weird }}");
    const absent = panel.querySelector(".rs-kind-absent .rs-artifact-text");
    expect(absent?.textContent).toBe("LogLevel debug");
  });

  it("counts only the gaps it can honestly claim", async () => {
    const host = mountArtifact();
    (rowFor(host, "Listen").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    // One engine gap and one deploy-time line; the warning names the first only.
    const warn = host.querySelector(".rs-artifact-warn")?.textContent ?? "";
    expect(warn).toContain("1");
    // …and no tally of how the tool built the document. A reviewer cannot act
    // on "31 lines had no Jinja on them".
    expect(host.querySelector(".rs-artifact-meta")?.textContent).not.toContain("verbatim");
  });

  it("shows the unset rows when a line points at one that is hidden", async () => {
    const host = mountArtifact();
    // `Mutex` is a product default, hidden until the reader asks for unset rows.
    (rowFor(host, "Listen").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    const line = [...host.querySelectorAll(".rs-artifact-line.rs-has-row")].find(
      (l) => l.querySelector(".rs-artifact-text")?.textContent?.includes("Mutex")
    );
    expect(line).toBeDefined();
    (line as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // The row is rendered now. Doing nothing was the alternative, and the
    // reader has just pointed at the line and said "this one".
    const keys = [...host.querySelectorAll("tbody tr .rs-col-key code")].map((e) => e.textContent);
    expect(keys).toContain("Mutex");
  });

  it("closes, and stays out of the way of print", async () => {
    const host = mountArtifact();
    (rowFor(host, "Listen").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    expect(host.querySelector(".rs-app")?.classList.contains("rs-with-artifact")).toBe(true);
    (host.querySelector(".rs-artifact-panel .rs-modal-close") as HTMLElement).click();
    await Promise.resolve();
    expect(host.querySelector(".rs-artifact-panel")).toBeNull();
    expect(customStyles).toContain(".rs-artifact-panel,");
  });

  it("routes each row to the file that holds its line, never an instance tab strip of unrelated files", async () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: TWO_FILES_SAME_COMPONENT, reviewEnabled: true, initialLang: "ja", server: false }), host);

    (rowFor(host, "instance_type").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    let panel = host.querySelector(".rs-artifact-panel")!;
    expect(panel.querySelector(".rs-artifact-path")?.textContent).toBe("modules/svc/main.tf");
    // Two previews share this sheet AND component — if they wrongly shared an
    // id too, this would render as an instance tab strip.
    expect(panel.querySelector(".rs-artifact-tab")).toBeNull();
    (panel.querySelector(".rs-modal-close") as HTMLElement).click();
    await Promise.resolve();

    (rowFor(host, "region").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    panel = host.querySelector(".rs-artifact-panel")!;
    expect(panel.querySelector(".rs-artifact-path")?.textContent).toBe("modules/svc/variables.tf");
    expect(panel.querySelector(".rs-artifact-tab")).toBeNull();
  });

  it("labels a source preview as a source file, not as rendered-from", async () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: WITH_SOURCE_ARTIFACT, reviewEnabled: true, initialLang: "ja", server: false }), host);

    (rowFor(host, "instance_type").querySelector(".rs-artifact-chip") as HTMLElement).click();
    await Promise.resolve();
    const meta = host.querySelector(".rs-artifact-meta")?.textContent ?? "";
    expect(meta).toContain("ソースファイル");
    expect(meta).not.toContain("生成元");
    expect(host.querySelector(".rs-artifact-path")?.textContent).toBe("modules/ec2/main.tf");
  });
});

// ---- the "Shipped" (baseline) column -----------------------------------
//
// ansible recipe's `baseline:` — a committed copy of what the vendor shipped,
// compared against the deployed artifact. Three row shapes: inherited
// unchanged (value equals baseline), changed (value differs from baseline),
// and `origin: "baseline"` (the vendor shipped this key and this deliverable
// does not have it at all).

const WITH_BASELINE = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "web",
          categories: [
            {
              name: "httpd.conf",
              params: [
                // Inherited unchanged: same value both sides.
                { key: "ServerRoot", value: '"/etc/httpd"', baseline: '"/etc/httpd"', description: "Server root" },
                // Changed from what the vendor shipped.
                { key: "Listen", value: "8080", baseline: "80", description: "Port" },
                // A row this sheet's baseline comparison never touches (no
                // template literal keyed to a variable here — a plain PARAMETER
                // with no baseline at all): the Shipped column must render it
                // blank, not "unchanged".
                { key: "ServerAdmin", value: "root@localhost", description: "Admin address" },
                // The vendor shipped this and this deliverable does not have it.
                { key: "KeepAlive", value: "", baseline: "Off", origin: "baseline" as const, description: "Keep-alive" },
                // Vendor shipped 60; the product documents 300. The host has 60.
                { key: "Timeout", value: "60", baseline: "60", default: "300", description: "Timeout" },
                // We added it; the vendor's file says nothing, so the documented
                // default is the only answer to "what without our line".
                { key: "AddedByUs", value: "120", default: "300", description: "Added" },
                // Removed by us. The vendor had None.
                { key: "Removed", value: "", baseline: "None", default: "FollowSymlinks", origin: "baseline" as const, description: "Removed" },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function mountBaseline(): HTMLElement {
  openSheetTab();
  const host = document.createElement("div");
  document.body.appendChild(host);
  render(h(Root, { payload: WITH_BASELINE, reviewEnabled: true, initialLang: "ja", server: false }), host);
  return host;
}

function cellText(host: HTMLElement, key: string, cls: string): string {
  const rows = [...host.querySelectorAll("tbody tr")];
  const row = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === key);
  if (!row) throw new Error(`row not found: ${key}`);
  const cell = row.querySelector(`td.${cls}`);
  if (!cell) throw new Error(`no .${cls} cell on row: ${key}`);
  return (cell.textContent ?? "").trim();
}

describe("viewer: the as-installed column", () => {
  // ONE column, not two. The vendor's shipped file and the product's documented
  // default are the tool's two sources for a single question the reader has —
  // "what does a freshly installed host do here?" — and showing them side by
  // side put the tool's plumbing on screen instead of the answer. The shipped
  // value wins because it is what the host actually has.
  it("is headed as-installed and prefers the shipped value over the documented default", async () => {
    const host = mountBaseline();
    const heads = [...host.querySelectorAll("thead th")].map((e) => e.textContent?.trim());
    expect(heads).toContain("インストール時");
    expect(heads).not.toContain("出荷時");
    // Timeout: vendor shipped 60, the product documents 300 — 60 is what the
    // host has.
    expect(cellText(host, "Timeout", "rs-col-default")).toBe("60");
  });

  it("falls back to the documented default where the vendor's file says nothing", async () => {
    const host = mountBaseline();
    expect(cellText(host, "AddedByUs", "rs-col-default")).toBe("300");
  });

  it("shows what the vendor had on a row we disabled, and claims nothing about what applies instead", async () => {
    const host = mountBaseline();
    // The vendor's value, NOT the documented default: with the container
    // possibly removed alongside the directive, what applies now needs the
    // product's merge semantics, which this tool does not model.
    expect(cellText(host, "Removed", "rs-col-default")).toBe("None");
  });
});

// The side-by-side table used to print values only. On a real project 672 of
// 1016 rows are unset and carry no value at all, so two blank columns sat
// beside each other over exactly the rows a version comparison finds things in
// — the product default moving under a value nobody set.
describe("viewer: the default under the value", () => {
  const anchor = { key: "anchor", value: "1", origin: "embedded", description: "x" };
  const doc = (params: unknown[]) => ({
    metadata: { title: "t" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "s",
            compare_components: true,
            categories: [
              // A set row on each side as well: a sheet whose every row is
              // unset renders empty until the filter is lifted, and the filter
              // menu itself only appears once the document HAS such rows.
              { name: "old", categories: [{ name: "Settings", params: [params[0], anchor] }] },
              { name: "new", categories: [{ name: "Settings", params: [params[1], anchor] }] },
            ],
          },
        ],
      },
    ],
  });

  async function mount(params: unknown[]): Promise<HTMLElement> {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: doc(params) as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    // An unset row is hidden by default, and the cases below that use one are
    // exactly the cases about what such a row says when it has no value.
    if ((params[0] as { origin?: string }).origin === "default") await showUnsetRows(host);
    (host.querySelector(".rs-compare-toggle input") as HTMLInputElement).click();
    await Promise.resolve();
    return host;
  }

  it("prints the default on an unset row, where it IS the value in force", async () => {
    const unset = (d: string) => ({ key: "k", origin: "default", default: d, description: "x" });
    const host = await mount([unset("ldapsOnly"), unset("always")]);
    const text = host.querySelector(".rs-pivot")?.textContent ?? "";
    expect(text).toContain("ldapsOnly");
    expect(text).toContain("always");
  });

  it("marks the default line when the columns disagree about it", async () => {
    const unset = (d: string) => ({ key: "k", origin: "default", default: d, description: "x" });
    const host = await mount([unset("ldapsOnly"), unset("always")]);
    expect(host.querySelectorAll(".rs-pivot-default-differs").length).toBe(2);
    // And the row is flagged, though neither column has a value at all.
    expect(host.querySelectorAll(".rs-pivot-differs").length).toBe(1);
  });

  it("stays quiet when the default is the same on both sides", async () => {
    const unset = () => ({ key: "k", origin: "default", default: "same", description: "x" });
    const host = await mount([unset(), unset()]);
    expect(host.querySelectorAll(".rs-pivot-default-differs").length).toBe(0);
    expect(host.querySelectorAll(".rs-pivot-differs").length).toBe(0);
  });

  it("does not repeat an identical default on rows the project sets", async () => {
    const set = () => ({ key: "k", value: "on", origin: "embedded", default: "off", description: "x" });
    const host = await mount([set(), set()]);
    // The configured value is the subject on such a row; printing the same
    // default down every one of them would bury the handful that moved.
    expect(host.querySelector(".rs-pivot")?.textContent).not.toContain("off");
  });

  it("shows it on a set row once the columns disagree", async () => {
    const set = (d: string) => ({ key: "k", value: "on", origin: "embedded", default: d, description: "x" });
    const host = await mount([set("off"), set("on")]);
    expect(host.querySelectorAll(".rs-pivot-default-differs").length).toBe(2);
  });
});

// Two releases beside each other, one column each. The inline overlay answers
// "what changed in this sheet"; this answers "what do these two releases say
// about the same key", which is the question an upgrade review actually asks
// and which no view offered.
describe("viewer: versions as columns", () => {
  const at = (label: string, workers: string, dflt: string) => ({
    version: label,
    sheets: [
      {
        name: "app",
        categories: [
          {
            name: "Tuning",
            params: [
              { key: "workers", value: workers, origin: "embedded", description: "d" },
              { key: "unset", origin: "default", default: dflt, description: "d" },
            ],
          },
        ],
      },
    ],
  });

  async function mountColumnar(): Promise<HTMLElement> {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: { metadata: { title: "t" }, versions: [at("19.0.2", "4", "ldapsOnly"), at("26.7.0", "4", "always")] },
        reviewEnabled: true,
        initialLang: "ja",
        server: false,
      } as never),
      host
    );
    const bar = host.querySelector(".rs-version-bar") as HTMLElement;
    [...bar.querySelectorAll("button")].find((b) => b.textContent?.includes("比較"))!.click();
    await Promise.resolve();
    // Unset rows are hidden document-wide until asked for, and here they are
    // the point: a version comparison finds most of its rows among them. Asked
    // for BEFORE switching to columns — the filter menu lives on the sheet
    // chrome, which the columnar view replaces.
    // Unset rows are hidden document-wide until asked for, and a version
    // comparison finds most of its rows among them.
    await showUnsetRows(host);
    const boxes = [...host.querySelectorAll(".rs-version-bar input[type=checkbox]")] as HTMLInputElement[];
    boxes[boxes.length - 1].click(); // the side-by-side toggle
    await Promise.resolve();
    return host;
  }

  it("gives each version a column of its own", async () => {
    const host = await mountColumnar();
    const heads = [...host.querySelectorAll(".rs-pivot th")].map((e) => (e.textContent ?? "").trim());
    expect(heads).toEqual(["設定項目", "19.0.2", "26.7.0"]);
  });

  it("finds the row whose product default moved under no value at all", async () => {
    const host = await mountColumnar();
    const text = host.querySelector(".rs-pivot")?.textContent ?? "";
    expect(text).toContain("ldapsOnly");
    expect(text).toContain("always");
    // Neither column has a value here; the row is a finding all the same.
    expect(host.querySelectorAll(".rs-pivot-default-differs").length).toBe(2);
  });

  it("leaves the row whose value held still unmarked", async () => {
    const host = await mountColumnar();
    const rows = [...host.querySelectorAll(".rs-param-row")];
    const workers = rows.find((r) => (r.textContent ?? "").includes("workers"));
    expect(workers?.className).not.toContain("rs-pivot-differs");
  });
});

// A sheet that exists only to compare has no stacked reading to return to, so
// it opens side by side and offers no way out. The togglable form is unchanged.
describe("viewer: a sheet that is always side by side", () => {
  const doc = (mode: boolean | "always") => ({
    metadata: { title: "t" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "s",
            compare_components: mode,
            categories: [
              { name: "a", categories: [{ name: "Settings", params: [{ key: "k", value: "1", description: "d" }] }] },
              { name: "b", categories: [{ name: "Settings", params: [{ key: "k", value: "2", description: "d" }] }] },
            ],
          },
        ],
      },
    ],
  });

  function mountMode(mode: boolean | "always"): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: doc(mode) as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }

  it("opens pivoted, with no toggle to leave by", () => {
    const host = mountMode("always");
    expect(host.querySelector(".rs-pivot")).toBeTruthy();
    expect(host.querySelector(".rs-compare-toggle")).toBeNull();
  });

  it("still opens stacked, with a toggle, for the plain declaration", () => {
    const host = mountMode(true);
    expect(host.querySelector(".rs-pivot")).toBeNull();
    expect(host.querySelector(".rs-compare-toggle")).toBeTruthy();
  });
});

// A stored value and a displayed value are not always the same string: an LDAP
// search scope is written `1` through the API and shown as "One Level" in the
// product's own console, so a reviewer who only ever used the console meets a
// bare `1` and cannot judge it. The dictionary carries the mapping; these tests
// pin what the viewer is allowed to do with it — which is to ANNOTATE, never to
// change the value, because that same string is what a review opens with and
// what `apply` writes back into the config file.
describe("option labels", () => {
  const OPTIONED: ParameterSheetInput = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "ldap",
        instances: ["production"],
        categories: [
          {
            name: "Searching",
            params: [
              {
                key: "searchScope",
                value: "1",
                default: "2",
                description: "Search scope",
                // English only, exactly as the product ships it: Keycloak
                // translates its field labels long before its option lists.
                options: [
                  { value: "1", label: { en: "One Level" } },
                  { value: "2", label: { en: "Subtree", ja: "サブツリー" } },
                ],
              },
              // A value the bound dictionary version does not list — a newer
              // server, or a placeholder. Annotating it would be a guess.
              {
                key: "editMode",
                value: "UNSYNCED",
                description: "Edit mode",
                options: [{ value: "READ_ONLY", label: { en: "Read only" } }],
              },
              // No options at all: the overwhelming majority of rows.
              { key: "connectionUrl", value: "ldaps://d", description: "Connection URL" },
            ],
          },
        ],
      },
    ],
  };
  const PAYLOAD_O = { metadata: OPTIONED.metadata, versions: [{ version: "current", sheets: OPTIONED.sheets }] };

  function mountOptioned(lang: "ja" | "en" = "en"): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: PAYLOAD_O, reviewEnabled: true, initialLang: lang, server: false }), host);
    return host;
  }

  const labels = (host: HTMLElement): string[] => [...host.querySelectorAll(".rs-option-label")].map((e) => e.textContent ?? "");

  it("names the value the product's own UI names", () => {
    const host = mountOptioned();
    expect(labels(host)).toContain("One Level");
  });

  it("names the DEFAULT too — an unset row is judged by what applies to it", () => {
    const host = mountOptioned();
    expect(labels(host)).toContain("Subtree");
  });

  it("never folds the label into the value", () => {
    // The load-bearing one. `value` is what a review's current value, the copy
    // button and `apply`'s write all use, so "1 (One Level)" reaching it would
    // put that text into a deployed configuration file.
    const host = mountOptioned();
    const codes = [...host.querySelectorAll("code")].map((e) => e.textContent ?? "");
    expect(codes).toContain("1");
    expect(codes.some((c) => c.includes("One Level"))).toBe(false);
  });

  it("says nothing about a value its options do not list", () => {
    const host = mountOptioned();
    expect(labels(host).some((l) => l.includes("READ_ONLY") || l.includes("Read only"))).toBe(false);
  });

  it("follows the language toggle, and falls back to English where the product has no translation", async () => {
    const host = mountOptioned("ja");
    // `2` is translated, `1` is not — and showing the English name beats
    // showing nothing, which is what a bare code already was.
    expect(labels(host)).toContain("サブツリー");
    expect(labels(host)).toContain("One Level");
    const toggle = [...host.querySelectorAll("button")].find((b) => /^(EN|JA)$/.test((b.textContent ?? "").trim()));
    if (!toggle) throw new Error("language toggle not found");
    (toggle as HTMLElement).click();
    await Promise.resolve();
    expect(labels(host)).toContain("Subtree");
  });
});

// `compare_components: "always"` is what a sheet that exists only to compare
// declares. It reached the viewer as a bare `true` for as long as it existed —
// the declaration parsed, the assembler's own check ran, and the sheet still
// opened stacked with a button offering the reading it does not have.
describe("a sheet that is always pivoted", () => {
  const ALWAYS: ParameterSheetInput = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "upgrade",
        instances: [],
        compare_components: "always",
        categories: [
          {
            name: "old",
            categories: [{ name: "HTTP", params: [{ key: "proxy", value: "edge", description: "Proxy mode" }] }],
          },
          {
            name: "new",
            categories: [{ name: "HTTP", params: [{ key: "proxy", value: "none", description: "Proxy mode" }] }],
          },
        ],
      },
    ],
  };

  it("opens side by side, with no way back to the stacked reading", () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: { metadata: ALWAYS.metadata, versions: [{ version: "current", sheets: ALWAYS.sheets }] },
        reviewEnabled: true,
        initialLang: "en",
        server: false,
      }),
      host
    );
    // Both components' values on one row is the whole point.
    const text = host.textContent ?? "";
    expect(text).toContain("edge");
    expect(text).toContain("none");
    // …and no control offering to leave it.
    const leave = [...host.querySelectorAll("button")].filter((b) => /stack|側|戻/i.test(b.textContent ?? ""));
    expect(leave).toEqual([]);
  });
});
