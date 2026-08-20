// A list whose elements ARE their identity — a firewall's permitted services,
// a set of enabled modules, any `[a, b, c]` where the strings are the settings
// rather than values of one.
//
// Addressed by position such a list keys as `services[0]`: a name no product
// knows, and one that makes removing a member read as a value CHANGE of the row
// that held it. The honest reading is that one member left the set and another
// joined, which only holds when the member is the key.

import { describe, it, expect } from "bun:test";
import { selectKeySource, makeKeyTransformer, transformCovers, PRESENCE_VALUE } from "../src/keytransform";

describe("selectKeySource", () => {
  it("takes the entry's own value when asked to", () => {
    expect(selectKeySource("value", "services[0]", "services[0]", "ssh")).toBe("ssh");
  });

  // Every other source is unchanged: this is one more answer to an existing
  // question, not a new question.
  it("leaves key and path exactly as they were", () => {
    expect(selectKeySource("key", "leaf", "a.b.leaf", "v")).toBe("leaf");
    expect(selectKeySource("path", "leaf", "a.b.leaf", "v")).toBe("a.b.leaf");
    expect(selectKeySource(undefined, "leaf", "a.b.leaf", "v")).toBe("leaf");
  });

  // An entry with no value cannot be keyed by one, and inventing an empty key
  // would collide every such row into a single nameless entry.
  it("falls back to the key when there is no value", () => {
    expect(selectKeySource("value", "services[0]", "services[0]", undefined)).toBe("services[0]");
  });

  // The steps still apply afterwards, so a project can normalise what it keyed
  // by — the source and the transform are separate decisions.
  it("hands the value to the steps like any other source", () => {
    const t = makeKeyTransformer({ from: "value", steps: [{ pattern: "^(.*)$", replace: "service:$1" }] });
    expect(t.apply(selectKeySource("value", "services[0]", undefined, "http"))).toBe("service:http");
  });
});

// `at:` — where a transform applies. A role's defaults/main.yml holds two dozen
// scalars that want their own names and one list whose elements ARE their
// names, and there is no single answer for the file.
describe("transformCovers", () => {
  it("covers the address itself and anything under it", () => {
    expect(transformCovers("services", "services", "services")).toBe(true);
    expect(transformCovers("services", "[0]", "services[0]")).toBe(true);
    expect(transformCovers("services", "a", "services.a")).toBe(true);
  });

  // Segment-aware: a prefix that half-matches a longer sibling would rename
  // rows nobody pointed at.
  it("does not half-match a longer name", () => {
    expect(transformCovers("services", "x", "services_extra.x")).toBe(false);
    expect(transformCovers("services", "x", "other.x")).toBe(false);
  });

  it("covers everything when nothing is declared", () => {
    expect(transformCovers(undefined, "anything", "any.where")).toBe(true);
  });

  // No structural path (a flat key=value file) — the key is the address.
  it("falls back to the key when the format has no paths", () => {
    expect(transformCovers("services", "services", undefined)).toBe(true);
    expect(transformCovers("services", "other", undefined)).toBe(false);
  });
});

// A membership row's three parts, which only make sense together: presence as
// the value, the member on the source, and a held apply.
describe("a membership row", () => {
  it("holds presence, in the spelling a bare flag already gets", () => {
    expect(PRESENCE_VALUE).toBe("true");
  });
});
