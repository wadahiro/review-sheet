// A PLAN THAT STILL PROPOSES CHANGES IS NOT A THING TO JUDGE AGAINST.
//
// An apply-後 plan can answer a sheet's values because, with nothing left to
// change, `change.after` is what the stack HOLDS. In a plan with pending
// actions the SAME field is what Terraform would MAKE true — and the two are
// indistinguishable from `after` alone, so a sheet judged against the second
// reads OK for values nothing has yet.
//
// Refused per row rather than thrown: one stale document must not take the
// whole record with it.

import { describe, it, expect } from "bun:test";
import { judgeFiles } from "../src/judge";
import { proposedChanges } from "../src/channels/terraform";
import type { TestPlan, TestItem } from "../src/testplan";

const planDoc = (actions: string[]): string =>
  JSON.stringify({
    format_version: "1.2",
    terraform_version: "1.9.5",
    resource_changes: [
      { address: "aws_lb.this", change: { actions, after: { idle_timeout: "60" } } },
      { address: "aws_db_instance.main", change: { actions: ["no-op"], after: { port: "5432" } } },
    ],
  });

const item = (): TestItem =>
  ({
    target: { sheet: "s", path: [], key: "aws_lb.this.idle_timeout", instance: "local" },
    unit: "u",
    kind: "value",
    decider: "project",
    expected: "60",
    address: "resource_changes[address=aws_lb.this].change.after.idle_timeout",
  }) as TestItem;

const plan = (): TestPlan =>
  ({ metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { en: "m" } }, sheets: ["s"] }], items: [item()], functional: [] }) as never;

const judged = (text: string, lang: "en" | "ja" = "en") =>
  judgeFiles(
    plan(),
    [
      {
        environment: "local",
        hosts: { h1: { files: {}, documents: [{ sheet: "s", format: "json", how: "terraform show -json", text }] } },
      },
    ] as never,
    { at: "X", lang, idFields: ["address"] }
  ).results[0];

describe("a plan document with nothing left to change", () => {
  it("answers the rows it holds", () => {
    expect(judged(planDoc(["no-op"]))?.status).toBe("pass");
  });

  // `read` observes and changes nothing, so a data source is not a proposal.
  it("counts a read as standing still", () => {
    expect(judged(planDoc(["read"]))?.status).toBe("pass");
  });
});

describe("a plan document that still proposes changes", () => {
  it("leaves the row unchecked rather than reading its after", () => {
    expect(judged(planDoc(["update"]))?.status).toBe("not_run");
  });

  // WHICH thing moved is what a reader needs first.
  it("names what moves, and how many", () => {
    const reason = judged(planDoc(["create"]))?.reason ?? "";
    expect(reason).toContain("aws_lb.this");
    expect(reason).toContain("1 change");
  });

  it("says it in the reader's language", () => {
    expect(judged(planDoc(["delete", "create"]), "ja")?.reason ?? "").toContain("提案している");
  });

  // Not a failure: the row's value was never compared, so calling it wrong
  // would assert something nobody checked. Drift itself is a functional check.
  it("is not a fail", () => {
    expect(judged(planDoc(["update"]))?.status).not.toBe("fail");
  });
});

describe("what counts as a plan at all", () => {
  // Narrow on purpose: a project's own document may carry a `resource_changes`
  // key, and refusing it for a reason that is not true of it is worse than
  // asking nothing.
  it("says nothing about a document that is not one", () => {
    expect(proposedChanges(JSON.stringify({ resource_changes: [{ address: "x", change: { actions: ["update"] } }] }))).toBeUndefined();
    expect(proposedChanges(JSON.stringify({ terraform_version: "1.9.5" }))).toBeUndefined();
    expect(proposedChanges("ServerRoot /etc/httpd")).toBeUndefined();
  });

  it("reads an empty plan as standing still", () => {
    expect(proposedChanges(JSON.stringify({ format_version: "1.2", resource_changes: [] }))).toEqual([]);
  });

  // A plan is still a plan when a resource has no address to name.
  it("has a word for a resource it cannot name", () => {
    const moving = proposedChanges(JSON.stringify({ format_version: "1.2", resource_changes: [{ change: { actions: ["create"] } }] }));
    expect(moving).toEqual(["(unnamed)"]);
  });
});
