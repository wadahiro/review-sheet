import { describe, it, expect } from "bun:test";
import {
  runInteractiveSession,
  applyInteractiveAnswers,
  deriveBulkPattern,
  matchesBulkPattern,
  filterCategories,
  type InteractiveQuestion,
} from "../src/interactive.js";
import type { ScaffoldEntry } from "../src/enrich.js";

// A canned `ask`: returns the next answer off a queue, and records every
// question it was actually asked — the same shape apply.ts/verify.ts's
// injected readFile is tested with, adapted to a Q&A loop instead of a
// lookup. No TTY, no real prompting, fully synchronous decisions wrapped in
// a resolved Promise.
function cannedAsk(answers: string[]): { ask: (q: InteractiveQuestion) => Promise<string>; asked: InteractiveQuestion[] } {
  const asked: InteractiveQuestion[] = [];
  let i = 0;
  return {
    asked,
    ask: async (q: InteractiveQuestion) => {
      asked.push(q);
      if (i >= answers.length) throw new Error(`cannedAsk: ran out of answers (asked ${asked.length} questions)`);
      return answers[i++];
    },
  };
}

function entry(overrides: Partial<ScaffoldEntry> & Pick<ScaffoldEntry, "sheet" | "key">): ScaffoldEntry {
  return { needsCategory: false, needsDescription: false, ...overrides };
}

describe("runInteractiveSession — what it asks", () => {
  it("asks category then description (en, ja) for a needsCategory+needsDescription entry", async () => {
    const entries = [entry({ sheet: "httpd", key: "httpd_health_check_path", needsCategory: true, needsDescription: true })];
    const { ask, asked } = cannedAsk(["2", "Health check path", "ヘルスチェックパス"]);
    const outcome = await runInteractiveSession(entries, { httpd: ["Reverse proxy", "General"] }, ask);

    expect(asked).toEqual([
      { kind: "category", sheet: "httpd", key: "httpd_health_check_path", choices: ["Reverse proxy", "General"], binding: undefined, invalid: undefined },
      { kind: "descriptionEn", sheet: "httpd", key: "httpd_health_check_path", allowSkip: false },
      { kind: "descriptionJa", sheet: "httpd", key: "httpd_health_check_path" },
    ]);
    expect(outcome.resolved).toEqual([
      { sheet: "httpd", key: "httpd_health_check_path", category: "General", descriptionEn: "Health check path", descriptionJa: "ヘルスチェックパス" },
    ]);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.newCategoriesBySheet).toEqual({});
  });

  it("asks only description for a needsDescription-only entry (no category question)", async () => {
    const entries = [entry({ sheet: "app", key: "some_key", needsDescription: true })];
    const { ask, asked } = cannedAsk(["English text", "日本語のテキスト"]);
    const outcome = await runInteractiveSession(entries, {}, ask);

    expect(asked).toEqual([
      { kind: "descriptionEn", sheet: "app", key: "some_key", allowSkip: true },
      { kind: "descriptionJa", sheet: "app", key: "some_key" },
    ]);
    expect(outcome.resolved).toEqual([{ sheet: "app", key: "some_key", descriptionEn: "English text", descriptionJa: "日本語のテキスト" }]);
  });

  it("re-asks the category question on an invalid answer, flagging what was invalid", async () => {
    const entries = [entry({ sheet: "httpd", key: "k", needsCategory: true })];
    const { ask, asked } = cannedAsk(["banana", "1"]);
    const outcome = await runInteractiveSession(entries, { httpd: ["A", "B"] }, ask);

    expect(asked).toEqual([
      { kind: "category", sheet: "httpd", key: "k", choices: ["A", "B"], binding: undefined, invalid: undefined },
      { kind: "category", sheet: "httpd", key: "k", choices: ["A", "B"], binding: undefined, invalid: "banana" },
    ]);
    expect(outcome.resolved).toEqual([{ sheet: "httpd", key: "k", category: "A" }]);
  });
});

describe("runInteractiveSession — new category creation", () => {
  it("appends a newly created category to the sheet's choices for the NEXT entry", async () => {
    const entries = [
      entry({ sheet: "httpd", key: "k1", needsCategory: true }),
      entry({ sheet: "httpd", key: "k2", needsCategory: true }),
    ];
    const { ask, asked } = cannedAsk([
      "n", // k1: create new
      "Custom", // new category name
      "3", // k2: pick the newly created "Custom" (index 3 = A, B, Custom)
    ]);
    const outcome = await runInteractiveSession(entries, { httpd: ["A", "B"] }, ask);

    const categoryQuestions = asked.filter((q) => q.kind === "category");
    expect(categoryQuestions[0]).toMatchObject({ choices: ["A", "B"] });
    expect(categoryQuestions[1]).toMatchObject({ choices: ["A", "B", "Custom"] });

    expect(outcome.resolved).toEqual([
      { sheet: "httpd", key: "k1", category: "Custom" },
      { sheet: "httpd", key: "k2", category: "Custom" },
    ]);
    // Created once, even though it was later picked by number for k2 — not
    // re-added every time it's reused.
    expect(outcome.newCategoriesBySheet).toEqual({ httpd: ["Custom"] });
  });

  it("re-prompts for a new category name until a non-empty one is given", async () => {
    const entries = [entry({ sheet: "httpd", key: "k", needsCategory: true })];
    const { ask, asked } = cannedAsk(["n", "", "  ", "Real Name"]);
    const outcome = await runInteractiveSession(entries, { httpd: [] }, ask);

    const nameQuestions = asked.filter((q) => q.kind === "newCategoryName");
    expect(nameQuestions).toHaveLength(3);
    expect(nameQuestions[0]).toMatchObject({ empty: false });
    expect(nameQuestions[1]).toMatchObject({ empty: true });
    expect(nameQuestions[2]).toMatchObject({ empty: true });
    expect(outcome.resolved).toEqual([{ sheet: "httpd", key: "k", category: "Real Name" }]);
  });
});

describe("runInteractiveSession — skipping", () => {
  it("'s' at the category prompt skips the whole entry, asking nothing else", async () => {
    const entries = [entry({ sheet: "httpd", key: "k", needsCategory: true, needsDescription: true })];
    const { ask, asked } = cannedAsk(["s"]);
    const outcome = await runInteractiveSession(entries, { httpd: ["A"] }, ask);

    expect(asked).toHaveLength(1); // no description questions after a skip
    expect(outcome.resolved).toEqual([]);
    expect(outcome.skipped).toEqual(entries);
  });

  it("'s' at the description prompt skips a needsDescription-only entry", async () => {
    const entries = [entry({ sheet: "app", key: "k", needsDescription: true })];
    const { ask, asked } = cannedAsk(["s"]);
    const outcome = await runInteractiveSession(entries, {}, ask);

    expect(asked).toEqual([{ kind: "descriptionEn", sheet: "app", key: "k", allowSkip: true }]); // no ja question
    expect(outcome.resolved).toEqual([]);
    expect(outcome.skipped).toEqual(entries);
  });

  it("blank Enter for description leaves TODO instead of skipping", async () => {
    const entries = [entry({ sheet: "app", key: "k", needsDescription: true })];
    const { ask } = cannedAsk(["", ""]);
    const outcome = await runInteractiveSession(entries, {}, ask);

    expect(outcome.resolved).toEqual([{ sheet: "app", key: "k", descriptionEn: "TODO", descriptionJa: "TODO" }]);
    expect(outcome.skipped).toEqual([]);
  });

  it("never visits an 'unused' entry — nothing is asked, nothing is resolved or skipped", async () => {
    const entries = [entry({ sheet: "", key: "stale_key", unused: true, hint: "stale_key2" })];
    const { ask, asked } = cannedAsk([]);
    const outcome = await runInteractiveSession(entries, {}, ask);

    expect(asked).toEqual([]);
    expect(outcome.resolved).toEqual([]);
    expect(outcome.skipped).toEqual([]);
  });
});

describe("applyInteractiveAnswers — comment preservation", () => {
  const sheetsDoc = `# Header comment for the whole file
sheets:
  httpd:
    # Tab order for this sheet
    categories:
      - Reverse proxy
      - General
      - KeepAlive
      - MPM
    params:
      # This one needs care, ops asked for it specifically
      httpd_timeout:
        category: General
        description:
          en: Request timeout in seconds # keep in sync with nginx
          ja: リクエストタイムアウト（秒）
`;

  it("preserves every leading/trailing comment while adding a new params entry", () => {
    const out = applyInteractiveAnswers(
      sheetsDoc,
      "sheets",
      [{ sheet: "httpd", key: "httpd_health_check_path", category: "Reverse proxy", descriptionEn: "Health check path", descriptionJa: "ヘルスチェックパス" }],
      {}
    );

    expect(out).toContain("# Header comment for the whole file");
    expect(out).toContain("# Tab order for this sheet");
    expect(out).toContain("# This one needs care, ops asked for it specifically");
    expect(out).toContain("# keep in sync with nginx");
    expect(out).toContain("httpd_health_check_path:");
    expect(out).toContain("category: Reverse proxy");
    expect(out).toContain("en: Health check path");
    expect(out).toContain("ja: ヘルスチェックパス");
    // The pre-existing entry is untouched.
    expect(out).toContain("en: Request timeout in seconds # keep in sync with nginx");
  });

  it("appends a newly created category to the sheet's existing categories: list, keeping it a list", () => {
    const out = applyInteractiveAnswers(sheetsDoc, "sheets", [], { httpd: ["MPM Prefork"] });
    expect(out).toContain("# Tab order for this sheet");
    const lines = out.split("\n");
    const idx = lines.findIndex((l) => l.includes("MPM Prefork"));
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx - 1]).toContain("MPM");
  });

  it("creates a categories: list when the sheet declares none yet", () => {
    const doc = `sheets:\n  app:\n    params:\n      existing:\n        category: General\n`;
    const out = applyInteractiveAnswers(doc, "sheets", [], { app: ["First"] });
    expect(out).toContain("categories:");
    expect(out).toContain("First");
  });

  it("writes to the top level for a flat (non-sheets) shape", () => {
    const doc = `# flat project metadata\nparams:\n  existing:\n    category: General\n`;
    const out = applyInteractiveAnswers(
      doc,
      "flat",
      [{ sheet: "", key: "new_key", category: "General", descriptionEn: "TODO", descriptionJa: "TODO" }],
      { "": ["New Cat"] }
    );
    expect(out).toContain("# flat project metadata");
    expect(out).toContain("new_key:");
    expect(out).toContain("category: General");
    expect(out).toContain("categories:");
    expect(out).toContain("New Cat");
    expect(out).not.toContain("sheets:");
  });

  it("creates a brand-new file from scratch when content is empty (missing project metadata path)", () => {
    const out = applyInteractiveAnswers(
      "",
      "sheets",
      [{ sheet: "app", key: "k", category: "General", descriptionEn: "TODO", descriptionJa: "TODO" }],
      { app: ["General"] }
    );
    expect(out).toContain("sheets:");
    expect(out).toContain("app:");
    expect(out).toContain("categories:");
    expect(out).toContain("General");
    expect(out).toContain("k:");
  });
});

// ---- P9: bulk apply --------------------------------------------------------

describe("deriveBulkPattern — pattern derivation", () => {
  it("derives a pattern from a structural identity predicate (the poc-oidc case from the task)", () => {
    expect(deriveBulkPattern("clients[clientId=poc-oidc].publicClient")).toBe("clients[clientId=poc-oidc].*");
  });

  it("cuts at the FIRST identity predicate, grouping deeper nesting under the same entity", () => {
    expect(deriveBulkPattern("clients[clientId=poc-oidc].protocolMappers[name=aud].config.claim")).toBe(
      "clients[clientId=poc-oidc].*"
    );
  });

  it("derives from a key that IS the predicate itself (no trailing field)", () => {
    expect(deriveBulkPattern("clients[clientId=poc-oidc]")).toBe("clients[clientId=poc-oidc].*");
  });

  it("does NOT derive a pattern from a bare snake_case key — no unambiguous split point", () => {
    // The httpd_keep_alive / httpd_keep_alive_timeout case from the task:
    // guessing a word boundary here would silently miscategorize real rows.
    expect(deriveBulkPattern("httpd_keep_alive")).toBeUndefined();
    expect(deriveBulkPattern("httpd_keep_alive_timeout")).toBeUndefined();
  });

  it("does NOT derive a pattern from a plain positional index — [0] names a slot, not an entity", () => {
    expect(deriveBulkPattern("clients[0].publicClient")).toBeUndefined();
  });
});

describe("matchesBulkPattern — literal prefix matching, never a real wildcard", () => {
  it("matches keys sharing the derived prefix", () => {
    const pattern = deriveBulkPattern("clients[clientId=poc-oidc].publicClient")!;
    expect(matchesBulkPattern("clients[clientId=poc-oidc].standardFlowEnabled", pattern)).toBe(true);
    expect(matchesBulkPattern("clients[clientId=poc-oidc].redirectUris[0]", pattern)).toBe(true);
  });

  it("does not match a DIFFERENT entity's keys, even with an identical field name", () => {
    const pattern = deriveBulkPattern("clients[clientId=poc-oidc].publicClient")!;
    expect(matchesBulkPattern("clients[clientId=poc-saml].publicClient", pattern)).toBe(false);
  });
});

describe("runInteractiveSession — bulk apply", () => {
  const clientEntries = (extra: Partial<ScaffoldEntry> = {}): ScaffoldEntry[] => [
    entry({ sheet: "realm", key: "clients[clientId=poc-oidc].publicClient", needsCategory: true, ...extra }),
    entry({ sheet: "realm", key: "clients[clientId=poc-oidc].standardFlowEnabled", needsCategory: true, ...extra }),
    entry({ sheet: "realm", key: "clients[clientId=poc-oidc].directAccessGrantsEnabled", needsCategory: true, ...extra }),
    entry({ sheet: "realm", key: "clients[clientId=poc-saml].publicClient", needsCategory: true, ...extra }),
  ];

  it("presents the pattern, count, and matching keys BEFORE asking whether to apply", async () => {
    const entries = clientEntries();
    const { ask, asked } = cannedAsk(["1", "y", "2"]);
    await runInteractiveSession(entries, { realm: ["Client: poc-oidc", "Client: poc-saml"] }, ask);

    const bulkQ = asked.find((q) => q.kind === "bulkApply");
    expect(bulkQ).toMatchObject({
      kind: "bulkApply",
      key: "clients[clientId=poc-oidc].publicClient",
      pattern: "clients[clientId=poc-oidc].*",
      category: "Client: poc-oidc",
      matches: [
        "clients[clientId=poc-oidc].standardFlowEnabled",
        "clients[clientId=poc-oidc].directAccessGrantsEnabled",
      ],
    });
    // The other client (poc-saml) is never offered here — different entity.
    expect((bulkQ as { matches: string[] }).matches).not.toContain("clients[clientId=poc-saml].publicClient");
  });

  it("accepting ('y') resolves every matched entry with the same category, asking no further questions for them", async () => {
    const entries = clientEntries();
    const { ask, asked } = cannedAsk([
      "1", // publicClient -> Client: poc-oidc
      "y", // bulk-apply to the other two poc-oidc entries
      "2", // poc-saml's own, unrelated, category question
    ]);
    const outcome = await runInteractiveSession(entries, { realm: ["Client: poc-oidc", "Client: poc-saml"] }, ask);

    expect(outcome.resolved).toEqual([
      { sheet: "realm", key: "clients[clientId=poc-oidc].publicClient", category: "Client: poc-oidc" },
      { sheet: "realm", key: "clients[clientId=poc-oidc].standardFlowEnabled", category: "Client: poc-oidc" },
      { sheet: "realm", key: "clients[clientId=poc-oidc].directAccessGrantsEnabled", category: "Client: poc-oidc" },
      { sheet: "realm", key: "clients[clientId=poc-saml].publicClient", category: "Client: poc-saml" },
    ]);
    expect(outcome.bulkApplied).toBe(2);
    // Only two category questions were asked in total (the triggering entry
    // and the unrelated poc-saml one) — the two bulk-applied entries never
    // got their own category question.
    expect(asked.filter((q) => q.kind === "category")).toHaveLength(2);
  });

  it("declining (anything but 'y', including blank) leaves the other entries to their own individual questions", async () => {
    const entries = clientEntries();
    // Declining is per-offer, so standardFlowEnabled — now resolved on its
    // own — gets to make its OWN bulk offer for the still-open
    // directAccessGrantsEnabled; also declined, so every entry ends up
    // asked individually.
    const { ask, asked } = cannedAsk([
      "1", // publicClient -> Client: poc-oidc
      "", // decline the bulk offer for {standardFlowEnabled, directAccessGrantsEnabled}
      "1", // standardFlowEnabled asked individually
      "", // decline the (now smaller) bulk offer for {directAccessGrantsEnabled}
      "1", // directAccessGrantsEnabled asked individually
      "2", // poc-saml's own category
    ]);
    const outcome = await runInteractiveSession(entries, { realm: ["Client: poc-oidc", "Client: poc-saml"] }, ask);

    expect(outcome.bulkApplied).toBe(0);
    expect(outcome.resolved).toHaveLength(4);
    // Every entry got its own category question this time.
    expect(asked.filter((q) => q.kind === "category")).toHaveLength(4);
    expect(asked.filter((q) => q.kind === "bulkApply")).toHaveLength(2);
  });

  it("'l' expands the shown list without deciding, then a following answer decides", async () => {
    const entries = clientEntries();
    const { ask, asked } = cannedAsk(["1", "l", "y", "2"]);
    const outcome = await runInteractiveSession(entries, { realm: ["Client: poc-oidc", "Client: poc-saml"] }, ask);

    const bulkQs = asked.filter((q) => q.kind === "bulkApply");
    expect(bulkQs).toHaveLength(2);
    expect(bulkQs[0]).toMatchObject({ expanded: false });
    expect(bulkQs[1]).toMatchObject({ expanded: true });
    expect(outcome.bulkApplied).toBe(2);
  });

  it("never offers a bulk apply for description-only fixes, and never for a bare (non-structural) key", async () => {
    const entries = [
      entry({ sheet: "httpd", key: "httpd_keep_alive", needsCategory: true }),
      entry({ sheet: "httpd", key: "httpd_keep_alive_timeout", needsCategory: true }),
    ];
    const { ask, asked } = cannedAsk(["1", "1"]);
    await runInteractiveSession(entries, { httpd: ["General"] }, ask);

    expect(asked.filter((q) => q.kind === "bulkApply")).toEqual([]);
  });

  it("skipping the triggering entry ('s') never offers a bulk apply — there is no category to apply", async () => {
    // Two single-representative entries from DIFFERENT entities, so there is
    // no sibling for either one to trigger a cascade of its own — isolates
    // "does skipping itself ever produce an offer" from "do later entries
    // still get to make their own offers" (covered elsewhere).
    const entries = [
      entry({ sheet: "realm", key: "clients[clientId=poc-oidc].publicClient", needsCategory: true }),
      entry({ sheet: "realm", key: "clients[clientId=poc-saml].publicClient", needsCategory: true }),
    ];
    const { ask, asked } = cannedAsk(["s", "1"]);
    const outcome = await runInteractiveSession(entries, { realm: ["Client: poc-oidc", "Client: poc-saml"] }, ask);

    // No bulk offer follows the skip, since no category was ever picked for
    // clients[clientId=poc-oidc].publicClient to propose applying elsewhere.
    expect(asked.filter((q) => q.kind === "bulkApply")).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(1);
    expect(outcome.resolved).toEqual([{ sheet: "realm", key: "clients[clientId=poc-saml].publicClient", category: "Client: poc-oidc" }]);
  });

  it("description is resolved per-entry even when its category was bulk-applied", async () => {
    const entries = clientEntries({ needsDescription: true });
    const { ask } = cannedAsk([
      "1",
      "y", // bulk-apply category to the other two poc-oidc entries
      "publicClient description",
      "パブリッククライアント",
      "standardFlow description",
      "標準フロー",
      "directAccessGrants description",
      "直接アクセス",
      "1",
      "saml description",
      "SAML",
    ]);
    const outcome = await runInteractiveSession(entries, { realm: ["Client: poc-oidc", "Client: poc-saml"] }, ask);

    expect(outcome.resolved.map((r) => r.descriptionEn)).toEqual([
      "publicClient description",
      "standardFlow description",
      "directAccessGrants description",
      "saml description",
    ]);
    // Every bulk-applied entry still has its OWN category, not a shared one
    // reused by reference — and every description is distinct, per the
    // task's "説明は一括適用しない" constraint.
    expect(new Set(outcome.resolved.map((r) => r.descriptionEn)).size).toBe(4);
  });
});

// ---- P9: incremental search -------------------------------------------------

describe("filterCategories — incremental search narrowing", () => {
  it("returns everything unfiltered for an empty query", () => {
    expect(filterCategories(["A", "B", "C"], "")).toEqual(["A", "B", "C"]);
  });

  it("is case-insensitive and matches by substring", () => {
    expect(filterCategories(["Reverse proxy", "General", "KeepAlive", "MPM"], "gen")).toEqual(["General"]);
    expect(filterCategories(["Reverse proxy", "General", "KeepAlive", "MPM"], "PROXY")).toEqual(["Reverse proxy"]);
  });

  it("ranks prefix matches before other substring matches", () => {
    // "Alive" is a substring of "KeepAlive" but "Live music" starts with it.
    expect(filterCategories(["KeepAlive", "Live music"], "live")).toEqual(["Live music", "KeepAlive"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterCategories(["A", "B"], "zzz")).toEqual([]);
  });
});

describe("runInteractiveSession — incremental search at the category prompt", () => {
  it("typing text narrows the choices shown next; a number then picks from the NARROWED list", async () => {
    const entries = [entry({ sheet: "httpd", key: "k", needsCategory: true })];
    const choices = ["Reverse proxy", "General", "KeepAlive", "MPM"];
    const { ask, asked } = cannedAsk(["keep", "1"]);
    const outcome = await runInteractiveSession(entries, { httpd: choices }, ask);

    const categoryQs = asked.filter((q) => q.kind === "category");
    expect(categoryQs[0]).toMatchObject({ choices, query: undefined });
    expect(categoryQs[1]).toMatchObject({ choices: ["KeepAlive"], query: "keep" });
    expect(outcome.resolved).toEqual([{ sheet: "httpd", key: "k", category: "KeepAlive" }]);
  });

  it("blank Enter while a filter is active clears it back to the full list", async () => {
    const entries = [entry({ sheet: "httpd", key: "k", needsCategory: true })];
    const choices = ["Reverse proxy", "General", "KeepAlive", "MPM"];
    const { ask, asked } = cannedAsk(["keep", "", "2"]);
    const outcome = await runInteractiveSession(entries, { httpd: choices }, ask);

    const categoryQs = asked.filter((q) => q.kind === "category");
    expect(categoryQs[1]).toMatchObject({ choices: ["KeepAlive"], query: "keep" });
    expect(categoryQs[2]).toMatchObject({ choices, query: undefined });
    expect(outcome.resolved).toEqual([{ sheet: "httpd", key: "k", category: "General" }]);
  });

  it("a query matching nothing falls back to 'invalid', same as unparseable input before P9", async () => {
    const entries = [entry({ sheet: "httpd", key: "k", needsCategory: true })];
    const { ask, asked } = cannedAsk(["zzz", "1"]);
    const outcome = await runInteractiveSession(entries, { httpd: ["A", "B"] }, ask);

    const categoryQs = asked.filter((q) => q.kind === "category");
    expect(categoryQs[1]).toMatchObject({ choices: ["A", "B"], query: undefined, invalid: "zzz" });
    expect(outcome.resolved).toEqual([{ sheet: "httpd", key: "k", category: "A" }]);
  });

  it("plain numeric selection is completely unaffected by the search feature (existing workflow preserved)", async () => {
    const entries = [entry({ sheet: "httpd", key: "k", needsCategory: true, needsDescription: true })];
    const { ask, asked } = cannedAsk(["2", "d", "j"]);
    const outcome = await runInteractiveSession(entries, { httpd: ["A", "B"] }, ask);

    expect(asked[0]).toEqual({ kind: "category", sheet: "httpd", key: "k", choices: ["A", "B"], query: undefined, binding: undefined, invalid: undefined });
    expect(outcome.resolved).toEqual([{ sheet: "httpd", key: "k", category: "B", descriptionEn: "d", descriptionJa: "j" }]);
  });
});
