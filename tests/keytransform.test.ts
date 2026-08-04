import { describe, it, expect } from "bun:test";
import { makeKeyTransformer, selectKeySource, type KeyTransform } from "../src/keytransform";

describe("selectKeySource", () => {
  it("defaults to the leaf key", () => {
    expect(selectKeySource(undefined, "default", "variable.vpc_cidr.default")).toBe("default");
  });

  it("reads the structural path when asked, falling back to the key when there is none", () => {
    expect(selectKeySource("path", "default", "variable.vpc_cidr.default")).toBe("variable.vpc_cidr.default");
    expect(selectKeySource("path", "vpc_cidr", undefined)).toBe("vpc_cidr");
  });
});

describe("makeKeyTransformer", () => {
  it("extracts a capture group (the Terraform variables.tf case: variable.<name>.default -> <name>)", () => {
    const t = makeKeyTransformer({ steps: [{ pattern: "^variable\\.(.+)\\.default$", replace: "$1" }] });
    expect(t.apply("variable.vpc_cidr.default")).toBe("vpc_cidr");
  });

  it("defaults on_no_match to keep — a non-matching entry passes through unchanged", () => {
    const t = makeKeyTransformer({ steps: [{ pattern: "^KC_", replace: "" }] });
    expect(t.apply("AWS_REGION")).toBe("AWS_REGION");
  });

  it("drops an entry when a step says on_no_match: drop (the Terraform description/type attributes)", () => {
    const t = makeKeyTransformer({ steps: [{ pattern: "^variable\\.(.+)\\.default$", replace: "$1", on_no_match: "drop" }] });
    expect(t.apply("variable.vpc_cidr.description")).toBeUndefined();
    expect(t.apply("variable.vpc_cidr.default")).toBe("vpc_cidr");
  });

  it("chains steps, threading the previous step's output into the next (the ECS env-var case)", () => {
    const t = makeKeyTransformer({
      steps: [
        // Anchored front-to-back (^...$): a plain JS String.replace on a
        // fully-matched string discards everything outside the capture
        // group, which is what turns a full structural path into a bare
        // variable name instead of leaving the array-index prefix attached.
        {
          pattern: "^.*\\.(?:environment|secrets)\\[name=([^\\]]+)\\]\\.(?:value|valueFrom)$",
          replace: "$1",
          on_no_match: "drop",
        },
        { pattern: "^KC_", replace: "" },
        { lowercase: true },
        { pattern: "_", replace: "-", flags: "g" },
      ],
    });
    expect(t.apply("containerDefinitions[0].environment[name=KC_DB_URL].value")).toBe("db-url");
    expect(t.apply("containerDefinitions[0].secrets[name=KC_DB_PASSWORD].valueFrom")).toBe("db-password");
    // Scaffolding fields (family, cpu, image, …) never match the first,
    // required step and are dropped entirely.
    expect(t.apply("family")).toBeUndefined();
  });

  it("uppercase step", () => {
    const t = makeKeyTransformer({ steps: [{ uppercase: true }] });
    expect(t.apply("db-url")).toBe("DB-URL");
  });

  it("stops applying later steps once an earlier one drops the entry", () => {
    let calls = 0;
    const t = makeKeyTransformer({
      steps: [
        { pattern: "^nope$", replace: "x", on_no_match: "drop" },
        { lowercase: true },
      ],
    });
    // No exception, no crash from calling toLowerCase on undefined — apply()
    // must short-circuit once the key becomes undefined.
    expect(t.apply("ANYTHING")).toBeUndefined();
    void calls;
  });

  it("reports a drop pattern that never matched any entry — the silent-loss guard", () => {
    const t = makeKeyTransformer({ steps: [{ pattern: "^variable\\.(.+)\\.default$", replace: "$1", on_no_match: "drop" }] });
    t.apply("variable.vpc_cidr.description");
    t.apply("variable.vpc_cidr.type");
    expect(t.unmatchedDropPatterns()).toEqual(["^variable\\.(.+)\\.default$"]);
  });

  it("does not report a drop pattern that matched at least once", () => {
    const t = makeKeyTransformer({ steps: [{ pattern: "^variable\\.(.+)\\.default$", replace: "$1", on_no_match: "drop" }] });
    t.apply("variable.vpc_cidr.default");
    t.apply("variable.vpc_cidr.description");
    expect(t.unmatchedDropPatterns()).toEqual([]);
  });

  it("does not track a 'keep' step or a case step as an unmatched drop pattern", () => {
    const transform: KeyTransform = {
      steps: [
        { pattern: "^KC_", replace: "" }, // on_no_match defaults to "keep" — never tracked
        { lowercase: true },
      ],
    };
    const t = makeKeyTransformer(transform);
    t.apply("AWS_REGION"); // never matches ^KC_
    expect(t.unmatchedDropPatterns()).toEqual([]);
  });
});
