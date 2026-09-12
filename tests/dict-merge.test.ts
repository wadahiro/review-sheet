// Two readings of one product, merged.
//
// Checked against the real pair this was built for: `sshd -T` reports 100
// settings with every default and no description; sshd_config(5) documents 112
// with every description and no default. Merged, 112 entries carry both. The
// numbers below are fixtures, but each rule here is one the real pair exercised
// — including the one that only showed up ON the real pair, that the two
// channels spell the same setting differently.

import { describe, it, expect } from "bun:test";
import { mergeDictionaries, DictionaryMergeError } from "../src/dict-merge";
import type { DictionaryDoc } from "../src/providers/dictionary";

const doc = (parameters: DictionaryDoc["parameters"], over: Partial<DictionaryDoc> = {}): DictionaryDoc => ({
  product: "p",
  version: "1",
  parameters,
  ...over,
});

describe("merging two readings of one product", () => {
  it("takes the field the other reading left empty", () => {
    const { doc: out, report } = mergeDictionaries(
      doc({ Port: { description: { en: "The port" } } }),
      doc({ Port: { default: "22", type: "int" } })
    );
    expect(out.parameters.Port).toEqual({ description: { en: "The port" }, default: "22", type: "int" });
    expect(report.filled).toEqual({ default: 1, type: 1 });
  });

  it("keeps the first reading's field where both have one", () => {
    const { doc: out } = mergeDictionaries(doc({ Port: { default: "22" } }), doc({ Port: { default: "22" } }));
    expect(out.parameters.Port!.default).toBe("22");
  });

  // Two readings of ONE build disagreeing about a default means one of them is
  // wrong about it, and picking silently is how a sheet asserts a default the
  // product does not have.
  it("refuses when they disagree, naming every field", () => {
    expect(() =>
      mergeDictionaries(
        doc({ Port: { default: "22" }, X11Forwarding: { default: "no" } }),
        doc({ Port: { default: "2222" }, X11Forwarding: { default: "yes" } })
      )
    ).toThrow(/disagree about 2 field/);
  });

  // The rule the real pair forced: `sshd -T` says `addressfamily`,
  // sshd_config(5) says `AddressFamily`. Matched exactly as the binder matches,
  // or the dictionary would hold two entries the binder considers one key.
  it("matches a setting the two readings spell differently", () => {
    const { doc: out, report } = mergeDictionaries(
      doc({ AddressFamily: { description: { en: "which family" } } }),
      doc({ addressfamily: { default: "any" } })
    );
    expect(Object.keys(out.parameters)).toEqual(["AddressFamily"]);
    expect(out.parameters.AddressFamily!.default).toBe("any");
    expect(report.matchedByNormalization).toBe(1);
  });

  it("reports what only one reading had, rather than dropping it", () => {
    const { doc: out, report } = mergeDictionaries(
      doc({ Port: { default: "22" } }),
      doc({ AcceptEnv: { description: { en: "list-valued, unreported when unset" } } })
    );
    expect(report.onlyInFirst).toEqual(["Port"]);
    expect(report.onlyInSecond).toEqual(["AcceptEnv"]);
    expect(Object.keys(out.parameters).sort()).toEqual(["AcceptEnv", "Port"]);
  });

  // Two keys of the second reading collapsing onto one of the first is a
  // question only its author can settle — the same refusal an ambiguous bind
  // makes.
  it("refuses when normalization makes two keys of the second one", () => {
    expect(() =>
      mergeDictionaries(doc({ log_level: { description: { en: "x" } } }), doc({ LogLevel: { default: "INFO" }, loglevel: { default: "INFO" } }))
    ).toThrow(/match more than one key/);
  });

  it("refuses two products", () => {
    expect(() => mergeDictionaries(doc({}), doc({}, { product: "other" }))).toThrow(DictionaryMergeError);
  });

  // A dictionary is pinned to one build, and two builds' defaults are not
  // interchangeable — merging them would produce a document true of neither.
  it("refuses two builds", () => {
    expect(() => mergeDictionaries(doc({}), doc({}, { version: "2" }))).toThrow(/one build/);
  });

  // A merge adds entries; it never proves the union covers the product, so the
  // weaker claim has to survive it.
  it("does not promote a coverage claim", () => {
    const { doc: out } = mergeDictionaries(
      doc({ Port: {} }, { coverage: "partial" }),
      doc({ Port: {} }, { coverage: "full" })
    );
    expect(out.coverage).toBe("partial");
  });

  // The case the test above passed for the wrong reason: a first reading that
  // claims nothing must not come out claiming what the second did.
  it("makes no coverage claim the first reading did not make", () => {
    const { doc: out } = mergeDictionaries(doc({ Port: {} }), doc({ Port: {} }, { coverage: "full" }));
    expect(out.coverage).toBeUndefined();
  });
});
