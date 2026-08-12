import { describe, it, expect } from "bun:test";
import { structuralLocate, structuralEdit } from "../src/structural";
import { extractFile, inferFormat, buildInput, buildInputWithReport } from "../src/extract";
import { verifySources } from "../src/verify";
import { validateInput } from "../src/validate";
import type { SheetData } from "../src/prompt";

describe("inferFormat", () => {
  it("maps extensions to formats", () => {
    expect(inferFormat("/x/a.yaml")).toBe("yaml");
    expect(inferFormat("/x/a.yml")).toBe("yaml");
    expect(inferFormat("/x/a.json")).toBe("json");
    expect(inferFormat("/x/a.env")).toBe("dotenv");
    expect(inferFormat("/x/a.properties")).toBe("properties");
    expect(inferFormat("/x/a.ini")).toBe("ini");
    expect(inferFormat("/x/a.conf")).toBe("sysctl");
    expect(inferFormat("/x/sshd_config")).toBe("generic");
  });
});

describe("extractFile — line-oriented", () => {
  it("extracts key = value with line + anchor (sysctl)", () => {
    const e = extractFile("# c\nnet.core.somaxconn = 128\n", "/etc/sysctl.conf");
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ key: "net.core.somaxconn", value: "128" });
    expect(e[0].source).toEqual({ line: 2, anchor: "net.core.somaxconn =" });
  });

  it("skips comments and blank lines", () => {
    expect(extractFile("# only a comment\n\n; another\n", "/x.conf")).toHaveLength(0);
  });

  it("handles ini sections as categories", () => {
    const e = extractFile("[core]\nworkers = 4\n[cache]\nttl = 300\n", "/x.ini");
    expect(e.map((x) => x.categoryPath[0])).toEqual(["core", "cache"]);
    expect(e[1]).toMatchObject({ key: "ttl", value: "300" });
  });

  it("strips an `export` prefix for dotenv", () => {
    const e = extractFile("export API_KEY=secret\n", "/x.env");
    expect(e[0]).toMatchObject({ key: "API_KEY", value: "secret" });
    expect(e[0].source.anchor).toBe("API_KEY=");
  });

  it("supports whitespace-delimited files (space format)", () => {
    const e = extractFile("Port 22\nMaxClients 256\n", "/sshd", "space");
    expect(e[0]).toMatchObject({ key: "Port", value: "22" });
    expect(e[0].source.anchor).toBe("Port ");
  });

  it("uses the first delimiter so values may contain it", () => {
    const e = extractFile("url: http://example.com\n", "/x.properties");
    expect(e[0]).toMatchObject({ key: "url", value: "http://example.com" });
  });
});

describe("extractFile — YAML / JSON", () => {
  it("extracts nested YAML leaves with path + key anchor", () => {
    const e = extractFile("server:\n  host: 0.0.0.0\n  port: 8080\n", "/app.yaml");
    expect(e).toHaveLength(2);
    expect(e[1]).toMatchObject({ key: "port", value: "8080", categoryPath: ["server"] });
    expect(e[1].source).toEqual({ line: 3, anchor: "port:", path: "server.port" });
  });

  it("extracts from minified JSON with paths", () => {
    const e = extractFile('{"db":{"pool":10,"name":"main"}}', "/app.json");
    expect(e.map((x) => x.source.path)).toEqual(["db.pool", "db.name"]);
    expect(e[0]).toMatchObject({ key: "pool", value: "10", categoryPath: ["db"] });
  });

  it("indexes scalar sequence items by position", () => {
    const e = extractFile("hosts:\n  - a\n  - b\n", "/x.yaml");
    expect(e.map((x) => x.source.path)).toEqual(["hosts[0]", "hosts[1]"]);
    expect(e.map((x) => x.value)).toEqual(["a", "b"]);
  });

  it("addresses list-of-maps by an identity predicate (reorder-robust)", () => {
    const yaml = "services:\n  - name: web\n    port: 8080\n  - name: api\n    port: 9090\n";
    const e = extractFile(yaml, "/svc.yaml");
    // identity field (name) becomes the category + predicate; it is not a param
    expect(e.map((x) => x.source.path)).toEqual([
      "services[name=web].port",
      "services[name=api].port",
    ]);
    expect(e[0]).toMatchObject({ key: "port", value: "8080", categoryPath: ["services", "web"] });
  });

  it("falls back to index when list items have no identity field", () => {
    const yaml = "items:\n  - x: 1\n  - x: 2\n"; // no name/id/key
    const e = extractFile(yaml, "/x.yaml");
    expect(e.map((x) => x.source.path)).toEqual(["items[0].x", "items[1].x"]);
  });
});

// Keycloak's realm export identifies a client by `clientId` and carries none of
// name/id/key, so its clients get a positional `clients[0]` that silently starts
// pointing at a different client once the list is reordered. `idFields`
// (ExtractOptions) lets a caller name the real identity field, threaded as an
// ordinary argument all the way to `extractTree` — no process-wide state
// involved (see extract.ts's `resolveIdFields` writeup for why that matters).
describe("extractTree — configurable identity fields (ExtractOptions.idFields)", () => {
  const realm = [
    "clients:",
    "  - clientId: poc-oidc",
    "    name: OIDC demo",
    "    enabled: true",
    "  - clientId: poc-saml",
    "    name: SAML demo",
    "    enabled: false",
  ].join("\n");
  const paths = (yaml: string, idFields?: string[], file = "/realm.yaml") =>
    extractFile(yaml, file, undefined, idFields ? { idFields } : undefined).map((x) => x.source.path);

  const noName = realm.split("\n").filter((l) => !l.includes("name:")).join("\n");

  it("addresses by position when no field is configured", () => {
    // clientId stays an ordinary parameter; only the CHOSEN identity field is
    // dropped from its item's own params.
    expect(paths(noName)).toEqual([
      "clients[0].clientId", "clients[0].enabled",
      "clients[1].clientId", "clients[1].enabled",
    ]);
  });

  it("uses a configured field, which then stops being a parameter of its own", () => {
    expect(paths(noName, ["clientId"])).toEqual([
      "clients[clientId=poc-oidc].enabled",
      "clients[clientId=poc-saml].enabled",
    ]);
  });

  it("tries a configured field BEFORE the built-ins", () => {
    // Both clientId and name are present and unique; naming clientId is an
    // explicit statement about the data, and a display name is not the identity.
    expect(paths(realm, ["clientId"])).toEqual([
      "clients[clientId=poc-oidc].name",
      "clients[clientId=poc-oidc].enabled",
      "clients[clientId=poc-saml].name",
      "clients[clientId=poc-saml].enabled",
    ]);
  });

  it("ignores a configured field that is missing, falling back to the built-ins", () => {
    expect(paths(realm, ["nope"])[0]).toBe('clients[name="OIDC demo"].clientId');
  });

  it("ignores a configured field whose values are not unique", () => {
    // No identity → positional, and `tag` stays an ordinary parameter.
    expect(paths("items:\n  - tag: a\n    v: 1\n  - tag: a\n    v: 2\n", ["tag"])).toEqual([
      "items[0].tag", "items[0].v", "items[1].tag", "items[1].v",
    ]);
  });

  it("an empty idFields array means built-ins only", () => {
    expect(paths(realm, [])).toEqual([
      'clients[name="OIDC demo"].clientId',
      'clients[name="OIDC demo"].enabled',
      'clients[name="SAML demo"].clientId',
      'clients[name="SAML demo"].enabled',
    ]);
  });

  it("emits an identity value the path grammar can read back", () => {
    // A URL is bare-word-safe under the path grammar (`:` and `/` are allowed);
    // a value with a space is quoted. Either way it must round-trip.
    const url = "clients:\n  - clientId: https://host/saml/metadata\n    enabled: true\n";
    expect(paths(url, ["clientId"])[0]).toBe("clients[clientId=https://host/saml/metadata].enabled");
    expect(structuralLocate(url, paths(url, ["clientId"])[0]!)).toEqual({ value: "true" });

    const spaced = "clients:\n  - clientId: a client\n    enabled: true\n";
    expect(paths(spaced, ["clientId"])[0]).toBe('clients[clientId="a client"].enabled');
    expect(structuralLocate(spaced, paths(spaced, ["clientId"])[0]!)).toEqual({ value: "true" });
  });
});

// A key that itself contains a dot — e.g. Keycloak SAML client attributes
// (`saml.client.signature`) — is ambiguous with the path grammar's own `.`
// segment separator unless escaped. See src/extract.ts renderPath.
describe("extractFile — YAML keys containing a dot", () => {
  const yaml = [
    "clients:",
    "  - clientId: poc-saml",
    "    attributes:",
    '      saml.client.signature: "true"',
    "      saml.signature.algorithm: RSA_SHA256",
  ].join("\n");

  it("bracket-quotes a dotted key instead of joining it with `.`", () => {
    const e = extractFile(yaml, "/realm.yaml", undefined, { idFields: ["clientId"] });
    expect(e.map((x) => x.source.path)).toEqual([
      'clients[clientId=poc-saml].attributes["saml.client.signature"]',
      'clients[clientId=poc-saml].attributes["saml.signature.algorithm"]',
    ]);
  });

  it("the escaped path resolves via structuralLocate (real structural resolution, not a fluke)", () => {
    const e = extractFile(yaml, "/realm.yaml", undefined, { idFields: ["clientId"] });
    expect(structuralLocate(yaml, e[0]!.source.path!)).toEqual({ value: "true" });
    expect(structuralLocate(yaml, e[1]!.source.path!)).toEqual({ value: "RSA_SHA256" });
  });

  it("survives reordering the map's keys — the reorder-robust property line fallback cannot offer", () => {
    const reordered = [
      "clients:",
      "  - clientId: poc-saml",
      "    attributes:",
      "      saml.signature.algorithm: RSA_SHA256",
      '      saml.client.signature: "true"',
    ].join("\n");
    const e = extractFile(yaml, "/realm.yaml", undefined, { idFields: ["clientId"] });
    expect(structuralLocate(reordered, e[0]!.source.path!)).toEqual({ value: "true" });
    expect(structuralLocate(reordered, e[1]!.source.path!)).toEqual({ value: "RSA_SHA256" });
  });

  it("full round trip: extract -> structuralEdit succeeds and edits the right scalar", () => {
    const e = extractFile(yaml, "/realm.yaml", undefined, { idFields: ["clientId"] });
    const r = structuralEdit(yaml, "yaml", e[0]!.source.path!, "true", "false");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain('saml.client.signature: "false"');
    expect(r.content).toContain("saml.signature.algorithm: RSA_SHA256"); // untouched
  });
});

describe("buildInput — round-trips through verify", () => {
  it("produces a valid, verifiable model from mixed files", () => {
    const files = [
      { file: "/etc/sysctl.conf", content: "net.core.somaxconn = 128\n" },
      { file: "/app.yaml", content: "server:\n  port: 8080\n" },
      { file: "/app.json", content: '{"db":{"pool":10}}' },
    ];
    const input = buildInput(files);
    // Schema-valid.
    expect(() => validateInput(input)).not.toThrow();
    expect(input.sheets).toHaveLength(3);

    // Every generated source map verifies against the original content.
    const read = (p: string): string | null => files.find((f) => f.file === p)?.content ?? null;
    const out = verifySources(input as SheetData, read);
    expect(out.ok).toBe(3);
    expect(out.error).toBe(0);
  });

  it("skips files that yield no parameters", () => {
    const input = buildInput([{ file: "/empty.conf", content: "# nothing here\n" }]);
    expect(input.sheets).toHaveLength(0);
  });
});

// P10 bug 1: a zero-extraction file used to vanish without a trace the
// moment ANOTHER file in the same call produced something — buildInput's
// `continue` silently dropped it, and the CLI's "Extracted N parameter(s)
// from M file(s)" summary counted the file in `M` regardless. The report
// buildInputWithReport now returns is what lets a caller (the CLI's `import
// -f`) name the offender AND the parser that was picked, instead of a mixed
// import quietly losing a whole file's worth of rows.
describe("buildInputWithReport — per-file report", () => {
  it("reports a non-zero count and the resolved parser name for every file that contributed", () => {
    const files = [
      { file: "/etc/sysctl.conf", content: "net.core.somaxconn = 128\n" },
      { file: "/app.yaml", content: "server:\n  port: 8080\n" },
    ];
    const { report } = buildInputWithReport(files);
    expect(report.files).toEqual([
      { file: "/etc/sysctl.conf", parser: "sysctl", count: 1 },
      { file: "/app.yaml", parser: "yaml", count: 1 },
    ]);
  });

  it("reports count 0 (with the resolved parser's name) for a file that contributes nothing, even when mixed with a working file", () => {
    // The exact shape of the reported bug: mixing a working file with one
    // that ends up matched to the wrong parser (forced here via --format,
    // the same mechanism a misdetection like httpd.ts's isHttpd would hit —
    // see P10 bug 3) used to report "Extracted N from 2 files" with no sign
    // the second file contributed zero.
    const files = [
      { file: "/etc/httpd/httpd.conf", content: "ServerRoot /etc/httpd\nListen 80\n" }, // real params, httpd
      {
        file: "/etc/httpd/conf.d/proxy.conf",
        content: "ProxyRequests Off\nProxyPass /app http://localhost:8080/app\n",
        format: "sysctl" as const, // forced to the wrong parser -> no '=' to extract, 0 rows
      },
    ];
    const { input, report } = buildInputWithReport(files);
    expect(input.sheets).toHaveLength(1); // only httpd.conf's sheet — proxy.conf silently contributed nothing
    expect(report.files).toEqual([
      { file: "/etc/httpd/httpd.conf", parser: "httpd", count: 2 },
      { file: "/etc/httpd/conf.d/proxy.conf", parser: "sysctl", count: 0 },
    ]);
  });

  it("buildInput (no report) still behaves exactly like before", () => {
    const input = buildInput([{ file: "/empty.conf", content: "# nothing here\n" }]);
    expect(input.sheets).toHaveLength(0);
  });
});

// A null scalar states that there is no value, in every format that has one:
// YAML's `key:` with nothing after it, JSON's `"key": null`. Extracting it as
// the four characters "null" invents a value no format means, and on a
// machine-rendered artifact (a terraform plan writes null for every unset
// argument) that fabrication is the bulk of the file.
describe("extract: null scalars", () => {
  it("does not turn a YAML key with no value into the text \"null\"", () => {
    const entries = extractFile("a: 1\nb:\nc: 3\n", "/x.yml");
    expect(entries.map((e) => e.key)).toEqual(["a", "c"]);
    expect(entries.some((e) => e.value === "null")).toBe(false);
  });

  it("does not turn an explicit JSON null into the text \"null\"", () => {
    const entries = extractFile('{"a": 1, "b": null, "c": "3"}', "/x.json");
    expect(entries.map((e) => e.key)).toEqual(["a", "c"]);
  });

  it("still extracts the STRING \"null\", which is a real value", () => {
    const entries = extractFile('{"a": "null"}', "/x.json");
    expect(entries.map((e) => [e.key, e.value])).toEqual([["a", "null"]]);
  });
});
