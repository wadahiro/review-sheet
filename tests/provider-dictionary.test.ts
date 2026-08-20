import { describe, it, expect } from "bun:test";
import { parse } from "yaml";
import { renderDictionary, provenanceFor, findDictionary, parseOverlay, type DictionaryDoc, type DictionaryParam } from "../src/providers/dictionary";
import { getMetadataProvider, pickLang, type MetadataContext } from "../src/metadata";
import type { Binding } from "../src/bind";
import "../src/providers/dictionary";

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

// A ready-made Binding, exactly what bind.ts's bindKey() would have already
// resolved before this provider ever sees the query (see metadata.ts's
// MetadataQuery.binding). The provider itself does no key matching or file
// loading anymore — that ground is covered by tests/bind.test.ts (tier
// precedence) and its "loadBindSources" tests (metadataDirs search order,
// missing-file error).
function binding(entry: DictionaryParam, overrides: Partial<Binding> = {}): Binding {
  return { product: "nginx", version: "1.26", dictKey: "listen", entry, method: "exact", ...overrides };
}

describe("dictionary metadata provider", () => {
  const provider = getMetadataProvider("dictionary")!;

  it("returns undefined when the query carries no binding (bind.ts found no dictionary counterpart)", () => {
    expect(provider.resolve({ key: "nginx_listen_port" }, ctx())).toBeUndefined();
  });

  it("resolves description/default/type/scope/docs_url straight off the binding's entry", () => {
    const entry: DictionaryParam = {
      description: { en: "Listen port", ja: "リッスンポート" },
      default: 80,
      type: "int",
      scope: "server",
      docs_url: "https://nginx.org/en/docs/http/ngx_http_core_module.html#listen",
    };
    const result = provider.resolve({ key: "listen", binding: binding(entry) }, ctx());
    expect(result?.description).toEqual({ en: "Listen port", ja: "リッスンポート" });
    expect(result?.default).toBe("80");
    expect(result?.type).toBe("int");
    expect(result?.scope).toBe("server");
    expect(result?.docs_url).toBe("https://nginx.org/en/docs/http/ngx_http_core_module.html#listen");
  });

  it("is language-agnostic: carries the full LangText through, pickLang resolves it downstream", () => {
    const entry: DictionaryParam = { description: { en: "Listen port", ja: "リッスンポート" } };
    const result = provider.resolve({ key: "listen", binding: binding(entry) }, ctx());
    expect(pickLang(result?.description, "ja")).toBe("リッスンポート");
    expect(pickLang(result?.description, "en")).toBe("Listen port");
  });

  it("coerces a numeric default to a string", () => {
    const result = provider.resolve({ key: "max_connections", binding: binding({ default: 100 }) }, ctx());
    expect(result?.default).toBe("100");
    expect(typeof result?.default).toBe("string");
  });

  // Where the defaults were read is a fact about the DOCUMENT (one dictionary
  // reads them from one place), so it rides on the binding, not the entry —
  // and it may only annotate a value that is actually there.
  it("carries the document's defaults_from onto a row that has a default", () => {
    const result = provider.resolve(
      { key: "rotate", binding: binding({ default: 4 }, { defaultsFrom: "/etc/logrotate.conf" }) },
      ctx()
    );
    expect(result?.default).toBe("4");
    expect(result?.default_from).toBe("/etc/logrotate.conf");
  });

  // Otherwise the sheet would print a source beside an empty cell, naming a
  // file for a value the dictionary never gives.
  it("leaves defaults_from off an entry that documents no default", () => {
    const result = provider.resolve(
      { key: "sharedscripts", binding: binding({ description: { en: "x" } }, { defaultsFrom: "/etc/logrotate.conf" }) },
      ctx()
    );
    expect(result?.default).toBeUndefined();
    expect(result?.default_from).toBeUndefined();
  });

  it("provenance precedence: the entry's own provenance wins over the dictionary document's", () => {
    const result = provider.resolve(
      { key: "worker_connections", binding: binding({ provenance: "community" }, { docProvenance: "official" }) },
      ctx()
    );
    expect(result?.provenance).toBe("community");
  });

  it("falls back to the dictionary document's provenance when the entry declares none", () => {
    const result = provider.resolve({ key: "listen", binding: binding({}, { docProvenance: "official" }) }, ctx());
    expect(result?.provenance).toBe("official");
  });

  it("falls back to community when neither the entry nor the document declare provenance", () => {
    const result = provider.resolve({ key: "listen", binding: binding({}) }, ctx());
    expect(result?.provenance).toBe("community");
  });

  it("doc-level provenance map + a bilingual entry with no override → the doc map, verbatim", () => {
    const entry: DictionaryParam = { description: { en: "Listen port", ja: "リッスンポート" } };
    const result = provider.resolve(
      { key: "listen", binding: binding(entry, { docProvenance: { en: "official", ja: "community" } }) },
      ctx()
    );
    expect(result?.provenance).toEqual({ en: "official", ja: "community" });
  });

  it("entry-level { ja } layered over a doc scalar → { en: <doc scalar>, ja: <entry override> }", () => {
    // The real keycloak@26.7.0 "db" case from the design doc: `en` has no
    // entry-level override, so it falls through to the document's scalar
    // `extracted`; `ja` is overridden at the entry.
    const result = provider.resolve(
      { key: "db", binding: binding({ provenance: { ja: "community" } }, { docProvenance: "extracted" }) },
      ctx()
    );
    expect(result?.provenance).toEqual({ en: "extracted", ja: "community" });
  });
});

// provenanceFor: the layered per-language resolution the dictionary provider
// builds its result from. Tests the exact order the design specifies — entry
// map's key -> entry scalar -> doc map's key -> doc scalar -> "community" —
// and, explicitly, that a map's MISSING key falls through to the NEXT LAYER
// rather than sideways to the map's OTHER language key (the one thing
// pickLang would get wrong here: pickLang's en<->ja fallback is right for
// prose, wrong for a trust claim — see the doc comment on provenanceFor).
describe("provenanceFor", () => {
  it("entry map's key wins outright when present", () => {
    expect(provenanceFor("ja", { en: "official", ja: "community" }, "extracted")).toBe("community");
  });

  it("entry scalar applies to every language", () => {
    expect(provenanceFor("en", "machine", { en: "official", ja: "community" })).toBe("machine");
    expect(provenanceFor("ja", "machine", { en: "official", ja: "community" })).toBe("machine");
  });

  it("entry map missing this language falls through to the doc map's key — NOT to the entry map's other key", () => {
    // If this fell back to the entry's own `en` (pickLang's behavior), it
    // would wrongly answer "official" instead of consulting the document.
    expect(provenanceFor("ja", { en: "official" }, { en: "extracted", ja: "community" })).toBe("community");
  });

  it("entry map missing this language, no doc map key either, falls through to the doc scalar", () => {
    expect(provenanceFor("ja", { en: "official" }, "extracted")).toBe("extracted");
  });

  it("no entry provenance at all falls straight to the doc layer", () => {
    expect(provenanceFor("en", undefined, { en: "official", ja: "community" })).toBe("official");
    expect(provenanceFor("en", undefined, "extracted")).toBe("extracted");
  });

  it("nothing at any layer defaults to community", () => {
    expect(provenanceFor("en", undefined, undefined)).toBe("community");
    // A doc map present but silent on THIS language still falls through to
    // "community" — not to the doc map's other language key.
    expect(provenanceFor("ja", undefined, { en: "official" })).toBe("community");
  });
});

// The dictionary SHAPE belongs to this package, so the per-product normalizers
// (a pg_settings dump, reflection over a container image, a docs scrape) should
// not each re-derive it from an example.
describe("renderDictionary", () => {
  const doc: DictionaryDoc = {
    product: "demo",
    version: "1",
    provenance: "extracted",
    generated_by: "a dump",
    docs_url: "https://example.test/docs",
    parameters: {
      b_key: { description: { en: "B", ja: "ビー" }, default: "off", group: "Group B" },
      a_key: { description: "A", type: "string", scope: "runtime" },
      c_container: { description: "A syntax container", kind: "container" },
    },
  };

  it("round-trips through the loader", () => {
    const parsed = parse(renderDictionary(doc)) as DictionaryDoc;
    expect(parsed.product).toBe("demo");
    expect(parsed.parameters.b_key.description).toEqual({ en: "B", ja: "ビー" });
    expect(parsed.parameters.b_key.group).toBe("Group B");
    expect(parsed.parameters.a_key.scope).toBe("runtime");
  });

  // `kind` is optional (omitted == "value", see the doc comment on
  // DictionaryParam) but must survive a round-trip when an entry does set it
  // — that's the only signal materializeDrafts() has to skip a syntax
  // container (see assemble.ts / materialize.test.ts).
  it("round-trips kind: container, and leaves kind unset (value) when omitted", () => {
    const parsed = parse(renderDictionary(doc)) as DictionaryDoc;
    expect(parsed.parameters.c_container.kind).toBe("container");
    expect(parsed.parameters.a_key.kind).toBeUndefined();
  });

  it("marks the file generated and cites where it came from", () => {
    const out = renderDictionary(doc, { generator: "normalize-x.ts", notes: ["English is the product's own."] });
    expect(out.startsWith("# GENERATED by normalize-x.ts — do not edit by hand.")).toBe(true);
    expect(out).toContain("# Source: a dump");
    expect(out).toContain("# English is the product's own.");
  });

  it("is deterministic, so a regenerated dictionary is an empty diff", () => {
    expect(renderDictionary(doc)).toBe(renderDictionary(doc));
  });

  it("does not wrap long prose (one value per line keeps diffs readable)", () => {
    const long = "x".repeat(200);
    const out = renderDictionary({ product: "p", version: "1", parameters: { k: { description: long } } });
    expect(out).toContain(long);
  });
});

// findDictionary: the overlay merge (T3). The base is written wholesale by a
// generator; an overlay (`<product>@<version>.overlay.yml`) is hand-authored
// and merged in HERE — the one function bind.ts's loadBindSources,
// assemble.ts's materialize, and (via Binding) this provider's resolve() all
// load a whole dictionary through, so this is the ONLY place these tests need
// to exercise to cover all three consumers.
describe("findDictionary: overlay merge", () => {
  // The design doc's own worked example, trimmed: `db` has English-only base
  // text (a bare string, per this repo's extraction convention — see
  // baseDescLangs's doc comment in dictionary.ts) that the overlay
  // gap-fills with `ja`; `db-dialect` has NO base description at all, and the
  // overlay supplies both languages under its own doc-level `provenance:
  // community`; `untouched` is never mentioned by any overlay.
  const BASE_YAML = `
product: widget
version: "1"
provenance: extracted
parameters:
  db:
    description: The database vendor.
    default: dev-file
  db-dialect:
    default: postgresql
  untouched:
    description: Never touched by any overlay.
    default: x
`;
  const OVERLAY_YAML = `
product: widget
version: "1"
provenance: community
parameters:
  db:
    description:
      ja: 使用するデータベースベンダー。
  db-dialect:
    description:
      en: JDBC dialect Hibernate uses.
      ja: Hibernate が使う JDBC ダイアレクト。
`;

  function filesWith(overrides: Record<string, string>): (p: string) => string | null {
    const files: Record<string, string> = { "dir1/widget@1.yml": BASE_YAML, ...overrides };
    return (p: string) => files[p] ?? null;
  }

  it("no overlay file present -> behaves exactly as before (regression)", () => {
    const readFile = filesWith({});
    const doc = findDictionary("widget", "1", ["dir1"], readFile)!;
    expect(doc.parameters.db.description).toBe("The database vendor.");
    expect(doc.parameters.db.provenance).toBeUndefined();
  });

  it("happy merge: fills the missing language; untouched entries stay bit-identical (same object reference)", () => {
    const base = parse(BASE_YAML) as DictionaryDoc;
    const readFile = filesWith({ "dir1/widget@1.overlay.yml": OVERLAY_YAML });
    const doc = findDictionary("widget", "1", ["dir1"], readFile)!;

    expect(doc.parameters.db.description).toEqual({
      en: "The database vendor.",
      ja: "使用するデータベースベンダー。",
    });
    // en falls through to the doc's "extracted" (provenanceFor's job, not
    // this merge's) — the merge itself only ever records the ja override.
    expect(doc.parameters.db.provenance).toEqual({ ja: "community" });

    expect(doc.parameters["db-dialect"].description).toEqual({
      en: "JDBC dialect Hibernate uses.",
      ja: "Hibernate が使う JDBC ダイアレクト。",
    });
    // Both languages filled under the SAME doc-level "community" claim ->
    // uniform -> collapses to the bare scalar, byte-identical to a plain
    // `provenance: community` entry.
    expect(doc.parameters["db-dialect"].provenance).toBe("community");

    expect(doc.parameters.untouched.description).toBe("Never touched by any overlay.");
    expect(doc.parameters.untouched.provenance).toBeUndefined();
  });

  it("base-now-supplies-ja -> error naming the key and language, verbatim wording", () => {
    const readFile = filesWith({
      "dir1/widget@1.overlay.yml": OVERLAY_YAML,
      // The regenerated base now ships its own ja for `db` too.
      "dir1/widget@1.yml": `
product: widget
version: "1"
provenance: extracted
parameters:
  db:
    description: { en: The database vendor., ja: 使用するデータベースベンダー（製品公式）。 }
  db-dialect:
    default: postgresql
  untouched:
    description: Never touched by any overlay.
`,
    });
    expect(() => findDictionary("widget", "1", ["dir1"], readFile)).toThrow(
      'the dictionary now supplies ja for "db" — drop it from the overlay.'
    );
  });

  it("unknown key -> error naming the key (renamed/removed upstream)", () => {
    const readFile = filesWith({
      "dir1/widget@1.overlay.yml": `
product: widget
version: "1"
parameters:
  db-charset:
    description: { en: Stale key., ja: 存在しないキー。 }
`,
    });
    expect(() => findDictionary("widget", "1", ["dir1"], readFile)).toThrow(
      'overlay names a key widget@1 no longer has: "db-charset"'
    );
  });

  it("overlay-sets-default -> rejected as an unknown field", () => {
    const readFile = filesWith({
      "dir1/widget@1.overlay.yml": `
product: widget
version: "1"
parameters:
  db:
    default: mysql
`,
    });
    expect(() => findDictionary("widget", "1", ["dir1"], readFile)).toThrow(/unknown field "default"/);
  });

  it("two overlays supplying the SAME language of the SAME key -> rejected", () => {
    const readFile = filesWith({
      "dir1/widget@1.overlay.yml": OVERLAY_YAML,
      "dir2/widget@1.overlay.yml": `
product: widget
version: "1"
parameters:
  db:
    description:
      ja: 二重翻訳。
`,
    });
    expect(() => findDictionary("widget", "1", ["dir1", "dir2"], readFile)).toThrow(/two overlays both supply ja for "db"/);
  });

  it("two overlays supplying DIFFERENT languages of the SAME key -> merge, not an error", () => {
    const readFile = filesWith({
      "dir1/widget@1.overlay.yml": `
product: widget
version: "1"
parameters:
  db:
    description:
      ja: 使用するデータベースベンダー。
`,
      "dir2/widget@1.overlay.yml": `
product: widget
version: "1"
provenance: official
parameters:
  db:
    docs_url: https://widget.example/docs#db
`,
    });
    const doc = findDictionary("widget", "1", ["dir1", "dir2"], readFile)!;
    expect(doc.parameters.db.description).toEqual({ en: "The database vendor.", ja: "使用するデータベースベンダー。" });
    expect(doc.parameters.db.docs_url).toBe("https://widget.example/docs#db");
  });

  it("overlay in a SECOND metadataDir overlays a base found in the FIRST", () => {
    const readFile = filesWith({ "dir2/widget@1.overlay.yml": OVERLAY_YAML });
    const doc = findDictionary("widget", "1", ["dir1", "dir2"], readFile)!;
    expect(doc.parameters.db.description).toEqual({ en: "The database vendor.", ja: "使用するデータベースベンダー。" });
  });

  it("overlay with no base -> hard error", () => {
    const readFile = (p: string): string | null => (p === "dir1/ghost@1.overlay.yml" ? OVERLAY_YAML.replace(/widget/g, "ghost") : null);
    expect(() => findDictionary("ghost", "1", ["dir1"], readFile)).toThrow(/no base dictionary ghost@1\.yml exists/);
  });

  it("overlay declaring a different product/version than its base -> error", () => {
    const readFile = filesWith({
      "dir1/widget@1.overlay.yml": `
product: widget
version: "2"
parameters: {}
`,
    });
    expect(() => findDictionary("widget", "1", ["dir1"], readFile)).toThrow(/product\/version must match its base/);
  });
});

// parseOverlay: strict structural validation, independent of the merge — a
// new format with no installed base to break, so unlike parseDictionary's lax
// four-field check it rejects anything it doesn't recognize outright.
describe("parseOverlay", () => {
  it("round-trips a well-formed overlay", () => {
    const doc = parseOverlay(
      "o.yml",
      `
product: widget
version: "1"
provenance: community
parameters:
  db:
    description: { ja: 訳 }
`
    );
    expect(doc.product).toBe("widget");
    expect(doc.parameters.db.description).toEqual({ ja: "訳" });
  });

  it("rejects an unknown top-level field, with a did-you-mean hint for a close typo", () => {
    expect(() =>
      parseOverlay(
        "o.yml",
        `
product: widget
version: "1"
provenence: community
parameters: {}
`
      )
    ).toThrow(/unknown field "provenence".*did you mean "provenance"/s);
  });

  it("rejects an unknown per-entry field (e.g. scope, group — product facts the overlay may not set)", () => {
    expect(() =>
      parseOverlay(
        "o.yml",
        `
product: widget
version: "1"
parameters:
  db:
    group: Database
`
      )
    ).toThrow(/parameter "db" has unknown field "group"/);
  });
});
