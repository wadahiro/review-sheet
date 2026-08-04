import { describe, it, expect } from "bun:test";
import { buildPromptText, effectiveOrigin } from "../src/prompt";
import withSourceFixture from "./fixtures/with-source.json";
import type { ParameterSheetInput, ReviewItem } from "../src/types";
import type { SheetData } from "../src/prompt";

// buildPromptText expects the embedded sheet-data shape; the validated input
// model is structurally identical, so the fixture stands in for it directly.
const data = withSourceFixture as ParameterSheetInput;

function review(partial: Partial<ReviewItem> & { target: ReviewItem["target"] }): ReviewItem {
  return { id: "r", comment: "", status: "pending", ...partial };
}

describe("buildPromptText", () => {
  it("returns empty string when there are no pending reviews", () => {
    const text = buildPromptText([], data as never);
    expect(text).toBe("");
  });

  it("groups a value change under its resolved source file with line + anchor", () => {
    const reviews = [
      review({
        target: { sheet: "OS Tuning", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "value" },
        changes: [{ field: "value", current: "60", suggested: "30" }],
        comment: "Reduce TIME_WAIT for high-connection workloads.",
      }),
    ];
    const text = buildPromptText(reviews as never, data as never);
    // English boilerplate (always), not localized.
    expect(text).toContain("# Configuration change requests");
    expect(text).toContain("Resolve every");
    // File grouping + precise location.
    expect(text).toContain("## File: /etc/sysctl.conf");
    expect(text).toContain("line 42");
    expect(text).toContain("anchor: `net.ipv4.tcp_fin_timeout =`");
    expect(text).toContain('value: "60" -> "30"');
    // Reviewer comment kept verbatim.
    expect(text).toContain("reason: Reduce TIME_WAIT for high-connection workloads.");
  });

  it("resolves per-instance source files and labels the instance", () => {
    const reviews = [
      review({
        target: { sheet: "Application", category: "Server", param: "server.port", instance: "prod", field: "value" },
        changes: [{ field: "value", current: "8080", suggested: "9090" }],
        comment: "New prod port.",
      }),
    ];
    const text = buildPromptText(reviews as never, data as never);
    expect(text).toContain("## File: /etc/app/config.prod.yaml");
    expect(text).toContain("[instance: prod]");
    expect(text).toContain("path: $.server.port");
    expect(text).toContain("line 17");
  });

  it("keeps a sheet-level file but adds a key fallback when the line is unknown", () => {
    const reviews = [
      review({
        target: { sheet: "OS Tuning", category: "Network", param: "net.core.somaxconn", field: "value" },
        changes: [{ field: "value", current: "128", suggested: "1024" }],
        comment: "Raise backlog.",
      }),
    ];
    const text = buildPromptText(reviews as never, data as never);
    // The sheet maps to a file, so it still groups there...
    expect(text).toContain("## File: /etc/sysctl.conf");
    // ...but with no precise locator, a key fallback is included.
    expect(text).toContain("fallback: locate `net.core.somaxconn`");
  });

  it("uses the no-source-mapping bucket when no file resolves at all", () => {
    const reviews = [
      review({
        target: { sheet: "Application", category: "Misc", param: "feature.flag", field: "value" },
        changes: [{ field: "value", current: "off", suggested: "on" }],
        comment: "Enable it.",
      }),
    ];
    const text = buildPromptText(reviews as never, data as never);
    expect(text).toContain("## File: (no source mapping)");
    expect(text).toContain("fallback: locate `feature.flag`");
  });

  it("separates documentation-field edits from deployed configuration", () => {
    const reviews = [
      review({
        target: { sheet: "OS Tuning", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "description" },
        changes: [{ field: "description", current: "old", suggested: "new" }],
        comment: "Clarify wording.",
      }),
    ];
    const text = buildPromptText(reviews as never, data as never);
    expect(text).toContain("# Documentation / parameter-sheet edits");
    expect(text).toContain("net.ipv4.tcp_fin_timeout");
    expect(text).toContain('description: "old" -> "new"');
    // A description edit must not be filed as a config file change.
    expect(text).not.toContain("## File:");
  });

  it("collects comment-only reviews as notes", () => {
    const reviews = [
      review({
        target: { sheet: "OS Tuning", category: "Network", param: "net.core.somaxconn" },
        comment: "Is this still needed?",
      }),
    ];
    const text = buildPromptText(reviews as never, data as never);
    expect(text).toContain("# Notes & open questions");
    expect(text).toContain("Is this still needed?");
  });

  it("ignores non-pending reviews", () => {
    const reviews = [
      review({
        target: { sheet: "OS Tuning", category: "Network", param: "net.ipv4.tcp_fin_timeout", field: "value" },
        changes: [{ field: "value", current: "60", suggested: "30" }],
        status: "applied",
      }),
    ];
    expect(buildPromptText(reviews as never, data as never)).toBe("");
  });
});

describe("effectiveOrigin", () => {
  it("derives \"overlay\" when instances is present and origin is unset", () => {
    expect(effectiveOrigin({ instances: [{ name: "prod", value: "1" }] })).toBe("overlay");
  });

  it("derives \"common\" when instances is absent and origin is unset", () => {
    expect(effectiveOrigin({})).toBe("common");
  });

  it("an explicit origin wins over the instances-based derivation", () => {
    expect(effectiveOrigin({ origin: "embedded" })).toBe("embedded");
    expect(effectiveOrigin({ origin: "common", instances: [{ name: "prod", value: "1" }] })).toBe("common");
  });
});

// A per-environment finding on a shared (or unset) row must never be filed
// under a file to edit: doing that is how an agent ends up hardcoding one
// environment's value into a shared definition or a template.
describe("buildPromptText: per-environment overrides", () => {
  const data: SheetData = {
    sheets: [
      {
        name: "App",
        instances: ["staging", "production"],
        source_file: "roles/app/templates/app.conf.j2",
        categories: [
          {
            name: "Server",
            params: [
              { key: "workers", value: "4", source: { file: "roles/app/defaults/main.yml", line: 1, anchor: "workers:" } },
              { key: "pool_size", value: "10", default: "10", origin: "default" },
            ],
          },
        ],
      },
    ],
  };
  const rev = (target: ReviewItem["target"], current: string, suggested: string): ReviewItem => ({
    id: "rev_1",
    status: "pending",
    target,
    changes: [{ field: "value", current, suggested }],
  });

  it("routes a shared row's per-environment change to the override section", () => {
    const text = buildPromptText(
      [rev({ sheet: "App", category: "Server", param: "workers", instance: "production", field: "value" }, "4", "16")],
      data
    );

    expect(text).toContain("# Per-environment overrides");
    expect(text).toContain("[environment: production]");
    expect(text).toContain("roles/app/defaults/main.yml"); // named as context…
    expect(text).toContain("add an override");
    // …but never as a file to go and edit, and never with the generic
    // "locate the key and update it" instruction.
    expect(text).not.toContain("## File: roles/app/defaults/main.yml");
    expect(text).not.toContain("locate `workers`");
    expect(text).not.toContain("app.conf.j2");
  });

  it("says a default row is not set anywhere", () => {
    const text = buildPromptText(
      [rev({ sheet: "App", category: "Server", param: "pool_size", instance: "staging", field: "value" }, "10", "50")],
      data
    );
    expect(text).toContain("not set anywhere");
    expect(text).not.toContain("## File:");
  });

  it("leaves a shared-scope change on the normal file path", () => {
    const text = buildPromptText(
      [rev({ sheet: "App", category: "Server", param: "workers", field: "value" }, "4", "16")],
      data
    );
    expect(text).toContain("## File: roles/app/defaults/main.yml");
    expect(text).not.toContain("# Per-environment overrides");
  });
});
