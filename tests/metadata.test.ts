import { describe, it, expect } from "bun:test";
import {
  registerMetadataProvider,
  getMetadataProvider,
  resolveMetadata,
  pickLang,
  type MetadataProvider,
  type MetadataContext,
} from "../src/metadata";
import "../src/providers/argument-specs";
import type { Binding } from "../src/bind";

function ctx(overrides: Partial<MetadataContext> = {}): MetadataContext {
  return {
    lang: "en",
    nativeLang: "en",
    readFile: () => null,
    argumentSpecs: [],
    terraformVariables: [],
    metadataDirs: [],
    dictionaries: [],
    cache: new Map(),
    ...overrides,
  };
}

describe("metadata provider registry", () => {
  it("registers and round-trips by name", () => {
    const p: MetadataProvider = { name: "test-a", resolve: () => undefined };
    registerMetadataProvider(p);
    expect(getMetadataProvider("test-a")).toBe(p);
  });

  it("replaces an existing provider by name", () => {
    const p1: MetadataProvider = { name: "test-b", resolve: () => ({ description: "one", provenance: "community" }) };
    const p2: MetadataProvider = { name: "test-b", resolve: () => ({ description: "two", provenance: "community" }) };
    registerMetadataProvider(p1);
    registerMetadataProvider(p2);
    expect(getMetadataProvider("test-b")).toBe(p2);
  });
});

describe("pickLang", () => {
  it("undefined -> undefined", () => {
    expect(pickLang(undefined, "en")).toBeUndefined();
  });
  it("string -> itself", () => {
    expect(pickLang("hello", "ja")).toBe("hello");
  });
  it("object -> lang match", () => {
    expect(pickLang({ en: "E", ja: "J" }, "ja")).toBe("J");
  });
  it("object -> falls back to en", () => {
    expect(pickLang({ en: "E" }, "ja")).toBe("E");
  });
  it("object -> falls back to ja when no en", () => {
    expect(pickLang({ ja: "J" }, "en")).toBe("J");
  });
});

describe("resolveMetadata", () => {
  it("merges fields first-wins across priority-sorted providers, tracks contributions", () => {
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: () => ({ description: "H", provenance: "machine" }),
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: () => ({ description: "L", default: "42", provenance: "official" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [high, low]);
    expect(result).toMatchObject({ description: "H", default: "42", provenance: "machine" });
    expect(result?.contributions).toEqual({ high: 1, low: 1 });
  });

  it("passes query.binding through unchanged to every provider (no per-provider routing/rewriting)", () => {
    const binding = {
      product: "nginx",
      version: "1.26",
      dictKey: "listen",
      entry: { description: "Listen port" },
      method: "exact" as const,
    };
    const seenBindings: (Binding | undefined)[] = [];
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: (q) => {
        seenBindings.push(q.binding);
        return undefined;
      },
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: (q) => {
        seenBindings.push(q.binding);
        return { description: "resolved", provenance: "community" };
      },
    };
    const result = resolveMetadata({ key: "nginx_listen_port", binding }, ctx(), [high, low]);
    expect(seenBindings).toEqual([binding, binding]);
    expect(result?.description).toBe("resolved");
  });

  it("returns undefined when nothing matches", () => {
    const none: MetadataProvider = { name: "none", resolve: () => undefined };
    expect(resolveMetadata({ key: "k" }, ctx(), [none])).toBeUndefined();
  });
});

describe("resolveMetadata — LangText per-language-key merge (description/remarks)", () => {
  it("merges { en } from high priority with { en, ja } from low priority per language key", () => {
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: () => ({ description: { en: "x" }, provenance: "project" }),
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: () => ({ description: { en: "y", ja: "z" }, provenance: "community" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [high, low]);
    expect(result?.description).toEqual({ en: "x", ja: "z" });
    // provenance is credited PER LANGUAGE, truthfully: `en` came from
    // `high` (project), `ja` came from `low` (community) — never the old
    // "whichever provider filled the field first" approximation.
    expect(result?.provenance).toEqual({ en: "project", ja: "community" });
    // one provider touched by each, even though `low` only filled `ja`
    // (its `en` was already claimed by `high`).
    expect(result?.contributions).toEqual({ high: 1, low: 1 });
  });

  it("fills a still-missing key from a lower-priority { ja } when high priority only has { en }", () => {
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: () => ({ description: { en: "E" }, provenance: "project" }),
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: () => ({ description: { ja: "J" }, provenance: "community" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [high, low]);
    expect(result?.description).toEqual({ en: "E", ja: "J" });
  });

  it("the motivating case: sheet.yml supplies only { ja }, a plain-string native channel supplies en", () => {
    // This is the exact scenario the task exists for: the project's own
    // metadata (highest priority) keeps only the Japanese translation, and
    // a lower-priority provider mirrors a Terraform `description =`
    // attribute / an Ansible argument_specs `description:` — both plain,
    // English-only strings with no concept of `ja`.
    const project: MetadataProvider = {
      name: "project",
      priority: 100,
      resolve: () => ({ description: { ja: "日本語の説明" }, provenance: "project" }),
    };
    const nativeChannel: MetadataProvider = {
      name: "argument-specs",
      priority: 50,
      resolve: () => ({ description: "English description from Terraform/Ansible", provenance: "community" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [project, nativeChannel]);
    expect(result?.description).toEqual({ en: "English description from Terraform/Ansible", ja: "日本語の説明" });
    // provenance now reads truthfully split per language: `ja` traces to
    // the project (sheet.yml), `en` traces to the native channel — the
    // exact case this whole per-language merge exists for. Before this
    // task, provenance would have wrongly said "project" for both, since
    // the project happened to run first.
    expect(result?.provenance).toEqual({ en: "community", ja: "project" });
    expect(result?.contributions).toEqual({ project: 1, "argument-specs": 1 });
  });

  it("documented edge case: a plain string fills a still-missing `ja` even though it is English prose", () => {
    // Mirror image of the motivating case, with no way for the merge logic
    // to know a bare string's language — see the comment on mergeLangField
    // in src/metadata.ts for why this is a deliberate trade-off rather than
    // leaving `ja` permanently unfillable once any provider touched the
    // field.
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: () => ({ description: { en: "E" }, provenance: "project" }),
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: () => ({ description: "L", provenance: "community" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [high, low]);
    expect(result?.description).toEqual({ en: "E", ja: "L" });
  });

  it("a plain string from the highest-priority contributor locks the field — no lower provider is consulted", () => {
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: () => ({ description: "H", provenance: "machine" }),
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: () => ({ description: { en: "y", ja: "z" }, provenance: "community" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [high, low]);
    expect(result?.description).toBe("H");
    expect(result?.provenance).toBe("machine");
    expect(result?.contributions).toEqual({ high: 1 });
  });

  it("a per-language provenance map that agrees on both languages collapses to the bare scalar", () => {
    // A single provider may itself return a { en, ja } LangProvenance object
    // (e.g. a dictionary provider forwarding a merged per-language claim —
    // see providers/dictionary.ts's provenanceFor/collapseProvenance). When
    // both languages agree, the output must be indistinguishable from a
    // provider that just returned the bare scalar — this is what keeps
    // every unmigrated (all-scalar) dictionary's output byte-identical.
    const uniform: MetadataProvider = {
      name: "uniform",
      priority: 100,
      resolve: () => ({ description: { en: "E", ja: "J" }, provenance: { en: "official", ja: "official" } }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [uniform]);
    expect(result?.description).toEqual({ en: "E", ja: "J" });
    expect(result?.provenance).toBe("official");
  });

  it("only one language ever gets a description: provenance collapses to that language's scalar", () => {
    const jaOnly: MetadataProvider = {
      name: "ja-only",
      priority: 100,
      resolve: () => ({ description: { ja: "J" }, provenance: "extracted" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [jaOnly]);
    expect(result?.description).toEqual({ ja: "J" });
    // Nothing to disagree with (`en` was never filled by anyone) — bare
    // scalar, not `{ ja: "extracted" }`.
    expect(result?.provenance).toBe("extracted");
  });

  it("behaves the same way for remarks", () => {
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: () => ({ remarks: { ja: "注意" }, provenance: "project" }),
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: () => ({ remarks: "Caution note", provenance: "community" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [high, low]);
    expect(result?.remarks).toEqual({ en: "Caution note", ja: "注意" });
    // remarks doesn't drive `provenance` (only description does).
    expect(result?.provenance).toBeUndefined();
    expect(result?.contributions).toEqual({ high: 1, low: 1 });
  });

  it("non-LangText fields stay field-level first-wins, unaffected by per-language merging", () => {
    const high: MetadataProvider = {
      name: "high",
      priority: 100,
      resolve: () => ({ description: { en: "E" }, default: "1", provenance: "project" }),
    };
    const low: MetadataProvider = {
      name: "low",
      priority: 10,
      resolve: () => ({ description: { ja: "J" }, default: "2", docs_url: "https://example.com", provenance: "community" }),
    };
    const result = resolveMetadata({ key: "k" }, ctx(), [high, low]);
    expect(result?.default).toBe("1"); // high wins outright, whole field
    expect(result?.docs_url).toBe("https://example.com"); // only low set it
    // high: default(1) + description(en) = 2. low: docs_url(1) + description(ja) = 2.
    expect(result?.contributions).toEqual({ high: 2, low: 2 });
  });
});

// N2c regression: before this task, argument-specs.ts / terraform-variables.ts
// returned a bare string, which resolveMetadata's per-language merge treats
// as "language-agnostic, locks the whole field" — so a lower-priority
// dictionary provider's `{ en, ja }` translation was discarded entirely,
// even though the dictionary was never consulted for `en` (argument-specs
// already claimed the field). This is the exact repro from the task:
// argument-specs (priority 50, native English channel) must no longer beat
// out the dictionary's `ja`.
describe("resolveMetadata — native channel (argument-specs) + dictionary integration (N2c regression)", () => {
  it("argument-specs supplies en, a lower-priority dictionary-shaped provider still fills ja", () => {
    const argSpecsLike: MetadataProvider = {
      name: "argument-specs",
      priority: 50,
      resolve: () => ({ description: { en: "Role author text." }, provenance: "community" }),
    };
    const dictionaryLike: MetadataProvider = {
      name: "dictionary",
      priority: 30,
      resolve: () => ({
        description: { en: "Official English.", ja: "公式の日本語。" },
        provenance: "official",
      }),
    };
    const result = resolveMetadata({ key: "x" }, ctx(), [argSpecsLike, dictionaryLike]);
    // en: argument-specs (higher priority) wins outright.
    // ja: argument-specs never supplied one, so the dictionary's ja is not discarded.
    expect(result?.description).toEqual({ en: "Role author text.", ja: "公式の日本語。" });
  });

  it("the real argument-specs provider (not a mock) exhibits the same fix", () => {
    const argumentSpecsProvider = getMetadataProvider("argument-specs")!;
    const dictionaryLike: MetadataProvider = {
      name: "dictionary",
      priority: 30,
      resolve: () => ({
        description: { en: "Official English.", ja: "公式の日本語。" },
        provenance: "official",
      }),
    };
    const specContent = `
argument_specs:
  main:
    options:
      x:
        description: Role author text.
`;
    const c = ctx({ argumentSpecs: ["role/meta/argument_specs.yml"], readFile: () => specContent });
    const result = resolveMetadata({ key: "x" }, c, [argumentSpecsProvider, dictionaryLike]);
    expect(result?.description).toEqual({ en: "Role author text.", ja: "公式の日本語。" });
  });
});
