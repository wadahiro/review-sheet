// HCL parser: wraps hclIndex/hclLocate/hclEdit.
// Handles Terraform (.tf), generic HCL (.hcl), and Terraform variable files (.tfvars).

import { hclIndex, hclLocate, hclEdit } from "../hcl.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const hclParser: ConfigParser = {
  name: "hcl",
  priority: 20,
  meta: {
    title: "HCL / Terraform",
    summary: "Blocks by label (resource type+name); scalar attributes only; expressions/lists/maps/heredocs skipped.",
    files: "*.tf *.hcl *.tfvars",
    detection: "extension (.tf, .hcl, .tfvars)",
    delimiter: "key = value (+ {} blocks)",
    comments: "# // /* */",
    pathStyle: "resource.aws_instance.web.instance_type — blocks by label; scalar attributes only",
    containers:
      "Each `name label… { }` is a block. A uniquely labelled one is addressed by name plus labels and rowed by the labels as written, quotes and spacing included.",
    notes: [
      "Block segments combine the block name and its labels: `resource \"aws_instance\" \"web\" {}` → path prefix `resource.aws_instance.web`.",
      "Repeated unlabeled blocks (e.g. ingress {}) are indexed: ingress[0], ingress[1].",
      "Only scalar values are emitted: double-quoted string literals, bare numbers, and true/false.",
      "Lists [...], maps {...}, heredocs <<EOF, interpolations ${...}, and references (var.x, data.x, etc.) are skipped → AI prompt.",
      "Reorder-robust: resource identity comes from labels (type + name), not line position.",
      "`Entry.key` is the bare attribute name (`variable \"region\" { default = ... }` → key `default`, not `variable.region.default`); the full address is `Entry.source.path`. A recipe matching on `key` alone silently matches nothing, or matches every block's `default` at once.",
    ],
    examples: [
      "terraform.required_version",
      "resource.aws_instance.web.instance_type",
      "resource.aws_instance.web.count",
      "variable.region.default",
      "ingress[0].from_port",
    ],
  },
  detect: (file) => /\.(tf|hcl|tfvars)$/i.test(file),
  extract: (content) =>
    hclIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
          containers: e.containers,
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = hclLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return hclEdit(content, source.path, current, suggested);
  },
};
registerParser(hclParser);
