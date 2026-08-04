import { describe, it, expect } from "bun:test";
import { tomlIndex, tomlEdit, tomlLocate } from "../src/toml";
import { extractFile } from "../src/extract";
import { computeApply } from "../src/apply";
import { verifySources } from "../src/verify";
import type { SheetData, ReviewItem } from "../src/prompt";

const toml = `title = "demo"

[server]
host = "0.0.0.0"
port = 8080

[server.tls]
enabled = true

[[service]]
name = "web"
replicas = 2

[[service]]
name = "api"
replicas = 3
`;

describe("tomlIndex", () => {
  it("handles top-level keys, nested tables, and array-of-tables by identity", () => {
    const paths = tomlIndex(toml).map((e) => `${e.path}=${e.value}`);
    expect(paths).toEqual([
      "title=demo",
      "server.host=0.0.0.0",
      "server.port=8080",
      "server.tls.enabled=true",
      "service[name=web].replicas=2",
      "service[name=api].replicas=3",
    ]);
  });

  it("extractFile routes .toml through the TOML adapter", () => {
    const e = extractFile(toml, "/x/config.toml");
    expect(e.find((x) => x.source.path === "server.port")).toMatchObject({ key: "port", value: "8080" });
    expect(e.find((x) => x.source.path === "service[name=web].replicas")).toMatchObject({ key: "replicas", value: "2", categoryPath: ["service", "web"] });
  });
});

describe("tomlEdit / tomlLocate", () => {
  it("edits a bare value", () => {
    const r = tomlEdit(toml, "server.port", "8080", "9090");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("port = 9090");
  });

  it("edits a quoted string, preserving quotes", () => {
    const r = tomlEdit(toml, "server.host", "0.0.0.0", "127.0.0.1");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain('host = "127.0.0.1"');
  });

  it("is idempotent and detects a stale value", () => {
    expect(tomlEdit(toml, "server.port", "x", "8080").status).toBe("skipped");
    expect(tomlEdit(toml, "server.port", "wrong", "9090").status).toBe("error");
  });

  it("locates by path", () => {
    expect(tomlLocate(toml, "service[name=api].replicas")).toEqual({ value: "3" });
  });
});

describe("apply/verify TOML reorder robustness", () => {
  const reordered = `[[service]]
name = "api"
replicas = 3

[[service]]
name = "web"
replicas = 2
`;
  const data: SheetData = {
    sheets: [{ name: "S", file_path: "/c.toml", categories: [{ name: "C", params: [{ key: "p", value: "2", source: { path: "service[name=web].replicas" } }] }] }],
  };
  const read = (): string => reordered;

  it("applies to the identity-matched table after a reorder", () => {
    const reviews: ReviewItem[] = [
      { id: "r", status: "pending", target: { sheet: "S", category: "C", param: "p", field: "value" }, changes: [{ field: "value", current: "2", suggested: "5" }] },
    ];
    const out = computeApply(data, reviews, read);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain('name = "web"\nreplicas = 5');
    expect(out.files[0].content).toContain('name = "api"\nreplicas = 3');
  });

  it("verifies by path after a reorder", () => {
    const out = verifySources(data, read);
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
  });
});
