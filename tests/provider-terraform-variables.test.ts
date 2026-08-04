import { describe, it, expect } from "bun:test";
import { getMetadataProvider, resolveMetadata, type MetadataContext } from "../src/metadata";
import "../src/providers/terraform-variables";

const VARS_A = `
variable "aws_region" {
  description = "AWS region every resource in the account is deployed into."
  type        = string
  default     = "us-east-1"
}

variable "instance_type" {
  description = "EC2 instance type for the app servers."
  type        = string
}

variable "no_description" {
  type = string
}
`;

const VARS_B = `
variable "aws_region" {
  description = "Should not win — first file wins."
}

variable "only_in_b" {
  description = "Only defined in the second file."
}
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
  "terraform/variables.tf": VARS_A,
  "terraform/other/variables.tf": VARS_B,
};
const readFile = (p: string): string | null => files[p] ?? null;

describe("terraform-variables metadata provider", () => {
  const provider = getMetadataProvider("terraform-variables")!;

  it("resolves a description from variables.tf, wrapped as { en: ... } (nativeLang defaults to en)", () => {
    const c = ctx({ terraformVariables: ["terraform/variables.tf"], readFile });
    const result = provider.resolve({ key: "aws_region" }, c);
    expect(result).toEqual({
      description: { en: "AWS region every resource in the account is deployed into." },
      provenance: "community",
    });
  });

  it("wraps the description as { ja: ... } when ctx.nativeLang is ja", () => {
    const c = ctx({ terraformVariables: ["terraform/variables.tf"], readFile, nativeLang: "ja" });
    const result = provider.resolve({ key: "aws_region" }, c);
    expect(result?.description).toEqual({ ja: "AWS region every resource in the account is deployed into." });
  });

  it("does not source `type` (unquoted identifiers are not extracted by the hcl parser)", () => {
    const c = ctx({ terraformVariables: ["terraform/variables.tf"], readFile });
    const result = provider.resolve({ key: "instance_type" }, c);
    expect(result?.description).toEqual({ en: "EC2 instance type for the app servers." });
    expect(result?.type).toBeUndefined();
  });

  it("returns undefined for a variable with no description attribute", () => {
    const c = ctx({ terraformVariables: ["terraform/variables.tf"], readFile });
    expect(provider.resolve({ key: "no_description" }, c)).toBeUndefined();
  });

  it("returns undefined for an unknown variable name", () => {
    const c = ctx({ terraformVariables: ["terraform/variables.tf"], readFile });
    expect(provider.resolve({ key: "nope" }, c)).toBeUndefined();
  });

  it("returns undefined when terraformVariables is empty", () => {
    const c = ctx({ terraformVariables: [], readFile });
    expect(provider.resolve({ key: "aws_region" }, c)).toBeUndefined();
  });

  it("first file wins across multiple terraformVariables paths", () => {
    const c = ctx({
      terraformVariables: ["terraform/variables.tf", "terraform/other/variables.tf"],
      readFile,
    });
    const result = provider.resolve({ key: "aws_region" }, c);
    expect(result?.description).toEqual({ en: "AWS region every resource in the account is deployed into." });
  });

  it("falls through to a later file for a variable only present there", () => {
    const c = ctx({
      terraformVariables: ["terraform/variables.tf", "terraform/other/variables.tf"],
      readFile,
    });
    const result = provider.resolve({ key: "only_in_b" }, c);
    expect(result?.description).toEqual({ en: "Only defined in the second file." });
  });

  it("throws when a listed file is not found", () => {
    const c = ctx({ terraformVariables: ["missing/variables.tf"], readFile });
    expect(() => provider.resolve({ key: "aws_region" }, c)).toThrow(
      "terraform variables file not found: missing/variables.tf"
    );
  });

  // The reason this provider exists: resolveMetadata (metadata.ts) now merges
  // LangText fields per language key, first-wins. When sheet.yml's `project`
  // provider (priority 100) supplies only `{ ja }`, this lower-priority
  // (50) provider's plain English string should fill the still-open `en`
  // slot instead of being discarded — both languages end up present.
  it("merges with a ja-only project-provider result to fill both languages", () => {
    const c = ctx({ terraformVariables: ["terraform/variables.tf"], readFile });
    const projectProvider = {
      name: "project",
      priority: 100,
      resolve: () => ({
        description: { ja: "アカウント内の全リソースがデプロイされる AWS リージョン。" },
        provenance: "project" as const,
      }),
    };
    const resolved = resolveMetadata({ key: "aws_region" }, c, [projectProvider, provider]);
    expect(resolved?.description).toEqual({
      ja: "アカウント内の全リソースがデプロイされる AWS リージョン。",
      en: "AWS region every resource in the account is deployed into.",
    });
  });
});
