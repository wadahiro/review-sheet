import { describe, it, expect } from "bun:test";
import { verifySources } from "../src/verify";
import type { SheetData } from "../src/prompt";

// A `ref` additional_sources entry marks a site that holds a *reference
// expression* to a value (`$(env:X)`), not the value itself — see
// types.ts's `ParameterBase.additional_sources`. verify checks it by
// CONTAINMENT, never equality, because a composed site
// (`https://$(env:X)/p`) never equals the bare reference text — only
// contains it. The fixture below deliberately includes both a whole-value
// site (`key:`) and a composed site (`url:`) to catch a real risk flagged in
// design review: `structuralLocate` returns the site's ACTUAL resolved
// value (not an echo of the `expected` argument passed to `locate`), so a
// naive equality check would wrongly fail every composed site.

function reader(map: Record<string, string>) {
  return (p: string): string | null => (p in map ? map[p] : null);
}

const envFile = "X=host.example.com\n";

// Both lines reference the same var, deliberately — the multi-site shape.
const yamlOk = ["key: $(env:X)", "url: https://$(env:X)/p"].join("\n");

function refSite(path: string) {
  return { file: "/config.yaml", path, anchor: "$(env:X)", ref: "$(env:X)" };
}

describe("verifySources — ref sites (containment, not equality)", () => {
  it("passes a whole-value ref site — equality is the containment special case", () => {
    const data: SheetData = {
      sheets: [{ name: "S", categories: [{ name: "C", params: [
        {
          key: "X",
          value: "host.example.com",
          source: { file: "/.env", line: 1, anchor: "X=" },
          additional_sources: [refSite("key")],
        },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/.env": envFile, "/config.yaml": yamlOk }));
    expect(out.error).toBe(0);
    expect(out.ok).toBe(2); // primary .env value + the ref site
    expect(out.checks.find((c) => c.file === "/config.yaml")?.status).toBe("ok");
  });

  it("passes a composed ref site by containment — the risk T2 exists to catch", () => {
    const data: SheetData = {
      sheets: [{ name: "S", categories: [{ name: "C", params: [
        {
          key: "X",
          value: "host.example.com",
          source: { file: "/.env", line: 1, anchor: "X=" },
          additional_sources: [refSite("url")],
        },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/.env": envFile, "/config.yaml": yamlOk }));
    expect(out.error).toBe(0);
    const check = out.checks.find((c) => c.file === "/config.yaml");
    expect(check?.status).toBe("ok");
    expect(check?.message).toBe("verified");
  });

  it("still passes a ref site resolved only via the line+anchor fallback", () => {
    // Only one occurrence of the anchor text in this file, so the fallback
    // scan (locateLine) is unambiguous. No `path` given, and the recorded
    // line is deliberately wrong to force the anchor rescan.
    const yamlSingleRef = ["key: $(env:X)", "other: unrelated"].join("\n");
    const data: SheetData = {
      sheets: [{ name: "S", categories: [{ name: "C", params: [
        {
          key: "X",
          value: "host.example.com",
          source: { file: "/.env", line: 1, anchor: "X=" },
          additional_sources: [{ file: "/config.yaml", line: 99, anchor: "$(env:X)", ref: "$(env:X)" }],
        },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/.env": envFile, "/config.yaml": yamlSingleRef }));
    expect(out.checks.find((c) => c.file === "/config.yaml")?.status).toBe("ok");
  });

  it("fails when the wiring is broken — the reference text is no longer present (hardcoded)", () => {
    const yamlHardcoded = ["key: $(env:X)", "url: https://otherhost.example.com/p"].join("\n");
    const data: SheetData = {
      sheets: [{ name: "S", categories: [{ name: "C", params: [
        {
          key: "X",
          value: "host.example.com",
          source: { file: "/.env", line: 1, anchor: "X=" },
          additional_sources: [refSite("url")],
        },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/.env": envFile, "/config.yaml": yamlHardcoded }));
    const check = out.checks.find((c) => c.file === "/config.yaml");
    expect(check?.status).toBe("error");
    expect(check?.message).toContain('reference "$(env:X)"');
    expect(check?.message).toContain("no longer present");
  });

  it("fails when a ref site cannot be located at all", () => {
    const data: SheetData = {
      sheets: [{ name: "S", categories: [{ name: "C", params: [
        {
          key: "X",
          value: "host.example.com",
          source: { file: "/.env", line: 1, anchor: "X=" },
          additional_sources: [{ file: "/config.yaml", anchor: "$(env:MISSING)", ref: "$(env:MISSING)" }],
        },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/.env": envFile, "/config.yaml": yamlOk }));
    const check = out.checks.find((c) => c.file === "/config.yaml");
    expect(check?.status).toBe("error");
    expect(check?.message).toContain('reference "$(env:MISSING)"');
    expect(check?.message).toContain("not found");
  });

  it("skips a ref site the same as any other value when the parameter is out of scope", () => {
    const data: SheetData = {
      sheets: [{ name: "S", categories: [{ name: "C", out_of_scope: { reason: "not our system" }, params: [
        {
          key: "X",
          value: "host.example.com",
          source: { file: "/.env", line: 1, anchor: "X=" },
          additional_sources: [refSite("key")],
        },
      ] }] }],
    };
    const out = verifySources(data, reader({ "/.env": envFile, "/config.yaml": yamlOk }));
    expect(out.out_of_scope).toBe(2); // primary + the ref site
    expect(out.error).toBe(0);
  });

  it("collects a ref site once per parameter, not once per Pattern B instance", () => {
    const data: SheetData = {
      sheets: [{ name: "S", categories: [{ name: "C", params: [
        {
          key: "X",
          instances: [
            { name: "prod", value: "host-a.example.com", source: { file: "/prod.env", line: 1, anchor: "X=" } },
            { name: "dev", value: "host-b.example.com", source: { file: "/dev.env", line: 1, anchor: "X=" } },
          ],
          additional_sources: [refSite("key")],
        },
      ] }] }],
    };
    const out = verifySources(
      data,
      reader({ "/prod.env": "X=host-a.example.com\n", "/dev.env": "X=host-b.example.com\n", "/config.yaml": yamlOk })
    );
    // 2 instance checks + exactly 1 ref-site check, not 2 (one per instance).
    expect(out.checks.length).toBe(3);
    expect(out.checks.filter((c) => c.file === "/config.yaml").length).toBe(1);
    expect(out.ok).toBe(3);
  });
});
