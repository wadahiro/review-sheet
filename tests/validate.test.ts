import { describe, it, expect } from "bun:test";
import { validateInput, validateReview } from "../src/validate";

describe("validateInput", () => {
  it("accepts valid Pattern A input", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                { key: "param1", value: "val1", default: "def1" },
              ],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.sheets).toHaveLength(1);
  });

  it("accepts valid Pattern B input", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  instances: [
                    { name: "dev", value: "val1" },
                    { name: "prod", value: "val2" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.sheets[0].categories[0].params![0]).toHaveProperty(
      "instances"
    );
  });

  it("accepts nested categories (multiple heading levels)", () => {
    const data = {
      sheets: [
        {
          name: "Sheet",
          categories: [
            {
              name: "Level 1",
              categories: [
                {
                  name: "Level 2",
                  categories: [
                    {
                      name: "Level 3",
                      params: [{ key: "p", value: "v", default: "d" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    const l1 = result.sheets[0].categories[0];
    const l2 = l1.categories![0];
    const l3 = l2.categories![0];
    expect(l1.name).toBe("Level 1");
    expect(l2.name).toBe("Level 2");
    expect(l3.name).toBe("Level 3");
    expect(l3.params![0].key).toBe("p");
  });

  it("errors when sheets is empty", () => {
    expect(() => validateInput({ sheets: [] })).toThrow();
  });

  it("errors on invalid data", () => {
    expect(() => validateInput({})).toThrow("validation error");
  });

  it("errors when both value and instances are present", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  value: "val1",
                  instances: [{ name: "dev", value: "val1" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow();
  });

  it("accepts out_of_scope as an object with a reason, at both category and parameter level", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              out_of_scope: { reason: "role-managed", owner: "platform-team" },
              params: [{ key: "param1", value: "val1", out_of_scope: { reason: "not applicable" } }],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.sheets[0].categories[0].out_of_scope).toEqual({ reason: "role-managed", owner: "platform-team" });
    expect(result.sheets[0].categories[0].params![0].out_of_scope).toEqual({ reason: "not applicable" });
  });

  it("errors when out_of_scope has no reason (reason-less exclusion)", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [{ key: "param1", value: "val1", out_of_scope: {} }],
            },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow();
  });

  it("rejects the removed boolean out_of_scope form with the migration message", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [{ key: "param1", value: "val1", out_of_scope: true }],
            },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow(
      "out_of_scope must be an object { reason, owner? }; boolean form is no longer supported"
    );
  });

  it("rejects a category-level boolean out_of_scope too", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [{ name: "Category 1", out_of_scope: true, params: [{ key: "param1", value: "val1" }] }],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow(
      "out_of_scope must be an object { reason, owner? }; boolean form is no longer supported"
    );
  });

  it("rejects origin: embedded combined with instances", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  origin: "embedded",
                  instances: [{ name: "dev", value: "val1" }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow("embedded origin cannot have per-environment instances");
  });

  it("accepts origin: embedded without instances", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [{ key: "param1", value: "val1", origin: "embedded" }],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.sheets[0].categories[0].params![0].origin).toBe("embedded");
  });

  // Widened `default` (types.ts's Origin comment): our authored sources set
  // nothing, so a `default` row must never carry a location in a file we
  // author — no `source` at all, or one with `generated: true` (observed in
  // a generated artifact, e.g. a Terraform plan). Mirrors the embedded-origin
  // check just above.
  it("rejects origin: default with a non-generated source", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  value: "val1",
                  origin: "default",
                  source: { file: "main.tf", line: 3 },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow(
      "default origin cannot carry a location in an authored file"
    );
  });

  it("accepts origin: default with a generated source", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  value: "val1",
                  origin: "default",
                  source: { file: "plan.json", line: 3, generated: true },
                },
              ],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.sheets[0].categories[0].params![0].origin).toBe("default");
  });

  it("accepts origin: default with no source at all (documented default)", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [{ name: "Category 1", params: [{ key: "param1", value: "val1", default: "val1", origin: "default" }] }],
        },
      ],
    };
    expect(() => validateInput(data)).not.toThrow();
  });

  it("rejects origin: default with a non-generated source on a Pattern B instance", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  origin: "default",
                  instances: [
                    { name: "staging", value: "true", source: { file: "plan.json", line: 3, generated: true } },
                    { name: "production", value: "true", source: { file: "main.tf", line: 3 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow(
      "default origin cannot carry a location in an authored file"
    );
  });

  it("rejects an unknown origin value", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            { name: "Category 1", params: [{ key: "param1", value: "val1", origin: "bogus" }] },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow();
  });

  it("accepts a ref-only additional_sources entry on an instance parameter", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  instances: [{ name: "dev", value: "val1" }],
                  additional_sources: [
                    { file: "poc.yml", path: "ssoSessionIdleTimeout", ref: "$(env:SSO_SESSION_IDLE_TIMEOUT)" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.sheets[0].categories[0].params![0].additional_sources).toHaveLength(1);
  });

  it("rejects a non-ref additional_sources entry on an instance parameter", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  instances: [{ name: "dev", value: "val1" }],
                  additional_sources: [{ file: "other.yml", line: 3 }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow();
  });

  it("accepts mixed ref and non-ref additional_sources entries on a simple parameter", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                {
                  key: "param1",
                  value: "val1",
                  additional_sources: [
                    { file: "same-value.yml", line: 2 },
                    { file: "poc.yml", path: "x", ref: "$(env:X)" },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.sheets[0].categories[0].params![0].additional_sources).toHaveLength(2);
  });

  it("accepts a document carrying a valid artifact preview", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [{ key: "param1", value: "val1" }],
            },
          ],
        },
      ],
      artifacts: [
        {
          id: "Test",
          sheet: "Test",
          source_file: "templates/app.conf.j2",
          deployed_path: "/etc/app/app.conf",
          instances: ["staging"],
          lines: [
            { text: "# managed by ansible", kind: "verbatim" },
            { text: "param1 val1", kind: "substituted", key: "param1" },
            { text: "{{ unresolved }}", kind: "unrendered", reason: "unresolved variable", cause: "engine" },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts?.[0].lines).toHaveLength(3);
  });

  it("rejects an artifact line with an unknown kind", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [{ name: "Category 1", params: [{ key: "param1", value: "val1" }] }],
        },
      ],
      artifacts: [
        {
          id: "Test",
          sheet: "Test",
          source_file: "templates/app.conf.j2",
          lines: [{ text: "some line", kind: "bogus" }],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow();
  });

  it("rejects an artifact line missing text", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [{ name: "Category 1", params: [{ key: "param1", value: "val1" }] }],
        },
      ],
      artifacts: [
        {
          id: "Test",
          sheet: "Test",
          source_file: "templates/app.conf.j2",
          lines: [{ kind: "verbatim" }],
        },
      ],
    };
    expect(() => validateInput(data)).toThrow();
  });

  it("accepts ref inside a source def (primary source)", () => {
    const data = {
      sheets: [
        {
          name: "Test",
          categories: [
            {
              name: "Category 1",
              params: [
                { key: "param1", value: "val1", source: { file: "f.yml", ref: "$(env:X)" } },
              ],
            },
          ],
        },
      ],
    };
    const result = validateInput(data);
    expect((result.sheets[0].categories[0].params![0] as { source?: { ref?: string } }).source?.ref).toBe(
      "$(env:X)"
    );
  });
});

describe("validateReview", () => {
  it("accepts valid review JSON", () => {
    const data = {
      schema_version: "2.0",
      created_at: "2026-06-17T10:00:00Z",
      reviews: [
        {
          id: "rev_abc123",
          target: { sheet: "Test", category: "Category 1", param: "param1" },
          changes: [{ field: "value", current: "old", suggested: "new" }],
          comment: "Reason for change",
          status: "pending",
        },
      ],
    };
    const result = validateReview(data);
    expect(result.reviews).toHaveLength(1);
  });

  it("errors on invalid schema version", () => {
    const data = {
      schema_version: "1.0",
      created_at: "2026-06-17T10:00:00Z",
      reviews: [],
    };
    expect(() => validateReview(data)).toThrow();
  });
});
