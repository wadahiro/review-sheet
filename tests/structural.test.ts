import { describe, it, expect } from "bun:test";
import { parseSteps, inferFormat, structuralEdit, structuralLocate, structuredFormat, STRUCTURED_FORMATS } from "../src/structural";
import { listParsers } from "../src/parser";
import "../src/parsers/index.js";
import { computeApply } from "../src/apply";
import { verifySources } from "../src/verify";
import type { SheetData, ReviewItem } from "../src/prompt";

describe("parseSteps / inferFormat", () => {
  it("parses keys, indexes, and identity predicates", () => {
    expect(parseSteps("$.server.port")).toEqual([{ kind: "key", key: "server" }, { kind: "key", key: "port" }]);
    expect(parseSteps("hosts[0]")).toEqual([{ kind: "key", key: "hosts" }, { kind: "index", index: 0 }]);
    expect(parseSteps("services[name=web].port")).toEqual([
      { kind: "key", key: "services" },
      { kind: "filter", field: "name", value: "web" },
      { kind: "key", key: "port" },
    ]);
    expect(parseSteps('services[name="a b"].port')).toEqual([
      { kind: "key", key: "services" },
      { kind: "filter", field: "name", value: "a b" },
      { kind: "key", key: "port" },
    ]);
  });
  it("parses a bracket-quoted key as one segment, not nested keys (dotted-key escape)", () => {
    // The interpretation side already understood `["..."]` as a key (it was
    // added for quoted identity-predicate values); extract.ts's renderPath
    // now actually emits it for keys that themselves contain a dot.
    expect(parseSteps('attributes["saml.client.signature"]')).toEqual([
      { kind: "key", key: "attributes" },
      { kind: "key", key: "saml.client.signature" },
    ]);
    // As the very first segment too (no leading dot).
    expect(parseSteps('["saml.client.signature"]')).toEqual([{ kind: "key", key: "saml.client.signature" }]);
    // Mixed with an identity predicate ahead of it.
    expect(parseSteps('clients[clientId="poc-saml"].attributes["saml.client.signature"]')).toEqual([
      { kind: "key", key: "clients" },
      { kind: "filter", field: "clientId", value: "poc-saml" },
      { kind: "key", key: "attributes" },
      { kind: "key", key: "saml.client.signature" },
    ]);
  });
  it("infers format from extension", () => {
    expect(inferFormat("/x/app.yaml")).toBe("yaml");
    expect(inferFormat("/x/app.YML")).toBe("yaml");
    expect(inferFormat("/x/app.json")).toBe("json");
    expect(inferFormat("/x/app.conf")).toBe(null);
  });
});

describe("reorder robustness (the map-vs-list distinction)", () => {
  const reviews = (current: string, suggested: string): ReviewItem[] => [
    { id: "r", status: "pending", target: { sheet: "S", category: "C", param: "p", field: "value" }, changes: [{ field: "value", current, suggested }] },
  ];
  const data = (path: string, value: string): SheetData => ({
    sheets: [{ name: "S", file_path: "/f.yaml", categories: [{ name: "C", params: [{ key: "p", value, source: { path } }] }] }],
  });

  it("resolves a map value after the KEYS are reordered (path = key)", () => {
    const reordered = "server:\n  port: 8080\n  host: 0.0.0.0\n"; // keys swapped vs authoring order
    const out = computeApply(data("server.port", "8080"), reviews("8080", "9090"), () => reordered);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("port: 9090");
  });

  it("resolves a list-of-maps value after the ITEMS are reordered (path = identity predicate)", () => {
    const reordered = "services:\n  - name: api\n    port: 9090\n  - name: web\n    port: 8080\n"; // web/api swapped
    const out = computeApply(data("services[name=web].port", "8080"), reviews("8080", "8888"), () => reordered);
    expect(out.applied).toBe(1);
    // edited web's port (now the 2nd item), not api's
    expect(out.files[0].content).toBe("services:\n  - name: api\n    port: 9090\n  - name: web\n    port: 8888\n");
  });

  it("verify also follows the identity predicate after a list reorder", () => {
    const reordered = "services:\n  - name: api\n    port: 9090\n  - name: web\n    port: 8080\n";
    const out = verifySources(data("services[name=web].port", "8080"), () => reordered);
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
  });

  it("resolves a dotted-key value after its sibling keys are reordered — true structural resolution, no line fallback", () => {
    const path = 'attributes["saml.client.signature"]';
    const original = 'attributes:\n  saml.client.signature: "true"\n  saml.signature.algorithm: RSA_SHA256\n';
    const reordered = 'attributes:\n  saml.signature.algorithm: RSA_SHA256\n  saml.client.signature: "true"\n';
    const out = computeApply(data(path, "true"), reviews("true", "false"), () => reordered);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toBe(
      'attributes:\n  saml.signature.algorithm: RSA_SHA256\n  saml.client.signature: "false"\n'
    );
    // Sanity: the original (unreordered) content resolves the same way.
    expect(structuralLocate(original, path)).toEqual({ value: "true" });
  });
});

describe("structuralEdit", () => {
  it("edits a nested YAML scalar in place, preserving formatting", () => {
    const yaml = "server:\n  host: 0.0.0.0\n  port: 8080  # listen\n";
    const r = structuralEdit(yaml, "yaml", "$.server.port", "8080", "9090");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toBe("server:\n  host: 0.0.0.0\n  port: 9090  # listen\n");
  });

  it("edits a value inside minified JSON", () => {
    const json = '{"server":{"port":8080,"host":"x"}}';
    const r = structuralEdit(json, "json", "server.port", "8080", "9090");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toBe('{"server":{"port":9090,"host":"x"}}');
  });

  it("preserves double quotes for JSON string values", () => {
    const json = '{"a":"old"}';
    const r = structuralEdit(json, "json", "a", "old", "new");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toBe('{"a":"new"}');
  });

  it("quotes a JSON string value that replaces a numeric plain scalar", () => {
    const json = '{"a":1}';
    const r = structuralEdit(json, "json", "a", "1", "two");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toBe('{"a":"two"}');
  });

  it("edits an array element by index", () => {
    const yaml = "hosts:\n  - a\n  - b\n";
    const r = structuralEdit(yaml, "yaml", "hosts[1]", "b", "c");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toBe("hosts:\n  - a\n  - c\n");
  });

  it("is idempotent when already at the suggested value", () => {
    const yaml = "a: 2\n";
    expect(structuralEdit(yaml, "yaml", "a", "1", "2").status).toBe("skipped");
  });

  it("errors on a value mismatch (stale current)", () => {
    const yaml = "a: 5\n";
    const r = structuralEdit(yaml, "yaml", "a", "1", "2");
    expect(r.status).toBe("error");
  });

  it("defers YAML block scalars", () => {
    const yaml = "msg: |\n  line1\n  line2\n";
    const r = structuralEdit(yaml, "yaml", "msg", "line1\nline2\n", "x");
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.reason).toContain("block scalar");
  });

  it("errors when the path is not found", () => {
    expect(structuralEdit("a: 1\n", "yaml", "b.c", "1", "2").status).toBe("error");
  });
});

describe("structuralLocate", () => {
  it("reads a nested value", () => {
    const r = structuralLocate("server:\n  port: 8080\n", "$.server.port");
    expect(r).toEqual({ value: "8080" });
  });
});

// Integration: a repeated leaf key that line+anchor cannot isolate, rescued by path.
describe("apply/verify structural fallback", () => {
  const yaml = "services:\n  web:\n    port: 8080\n  api:\n    port: 9090\n";
  const data: SheetData = {
    sheets: [
      {
        name: "S",
        categories: [
          {
            name: "C",
            params: [
              // anchor "port:" is ambiguous (two matches); path disambiguates.
              { key: "web.port", value: "8080", source: { file: "/svc.yaml", anchor: "port:", path: "$.services.web.port" } },
            ],
          },
        ],
      },
    ],
  };
  const read = (p: string): string | null => (p === "/svc.yaml" ? yaml : null);

  it("applies via path when the anchor alone is ambiguous", () => {
    const reviews: ReviewItem[] = [
      {
        id: "r1",
        status: "pending",
        target: { sheet: "S", category: "C", param: "web.port", field: "value" },
        changes: [{ field: "value", current: "8080", suggested: "8888" }],
      },
    ];
    const out = computeApply(data, reviews, read);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("web:\n    port: 8888");
    expect(out.files[0].content).toContain("api:\n    port: 9090"); // untouched
  });

  it("verifies the ambiguous-but-pathed value as ok", () => {
    const out = verifySources(data, read);
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
  });
});

// STRUCTURED_FORMATS is a hand-written list of what `structuredFormat` can
// return, kept so a caller holding a format NAME rather than a file name can
// ask the same question. A hand-written list drifts; this is what notices.
describe("STRUCTURED_FORMATS", () => {
  it("names only registered parsers", () => {
    const known = new Set(listParsers().map((p) => p.name));
    for (const f of STRUCTURED_FORMATS) expect(known.has(f), `${f} names no parser`).toBe(true);
  });

  it("covers every format structuredFormat can return", () => {
    // One witness file per branch of structuredFormat, so a branch added there
    // without a member here fails rather than silently answering "not
    // structured" for a format that is.
    for (const file of ["a.yml", "a.yaml", "a.json", "a.xml", "a.toml", "a.service", "x.conf.d/a.conf"]) {
      const f = structuredFormat(file);
      expect(f, `${file} resolved no structured format`).not.toBeNull();
      expect(STRUCTURED_FORMATS.has(f!), `${file} -> ${f} is missing from STRUCTURED_FORMATS`).toBe(true);
    }
  });
});
