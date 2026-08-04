import { describe, it, expect } from "bun:test";
import { getMetadataProvider, type MetadataContext } from "../src/metadata";
import "../src/providers/argument-specs";

const SPEC_A = `
argument_specs:
  main:
    short_description: role main entrypoint
    options:
      pg_max_connections:
        type: int
        description: Maximum number of concurrent connections.
      pg_shared_buffers:
        type: str
        description:
          - Shared memory buffer size.
          - Tune to ~25% of RAM.
      pg_default_only:
        type: str
        default: something
        description: Has a default too, but we never emit it.
`;

const SPEC_B = `
argument_specs:
  main:
    options:
      pg_max_connections:
        type: int
        description: Should not win — first file wins.
      only_in_b:
        type: str
        description: Only defined in the second file.
`;

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

const files: Record<string, string> = {
  "roles/postgresql/meta/argument_specs.yml": SPEC_A,
  "roles/other/meta/argument_specs.yml": SPEC_B,
};
const readFile = (p: string): string | null => files[p] ?? null;

describe("argument-specs metadata provider", () => {
  const provider = getMetadataProvider("argument-specs")!;

  it("wraps the description as { en: ... } (nativeLang defaults to en)", () => {
    const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
    const result = provider.resolve({ key: "pg_max_connections" }, c);
    expect(result).toEqual({
      description: { en: "Maximum number of concurrent connections." },
      type: "int",
      provenance: "community",
    });
  });

  it("wraps the description as { ja: ... } when ctx.nativeLang is ja", () => {
    const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile, nativeLang: "ja" });
    const result = provider.resolve({ key: "pg_max_connections" }, c);
    expect(result?.description).toEqual({ ja: "Maximum number of concurrent connections." });
  });

  it("joins an array description with a space", () => {
    const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
    const result = provider.resolve({ key: "pg_shared_buffers" }, c);
    expect(result?.description).toEqual({ en: "Shared memory buffer size. Tune to ~25% of RAM." });
    expect(result?.type).toBe("str");
  });

  it("never emits default even when the spec has one", () => {
    const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
    const result = provider.resolve({ key: "pg_default_only" }, c);
    expect(result?.default).toBeUndefined();
  });

  it("returns undefined for an unknown key", () => {
    const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
    expect(provider.resolve({ key: "nope" }, c)).toBeUndefined();
  });

  it("first file wins across multiple argumentSpecs paths", () => {
    const c = ctx({
      argumentSpecs: ["roles/postgresql/meta/argument_specs.yml", "roles/other/meta/argument_specs.yml"],
      readFile,
    });
    const result = provider.resolve({ key: "pg_max_connections" }, c);
    expect(result?.description).toEqual({ en: "Maximum number of concurrent connections." });
  });

  it("falls through to a later file for a key only present there", () => {
    const c = ctx({
      argumentSpecs: ["roles/postgresql/meta/argument_specs.yml", "roles/other/meta/argument_specs.yml"],
      readFile,
    });
    const result = provider.resolve({ key: "only_in_b" }, c);
    expect(result?.description).toEqual({ en: "Only defined in the second file." });
  });

  it("returns undefined when argumentSpecs is empty", () => {
    const c = ctx({ argumentSpecs: [], readFile });
    expect(provider.resolve({ key: "pg_max_connections" }, c)).toBeUndefined();
  });

  it("throws when a listed file is not found", () => {
    const c = ctx({ argumentSpecs: ["missing/argument_specs.yml"], readFile });
    expect(() => provider.resolve({ key: "pg_max_connections" }, c)).toThrow(
      "argument_specs not found: missing/argument_specs.yml"
    );
  });

  // Regression: since S2 (per-row product-key naming via keyMap), a row's
  // display key can differ from the Ansible variable argument_specs.yml
  // documents it under (e.g. a role variable `pg_max_connections` filed as
  // the product's own `max_connections`). Without a fallback, the file's
  // entry becomes permanently unreachable the moment the row is renamed —
  // even though the entry, and the variable, are both still there. See
  // review-sheet's CLAUDE.md ("N2 argument_specs.yml") and metadata.ts's
  // MetadataQuery.variable.
  describe("query.variable fallback (S2 keyMap renaming)", () => {
    it("matches by query.key first even when query.variable is also set", () => {
      const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
      const result = provider.resolve({ key: "pg_max_connections", variable: "only_in_b" }, c);
      expect(result?.description).toEqual({ en: "Maximum number of concurrent connections." });
    });

    it("falls back to query.variable when query.key does not match", () => {
      const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
      // The row is now keyed "max_connections" (the product's own key), but
      // the role's argument_specs.yml still documents it as pg_max_connections.
      const result = provider.resolve({ key: "max_connections", variable: "pg_max_connections" }, c);
      expect(result?.description).toEqual({ en: "Maximum number of concurrent connections." });
      expect(result?.provenance).toBe("community");
    });

    it("does not fall back when query.variable is the same as query.key (nothing to gain)", () => {
      const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
      const result = provider.resolve({ key: "nope", variable: "nope" }, c);
      expect(result).toBeUndefined();
    });

    it("returns undefined when neither key nor variable match", () => {
      const c = ctx({ argumentSpecs: ["roles/postgresql/meta/argument_specs.yml"], readFile });
      expect(provider.resolve({ key: "nope", variable: "also_nope" }, c)).toBeUndefined();
    });
  });
});
