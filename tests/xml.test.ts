import { describe, it, expect } from "bun:test";
import { xmlIndex, xmlEdit, xmlLocate } from "../src/xml";
import { extractFile } from "../src/extract";
import { computeApply } from "../src/apply";
import { verifySources } from "../src/verify";
import type { SheetData, ReviewItem } from "../src/prompt";

const xml = `<server>
  <connector port="8080" proto="http"/>
  <services>
    <service name="web"><port>3000</port></service>
    <service name="api"><port>4000</port></service>
  </services>
</server>`;

describe("xmlIndex", () => {
  it("indexes attributes and element text with reorder-robust paths", () => {
    const paths = xmlIndex(xml).map((e) => `${e.path}=${e.value}`);
    expect(paths).toEqual([
      "server.connector.@port=8080",
      "server.connector.@proto=http",
      "server.services.service[name=web].port=3000",
      "server.services.service[name=api].port=4000",
    ]);
  });

  it("extractFile routes .xml through the XML adapter", () => {
    const e = extractFile(xml, "/x/server.xml");
    expect(e[0]).toMatchObject({ key: "@port", value: "8080", source: { path: "server.connector.@port" } });
    expect(e.find((x) => x.source.path === "server.services.service[name=web].port")).toMatchObject({ key: "port", value: "3000" });
  });
});

describe("xmlEdit / xmlLocate", () => {
  it("edits element text in place, preserving formatting", () => {
    const r = xmlEdit(xml, "server.services.service[name=web].port", "3000", "3999");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("<service name=\"web\"><port>3999</port>");
    expect(r.content).toContain("<service name=\"api\"><port>4000</port>"); // untouched
  });

  it("edits an attribute value", () => {
    const r = xmlEdit(xml, "server.connector.@port", "8080", "9090");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain('<connector port="9090" proto="http"/>');
  });

  it("is idempotent and detects a stale value", () => {
    expect(xmlEdit(xml, "server.connector.@port", "x", "8080").status).toBe("skipped");
    expect(xmlEdit(xml, "server.connector.@port", "wrong", "9090").status).toBe("error");
  });

  it("locates a value", () => {
    expect(xmlLocate(xml, "server.services.service[name=api].port")).toEqual({ value: "4000" });
  });
});

describe("apply/verify XML reorder robustness", () => {
  const reordered = `<server>
  <services>
    <service name="api"><port>4000</port></service>
    <service name="web"><port>3000</port></service>
  </services>
</server>`;
  const data: SheetData = {
    sheets: [{ name: "S", file_path: "/server.xml", categories: [{ name: "C", params: [{ key: "p", value: "3000", source: { path: "server.services.service[name=web].port" } }] }] }],
  };
  const read = (): string => reordered;

  it("applies to the identity-matched element after a reorder", () => {
    const reviews: ReviewItem[] = [
      { id: "r", status: "pending", target: { sheet: "S", category: "C", param: "p", field: "value" }, changes: [{ field: "value", current: "3000", suggested: "3999" }] },
    ];
    const out = computeApply(data, reviews, read);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain('<service name="web"><port>3999</port>');
    expect(out.files[0].content).toContain('<service name="api"><port>4000</port>');
  });

  it("verifies by path after a reorder", () => {
    const out = verifySources(data, read);
    expect(out.ok).toBe(1);
    expect(out.error).toBe(0);
  });
});
