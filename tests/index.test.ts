import { describe, it, expect } from "bun:test";
import * as lib from "../src/index";

describe("public API", () => {
  it("re-exports the core entry points", () => {
    for (const name of [
      "generateHtml",
      "validateInput",
      "validateReview",
      "validateVersionedInput",
      "isVersionedInput",
      "verifySources",
      "computeApply",
      "buildPromptText",
      "diffSheets",
      // extraction adapters (for project-specific conversion scripts)
      "extractFile",
      "buildInput",
      "inferFormat",
    ]) {
      expect(typeof (lib as Record<string, unknown>)[name]).toBe("function");
    }
  });

  it("extractFile from the package produces entries with a source map", () => {
    const entries = lib.extractFile("a.b = 1\n", "/etc/x.conf");
    expect(entries[0]).toMatchObject({ key: "a.b", value: "1" });
    expect(entries[0].source).toMatchObject({ line: 1, anchor: "a.b =" });
  });
});
