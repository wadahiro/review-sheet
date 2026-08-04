import { describe, it, expect } from "bun:test";
import { verifySources } from "../src/verify";
import type { SheetData } from "../src/prompt";

const file = ["# header", "drift = 1", "fin_timeout = 60", "dup = 1", "dup = 1"].join("\n");

function reader(map: Record<string, string>) {
  return (p: string): string | null => (p in map ? map[p] : null);
}

function sheet(params: SheetData["sheets"][number]["categories"][number]["params"]): SheetData {
  return {
    sheets: [{ name: "S", file_path: "/etc/conf", categories: [{ name: "C", params }] }],
  };
}

describe("verifySources", () => {
  it("reports ok when the value is found at the located line", () => {
    const data = sheet([{ key: "fin_timeout", value: "60", source: { line: 3, anchor: "fin_timeout" } }]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
    expect(out.checks[0].status).toBe("ok");
  });

  it("re-locates by anchor when the line is wrong (still ok)", () => {
    const data = sheet([{ key: "drift", value: "1", source: { line: 1, anchor: "drift" } }]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.ok).toBe(1);
  });

  it("flags a stale value / wrong anchor as an error", () => {
    const data = sheet([{ key: "fin_timeout", value: "999", source: { line: 3, anchor: "fin_timeout" } }]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.error).toBe(1);
    expect(out.checks[0].message).toContain("not found");
  });

  it("warns on an ambiguous anchor", () => {
    const data = sheet([{ key: "dup", value: "1", source: { anchor: "dup" } }]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.warn).toBe(1);
    expect(out.checks[0].status).toBe("warn");
  });

  it("errors when the source file is not readable", () => {
    const data = sheet([{ key: "fin_timeout", value: "60", source: { file: "/missing", line: 3, anchor: "fin_timeout" } }]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.error).toBe(1);
    expect(out.checks[0].message).toContain("not readable");
  });

  it("warns (not errors) when a generated source's file is missing", () => {
    const data = sheet([
      { key: "fin_timeout", value: "60", source: { file: "/build/generated.conf", line: 3, anchor: "fin_timeout", generated: true } },
    ]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.warn).toBe(1);
    expect(out.error).toBe(0);
    expect(out.checks[0].status).toBe("warn");
  });

  it("still verifies a generated source normally when its file exists", () => {
    const data = sheet([
      { key: "fin_timeout", value: "60", source: { file: "/etc/conf", line: 3, anchor: "fin_timeout", generated: true } },
    ]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
  });

  it("marks a value with no locator as unmapped (not an error)", () => {
    const data = sheet([{ key: "fin_timeout", value: "60" }]); // inherits file, but no line/anchor
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.unmapped).toBe(1);
    expect(out.error).toBe(0);
  });

  it("verifies each Pattern B instance value against its own file", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "App",
          categories: [
            {
              name: "Server",
              params: [
                {
                  key: "port",
                  instances: [
                    { name: "prod", value: "8080", source: { file: "/p.yaml", line: 1, anchor: "port:" } },
                    { name: "dev", value: "9999", source: { file: "/d.yaml", line: 1, anchor: "port:" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const out = verifySources(data, reader({ "/p.yaml": "port: 8080", "/d.yaml": "port: 8080" }));
    expect(out.ok).toBe(1); // prod matches
    expect(out.error).toBe(1); // dev value 9999 not present
  });
});

// A key that itself contains dots (Keycloak's `saml.client.signature`) cannot be
// told apart from nesting by the structural path grammar, so the path never
// resolves and the line+anchor fallback answers instead. It answers CORRECTLY, so
// this stays `ok` — but reporting it as a clean structural hit hid a source map
// that any reordering of the file would break.
describe("verifySources — line fallback after an unresolved structural path", () => {
  const yaml = ["attributes:", '  saml.client.signature: "true"'].join("\n");

  it("still counts as ok, but is flagged and counted apart", () => {
    const data: SheetData = {
      sheets: [{ name: "S", file_path: "/realm.yaml", categories: [{ name: "C", params: [
        { key: "saml.client.signature", value: "true", source: { line: 2, anchor: "saml.client.signature:", path: "attributes.saml.client.signature" } },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/realm.yaml": yaml }));
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
    expect(out.fallback).toBe(1);
    expect(out.checks[0].status).toBe("ok");
    expect(out.checks[0].fallback).toContain("did not resolve");
    expect(out.checks[0].message).toContain("line fallback");
  });

  it("does not flag a value whose structural path resolves", () => {
    const data: SheetData = {
      sheets: [{ name: "S", file_path: "/ok.yaml", categories: [{ name: "C", params: [
        { key: "host", value: "db", source: { line: 2, anchor: "host:", path: "database.host" } },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/ok.yaml": "database:\n  host: db" }));
    expect(out.ok).toBe(1);
    expect(out.fallback).toBe(0);
    expect(out.checks[0].fallback).toBeUndefined();
  });

  it("does not flag a value that never claimed a structural path", () => {
    const data = sheet([{ key: "fin_timeout", value: "60", source: { line: 3, anchor: "fin_timeout" } }]);
    const out = verifySources(data, reader({ "/etc/conf": file }));
    expect(out.fallback).toBe(0);
    expect(out.checks[0].fallback).toBeUndefined();
  });
});
