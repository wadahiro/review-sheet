import { describe, it, expect } from "bun:test";
import { generateHtml, assembleVersions, allDated } from "../src/html/generate";
import { validateVersionedInput, isVersionedInput, validateInput } from "../src/validate";
import type { VersionedSheetInput, ParameterSheetInput } from "../src/types";

const mkModel = (version: string | undefined, date: string | undefined, value: string): ParameterSheetInput => ({
  metadata: { version, generated_at: date },
  sheets: [{ name: "S", categories: [{ name: "C", params: [{ key: "a", value }] }] }],
});

const versioned: VersionedSheetInput = {
  metadata: { title: "Versioned" },
  versions: [
    { version: "1.0", date: "2026-01-10", sheets: [{ name: "S", categories: [{ name: "C", params: [{ key: "a", value: "1" }] }] }] },
    { version: "1.1", date: "2026-02-01", sheets: [{ name: "S", categories: [{ name: "C", params: [{ key: "a", value: "2" }] }] }] },
  ],
};

describe("isVersionedInput", () => {
  it("distinguishes versioned from single", () => {
    expect(isVersionedInput(versioned)).toBe(true);
    expect(isVersionedInput({ sheets: [] })).toBe(false);
  });
});

describe("validateVersionedInput", () => {
  it("accepts a valid versioned document", () => {
    expect(validateVersionedInput(versioned).versions).toHaveLength(2);
  });

  it("errors on an empty versions array", () => {
    expect(() => validateVersionedInput({ versions: [] })).toThrow();
  });

  it("errors when a version is missing its label", () => {
    expect(() =>
      validateVersionedInput({ versions: [{ sheets: [{ name: "S", categories: [{ name: "C", params: [{ key: "a", value: "1" }] }] }] }] })
    ).toThrow(/version/);
  });

  it("surfaces a per-version schema error with version context", () => {
    const bad = { versions: [{ version: "1.0", sheets: [] }] };
    expect(() => validateVersionedInput(bad)).toThrow(/version "1.0"/);
  });
});

describe("assembleVersions", () => {
  it("orders by date regardless of input (argument) order", () => {
    const inputs = [
      { file: "newer.json", input: mkModel("1.2", "2026-03-01", "30") },
      { file: "older.json", input: mkModel("1.0", "2026-01-10", "60") },
      { file: "mid.json", input: mkModel("1.1", "2026-02-01", "45") },
    ];
    expect(allDated(inputs)).toBe(true);
    const doc = assembleVersions(inputs);
    expect(doc.versions.map((v) => v.version)).toEqual(["1.0", "1.1", "1.2"]); // sorted by date
  });

  it("keeps the given order when dates are missing", () => {
    const inputs = [
      { file: "a.json", input: mkModel("a", undefined, "1") },
      { file: "b.json", input: mkModel("b", undefined, "2") },
    ];
    expect(allDated(inputs)).toBe(false);
    expect(assembleVersions(inputs).versions.map((v) => v.version)).toEqual(["a", "b"]);
  });

  it("falls back to the file basename when a version label is absent", () => {
    const inputs = [{ file: "/path/prod-config.json", input: mkModel(undefined, "2026-01-01", "1") }];
    expect(assembleVersions(inputs).versions[0].version).toBe("prod-config");
  });

  it("disambiguates duplicate version labels with unique ids", () => {
    const inputs = [
      { file: "x.json", input: mkModel("1.0", "2026-01-01", "1") },
      { file: "y.json", input: mkModel("1.0", "2026-02-01", "2") },
    ];
    const ids = assembleVersions(inputs).versions.map((v) => v.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("generateHtml — versioned", () => {
  it("embeds a versions payload and both snapshots", async () => {
    const html = await generateHtml(versioned);
    expect(html).toContain('"versions"');
    expect(html).toContain('"version":"1.0"');
    expect(html).toContain('"version":"1.1"');
  });

  it("normalizes a single-version input into one version", async () => {
    const html = await generateHtml(validateInput({
      metadata: { version: "9.9" },
      sheets: [{ name: "S", categories: [{ name: "C", params: [{ key: "a", value: "1" }] }] }],
    }));
    expect(html).toContain('"versions"');
    expect(html).toContain('"version":"9.9"');
  });
});
