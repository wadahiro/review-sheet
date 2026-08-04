// `origin: "default"` — the product's own default, set NOWHERE in our
// deliverable. The row exists so a sheet can be the exhaustive ledger of a
// product's parameters; it carries a value (the documented default) but no
// source, which verify and apply both have to treat as "nothing to resolve"
// rather than "a source map that failed".

import { describe, it, expect } from "bun:test";
import { validateInput } from "../src/validate";
import { verifySources } from "../src/verify";
import { computeApply } from "../src/apply";
import { effectiveOrigin, HELD_REASON_DEFAULT, type SheetData, type ReviewItem } from "../src/prompt";

// The sheet's file_path is the trap: a default row must NOT be edited into the
// nearest file just because one is in scope up the tree.
const data: SheetData = {
  sheets: [
    {
      name: "postgresql",
      file_path: "/etc/postgresql.conf",
      categories: [
        {
          name: "Memory",
          params: [
            { key: "shared_buffers", value: "512MB", source: { line: 1, anchor: "shared_buffers" } },
            // Not set by us: the product's compiled-in default.
            { key: "work_mem", value: "4MB", default: "4MB", origin: "default" },
          ],
        },
      ],
    },
  ],
};

const conf = ["shared_buffers = 512MB", "# work_mem is not set here"].join("\n");
const readFile = (p: string): string | null => (p === "/etc/postgresql.conf" ? conf : null);

function review(target: ReviewItem["target"], current: string, suggested: string): ReviewItem {
  return { id: "r1", status: "pending", target, changes: [{ field: "value", current, suggested }] };
}

describe("origin: default", () => {
  it("is accepted by the input schema and never derived", () => {
    const input = validateInput({
      sheets: [
        {
          name: "s",
          categories: [{ name: "c", params: [{ key: "k", value: "v", origin: "default" }] }],
        },
      ],
    });
    expect(input.sheets[0].categories![0].params![0].origin).toBe("default");

    // A row with no explicit origin still derives common/overlay — "we set
    // nothing here" is not something the shape of a row can prove.
    expect(effectiveOrigin({ value: "v" } as { origin?: undefined })).toBe("common");
    expect(effectiveOrigin({ instances: [{ name: "prod", value: "v" }] })).toBe("overlay");
  });

  it("verify counts it apart from unmapped instead of reporting a gap", () => {
    const outcome = verifySources(data, readFile);

    expect(outcome.ok).toBe(1); // the value we do set
    expect(outcome.default).toBe(1);
    expect(outcome.unmapped).toBe(0); // the whole point: not a source-map failure
    expect(outcome.error).toBe(0);

    const check = outcome.checks.find((c) => c.target.param === "work_mem");
    expect(check?.status).toBe("default");
    expect(check?.message).toContain("nothing set");
  });

  it("apply holds a change on it instead of editing the nearest file", () => {
    const out = computeApply(
      data,
      [review({ sheet: "postgresql", category: "Memory", param: "work_mem", field: "value" }, "4MB", "64MB")],
      readFile
    );

    expect(out.applied).toBe(0);
    expect(out.files.length).toBe(0); // /etc/postgresql.conf untouched
    expect(out.results.map((r) => [r.status, r.reason])).toEqual([["held", HELD_REASON_DEFAULT]]);
    // Held changes ride the AI prompt, whose protocol covers adding a setting
    // that isn't there yet.
    expect(out.heldPrompt).toContain("work_mem");
    expect(out.heldPrompt).toContain("64MB");
  });

  it("still applies normally to a value we do set", () => {
    const out = computeApply(
      data,
      [review({ sheet: "postgresql", category: "Memory", param: "shared_buffers", field: "value" }, "512MB", "1GB")],
      readFile
    );

    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("shared_buffers = 1GB");
  });
});
