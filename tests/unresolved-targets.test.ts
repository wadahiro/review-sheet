// A finding whose target resolves to nothing.
//
// `retargetReviews` has computed `unresolved` since it was written and NOBODY
// read it — while the `moved` case sitting right beside it was reported by the
// CLI. So a finding against a row that no longer exists was carried along,
// applied to nothing, and counted nowhere: the run said "0 applied" exactly as
// if the review file had been empty.
//
// The category grain was worse than unread, it was unchecked: a target naming
// no param is returned "untouched, first-class", which is right for following
// (there is no row to follow) and wrong for reporting — a comment filed against
// a category the document no longer has is as orphaned as one against a deleted
// row.

import { describe, it, expect } from "bun:test";
import { computeApply } from "../src/apply";
import { HELD_REASON_NO_ROW } from "../src/prompt";
import { retargetReviews } from "../src/prompt";
import type { ParameterSheetInput, ReviewItem } from "../src/types";

const data = (): ParameterSheetInput => ({
  metadata: { project: "p", version: "1", generated_at: "2026-01-01" },
  sheets: [
    {
      name: "web",
      categories: [
        {
          name: "General",
          params: [{ key: "TimeOut", value: "60", source: { file: "httpd.conf", line: 1, anchor: "60", path: "TimeOut" } }],
        },
      ],
    },
  ],
});

const read = (): string | null => "TimeOut 60\n";

const finding = (target: ReviewItem["target"]): ReviewItem => ({
  id: "r1",
  status: "pending",
  target,
  changes: [{ field: "value", current: "60", suggested: "120" }],
});

describe("unresolved review targets", () => {
  it("names a finding whose row is gone instead of doing nothing quietly", () => {
    const out = computeApply(data(), [finding({ sheet: "web", category: "General", param: "KeepAlive" })], read);
    expect(out.unresolved).toEqual([{ sheet: "web", category: "General", param: "KeepAlive" }]);
    expect(out.applied).toBe(0);
  });

  // "no file mapped" is a fact about a row's source map. A finding against a
  // row that does not exist has no source map to lack, and the two used to read
  // identically — so a finding about a deleted setting looked like an ordinary
  // unmapped one, and the reader was never told the thing is gone.
  it("says the row is gone rather than that no file is mapped", () => {
    const out = computeApply(data(), [finding({ sheet: "web", category: "General", param: "KeepAlive" })], read);
    expect(out.results[0].status).toBe("held");
    expect(out.results[0].reason).toBe(HELD_REASON_NO_ROW);
  });

  it("still says \"no file mapped\" for a row that exists without one", () => {
    const noSource = data();
    noSource.sheets[0].categories![0].params = [{ key: "TimeOut", value: "60" }];
    const out = computeApply(noSource, [finding({ sheet: "web", category: "General", param: "TimeOut" })], read);
    expect(out.results[0].reason).toBe("no file mapped");
    expect(out.unresolved).toEqual([]);
  });

  it("says nothing when the row is there", () => {
    const out = computeApply(data(), [finding({ sheet: "web", category: "General", param: "TimeOut" })], read);
    expect(out.applied).toBe(1);
    expect(out.unresolved).toEqual([]);
  });

  // The grain that was not merely unread but unchecked.
  it("names a comment filed against a category the document no longer has", () => {
    const comment: ReviewItem = { id: "c1", status: "pending", target: { sheet: "web", category: "Logging" }, changes: [], comment: "why?" };
    const { unresolved } = retargetReviews([comment], data());
    expect(unresolved).toEqual([{ sheet: "web", category: "Logging" }]);
  });

  it("accepts a comment on a category that exists, and on the sheet itself", () => {
    const onCategory: ReviewItem = { id: "c1", status: "pending", target: { sheet: "web", category: "General" }, changes: [] };
    const onSheet: ReviewItem = { id: "c2", status: "pending", target: { sheet: "web" }, changes: [] };
    expect(retargetReviews([onCategory, onSheet], data()).unresolved).toEqual([]);
  });

  // A nested category is addressed by its full path, so the check has to walk
  // the tree rather than compare leaf names — otherwise a comment on "General"
  // would validate against a "poc/General" that means something else.
  it("resolves a nested category by its full path", () => {
    const nested = data();
    nested.sheets[0].categories = [{ name: "poc", categories: [{ name: "General", params: [] }] }];
    const ok: ReviewItem = { id: "c1", status: "pending", target: { sheet: "web", category: "poc/General" }, changes: [] };
    const bad: ReviewItem = { id: "c2", status: "pending", target: { sheet: "web", category: "General" }, changes: [] };
    const { unresolved } = retargetReviews([ok, bad], nested);
    expect(unresolved).toEqual([{ sheet: "web", category: "General" }]);
  });

  it("names a comment against a sheet that is gone", () => {
    const c: ReviewItem = { id: "c1", status: "pending", target: { sheet: "database" }, changes: [] };
    expect(retargetReviews([c], data()).unresolved).toEqual([{ sheet: "database" }]);
  });
});
