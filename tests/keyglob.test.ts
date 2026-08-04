import { describe, it, expect } from "bun:test";
import { makeKeySelector } from "../src/keyglob";

describe("makeKeySelector", () => {
  const keys = ["kc_db_url", "httpd_port", "Resources.Api.Properties.Timeout", "Resources.Db.Properties.Timeout", "Tags[0].Value"];
  const pick = (include: string[], exclude: string[] = []) => {
    const s = makeKeySelector(include, exclude);
    return keys.filter((k) => s.select(k));
  };

  it("selects everything when no pattern is given", () => {
    expect(pick([])).toEqual(keys);
  });

  it("matches a prefix with * inside one segment", () => {
    expect(pick(["kc_*"])).toEqual(["kc_db_url"]);
  });

  it("does not let * cross a segment boundary, but ** does", () => {
    expect(pick(["Resources.*.Timeout"])).toEqual([]);
    expect(pick(["Resources.**.Timeout"])).toEqual([
      "Resources.Api.Properties.Timeout",
      "Resources.Db.Properties.Timeout",
    ]);
  });

  it("treats . [ ] as literals so a path can be written as-is", () => {
    expect(pick(["Tags[0].Value"])).toEqual(["Tags[0].Value"]);
    // A literal dot must not behave as "any character".
    expect(pick(["kcXdb_url"])).toEqual([]);
  });

  it("applies exclude after include", () => {
    expect(pick(["Resources.**"], ["**.Db.**"])).toEqual(["Resources.Api.Properties.Timeout"]);
  });

  it("reports a pattern that never matched, whichever list it is in", () => {
    const s = makeKeySelector(["kc_*", "nope_*"], ["also_missing_*"]);
    keys.forEach((k) => s.select(k));
    expect(s.unmatchedPatterns().sort()).toEqual(["also_missing_*", "nope_*"]);
  });

  it("counts an exclude pattern that removed something as used", () => {
    const s = makeKeySelector([], ["kc_*"]);
    keys.forEach((k) => s.select(k));
    expect(s.unmatchedPatterns()).toEqual([]);
  });
});
