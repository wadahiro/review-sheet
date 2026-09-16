// DOM tests for the viewer: render the REAL component tree against a real
// document and assert on what a reviewer would see.
//
// Everything else in this suite is a pure function; these exist because the
// viewer's most costly bugs have been about which cell a finding lands on and
// what a control does — behaviour that only shows up once the tree is rendered.
// Layout (CSS cascade, hit areas, pseudo-elements) is still out of reach here
// and needs a real browser.

import { GlobalRegistrator } from "@happy-dom/global-registrator";
// Guarded: bun can run several DOM test files in one process, and a second
// register() throws instead of being a no-op.
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { h, render } from "preact";
import { Root, artifactProvenance, payloadOfSet, docIdPrefix } from "../src/html/app";
import { readMarkdownSet } from "../src/md-read";
import { setMarkdownRenderer } from "../src/html/markdown-runtime";
import { renderMarkdown } from "../src/markdown";
import { toMarkdownSet } from "../src/md-set";
import { carriedDocuments, addressOf } from "../src/md-documents";
import { buildArtifactIndex } from "../src/artifact-index";
import { customStyles } from "../src/html/styles";
import { getMessages } from "../src/html/i18n";
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
// UNMOUNTED, not just emptied. Clearing `innerHTML` detaches a tree without
// telling Preact, so every effect it registered stays live — and the scroll-spy
// registers one on `window`. By the end of this file dozens of dead Apps were
// still answering every scroll event a later test dispatched, each of them
// walking the document; the one test that measures what a scroll produced
// failed about one run in three, and passed on its own every time.
afterEach(() => {
  for (const el of [...document.body.children]) render(null, el as HTMLElement);
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
describe("viewer: the tree's headings", () => {
  const tree = (host: HTMLElement): HTMLElement => {
    const el = host.querySelector(".rs-navtree") as HTMLElement | null;
    if (!el) throw new Error("the navigation tree is not on the page");
    return el;
  };
  const headings = (host: HTMLElement): string[] =>
    [...tree(host).querySelectorAll(".rs-navtree-heading")].map((b) => b.textContent?.trim() ?? "");

  it("carries one entry per category of the sheet being read", () => {
    const host = mount();
    expect(headings(host).length).toBeGreaterThan(0);
    expect(headings(host).join(" ")).toContain("Tuning");
  });

  it("navigates on click without throwing", () => {
    const host = mount();
    const item = tree(host).querySelector(".rs-navtree-heading .rs-navtree-item") as HTMLElement;
    expect(() => item.click()).not.toThrow();
  });

  it("leaves out a category made only of unset rows, matching the body", () => {
    const host = mount();
    // SHEET's "Defaults only" category holds nothing but origin:default rows.
    expect(headings(host).join(" ")).not.toContain("Defaults only");
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
  // The document's sheets, as the tree lists them — its rows that are neither a
  // chapter nor one of a sheet's own headings. The chapter number is part of
  // the name (see nav-tree.ts) and is dropped here: what is being asserted is
  // the words, not the position.
  const tabs = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-navtree-row:not(.rs-navtree-heading) .rs-navtree-item:not(.rs-navtree-group)")]
      .map((b) => (b.textContent ?? "").trim().replace(/^[\d.]+\s+/, ""));

  it("names the tabs in the reader's language", () => {
    expect(tabs(mountSheets("ja"))).toEqual(["OS 設定", "Keycloak 設定"]);
    document.body.innerHTML = "";
    expect(tabs(mountSheets("en"))).toEqual(["OS baseline", "Keycloak configuration"]);
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

// The tree is the other half of the same navigation, so it has to follow the
// path in the header: one sheet is where the reader is, and exactly one row
// says so.
describe("viewer: the tree follows the header", () => {
  const tree = (host: HTMLElement): HTMLElement => host.querySelector(".rs-navtree") as HTMLElement;

  it("marks the sheet the header is on, and only that one", () => {
    const host = mount();
    expect(tree(host).querySelectorAll(".rs-navtree-current")).toHaveLength(1);
  });

  // The keyboard walk and the scroll-into-view both look rows up by this
  // attribute; without it neither moves, silently.
  it("gives every row an address they can be found by", () => {
    const host = mount();
    const rows = [...tree(host).querySelectorAll("[data-nav-row]")];
    expect(rows.length).toBeGreaterThan(0);
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
          { name: "app", categories: [{ name: "Sessions", params: [{ key: "idle", value: "1", description: "d" }] }] },
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
    expect(heading?.textContent?.replace(/\s+/g, " ").trim()).toBe("app / master");
  });

  it("gives its groups the anchors the outline points at", async () => {
    // The outline is rebuilt for the pivoted shape — component-less paths — so
    // its entries have to resolve to something on the page. They used to point
    // at ids that only exist in the stacked view, and clicking did nothing.
    const host = await pivot();
    const items = [...host.querySelectorAll(".rs-navtree-item")];
    expect(items.length).toBeGreaterThan(0);
    for (const el of [...host.querySelectorAll(".rs-navtree-row")]) {
      const id = (el.querySelector("button") as HTMLElement | null)?.getAttribute("data-nav-id");
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
        categories: ["app", "master"].map((c) => ({
          name: c,
          categories: [
            { name: "Tokens", categories: [{ name: "Access tokens", params: [{ key: "lifespan", value: c === "app" ? "300" : "60", description: "d" }] }] },
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
    expect(heads).toEqual(["app / master", "Tokens", "Access tokens"]);
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
    const items = [...host.querySelectorAll(".rs-navtree-item")].map((e) => e.textContent?.trim());
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
        categories: ["app", "master"].map((c) => ({
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
    return host;
  }

  it("lists the components as an ordinary entry, so it looks and behaves like the rest", async () => {
    const host = await outline(true);
    const items = [...host.querySelectorAll(".rs-navtree-item")].map((e) => e.textContent?.trim());
    expect(items).toContain("app / master");
  });

  it("points that entry at the heading on the page", async () => {
    // A caption in its own style went nowhere when clicked; an entry has to
    // resolve like every other one.
    const host = await outline(true);
    const entry = [...host.querySelectorAll(".rs-navtree-item")].find((e) => e.textContent?.trim() === "app / master");
    const row = entry?.closest(".rs-navtree-row");
    expect(row).not.toBeNull();
    expect(host.querySelector(".rs-pivot .rs-category[id]")).not.toBeNull();
  });

  it("lists the components only while comparing", async () => {
    const host = await outline(false);
    const items = [...host.querySelectorAll(".rs-navtree-item")].map((e) => e.textContent?.trim());
    expect(items).not.toContain("app / master");
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
            name: "app",
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
    // beside app's three lines.
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
            { name: "app", categories: [{ name: "Login", params: [{ key: "enabled", value: "true", description: "On" }] }] },
          ],
        },
      ],
      artifacts: [
        {
          id: "realms::app",
          sheet: "realms",
          component: "app",
          source_file: "config/app.yml",
          lines: [{ text: "enabled: true", kind: "verbatim" as const, key: "enabled" }],
        },
      ],
    },
  ],
};

// A component that IS a deployed file. The category path is joined with "/",
// and such a component contains one — so recovering the outermost level by
// splitting on the separator took the empty string before the leading slash,
// and every row under it silently offered no preview at all.
const PATH_COMPONENTS = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "os",
          categories: [
            { name: "/etc/logrotate.d/netstat", params: [{ key: "rotate", value: "3", description: "Keep" }] },
            { name: "/etc/logrotate.d/postgresql", params: [{ key: "rotate", value: "7", description: "Keep" }] },
          ],
        },
      ],
      artifacts: [
        {
          id: "os::netstat",
          sheet: "os",
          component: "/etc/logrotate.d/netstat",
          source_file: "roles/os/templates/logrotate-netstat.j2",
          lines: [{ text: "    rotate 3", kind: "substituted" as const, key: "rotate" }],
        },
        {
          id: "os::postgresql",
          sheet: "os",
          component: "/etc/logrotate.d/postgresql",
          source_file: "roles/os/templates/logrotate-postgresql.j2",
          lines: [{ text: "    rotate 7", kind: "substituted" as const, key: "rotate" }],
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

// A `nature: "observed"` document is what a HOST actually held — the evidence a
// test result points at, not what this document says the file will be. It is the
// same shape and the same panel, and it must NOT join the row->preview index:
// a row already routes to exactly one document, and an observed copy of the
// same file would make which one it opens depend on emission order.
const WITH_OBSERVED = {
  metadata: { title: "t" },
  versions: [
    {
      version: "current",
      sheets: [
        {
          name: "web",
          categories: [{ name: "httpd.conf", params: [{ key: "Listen", value: "80", description: "Port" }] }],
        },
      ],
      artifacts: [
        {
          id: "web",
          sheet: "web",
          deployed_path: "/etc/httpd/conf/httpd.conf",
          source_file: "roles/httpd/templates/httpd.conf.j2",
          lines: [{ text: "Listen 80", kind: "substituted" as const, key: "Listen" }],
        },
        {
          id: "web::observed:node1:/etc/httpd/conf/httpd.conf",
          sheet: "web",
          source_file: "/etc/httpd/conf/httpd.conf",
          nature: "observed" as const,
          observed: { host: "node1", at: "2026-09-08T00:11:22Z" },
          lines: [{ text: "Listen 80", kind: "verbatim" as const, key: "Listen" }],
        },
      ],
    },
  ],
};

describe("artifact panel", () => {
  // The row keeps routing to the document this sheet DESCRIBES, whatever else
  // was collected under the same key.
  it("never routes a row to an observed document", async () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: WITH_OBSERVED, reviewEnabled: true, initialLang: "ja", server: false }), host);
    const chip = host.querySelector(".rs-artifact-chip") as HTMLElement | null;
    expect(chip).not.toBeNull();
    chip!.click();
    await Promise.resolve();
    const header = host.querySelector(".rs-artifact-panel")?.textContent ?? "";
    expect(header).toContain("roles/httpd/templates/httpd.conf.j2");
    expect(header).not.toContain("2026-09-08T00:11:22Z");
  });

  // …and when it IS opened, the panel says where it came from and when — never
  // "Rendered from", which is a claim about a file this document produced.
  it("says an observed document was collected, with the host and the moment", () => {
    const t = getMessages("ja");
    const line = artifactProvenance({ nature: "observed", observed: { host: "node1", at: "2026-09-08T00:11:22Z" } }, t);
    expect(line).toContain("node1");
    expect(line).toContain("2026-09-08T00:11:22Z");
    expect(line).not.toContain("生成元");
    // …and the other two keep exactly the claims they had.
    expect(artifactProvenance({}, t)).toBe(t.artifactRenderedFrom);
    expect(artifactProvenance({ nature: "source" }, t)).toBe(t.artifactSourceFile);
  });

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

  it("offers the file when the component is a path, not only when it is a name", () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: PATH_COMPONENTS, reviewEnabled: true, initialLang: "ja", server: false }), host);
    const rows = [...host.querySelectorAll("tbody tr")].filter(
      (r) => r.querySelector(".rs-col-key code")?.textContent === "rotate"
    );
    expect(rows.length).toBe(2);
    // Each row opens ITS OWN file: both are named `rotate`, and the component
    // is the only thing telling them apart.
    expect(rows.filter((r) => r.querySelector(".rs-artifact-chip")).length).toBe(2);
  });

  // A component is free to be a short alias while the CATEGORY is the file it
  // deploys — which is the ordinary shape once categories are named after the
  // deployed path. Assuming the category head IS the component left every one
  // of those rows without a preview: 294 of them on one real sheet.
  it("offers the file when the category is the path and the component an alias", () => {
    const payload = {
      metadata: { title: "t" },
      versions: [
        {
          version: "current",
          sheets: [
            {
              name: "kc",
              categories: [
                { name: "/opt/keycloak/conf/keycloak.conf", params: [{ key: "hostname", value: "sso", description: "Host" }] },
              ],
            },
          ],
          artifacts: [
            {
              id: "kc::conf",
              sheet: "kc",
              component: "keycloak.conf",
              deployed_path: "/opt/keycloak/conf/keycloak.conf",
              source_file: "roles/keycloak/templates/keycloak.conf.j2",
              lines: [{ text: "hostname=sso", kind: "substituted" as const, key: "hostname" }],
            },
          ],
        },
      ],
    };
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    expect(rowFor(host, "hostname").querySelector(".rs-artifact-chip")).not.toBeNull();
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
                // `default_from` is set as well: the shipped value wins in the
                // cell, so the annotation must NOT follow the default up.
                { key: "Timeout", value: "60", baseline: "60", default: "300", default_from: "/etc/httpd/conf/httpd.conf", description: "Timeout" },
                // We added it; the vendor's file says nothing, so the documented
                // default is the only answer to "what without our line".
                { key: "AddedByUs", value: "120", default: "300", description: "Added" },
                // A default the dictionary read out of a file the distribution
                // ships, not out of the product's documentation.
                { key: "Rotate", value: "7", default: "4", default_from: "/etc/logrotate.conf", description: "Log files are rotated count times. Default is 0." },
                // A presence row whose default is also presence: the word
                // REPLACES the stored value, so there is nothing left to
                // annotate beside it.
                { key: "RtcSync", value: "true", default: "true", presence: true as const, description: "Sync the RTC" },
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

  // logrotate's man page says `rotate` defaults to 0 and the shipped
  // logrotate.conf sets 4 — both true one layer apart. A cell reading `4`
  // beside a description reading "Default is 0" reads as broken until it says
  // which document the 4 came from.
  it("names the file a default was read from, when it was not the product's own documentation", async () => {
    const host = mountBaseline();
    const rows = [...host.querySelectorAll("tbody tr")];
    const row = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === "Rotate")!;
    const cell = row.querySelector("td.rs-col-default")!;
    expect(cell.querySelector(".rs-option-label")?.textContent).toBe("/etc/logrotate.conf");
    expect(cell.textContent).toContain("4");
  });

  // The word IS the value on a presence row — `display` already replaced it —
  // so a label beside it repeats itself: "あり (あり)".
  it("does not repeat the presence word as a label beside itself", async () => {
    const host = mountBaseline();
    const rows = [...host.querySelectorAll("tbody tr")];
    const row = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === "RtcSync")!;
    const cell = row.querySelector("td.rs-col-default")!;
    expect((cell.textContent ?? "").trim()).toBe("あり");
    expect(cell.querySelector(".rs-option-label")).toBeNull();
  });

  // The shipped value wins in this cell, and it is a different fact with a
  // different source: annotating it with the defaults file would name the
  // wrong document for the number on screen.
  it("does not name that file on a row where the shipped value is what is shown", async () => {
    const host = mountBaseline();
    const rows = [...host.querySelectorAll("tbody tr")];
    const row = rows.find((r) => r.querySelector(".rs-col-key code")?.textContent === "Timeout")!;
    expect(row.querySelector("td.rs-col-default .rs-option-label")).toBeNull();
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

  it("falls back to English where the product has no translation", () => {
    const host = mountOptioned("ja");
    // `2` is translated, `1` is not — and showing the English name beats
    // showing nothing, which is what a bare code already was.
    expect(labels(host)).toContain("サブツリー");
    expect(labels(host)).toContain("One Level");
  });

  it("names them in English in an English document", () => {
    expect(labels(mountOptioned("en"))).toContain("Subtree");
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

// `category: null` — the row a component holds directly, which in the admin
// console is the field ABOVE the tabs. The side-by-side view walked only the
// component's child categories, so those rows existed in the stacked view and
// nowhere else; and since a component here is one client or one realm, the
// fields above the tabs are exactly the ones a comparison is reaching for.
describe("viewer: a row with no category survives the side-by-side view", () => {
  const payload = {
    metadata: { title: "t" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "clients",
            compare_components: true,
            categories: ["oidc-app", "account"].map((c) => ({
              name: c,
              params: [{ key: "clientId", value: c, description: "d" }],
              categories: [
                { name: "Settings", params: [{ key: "protocol", value: "openid-connect", description: "d" }] },
              ],
            })),
          },
        ],
      },
    ],
  };

  async function pivot(): Promise<HTMLElement> {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    (host.querySelector(".rs-compare-toggle input") as HTMLInputElement).click();
    await Promise.resolve();
    return host;
  }

  const rowOf = (host: HTMLElement, key: string): Element | undefined =>
    [...host.querySelectorAll(".rs-pivot tbody tr")].find(
      (tr) => (tr.querySelector(".rs-col-key")?.textContent ?? "").trim() === key
    );

  it("shows the row, with a column per component", async () => {
    const host = await pivot();
    const row = rowOf(host, "clientId");
    expect(row).not.toBeUndefined();
    const cells = [...row!.querySelectorAll(".rs-col-value")].map((e) => (e.textContent ?? "").trim());
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain("oidc-app");
    expect(cells[1]).toContain("account");
    // Two different values: the view has to mark it as a difference, same as
    // any other row.
    expect(row!.className).toContain("rs-pivot-differs");
  });

  it("puts it above the categories, where the stacked view puts it", async () => {
    const host = await pivot();
    const keys = [...host.querySelectorAll(".rs-pivot tbody tr .rs-col-key")].map((e) => (e.textContent ?? "").trim());
    expect(keys).toEqual(["clientId", "protocol"]);
  });

  it("does not invent a heading for it", async () => {
    // It has no category, so the only heading above it is the components one.
    const host = await pivot();
    const heads = [...host.querySelectorAll(".rs-pivot .rs-cat-label")].map((e) => e.textContent?.replace(/\s+/g, " ").trim());
    expect(heads).toEqual(["oidc-app / account", "Settings"]);
  });
});

// A document sheet: prose where the rows would be. It is a SHEET — it takes a
// tab, it takes its place in the order, and its headings are its outline —
// which is the whole reason it is not a panel bolted onto the overview page.
describe("viewer: a document sheet", () => {
  const payload = {
    metadata: { title: "t" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "policy",
            label: { ja: "移行方針", en: "Migration policy" },
            categories: [],
            document: {
              html: '<h1 id="rs-doc-移行方針">移行方針</h1>\n<p>本文</p>\n<h2 id="rs-doc-前提">前提</h2>\n<p><img src="data:image/png;base64,AAAA" alt="図" /></p>\n',
              headings: [
                { level: 1, text: "移行方針", id: "rs-doc-移行方針" },
                { level: 2, text: "前提", id: "rs-doc-前提" },
              ],
            },
          },
        ],
      },
    ],
  };

  function mountDoc(): HTMLElement {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }

  it("renders the document, images and all", () => {
    const host = mountDoc();
    const doc = host.querySelector(".rs-doc");
    expect(doc).not.toBeNull();
    expect(doc?.querySelector("h1")?.textContent).toBe("移行方針");
    expect(doc?.querySelector("img")?.getAttribute("src")).toStartWith("data:image/png;base64,");
  });

  it("shows no parameter table at all", () => {
    // It has no rows. Anything row-shaped here would be the viewer inventing
    // one.
    const host = mountDoc();
    expect(host.querySelectorAll(".rs-param-table")).toHaveLength(0);
  });

  it("is named by its label in the tree, like any other sheet", () => {
    const host = mountDoc();
    const rows = [...host.querySelectorAll(".rs-navtree-item")].map((e) => (e.textContent ?? "").trim());
    expect(rows.some((tx) => tx.includes("移行方針"))).toBe(true);
  });

  it("lists its headings in the outline", async () => {
    const host = mountDoc();
    const items = [...host.querySelectorAll(".rs-navtree-item")].map((e) => (e.textContent ?? "").trim());
    expect(items).toContain("移行方針");
    expect(items).toContain("前提");
  });

  // A document has no `.rs-category[id]`, so the tree's entries point at the
  // headings the RENDER produced. Jumping to one marks it — the one thing about
  // a document's navigation that can be observed without a layout engine; the
  // scroll-spy's own arithmetic is covered where there is one to observe.
  it("marks the heading a jump lands on", async () => {
    const host = mountDoc();
    const entry = [...host.querySelectorAll(".rs-navtree-heading .rs-navtree-item")]
      .find((e) => (e.textContent ?? "").includes("前提")) as HTMLElement;
    entry.click();
    await new Promise((r) => setTimeout(r, 30));
    const here = [...host.querySelectorAll(".rs-navtree-here")];
    expect(here).toHaveLength(1);
    expect(here[0].textContent).toContain("前提");
  });

  it("points each outline entry at an anchor that is really on the page", async () => {
    // The failure this replaces is silent: an entry whose id is not in the DOM
    // simply does nothing when clicked.
    const host = mountDoc();
    for (const id of ["rs-doc-移行方針", "rs-doc-前提"]) {
      expect(host.querySelector(`[id="${id}"]`)).not.toBeNull();
    }
  });
});

// Two document sheets whose markdown happens to share a heading. The outline
// lists every sheet's entries at once and marks the current one by comparing
// ids, so two entries carrying the SAME id are both "current" — a heading
// clicked on one sheet lights up in the other's tree as well.
describe("viewer: two documents with the same heading", () => {
  const doc = (name: string, id: string) => ({
    name,
    categories: [],
    document: {
      html: `<h2 id="${id}">ツリー</h2>\n<p>x</p>\n`,
      headings: [{ level: 2, text: "ツリー", id }],
    },
  });

  function mountWith(idA: string, idB: string): HTMLElement {
    const payload = {
      metadata: { title: "t" },
      versions: [{ version: "current", sheets: [doc("a", idA), doc("b", idB)] }],
    };
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }

  // WAITED FOR, not timed. The spy runs in an effect, and Preact defers those
  // to after paint — which in this environment means a fallback timer, not the
  // frame a browser would give it. A fixed 30ms was sometimes enough and
  // sometimes not, so this test failed about one run in three and passed on its
  // own every time; the mark it is about had simply not been made yet. What is
  // asserted is that exactly one entry ends up current, never how soon.
  async function currentCount(host: HTMLElement): Promise<number> {
    window.dispatchEvent(new Event("scroll"));
    for (let i = 0; i < 100; i++) {
      if (host.querySelector(".rs-navtree-here") !== null) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return host.querySelectorAll(".rs-navtree-here").length;
  }

  // The tree marks where the reader is by comparing ids, so one id shared by
  // two sheets would be two entries claiming it — or, since the collision also
  // confuses the lookup, none. `recipes/document.ts` namespaces the ids by
  // sheet so that input cannot be produced; that it does is checked where it
  // happens (tests/recipe-document.test.ts). What is checked HERE is the
  // consumer's side of the same contract: distinct ids, exactly one mark.
  it("marks one entry current when the ids differ", async () => {
    expect(await currentCount(mountWith("rs-doc-a-ツリー", "rs-doc-b-ツリー"))).toBe(1);
  });
});

// `layout: file+categories`: the file heads the rows, and the grouping that
// heading displaced sub-heads them inside its table. Derived here rather than
// stored as a second category level, because a row's identity is
// `sheet :: category :: key` — making the group a category would move every
// review target and apply target the day a project changed its layout, which is
// a display decision moving data.
describe("sub-headings inside a file's table", () => {
  const row = (key: string, sub?: string[]) => ({
    key,
    value: "v",
    description: { ja: "d" },
    ...(sub ? { sub_category: sub } : {}),
  });

  function mountSub(params: ReturnType<typeof row>[]): HTMLElement {
    const payload = {
      metadata: { title: "t" },
      versions: [{ version: "current", sheets: [{ name: "s", categories: [{ name: "/etc/app.conf", params }] }] }],
    } as unknown as ParameterSheetInput as never;
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }

  const headsOf = (host: HTMLElement): string[] =>
    [...host.querySelectorAll("tr.rs-row-subhead")].map((tr) => tr.textContent?.trim() ?? "");
  const keysOf = (host: HTMLElement): string[] =>
    [...host.querySelectorAll("tr.rs-param-row")]
      .filter((tr) => !tr.className.includes("rs-row-subhead"))
      .map((tr) => tr.querySelector(".rs-col-key")?.textContent?.trim() ?? "");

  it("heads each group once, in first-appearance order", () => {
    const host = mountSub([row("a", ["Logging"]), row("b", ["Memory"]), row("c", ["Logging"])]);
    expect(headsOf(host)).toEqual(["Logging", "Memory"]);
  });

  it("gathers a group's rows under its heading, keeping their order within it", () => {
    const host = mountSub([row("a", ["Logging"]), row("b", ["Memory"]), row("c", ["Logging"])]);
    expect(keysOf(host)).toEqual(["a", "c", "b"]);
  });

  // A path is written as one heading, the way a dictionary states it.
  it("writes a nested group as its path", () => {
    expect(headsOf(mountSub([row("a", ["Write-Ahead Log", "Archiving"])]))).toEqual(["Write-Ahead Log / Archiving"]);
  });

  // The rows a file heads but a dictionary never grouped keep their place at
  // the top rather than being filed under a heading invented for them.
  it("leaves an ungrouped row unheaded", () => {
    const host = mountSub([row("plain"), row("a", ["Logging"])]);
    expect(headsOf(host)).toEqual(["Logging"]);
    expect(keysOf(host)).toEqual(["plain", "a"]);
  });

  // The default layout stores no `sub_category` at all, and a table with none
  // must render exactly as it did before this existed.
  it("adds nothing to a table whose rows carry no grouping", () => {
    const host = mountSub([row("a"), row("b")]);
    expect(headsOf(host)).toEqual([]);
    expect(keysOf(host)).toEqual(["a", "b"]);
  });
});

// `layout: categories` heads rows by the product's grouping and says nothing
// about files — right for a unit whose file is how it SHIPS rather than what it
// IS. The hazard it carries is that two files' rows can land under one heading
// with nothing on the page saying so, and a reader then takes them for one
// file's settings. A build-time report would tell the author; this tells the
// reader, where the mixture is.
describe("a group holding rows from more than one file", () => {
  const row = (key: string, file?: string) => ({
    key,
    value: "v",
    description: { ja: "d" },
    // The DEPLOYED file, which is what the mark is about — a row's source is
    // where its value is written, and two rows of one file routinely have
    // different ones (a template and the vars file feeding it).
    ...(file ? { deployed_file: file, source: { file: "vars.yml", line: 1 } } : {}),
  });

  function mountFiles(params: ReturnType<typeof row>[]): HTMLElement {
    const payload = {
      metadata: { title: "t" },
      versions: [{ version: "current", sheets: [{ name: "s", categories: [{ name: "General", params }] }] }],
    } as unknown as ParameterSheetInput as never;
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  }

  const filesShown = (host: HTMLElement): string[] =>
    [...host.querySelectorAll(".rs-row-file code")].map((e) => e.textContent?.trim() ?? "");

  it("says which file each row is a line of", () => {
    expect(filesShown(mountFiles([row("a", "realm-a.json"), row("b", "realm-b.json")]))).toEqual([
      "realm-a.json",
      "realm-b.json",
    ]);
  });

  // One file is the ordinary case and needs no mark: repeating the same path on
  // every row would be noise that says nothing a reader did not already know.
  it("says nothing when every row is a line of the same file", () => {
    expect(filesShown(mountFiles([row("a", "realm.json"), row("b", "realm.json")]))).toEqual([]);
  });

  it("says nothing when no row has a file at all", () => {
    expect(filesShown(mountFiles([row("a"), row("b")]))).toEqual([]);
  });
});

// A presence row holds this tool's spelling of "it is there" — a string written
// nowhere in the file under review. The annotation rule that puts a product's
// name for a value BESIDE it exists because the value is what the review dialog
// opens with, the copy button yields and apply writes back; for presence none of
// those hold, so the word stands alone and the value stays the identity beneath.
describe("what a presence row shows in its value cell", () => {
  function mountRows(params: Record<string, unknown>[], lang: "ja" | "en" = "ja"): HTMLElement {
    const payload = {
      metadata: { title: "t" },
      versions: [{ version: "current", sheets: [{ name: "s", categories: [{ name: "c", params }] }] }],
    } as unknown as ParameterSheetInput as never;
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload, reviewEnabled: true, initialLang: lang, server: false }), host);
    return host;
  }
  const valueCell = (host: HTMLElement, key: string): string =>
    [...host.querySelectorAll("tr.rs-param-row")]
      .find((tr) => tr.querySelector(".rs-col-key")?.textContent?.includes(key))
      ?.querySelector(".rs-col-value")?.textContent?.trim() ?? "";

  const presenceRow = (extra: Record<string, unknown> = {}) => ({
    key: "missingok",
    value: "true",
    presence: true,
    description: { ja: "d" },
    ...extra,
  });

  it("shows the product's word for presence, not the stored spelling", () => {
    const host = mountRows([presenceRow({ presence_label: { ja: "許可", en: "permitted" } })]);
    expect(valueCell(host, "missingok")).toBe("許可");
  });

  // A dictionary must never have to invent wording, so the viewer has one.
  it("falls back to a neutral word when the product has none", () => {
    expect(valueCell(mountRows([presenceRow()]), "missingok")).toBe("あり");
    expect(valueCell(mountRows([presenceRow()], "en"), "missingok")).toBe("present");
  });

  // An ordinary row is untouched: its value IS what the file says.
  it("leaves a row that holds a real value alone", () => {
    const host = mountRows([{ key: "rotate", value: "4", description: { ja: "d" } }]);
    expect(valueCell(host, "rotate")).toBe("4");
  });

  // A value that merely looks like the spelling is not presence, and says so.
  it("does not touch a row whose value is `true` but is not presence", () => {
    const host = mountRows([{ key: "debug", value: "true", description: { ja: "d" } }]);
    expect(valueCell(host, "debug")).toBe("true");
  });
});


// "Nothing is set here" and "this environment's file does not have the line"
// are two different facts, and the cell said the first about the second: a
// block a `{% if %}` keeps out of dev read "uses default", about a line dev's
// file does not contain. The preview panel had it right — struck through, with
// the condition as the reason — and the table beside it did not.
describe("viewer: an environment the row is not in", () => {
  const doc = (extra: Record<string, unknown>) => ({
    metadata: { title: "t" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "web",
            instances: ["dev", "prod"],
            categories: [
              {
                name: "proxy.conf",
                params: [
                  {
                    key: 'LocationMatch["^/x/"]',
                    container: { name: "LocationMatch" },
                    instances: [{ name: "prod", value: '"^/x/"' }],
                    description: "a block",
                    ...extra,
                  },
                  // A row that IS merely unset in dev, so the two labels are
                  // told apart by what the row says rather than by position.
                  { key: "Timeout", instances: [{ name: "prod", value: "60" }], description: "t" },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  const mountDoc = (extra: Record<string, unknown>): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: doc(extra) as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  };

  // A block's key cell shows the block's own name, not the full address — see
  // the container row's rendering.
  const cells = (host: HTMLElement, key: string) => {
    const row = [...host.querySelectorAll("tbody tr")].find((r) =>
      (r.querySelector(".rs-col-key")?.textContent ?? "").startsWith(key)
    )!;
    return [...row.querySelectorAll("td.rs-col-value")].map((c) => (c.textContent ?? "").trim());
  };

  it("says the file does not have it, not that it uses a default", () => {
    const host = mountDoc({ absent_where_unlisted: true });
    expect(cells(host, "LocationMatch")).toEqual(["この環境のファイルにはない", '"^/x/"']);
  });

  // Same shape, no such claim on the row: an ordinary partial Pattern B row is
  // unset in the environments it leaves out, and still says so.
  it("still says uses-default for a row that is merely unset there", () => {
    const host = mountDoc({});
    expect(cells(host, "Timeout")).toEqual(["デフォルト値を利用", "60"]);
    expect(cells(host, "LocationMatch")).toEqual(["デフォルト値を利用", '"^/x/"']);
  });
});


// WHERE a value is written, shown or not. On a real sheet 454 rows of 1536
// carried a file name under the key — `main.yml`, `app.yml`, a template — and
// for a reader who is judging the settings rather than maintaining the
// repository, a name that never becomes an action is a column of noise.
//
// A display switch and not redaction: the source map stays in the document,
// because apply and verify resolve every change through it. The tests below
// check both halves of that.
describe("viewer: showing where a value is written", () => {
  const doc = {
    metadata: { title: "t" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "web",
            file_path: "/etc/httpd/conf/httpd.conf",
            source_file: "roles/httpd/templates/httpd.conf.j2",
            categories: [
              {
                name: "httpd.conf",
                params: [
                  {
                    key: "Listen",
                    value: "80",
                    origin: "embedded",
                    source: { file: "roles/httpd/defaults/main.yml", line: 3 },
                    description: "port",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const mountWith = (sources: boolean): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, { payload: doc as never, reviewEnabled: true, showSources: sources, initialLang: "ja", server: false }),
      host
    );
    return host;
  };

  // TWO places now, not three. A row's own key cell used to carry the file its
  // literal sits in; that went when the row's preview link started opening the
  // same file (see `originTag`), so what is left for this flag to hide is the
  // template a sheet was rendered from, and a preview's source line.
  it("shows the template a sheet was rendered from", () => {
    const host = mountWith(true);
    expect(host.textContent).toContain("httpd.conf.j2");
  });

  it("shows it not at all when the document was generated without them", () => {
    const host = mountWith(false);
    expect(host.textContent).not.toContain("httpd.conf.j2");
  });

  // …and the row's own file name is in neither, now that nothing puts it in
  // the key cell — the flag has one fewer thing to govern, not a new exception.
  it("never puts a row's own source file in its key cell", () => {
    for (const sources of [true, false]) {
      expect(mountWith(sources).querySelector("td.rs-col-key")!.textContent).not.toContain("main.yml");
    }
  });

  // The DEPLOYED path is what the sheet is ABOUT, not where the repository
  // keeps its template — it stays either way.
  it("keeps the path the settings land on", () => {
    expect(mountWith(false).textContent).toContain("/etc/httpd/conf/httpd.conf");
  });
});


// A category's heading and the path its settings land on, where those are the
// same string. On a sheet whose components ARE files the project labels the
// category `/etc/systemd/system/keycloak.service`, and the same path arrives
// again as the category's file_path — so the heading printed it twice, one line
// under the other.
//
// The guard for this existed and asked the wrong question: it compared against
// the category's NAME (`keycloak.service`), while the heading shows its LABEL.
describe("viewer: a category headed by the file it deploys", () => {
  const doc = (label: string) => ({
    metadata: { title: "t" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "os",
            categories: [
              {
                name: "keycloak.service",
                label: { ja: label, en: label },
                file_path: "/etc/systemd/system/keycloak.service",
                params: [{ key: "Unit.Description", value: "Keycloak", description: "d" }],
              },
            ],
          },
        ],
      },
    ],
  });

  const mount = (label: string): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: doc(label) as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  };

  const headerText = (host: HTMLElement): string =>
    (host.querySelector(".rs-category-header")?.textContent ?? "").trim();

  it("names the path once when the heading is that path", () => {
    const text = headerText(mount("/etc/systemd/system/keycloak.service"));
    expect(text.split("/etc/systemd/system/keycloak.service")).toHaveLength(2);
  });

  // Still shown where it adds something: a heading that does NOT say where the
  // settings land is exactly the case the line is for.
  it("still names it when the heading says something else", () => {
    const text = headerText(mount("Keycloak のユニット"));
    expect(text).toContain("/etc/systemd/system/keycloak.service");
  });
});






// The outline of a hand-maintained sheet: its own headings and rows, from the
// same text the page renders. A PROSE document's outline is its headings, and a
// sheet handed over as markdown is a document too — which made it take that
// branch and show the sheet's name with nothing under it.
describe("the outline of a hand-maintained sheet", () => {
  const md = [
    "# os",
    "",
    "## SELinux",
    "",
    "| 設定項目 | デフォルト値 | 設定値 |",
    "| --- | --- | --- |",
    "| `state` |  | enforcing |",
    "",
    "## firewalld",
    "",
    "| 設定項目 | デフォルト値 | 設定値 |",
    "| --- | --- | --- |",
    "| `ssh` |  | true |",
    "",
  ].join("\n");
  const payload = {
    metadata: { title: "t", version: "current" },
    versions: [
      {
        version: "current",
        sheets: [{ name: "os", instances: [], categories: [], document: { html: "", markdown: md, mode: "sheet" } }],
      },
    ],
  };

  it("lists the sections under the sheet", async () => {
    localStorage.setItem("rs-outline-open", "1");
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: payload as never, reviewEnabled: false, initialLang: "ja", server: false }), host);
    await waitForEffects();
    const outline = host.querySelector(".rs-navtree-body")?.textContent ?? "";
    expect(outline).toContain("SELinux");
    expect(outline).toContain("firewalld");
  });
});

describe("a paragraph in a hand-maintained sheet", () => {
  const md = ["# os", "", "## SELinux", "", "運用メモ: 本番のみ enforcing。", "", "| 設定項目 | デフォルト値 | 設定値 |", "| --- | --- | --- |", "| `state` |  | enforcing |", ""].join("\n");
  const payload = {
    metadata: { title: "t", version: "current" },
    versions: [
      {
        version: "current",
        sheets: [{ name: "os", instances: [], categories: [], document: { html: "", markdown: md, mode: "sheet" } }],
      },
    ],
  };

  it("is on the page", async () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: payload as never, reviewEnabled: false, initialLang: "ja", server: false }), host);
    await waitForEffects();
    expect(host.textContent).toContain("運用メモ: 本番のみ enforcing。");
    expect(host.textContent).toContain("enforcing");
  });
});

// A sheet handed over as markdown, compared side by side. The comparison is
// built from the TEXT — so editing one component's table redraws it, which is
// the reading the view exists for, and it survives the model going away.
describe("a hand-maintained sheet, compared side by side", () => {
  const md = [
    "# clients",
    "",
    "## client-a",
    "",
    "### Settings",
    "",
    "| 設定項目 | デフォルト値 | 設定値 |",
    "| --- | --- | --- |",
    "| `publicClient` |  | false |",
    "",
    "## client-b",
    "",
    "### Settings",
    "",
    "| 設定項目 | デフォルト値 | 設定値 |",
    "| --- | --- | --- |",
    "| `publicClient` |  | true |",
    "",
  ].join("\n");
  const payload = {
    metadata: { title: "t", version: "current" },
    versions: [
      {
        version: "current",
        sheets: [
          {
            name: "clients",
            instances: [],
            compare_components: "always",
            categories: [],
            document: { html: "", markdown: md, mode: "sheet" },
          },
        ],
      },
    ],
  };

  it("puts one column per component, read from the markdown", async () => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: payload as never, reviewEnabled: false, initialLang: "ja", server: false }), host);
    await waitForEffects();
    const heads = [...host.querySelectorAll(".rs-pivot th")].map((e) => (e.textContent ?? "").trim());
    expect(heads).toEqual(["設定項目", "client-a", "client-b"]);
    const row = [...host.querySelectorAll(".rs-pivot tbody tr")].find((r) => (r.textContent ?? "").includes("publicClient"));
    expect([...(row?.querySelectorAll("td") ?? [])].map((c) => (c.textContent ?? "").trim())).toEqual([
      "publicClient",
      "false",
      "true",
    ]);
  });
});


describe("a button that cannot act", () => {
  it("is styled as disabled, whatever kind of button it is", () => {
    const css = customStyles;
    const rule = css.slice(css.indexOf(".rs-btn-primary:disabled"));
    const block = rule.slice(0, rule.indexOf("}"));
    expect(block).toContain(".rs-btn-danger:disabled");
    expect(block).toContain("cursor: not-allowed");
    // …and it must not light up under the pointer either.
    expect(css).toContain(".rs-btn-danger:hover:not(:disabled)");
  });
});


// A handed-over set, opened the way a recipient opens it.
//
// This is the whole chain the delivery rests on and the one nothing covered:
// the projection writes an address under a row's key, the reader of the folder
// rebases it, the page holds the file under that very path, and a click has to
// land on the line. Every step is an equality between two strings computed in
// different modules, so any of them can be off while every part still looks
// right on its own — a link that is there, reads correctly, and opens nothing.
//
// The page is built by `payloadOfSet`, the same function the drop, the picker
// and a carried set all go through: a test assembling its own idea of what a
// drop produces would pass whatever those three went on to do.
describe("a dropped set, opened at a row's line", () => {
  const MODEL = {
    metadata: { title: "d", project: "p" },
    // In a chapter, and a nested one: a set writes its addresses relative to
    // the sheet, while the page is ONE document for the whole folder — so an
    // address that is not rebased resolves against the page and is off by
    // exactly the sheet's depth. A top-level sheet cannot show that, because
    // there is nothing to climb.
    groups: [{ name: "design", display: "Detailed design", groups: [{ name: "srv", display: "Web tier" }] }],
    sheets: [
      {
        name: "web",
        group: "srv",
        instances: ["staging"],
        categories: [{ name: "httpd.conf", params: [{ key: "Listen", value: "8080", description: "Port" }] }],
      },
    ],
    artifacts: [
      {
        id: "web",
        sheet: "web",
        source_file: "roles/web/templates/httpd.conf.j2",
        deployed_path: "/etc/httpd/conf/httpd.conf",
        instances: ["staging"],
        lines: [
          { text: "# managed", kind: "verbatim" },
          { text: "ServerRoot /etc/httpd", kind: "verbatim" },
          { text: "Listen 8080", kind: "substituted", key: "Listen" },
        ],
      },
    ],
  };

  // Written and read back exactly as the CLI does it: the same projection, the
  // same carried documents, the same address rule.
  function writtenSet(): ReturnType<typeof toMarkdownSet> {
    const carried = carriedDocuments(MODEL.artifacts as never, ["staging"]);
    const index = buildArtifactIndex(MODEL.artifacts as never);
    return toMarkdownSet(MODEL as never, "ja", {
      documents: carried,
      preview: (sheet) => (row, categoryPath) => {
        const hit = index.previewFor(sheet.name, categoryPath.join("/"), row.key);
        const doc = carried[MODEL.artifacts.indexOf(hit as never)];
        return doc === undefined ? undefined : addressOf([doc], row.key);
      },
    });
  }

  function droppedPage(): HTMLElement {
    const { files } = writtenSet();
    const read = readMarkdownSet(files.map((f) => ({ path: `${f.path}`, text: f.text })), "ja");
    expect(read.problems).toEqual([]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    openSheetTab();
    render(
      h(Root, {
        payload: payloadOfSet({ title: "d" } as never, read),
        reviewEnabled: false,
        initialLang: "ja",
        server: false,
        dropped: "…",
      }),
      host
    );
    return host;
  }

  // The address the page carries, checked where it is WRITTEN rather than where
  // it is rendered: the page draws the sheet's own chip from the lifted model
  // (the two readings of a document are one renderer now), so the address is no
  // longer an `<a>` in the cell — but it is still the string the whole chain
  // rests on, and it still has to survive the climb out of the chapter.
  it("writes the address into the set, rebased on it", () => {
    const { files } = writtenSet();
    const page = files.find((f) => f.path.endsWith("web.md"))!;
    expect(page.text).toContain("[プレビュー](artifacts/common/etc/httpd/conf/httpd.conf#L3)");
  });

  it("offers the file under the row's key", () => {
    const chip = droppedPage().querySelector("td.rs-col-key .rs-artifact-chip");
    expect(chip, "no way into the file under the key").not.toBeNull();
    expect(chip!.textContent?.trim()).toBe("プレビュー");
  });

  it("opens the file beside the sheet, at that line", async () => {
    const host = droppedPage();
    expect(host.querySelector(".rs-artifact-panel")).toBeNull();
    const a = host.querySelector("td.rs-col-key .rs-artifact-chip") as HTMLElement;
    a.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));

    const panel = host.querySelector(".rs-artifact-panel");
    expect(panel, "the link did not open the panel").not.toBeNull();
    // Named by where it sits in the folder, since that is all a read-back set
    // knows: the deployed path lost its leading slash on the way to disk, and
    // the page has no model to ask for the original.
    expect(panel!.querySelector(".rs-artifact-path")!.textContent).toBe("etc/httpd/conf/httpd.conf");
    // The line the row is written on, and not another one: the highlight is
    // the whole point of carrying a line number.
    const here = panel!.querySelector(".rs-artifact-line.rs-here");
    expect(here, "no line is marked").not.toBeNull();
    expect(here!.textContent).toContain("Listen 8080");
  });
});


// A page of a dropped set that is PROSE, not rows.
//
// Two halves had to meet for this to work at all. The set has to carry the
// document (it used to write the title and stop), and the page has to render
// it: nothing built a dropped set, so there is no finished html to show, only
// the markdown a recipient edited. Before this the body was simply blank —
// which is what "the test items are missing" looked like from the reader's
// side, and is indistinguishable from a document that is genuinely empty.
describe("a dropped set's prose page", () => {
  const PROSE = ["# Acceptance record", "", "## Items", "", "| No. | Subject | Result |", "| --- | --- | --- |", "| 1 | Listen | pass |", ""].join("\n");

  it("renders the markdown it was handed, since nothing built it html", () => {
    setMarkdownRenderer((source, images, opts) =>
      renderMarkdown(source, () => null, opts)
    );
    const read = readMarkdownSet([{ path: "Records/Acceptance.md", text: PROSE }], "ja");
    // Read as PROSE — its tables are a record, not rows (see md-read.ts).
    expect(read.sheets[0]!.document.mode).toBeUndefined();

    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, { payload: payloadOfSet({ title: "d" } as never, read), reviewEnabled: false, initialLang: "ja", server: false, dropped: "…" }),
      host
    );

    const body = host.querySelector(".rs-doc");
    expect(body, "the page rendered no document body").not.toBeNull();
    expect(body!.querySelector("h2")!.textContent).toBe("Items");
    expect(body!.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(body!.textContent).toContain("Listen");
    // The document's own h1 is the sheet's name and is not printed twice.
    expect(body!.querySelector("h1")).toBeNull();
  });

  // …and its headings are its OUTLINE. The model bakes those in at generate
  // time; a dropped set has only the text, and the render that draws it is
  // where they come from — so the tree entry is not a heading with nothing
  // under it. The entry has to point at an id the page really has, which is
  // what makes one render rather than two the load-bearing part.
  it("puts its headings in the chapter tree, pointing at the page's own ids", () => {
    setMarkdownRenderer((source, images, opts) => renderMarkdown(source, () => null, opts));
    const read = readMarkdownSet([{ path: "Records/Acceptance.md", text: PROSE }], "ja");
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, { payload: payloadOfSet({ title: "d" } as never, read), reviewEnabled: false, initialLang: "ja", server: false, dropped: "…" }),
      host
    );
    expect(
      [...host.querySelectorAll(".rs-navtree-item")].some((e) => (e.textContent ?? "").trim() === "Items"),
      "the page's heading is not in the tree"
    ).toBe(true);
    // …and the tree's entry resolves. The id it carries comes from the render
    // that produced the outline; the id on the page comes from the render that
    // drew it — one render, so they are the same string, and the check is that
    // the page really has the id that render decided.
    const id = renderMarkdown(read.sheets[0]!.document.markdown, () => null, {
      idPrefix: docIdPrefix(read.sheets[0]!.name),
    }).headings[0]!.id;
    expect(host.querySelector(`[id="${id}"]`), `the outline points at ${id}, which the page does not have`).not.toBeNull();
  });

  // EVERY level, not the two a default would take. A set carries the text and
  // not the depth its author declared, and the records this exists for put each
  // item at h4 — a tree stopping at h2 leaves the page it matters most on with
  // four entries out of thirty-five.
  it("reaches a heading as deep as the page goes", () => {
    setMarkdownRenderer((source, images, opts) => renderMarkdown(source, () => null, opts));
    const deep = ["# Record", "", "## Env", "", "### Host", "", "#### Item 12", "", "text", ""].join("\n");
    const read = readMarkdownSet([{ path: "Records/Deep.md", text: deep }], "ja");
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, { payload: payloadOfSet({ title: "d" } as never, read), reviewEnabled: false, initialLang: "ja", server: false, dropped: "…" }),
      host
    );
    const labels = [...host.querySelectorAll(".rs-navtree-item")].map((e) => (e.textContent ?? "").trim());
    expect(labels).toContain("Item 12");
  });
});

// One control of the product's screen whose value is a TUPLE over several rows
// (types.ts's `composite`). Everything here is about what the head row READS —
// the three rows below it are ordinary rows and are covered like any other.
describe("a control several rows spell", () => {
  const MODES = [
    { label: { ja: "無効", en: "Off" }, values: { detect: "false", permanent: "false", tries: "0" } },
    { label: { ja: "一時的に停止", en: "Pause" }, values: { detect: "true", permanent: "false", tries: "0" } },
    { label: { ja: "恒久的に停止", en: "Stop" }, values: { detect: "true", permanent: "true", tries: "0" } },
  ];
  const CONTROL = {
    control: { ja: "検知モード", en: "Detection mode" },
    description: { ja: "検知したときに何が起きるかを指定します。", en: "What happens when one is detected." },
    of: ["detect", "permanent", "tries"],
    modes: MODES,
  };
  // Two of the three are UNSET, which is the ordinary shape: a product ships
  // them defaulted and the config states only the one it changes.
  const trio = (vals: Record<string, string>, composite = CONTROL) => [
    { key: "detect", value: vals.detect, default: "false", origin: "embedded" as const, composite, description: "d" },
    { key: "permanent", default: "false", origin: "default" as const, composite, description: "p" },
    { key: "tries", default: "0", origin: "default" as const, composite, description: "t" },
  ];

  const mountRows = (categories: { name: string; params: unknown[] }[]): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const payload = { metadata: { title: "t", version: "1" }, versions: [{ version: "current", sheets: [{ name: "s", categories }] }] };
    render(h(Root, { payload: payload as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  };
  const heads = (host: HTMLElement) => [...host.querySelectorAll("tr.rs-row-composite")];
  const cell = (row: Element, sel: string) => (row.querySelector(sel)?.textContent ?? "").trim();

  it("shows the whole tuple, though two thirds of it is unset", () => {
    // `permanent` and `tries` sit at their defaults, which the unset filter
    // hides — leaving the control standing over one row that does not explain
    // it, and a tuple missing two members that matches no choice at all.
    const host = mountRows([{ name: "c", params: trio({ detect: "true" }) }]);
    const keys = [...host.querySelectorAll("tr.rs-param-row .rs-col-key")].map((c) => (c.textContent ?? "").trim());
    for (const k of ["detect", "permanent", "tries"]) expect(keys.join(" ")).toContain(k);
    expect(cell(heads(host)[0]!, ".rs-col-value")).toBe("一時的に停止");
  });

  it("says what the product's screen says about the control, not about one field", () => {
    const head = heads(mountRows([{ name: "c", params: trio({ detect: "true" }) }]))[0]!;
    expect(head.querySelector(".rs-composite-control")!.textContent!.trim()).toBe("検知モード");
    expect(cell(head, ".rs-col-description")).toBe("検知したときに何が起きるかを指定します。");
  });

  it("computes the control's own default from the rows' defaults", () => {
    // Nothing states it: false/false/0 IS "off", and computing it is how the
    // two can never disagree.
    expect(cell(heads(mountRows([{ name: "c", params: trio({ detect: "true" }) }]))[0]!, ".rs-col-default")).toBe("無効");
  });

  it("never resolves a combination the screen cannot produce to the nearest one", () => {
    const params = trio({ detect: "true" });
    params[2] = { ...params[2]!, value: "5", origin: "embedded" as const };
    const head = heads(mountRows([{ name: "c", params }]))[0]!;
    expect(head.querySelector(".rs-composite-mode-unmatched")).not.toBeNull();
    expect(cell(head, ".rs-col-value")).not.toContain("停止");
  });

  it("keeps two components' controls apart", () => {
    // One sheet holds the same control once per component (two realms both have
    // a brute force mode). Read as one tuple they mix into a combination
    // neither deployment has, and BOTH heads then read "no matching choice".
    const host = mountRows([
      { name: "alpha", params: trio({ detect: "true" }) },
      { name: "beta", params: trio({ detect: "true" }).map((p) => (p.key === "permanent" ? { ...p, value: "true", origin: "embedded" as const } : p)) },
    ]);
    expect(heads(host)).toHaveLength(2);
    expect(cell(heads(host)[0]!, ".rs-col-value")).toBe("一時的に停止");
    expect(cell(heads(host)[1]!, ".rs-col-value")).toBe("恒久的に停止");
  });
});

// How the sheet says that a control and the rows under it are one thing.
describe("a control and the rows it writes", () => {
  const CONTROL = {
    control: "検知モード",
    of: ["detect", "permanent"],
    modes: [
      { label: "無効", values: { detect: "false", permanent: "false" } },
      { label: "一時的に停止", values: { detect: "true", permanent: "false" } },
    ],
  };
  const pair = (detect: string) => [
    { key: "detect", value: detect, default: "false", origin: "embedded" as const, composite: CONTROL, description: "d" },
    { key: "permanent", default: "false", origin: "default" as const, composite: CONTROL, description: "p" },
  ];
  const mount = (categories: { name: string; params: unknown[] }[]): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const payload = { metadata: { title: "t", version: "1" }, versions: [{ version: "current", sheets: [{ name: "s", categories }] }] };
    render(h(Root, { payload: payload as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  };

  it("names the rows it writes, rather than describing that it has some", () => {
    // An earlier version said "one control of the product's screen, spelled by
    // the 3 rows below" — true of every control on every sheet, and furniture
    // after one reading. The keys are the one thing indentation cannot say.
    const host = mount([{ name: "c", params: pair("true") }]);
    const head = host.querySelector("tr.rs-row-composite")!;
    expect(head.querySelector(".rs-composite-writes")!.textContent!.trim()).toBe("detect / permanent を設定");
  });

  it("says the control's help once, on the control, not on each row under it", () => {
    // The product has no help for `detect` — it has help for the thing an
    // operator sets. Repeated down the column it is the same paragraph twice
    // with nothing to tell the rows apart.
    const HELP = "検出したときに何が起きるかを指定します。";
    const c = { ...CONTROL, description: HELP };
    const host = mount([
      {
        name: "c",
        params: [
          { key: "detect", value: "true", origin: "embedded", composite: c, description: HELP },
          // …and a field the product describes in its own right keeps it.
          { key: "permanent", default: "false", origin: "default", composite: c, description: "ロックを永久にするか。" },
        ],
      },
    ]);
    const descs = [...host.querySelectorAll("tr.rs-row-composed .rs-col-description")].map((d) => d.textContent!.trim());
    expect(descs).toEqual(["", "ロックを永久にするか。"]);
    expect(host.querySelector("tr.rs-row-composite .rs-col-description")!.textContent!.trim()).toBe(HELP);
  });

  it("says the control's name once, not on each row under it", () => {
    // The product names the thing an operator SETS, so the extraction gives all
    // three fields that one name. Printed on each of them it is the same word
    // three times, directly under the line that already says it, with the keys
    // — the only thing telling the rows apart — pushed beneath.
    const host = mount([
      {
        name: "c",
        params: ["detect", "permanent", "tries"].map((key) => ({
          key,
          value: key === "detect" ? "true" : key === "permanent" ? "false" : "0",
          origin: "embedded",
          composite: CONTROL,
          description: "d",
          label: "検知モード",
        })),
      },
    ]);
    const keys = [...host.querySelectorAll("tr.rs-row-composed .rs-col-key")].map((c) => c.textContent!.trim());
    expect(keys).toEqual(["detect", "permanent", "tries"]);
    expect(host.querySelector("tr.rs-row-composite .rs-composite-control")!.textContent!.trim()).toBe("検知モード");
  });

  it("brings the control's fields together, though the sheet files them apart", () => {
    // A real realm puts `failureFactor`, `bruteForceStrategy` and four others
    // between the three that spell the mode — the dictionary's order, not the
    // screen's. Scattered, the control heads a block that is not one.
    const host = mount([
      {
        name: "c",
        params: [
          { key: "detect", value: "true", origin: "embedded", composite: CONTROL, description: "d" },
          { key: "other", value: "9", origin: "embedded", description: "o" },
          { key: "permanent", value: "false", origin: "embedded", composite: CONTROL, description: "p" },
          { key: "tries", value: "0", origin: "embedded", composite: CONTROL, description: "t" },
        ],
      },
    ]);
    const rows = [...host.querySelectorAll("tr.rs-param-row")];
    const at = (i: number) => (rows[i]!.querySelector(".rs-col-key")?.textContent ?? "").trim();
    expect(rows[0]!.classList.contains("rs-row-composite")).toBe(true);
    expect([at(1), at(2), at(3)].join(" ")).toContain("detect");
    expect([at(1), at(2), at(3)].join(" ")).toContain("tries");
    // …and the row that belongs to no control keeps its place, after them.
    expect(at(4)).toContain("other");
    expect(host.querySelector("tr.rs-row-composite .rs-col-value")!.textContent!.trim()).toBe("一時的に停止");
  });

  it("claims nothing where the sheet carries only part of the tuple", () => {
    // A sheet scoped to part of a product has some of a control's fields and
    // not the rest. A tuple missing a member matches no choice at all, so the
    // control would announce "no matching choice" over a screen that is
    // perfectly ordinary — measured on a real upgrade sheet carrying one of
    // three. The rows render as themselves and the control says nothing.
    const host = mount([
      { name: "c", params: [{ key: "detect", value: "true", origin: "embedded", composite: CONTROL, description: "d" }] },
    ]);
    expect(host.querySelectorAll("tr.rs-row-composite")).toHaveLength(0);
    expect([...host.querySelectorAll("tr.rs-param-row .rs-col-key")].map((c) => c.textContent!.trim()).join(" ")).toContain("detect");
  });

  it("marks only the rows the control is spelled by", () => {
    // A sibling combinator cannot say where a group ends, so the rest of the
    // category was indented under a control it has nothing to do with.
    const host = mount([{ name: "c", params: [...pair("true"), { key: "after", value: "9", origin: "embedded", description: "a" }] }]);
    const composed = [...host.querySelectorAll("tr.rs-row-composed .rs-col-key")].map((c) => c.textContent!.trim()).join(" ");
    expect(composed).toContain("detect");
    expect(composed).toContain("permanent");
    expect(composed).not.toContain("after");
  });
});

// Where THIS PROJECT keeps a value, as opposed to what the value is.
describe("--no-sources and a row's backing variable", () => {
  const SHEET = {
    metadata: { title: "t", version: "1" },
    versions: [
      {
        version: "current",
        // Declared on the VERSION, which is where a document's columns live.
        columns: [{ field: "extra.var", header: "Ansible 変数", place: "under_key" }],
        sheets: [
          {
            name: "web",
            categories: [
              { name: "c", params: [{ key: "Listen", value: "80", description: "d", extra: { var: "httpd_listen" } }] },
            ],
          },
        ],
      },
    ],
  };
  const mount = (sources: boolean): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: SHEET as never, reviewEnabled: true, showSources: sources, initialLang: "ja", server: false }), host);
    return host;
  };

  it("shows it by default", () => {
    expect(mount(true).querySelector("tbody .rs-col-key")!.textContent).toContain("httpd_listen");
  });

  it("hides it under --no-sources, with the other places the same fact appears", () => {
    // `httpd_listen` is a name the recipient of a delivered document has never
    // seen and cannot act on; `Listen` is the product's own, and the one they
    // are checking against a screen.
    const host = mount(false);
    expect(host.querySelector("tbody .rs-col-key")!.textContent).not.toContain("httpd_listen");
    expect(host.querySelector("tbody .rs-col-key")!.textContent).toContain("Listen");
  });
});

// A preview the sheet is ABOUT, whose file has no deployed counterpart.
describe("a source preview's title in a delivery", () => {
  const PAYLOAD = (nature: "source" | "artifact") => ({
    metadata: { title: "t", version: "1" },
    versions: [
      {
        version: "current",
        sheets: [{ name: "aws", categories: [{ name: "alb", params: [{ key: "idle_timeout", value: "60", description: "d" }] }] }],
        artifacts: [
          {
            id: "aws::alb",
            sheet: "aws",
            component: "alb",
            nature,
            source_file: "platforms/aws-ec2/terraform/modules/alb/main.tf",
            ...(nature === "artifact" ? { deployed_path: "/etc/thing.conf" } : {}),
            lines: [{ text: 'idle_timeout = 60', kind: "verbatim" as const, key: "idle_timeout" }],
          },
        ],
      },
    ],
  });
  const openPanel = async (nature: "source" | "artifact", sources: boolean): Promise<string> => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(h(Root, { payload: PAYLOAD(nature) as never, reviewEnabled: true, showSources: sources, initialLang: "ja", server: false }), host);
    (host.querySelector(".rs-artifact-chip") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    return (host.querySelector(".rs-artifact-path")?.textContent ?? "").trim();
  };

  it("names the file and not its place in this repository", async () => {
    // A `.tf` is authored and never deployed, so the title has nowhere to fall
    // back to but a path inside this repository — the one thing a delivery does
    // not carry. The module is already the component the reader opened it from.
    expect(await openPanel("source", false)).toBe("main.tf");
  });

  it("keeps the whole path for our own build", async () => {
    expect(await openPanel("source", true)).toBe("platforms/aws-ec2/terraform/modules/alb/main.tf");
  });

  it("leaves a deployed path alone either way", async () => {
    // That is where the file LANDS on the recipient's host — what the sheet is
    // about, not where this project keeps it.
    expect(await openPanel("artifact", false)).toBe("/etc/thing.conf");
    expect(await openPanel("artifact", true)).toBe("/etc/thing.conf");
  });
});

// A description is PROSE the product wrote, and what a product writes is
// markdown: `Indicates if this EIP is for use in VPC (`vpc`)`.
describe("prose in a cell", () => {
  const mount = (over: Record<string, unknown>): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const payload = {
      metadata: { title: "t", version: "1" },
      versions: [{ version: "current", sheets: [{ name: "s", categories: [{ name: "c", params: [{ key: "domain", value: "vpc", ...over }] }] }] }],
    };
    render(h(Root, { payload: payload as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  };

  it("renders a code span instead of printing its backticks", () => {
    const host = mount({ description: "Indicates if this EIP is for use in VPC (`vpc`)." });
    const cell = host.querySelector("tbody .rs-col-description")!;
    expect(cell.querySelector("code")?.textContent).toBe("vpc");
    expect(cell.textContent).not.toContain("`");
  });

  it("does the same for a remark", () => {
    const host = mount({ description: "d", remarks: "Set to `on` here." });
    expect(host.querySelector("tbody .rs-col-remarks")!.querySelector("code")?.textContent).toBe("on");
  });

  it("leaves a VALUE alone — there a backtick is a character of a file", () => {
    const host = mount({ value: "a`b", description: "d" });
    const cell = host.querySelector("tbody .rs-col-value")!;
    expect(cell.textContent).toContain("a`b");
    expect(cell.querySelector("code")?.textContent).toBe("a`b");
  });
});

// The file, opened from the CONTROL rather than from one of its rows.
describe("a control's way into the file", () => {
  const CONTROL = {
    control: "検知モード",
    of: ["detect", "permanent"],
    modes: [{ label: "入", values: { detect: "true", permanent: "false" } }],
  };
  const mount = (lines: { text: string; key?: string }[]): HTMLElement => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const payload = {
      metadata: { title: "t", version: "1" },
      versions: [
        {
          version: "current",
          sheets: [
            {
              name: "s",
              categories: [
                {
                  name: "c",
                  params: [
                    { key: "detect", value: "true", origin: "embedded", composite: CONTROL, description: "d" },
                    { key: "permanent", value: "false", origin: "embedded", composite: CONTROL, description: "p" },
                  ],
                },
              ],
            },
          ],
          artifacts: [
            {
              id: "s",
              sheet: "s",
              deployed_path: "a.yml",
              source_file: "a.yml",
              lines: lines.map((l) => ({ text: l.text, kind: "verbatim" as const, ...(l.key === undefined ? {} : { key: l.key }) })),
            },
          ],
        },
      ],
    };
    render(h(Root, { payload: payload as never, reviewEnabled: true, initialLang: "ja", server: false }), host);
    return host;
  };

  it("marks every line the control writes, not just one", async () => {
    const host = mount([
      { text: "detect: true", key: "detect" },
      { text: "unrelated: 1" },
      { text: "permanent: false", key: "permanent" },
    ]);
    const chip = host.querySelector("tr.rs-row-composite .rs-artifact-chip") as HTMLElement;
    expect(chip, "the control offers no way into the file").not.toBeNull();
    chip.click();
    await new Promise((r) => setTimeout(r, 0));
    const marked = [...host.querySelectorAll(".rs-artifact-body .rs-here")].map((l) => l.textContent ?? "");
    expect(marked.length).toBe(2);
    expect(marked.join(" ")).toContain("detect: true");
    expect(marked.join(" ")).toContain("permanent: false");
  });

  it("offers nothing where no row of the tuple has a line", async () => {
    // A control whose fields are all unset has nothing to open, and an
    // affordance that opens nothing is worse than none.
    const host = mount([{ text: "unrelated: 1" }]);
    expect(host.querySelector("tr.rs-row-composite .rs-artifact-chip")).toBeNull();
  });
});

// Evidence is bytes a HOST was found holding, and where it held them is the
// content — never this repository's plumbing.
describe("an observed document's path in a delivery", () => {
  const REF = "rs-evidence:observed%20local%20kc-node2%20%2Fopt%2Fkeycloak%2Fconf%2Fkeycloak.conf%23L1";
  const open = async (sources: boolean): Promise<string> => {
    openSheetTab();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const payload = {
      metadata: { title: "t", version: "1" },
      versions: [
        {
          version: "current",
          // A RECORD, which is how evidence is ever reached: a verdict names an
          // address and the link beside it opens the bytes.
          sheets: [{ name: "rec", categories: [], document: { html: `<p><a href="${REF}">evidence</a></p>` } }],
          artifacts: [
            {
              id: "observed local kc-node2 /opt/keycloak/conf/keycloak.conf",
              sheet: "rec",
              nature: "observed",
              observed: { host: "kc-node2", at: "2026-09-14T08:42:55Z" },
              source_file: "/opt/keycloak/conf/keycloak.conf",
              lines: [{ text: "db=postgres", kind: "verbatim" as const }],
            },
          ],
        },
      ],
    };
    render(h(Root, { payload: payload as never, reviewEnabled: true, showSources: sources, initialLang: "ja", server: false }), host);
    (host.querySelector(`a[href="${REF}"]`) as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    return (host.querySelector(".rs-artifact-path")?.textContent ?? "").trim();
  };

  it("keeps the whole path under --no-sources", async () => {
    // Shortening it to `keycloak.conf` threw away the half a reader checks the
    // verdict against: which file on which host held these bytes.
    expect(await open(false)).toBe("/opt/keycloak/conf/keycloak.conf");
  });

  it("says the same thing in our own build", async () => {
    expect(await open(true)).toBe("/opt/keycloak/conf/keycloak.conf");
  });

  it("names the host and the moment beside it", async () => {
    await open(false);
    const meta = (document.querySelector(".rs-artifact-meta")?.textContent ?? "").trim();
    expect(meta).toContain("kc-node2");
  });
});


// A dropped set's record, opened at the bytes a verdict was read from.
//
// The whole chain is equalities between strings computed in different modules:
// the projection rewrites the record's link to the document's path, `rebase`
// climbs it out of its chapter, `documentPreviews` names the same file by that
// very path, and the delegated handler compares the two. Any link of it can be
// off while every part looks right on its own — a link that is there, reads
// correctly and opens nothing, which is what the whole set did before this.
describe("a dropped set's record, opened at its evidence", () => {
  const ID = "observed local web01 /etc/hosts";
  // In a NESTED chapter on purpose: a top-level page leaves `rebase` nothing to
  // climb, and the address would match without ever exercising it.
  const MODEL = {
    metadata: { title: "d", project: "p" },
    groups: [{ name: "v", display: "Verification", groups: [{ name: "u", display: "Unit tests" }] }],
    sheets: [
      {
        name: "rec",
        group: "u",
        instances: [],
        categories: [],
        document: { markdown: `# Record\n\n| No. | Evidence |\n| --- | --- |\n| 1 | [web01 /etc/hosts:2](rs-evidence:${encodeURIComponent(`${ID}#L2`)}) |\n` },
      },
    ],
    artifacts: [
      {
        id: ID,
        sheet: "rec",
        source_file: "/etc/hosts",
        nature: "observed",
        observed: { host: "web01", at: "2026-09-08T00:11:22Z" },
        instances: ["local"],
        lines: [
          { text: "127.0.0.1 localhost", kind: "verbatim" },
          { text: "10.0.0.9 web01", kind: "verbatim" },
        ],
      },
    ],
  };

  function droppedRecord(): HTMLElement {
    setMarkdownRenderer((source, images, opts) => renderMarkdown(source, () => null, opts));
    const { files } = toMarkdownSet(MODEL as never, "ja", { documents: carriedDocuments(MODEL.artifacts as never, ["local"]) });
    const read = readMarkdownSet(files.map((f) => ({ path: f.path, text: f.text })), "ja");
    expect(read.problems).toEqual([]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    openSheetTab();
    render(h(Root, { payload: payloadOfSet({ title: "d" } as never, read), reviewEnabled: false, initialLang: "ja", server: false, dropped: "…" }), host);
    return host;
  }

  // The verdict's own cell, which is the link a reader follows.
  const verdictLink = (host: HTMLElement): HTMLAnchorElement =>
    [...host.querySelectorAll(".rs-doc td a")].find((x) => (x.textContent ?? "").endsWith(":2")) as HTMLAnchorElement;

  it("carries an address a plain markdown reader could follow", () => {
    const host = droppedRecord();
    const a = verdictLink(host);
    expect(a).not.toBeUndefined();
    expect(decodeURI(a.getAttribute("href")!)).toBe("Verification/Unit tests/evidence/local/web01/etc/hosts#L2");
    // …and it is the ONLY link on the page: a set that opened its pages with a
    // list of the files it carries showed that list in the folder reading and
    // nowhere else, which is one document with two appearances.
    expect([...host.querySelectorAll(".rs-doc a")].length).toBe(1);
  });

  it("opens the collected bytes, at the line the verdict names", async () => {
    const host = droppedRecord();
    // Nothing is open yet — without this the click could be credited with a
    // panel something else put there.
    expect(host.querySelector(".rs-artifact-panel")).toBeNull();
    const a = verdictLink(host);
    a.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    const panel = host.querySelector(".rs-artifact-panel");
    expect(panel, "the link did not open the panel").not.toBeNull();
    const here = panel!.querySelector(".rs-artifact-line.rs-here");
    expect(here, "no line is marked").not.toBeNull();
    expect(here!.textContent).toContain("10.0.0.9 web01");
  });
});


// The order a reader meets the sheets in is the one the document DECLARES.
//
// Everything they navigate by has always used the chapter tree; the tab index
// followed the array the build emitted, which is the spec's order and means
// nothing to a reader. On one real document the two part company at the seventh
// sheet — and a set is written in chapter order by construction, so the same
// number opened a different sheet depending on which half of a delivery was in
// the reader's hands.
describe("the order the sheets are in", () => {
  it("follows the chapter tree, not the order the build emitted", () => {
    const payload = {
      metadata: { title: "t" },
      versions: [
        {
          version: "current",
          groups: [{ name: "a", display: "First" }, { name: "b", display: "Second" }],
          sheets: [
            // The build's order: the second chapter's sheet first.
            { name: "later", group: "b", instances: [], categories: [{ name: "c", params: [{ key: "k", value: "1" }] }] },
            { name: "earlier", group: "a", instances: [], categories: [{ name: "c", params: [{ key: "k", value: "1" }] }] },
            // …and one whose chapter the tree does not have, which comes last
            // rather than being dropped.
            { name: "loose", group: "nowhere", instances: [], categories: [{ name: "c", params: [{ key: "k", value: "1" }] }] },
          ],
        },
      ],
    };
    const titleAt = (tab: number): string => {
      document.body.innerHTML = "";
      location.hash = `#${tab}`;
      const host = document.createElement("div");
      document.body.appendChild(host);
      render(h(Root, { payload: payload as never, reviewEnabled: false, initialLang: "ja", server: false }), host);
      return host.querySelector("h2")?.textContent?.trim() ?? "";
    };
    expect([titleAt(1), titleAt(2), titleAt(3)]).toEqual(["earlier", "later", "loose"]);
  });
});


// The first page a reader opens.
//
// It used to lead with two cards: the project, which the title above it already
// names, and the version, which is the model's own bookkeeping — `current` on
// every document that is not a comparison. What a reader comes to this page for
// is the list of sheets.
describe("the overview page", () => {
  const draw = (metadata: Record<string, unknown>): HTMLElement => {
    document.body.innerHTML = "";
    location.hash = "#overview";
    const host = document.createElement("div");
    document.body.appendChild(host);
    render(
      h(Root, {
        payload: {
          metadata,
          versions: [
            {
              version: "current",
              // WHEN is the version's, not the metadata's: a document carries one
              // per version and the overview shows the one on screen.
              ...(metadata.generated_at === undefined ? {} : { date: metadata.generated_at }),
              sheets: [{ name: "web", instances: [], categories: [{ name: "c", params: [{ key: "k", value: "1" }] }] }],
            },
          ],
        } as never,
        reviewEnabled: false,
        initialLang: "ja",
        server: false,
      }),
      host
    );
    return host;
  };

  // A CHAPTER TREE DEEPER THAN ONE LEVEL.
  //
  // `sheetsInOrder`'s contract is that a sheet belongs to the NEAREST group it
  // names and never to an ancestor, so a chapter's own sheets are only ever the
  // ones matching its own name. The list here matched every group against
  // `data.groups` — the top level alone — so a project whose sheets sit under a
  // child chapter got the ancestor's heading over an empty list and no way to
  // reach the sheets at all. Measured on a real delivery: 8 of 19 sheets
  // listed, and the chapter holding the other 11 shown empty.
  const chapters = (): HTMLElement => {
    document.body.innerHTML = "";
    location.hash = "#overview";
    const host = document.createElement("div");
    document.body.appendChild(host);
    const sheet = (name: string, group: string) => ({
      name,
      group,
      instances: [],
      categories: [{ name: "c", params: [{ key: "k", value: "1" }] }],
    });
    render(
      h(Root, {
        payload: {
          metadata: { title: "t" },
          versions: [
            {
              version: "current",
              groups: [{ name: "top", groups: [{ name: "mid", groups: [{ name: "deep" }] }] }, { name: "flat" }],
              sheets: [sheet("deep-sheet", "deep"), sheet("mid-sheet", "mid"), sheet("flat-sheet", "flat")],
            },
          ],
        } as never,
        reviewEnabled: false,
        initialLang: "ja",
        server: false,
      }),
      host
    );
    return host;
  };

  it("lists every sheet, at whatever depth of the tree it is filed", () => {
    const named = [...chapters().querySelectorAll(".rs-overview-sheet-link")].map((e) => e.textContent?.trim());
    expect(named.sort()).toEqual(["deep-sheet", "flat-sheet", "mid-sheet"]);
  });

  it("shows every chapter of the tree, not only its top level", () => {
    const seen = [...chapters().querySelectorAll(".rs-overview-groupname")].map((e) => e.textContent?.trim());
    expect(seen).toEqual(["top", "mid", "deep", "flat"]);
  });

  // …and a child chapter is INSIDE its parent, so the page can say which
  // chapter a sheet is under rather than listing four that look alike.
  it("puts a child chapter inside its parent", () => {
    const host = chapters();
    const nested = host.querySelectorAll(".rs-overview-group .rs-overview-group");
    expect(nested.length).toBe(2);
  });

  it("does not repeat the project or state a version nobody set", () => {
    const host = draw({ title: "t", project: "iam-platform-poc", version: "current" });
    const text = host.querySelector(".rs-overview")?.textContent ?? "";
    expect(text).not.toContain("iam-platform-poc");
    expect(text).not.toContain("バージョン");
    // …and what the page IS for is still there.
    expect(host.querySelector(".rs-overview-sheets")?.textContent).toContain("web");
  });

  it("keeps what a project chose to put there, and when it was generated", () => {
    const host = draw({ title: "t", generated_at: "2026-09-16T00:00:00Z", extra: { 担当: "SRE" } });
    const text = host.querySelector(".rs-overview-grid")?.textContent ?? "";
    expect(text).toContain("担当");
    expect(text).toContain("SRE");
    expect(text).toContain("2026");
  });

  // An empty box is worse than no box: the grid is the only thing between the
  // title and the sheet list, and a document with neither of those two has
  // nothing to put in it.
  it("draws no box when there is nothing for it", () => {
    expect(draw({ title: "t", project: "p", version: "current" }).querySelector(".rs-overview-grid")).toBeNull();
  });
});
