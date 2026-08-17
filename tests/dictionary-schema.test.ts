// The dictionary was the one input this tool read without validating it: three
// `typeof`s and a cast. A misspelled field simply never arrived — the row
// showed nothing where its default or its group should be, with no error and
// no warning. These tests cover the schema that closed that, and the two
// places the schema itself could drift: the TypeScript types beside it, and
// the hand-written overlay parser that the schema does NOT cover.
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDictionary } from "../src/providers/dictionary";
import { findDictionary, DICTIONARY_PARAM_FIELDS, DICTIONARY_DOC_FIELDS } from "../src/providers/dictionary.js";
import schema from "../src/schema/dictionary.schema.json";

const VALID = `product: demo
version: "1"
provenance: extracted
coverage: full
parameters:
  timeout:
    description: { en: How long to wait }
    default: "30"
    group: Connections
`;

function withDict(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "rs-dict-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const load = (files: Record<string, string>, product = "demo", version = "1") => {
  const { dir, cleanup } = withDict(files);
  try {
    return findDictionary(product, version, [dir], (p) => {
      try {
        return require("node:fs").readFileSync(p, "utf8") as string;
      } catch {
        return null;
      }
    });
  } finally {
    cleanup();
  }
};

describe("dictionary schema", () => {
  it("accepts a dictionary that uses every field it declares", () => {
    const doc = load({ "demo@1.yml": VALID });
    expect(doc?.parameters.timeout?.default).toBe("30");
  });

  it("rejects an unknown field, and says which one it meant", () => {
    // `descriptoin` used to be accepted and then ignored: the row rendered
    // with no description at all, and the strict-metadata gate blamed the
    // project for not writing one.
    expect(() =>
      load({ "demo@1.yml": `product: demo\nversion: "1"\nparameters:\n  timeout:\n    descriptoin: { en: x }\n` })
    ).toThrow(/unknown|additional property "descriptoin"/);
    try {
      load({ "demo@1.yml": `product: demo\nversion: "1"\nparameters:\n  timeout:\n    descriptoin: { en: x }\n` });
    } catch (e) {
      expect(String(e)).toContain('did you mean "description"');
    }
  });

  it("rejects a language key that is neither en nor ja", () => {
    expect(() => load({ "demo@1.yml": `product: demo\nversion: "1"\nparameters:\n  timeout:\n    description: { enn: x }\n` })).toThrow(
      /description/
    );
  });

  it("rejects a container that carries a default", () => {
    // A container holds other objects and has no value of its own, so its
    // "default" is the empty shape of what it holds — an object, which the
    // resolver would hand out through String().
    expect(() =>
      load({ "demo@1.yml": `product: demo\nversion: "1"\nparameters:\n  policies:\n    kind: container\n    default: "x"\n` })
    ).toThrow(/policies/);
  });

  it("rejects a dictionary that documents nothing", () => {
    // A rule that matched nothing is reported everywhere else in this tool;
    // an extraction that produced no parameters is the same failure.
    expect(() => load({ "demo@1.yml": `product: demo\nversion: "1"\nparameters: {}\n` })).toThrow(/parameters/);
  });

  it("rejects an unknown provenance rather than treating it as untrusted", () => {
    expect(() => load({ "demo@1.yml": `product: demo\nversion: "1"\nprovenance: vendor\nparameters:\n  a:\n    default: "1"\n` })).toThrow(
      /provenance/
    );
  });

  it("declares exactly the fields the types declare", () => {
    // The compile-time half lives in providers/dictionary.ts (Exclude<>
    // assertions); this is the half that catches a field added to the type
    // and the list but never to the schema, where it would be REJECTED at
    // load time by additionalProperties.
    const param = (schema as { definitions: { parameter: { properties: Record<string, unknown> } } }).definitions.parameter;
    expect(Object.keys(param.properties).sort()).toEqual([...DICTIONARY_PARAM_FIELDS].sort());
    const doc = (schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(doc).sort()).toEqual([...DICTIONARY_DOC_FIELDS].sort());
  });
});

describe("overlay language keys", () => {
  it("rejects a description language the merge would silently ignore", () => {
    // parseOverlay is hand-written and NOT covered by the schema, and this is
    // the shape it used to let through: mergeOverlays reads `en`/`ja` off the
    // map, finds neither, and fills nothing — no error, no warning, no text.
    expect(() =>
      load({
        "demo@1.yml": VALID,
        "demo@1.overlay.yml": `product: demo\nversion: "1"\nparameters:\n  timeout:\n    description: { enn: "typo" }\n`,
      })
    ).toThrow(/unknown language "enn"/);
  });

  it("still accepts en and ja", () => {
    const doc = load({
      "demo@1.yml": VALID,
      "demo@1.overlay.yml": `product: demo\nversion: "1"\nparameters:\n  timeout:\n    description: { ja: "待ち時間" }\n`,
    });
    expect((doc?.parameters.timeout?.description as { ja?: string })?.ja).toBe("待ち時間");
  });
});

// An alias is a second spelling of ONE setting. A document that also gives it
// a key, or that hands it to two entries, is saying the setting is two — and
// the binder would have to pick, which is the one thing it never does quietly.
describe("dictionary aliases", () => {
  const base = "product: demo\nversion: \"1\"\nprovenance: official\ncoverage: partial\nparameters:\n";

  it("accepts an alias no key of its own claims", () => {
    const doc = parseDictionary(
      "d.yml",
      base + "  short:\n    description:\n      en: d\n    aliases: [long-form]\n"
    );
    expect(doc.parameters.short.aliases).toEqual(["long-form"]);
  });

  it("refuses an alias that is also a key", () => {
    expect(() =>
      parseDictionary("d.yml", base + "  short:\n    aliases: [other]\n  other:\n    description:\n      en: d\n")
    ).toThrow(/alias of "short" and a key of its own/);
  });

  it("refuses one alias claimed by two entries", () => {
    expect(() =>
      parseDictionary("d.yml", base + "  a:\n    aliases: [same]\n  b:\n    aliases: [same]\n")
    ).toThrow(/claimed by both/);
  });
});
