import { describe, it, expect } from "bun:test";
import { parse } from "yaml";
import { renderDictionary, type DictionaryDoc, type DictionaryParam } from "../src/providers/dictionary";
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
