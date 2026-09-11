// What `terraform plan` says, and how it says it — vocabulary, not policy.

import { describe, it, expect } from "bun:test";
import { planOutcome, complaint, changedResources } from "../src/channels/terraform";

const E = "\u001b";
// Colour codes and the box-drawing frame, exactly as terraform writes them.
const FAILED = [
  `${E}[31m\u2577${E}[0m`,
  `${E}[31m\u2502${E}[0m ${E}[1m${E}[31mError: ${E}[0mNo valid credential sources found${E}[0m`,
  `${E}[31m\u2502${E}[0m `,
  `${E}[31m\u2502${E}[0m   with provider["registry.terraform.io/hashicorp/aws"],`,
  `${E}[31m\u2575${E}[0m`,
].join("\n");

describe("what a plan run means", () => {
  // The verdict is in the EXIT CODE and nowhere else: a run that failed before
  // reaching its summary still has whatever text it managed to print.
  it("reads the answer from the exit code, not from the output", () => {
    expect(planOutcome(0, "No changes. Your infrastructure matches the configuration.")).toEqual({ ran: true, ok: true });
    expect(planOutcome(2, "Plan: 0 to add, 3 to change, 0 to destroy.")).toEqual({ ran: true, ok: false });
    // …and a failed run is NOT a verdict about the infrastructure.
    const failed = planOutcome(1, FAILED);
    expect(failed.ran).toBe(false);
    expect(failed.ok).toBeUndefined();
    expect(failed.why).toBe("Error: No valid credential sources found");
  });

  // The LAST line of a failed run is the bottom of the box. The reason is the
  // line that says Error, without its colours.
  it("takes the reason from the line that says Error, uncoloured", () => {
    expect(complaint(FAILED)).toBe("Error: No valid credential sources found");
    expect(complaint(`${E}[1msomething else went wrong${E}[0m`)).toBe("something else went wrong");
    expect(complaint("")).toBe("");
  });

  it("names the resources a plan would touch", () => {
    const plan = [
      "Terraform will perform the following actions:",
      "",
      `  ${E}[1m# module.aurora.aws_rds_cluster.this${E}[0m will be updated in-place`,
      '  ~ resource "aws_rds_cluster" "this" {',
      "  # module.alb.aws_lb.this will be destroyed",
      "",
      "Plan: 0 to add, 1 to change, 1 to destroy.",
    ].join("\n");
    expect(changedResources(plan)).toEqual(["module.aurora.aws_rds_cluster.this", "module.alb.aws_lb.this"]);
    expect(changedResources("No changes.")).toEqual([]);
  });
});
