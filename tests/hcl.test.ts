import { describe, it, expect } from "bun:test";
import { hclIndex, hclLocate, hclEdit } from "../src/hcl";
import { extractFile } from "../src/extract";
import { computeApply } from "../src/apply";
import { verifySources } from "../src/verify";
import type { SheetData, ReviewItem } from "../src/prompt";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const tf = `
terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "region" {
  default = "us-east-1"
}

variable "count_override" {
  default = 3
}

resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.micro"
  count         = 2
  tags          = { Name = "web" }

  ingress {
    from_port = 80
    to_port   = 80
  }
  ingress {
    from_port = 443
    to_port   = 443
  }
}

resource "aws_instance" "db" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.small"
  count         = 1
}
`;

// Reordered: db first, web second, ingress blocks reversed
const tfReordered = `
resource "aws_instance" "db" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.small"
  count         = 1
}

resource "aws_instance" "web" {
  ami           = data.aws_ami.ubuntu.id
  instance_type = "t3.micro"
  count         = 2
  tags          = { Name = "web" }

  ingress {
    from_port = 443
    to_port   = 443
  }
  ingress {
    from_port = 80
    to_port   = 80
  }
}
`;

// ---------------------------------------------------------------------------
// Index tests
// ---------------------------------------------------------------------------

describe("hcl", () => {
  it("indexes terraform block scalar attributes", () => {
    const out = hclIndex(tf).map((e) => `${e.path}=${e.value}`);
    // required_version is a plain string (no interpolation at the top level —
    // but ">= 1.5" is a plain string literal, so it IS indexed)
    expect(out).toContain('terraform.required_version=>= 1.5');
  });

  it("indexes variable defaults (string and number)", () => {
    const out = hclIndex(tf).map((e) => `${e.path}=${e.value}`);
    expect(out).toContain("variable.region.default=us-east-1");
    expect(out).toContain("variable.count_override.default=3");
  });

  it("skips expression attribute values (data.*, var.*, interpolation)", () => {
    const paths = hclIndex(tf).map((e) => e.path);
    // ami = data.aws_ami.ubuntu.id → expression, skipped
    expect(paths).not.toContain("resource.aws_instance.web.ami");
    expect(paths).not.toContain("resource.aws_instance.db.ami");
  });

  it("skips map/object attribute values (tags = { ... })", () => {
    const paths = hclIndex(tf).map((e) => e.path);
    expect(paths).not.toContain("resource.aws_instance.web.tags");
  });

  it("indexes string and number scalars inside resource blocks", () => {
    const out = hclIndex(tf).map((e) => `${e.path}=${e.value}`);
    expect(out).toContain("resource.aws_instance.web.instance_type=t3.micro");
    expect(out).toContain("resource.aws_instance.web.count=2");
    expect(out).toContain("resource.aws_instance.db.instance_type=t3.small");
    expect(out).toContain("resource.aws_instance.db.count=1");
  });

  it("two resources distinguished by label in path", () => {
    const paths = hclIndex(tf).map((e) => e.path);
    expect(paths.some((p) => p.startsWith("resource.aws_instance.web."))).toBe(true);
    expect(paths.some((p) => p.startsWith("resource.aws_instance.db."))).toBe(true);
  });

  it("indexes repeated unlabeled ingress blocks by position", () => {
    const out = hclIndex(tf).map((e) => `${e.path}=${e.value}`);
    expect(out).toContain("resource.aws_instance.web.ingress[0].from_port=80");
    expect(out).toContain("resource.aws_instance.web.ingress[0].to_port=80");
    expect(out).toContain("resource.aws_instance.web.ingress[1].from_port=443");
    expect(out).toContain("resource.aws_instance.web.ingress[1].to_port=443");
  });

  it("skips heredoc values", () => {
    const heredocTf = `
resource "local_file" "script" {
  content = <<-EOF
    #!/bin/bash
    echo hello
  EOF
  filename = "/tmp/test.sh"
}
`;
    const out = hclIndex(heredocTf).map((e) => `${e.path}=${e.value}`);
    // content is a heredoc → skipped; filename is a plain string → indexed
    expect(out).not.toContain(expect.stringContaining("content"));
    expect(out).toContain("resource.local_file.script.filename=/tmp/test.sh");
  });

  it("skips interpolation strings", () => {
    const interpTf = `
resource "aws_s3_bucket" "main" {
  bucket = "\${var.prefix}-bucket"
  acl    = "private"
}
`;
    const out = hclIndex(interpTf).map((e) => `${e.path}=${e.value}`);
    expect(out).not.toContain(expect.stringContaining("bucket="));
    expect(out).toContain("resource.aws_s3_bucket.main.acl=private");
  });

  it("skips list values", () => {
    const listTf = `
resource "aws_security_group" "sg" {
  name    = "my-sg"
  ingress = []
}
`;
    const out = hclIndex(listTf).map((e) => `${e.path}=${e.value}`);
    expect(out).toContain("resource.aws_security_group.sg.name=my-sg");
    expect(out).not.toContain(expect.stringContaining("ingress="));
  });

  // ---------------------------------------------------------------------------
  // Locate
  // ---------------------------------------------------------------------------

  it("locates by path", () => {
    expect(hclLocate(tf, "resource.aws_instance.web.instance_type")).toEqual({ value: "t3.micro" });
    expect(hclLocate(tf, "variable.region.default")).toEqual({ value: "us-east-1" });
  });

  it("returns error for unknown path", () => {
    const r = hclLocate(tf, "resource.aws_instance.web.ami"); // expression → not indexed
    expect("error" in r).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Edit
  // ---------------------------------------------------------------------------

  it("edits a string attribute (quoted → re-quoted)", () => {
    const r = hclEdit(tf, "resource.aws_instance.web.instance_type", "t3.micro", "t3.large");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain('instance_type = "t3.large"');
    expect(r.content).toContain('instance_type = "t3.small"'); // db unchanged
  });

  it("edits a number attribute (bare → bare)", () => {
    const r = hclEdit(tf, "resource.aws_instance.web.count", "2", "4");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("count         = 4");
  });

  it("skips when already at suggested", () => {
    const r = hclEdit(tf, "resource.aws_instance.web.instance_type", "t3.nano", "t3.micro");
    expect(r.status).toBe("skipped");
  });

  it("errors on stale current value", () => {
    const r = hclEdit(tf, "resource.aws_instance.web.instance_type", "t3.nano", "t3.large");
    expect(r.status).toBe("error");
  });

  it("errors on unknown path", () => {
    const r = hclEdit(tf, "resource.aws_instance.web.ami", "old", "new");
    expect(r.status).toBe("error");
  });

  // ---------------------------------------------------------------------------
  // Reorder robustness
  // ---------------------------------------------------------------------------

  it("edits resource.aws_instance.web.instance_type even after block reorder", () => {
    const r = hclEdit(tfReordered, "resource.aws_instance.web.instance_type", "t3.micro", "t3.large");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    // web updated, db unchanged
    expect(r.content).toContain('"t3.large"');
    expect(r.content).toContain('"t3.small"');
  });

  // ---------------------------------------------------------------------------
  // extractFile auto-detect
  // ---------------------------------------------------------------------------

  it("extractFile detects .tf by extension", () => {
    const entries = extractFile(tf, "main.tf");
    expect(entries.find((e) => e.source.path === "resource.aws_instance.web.instance_type")).toMatchObject({
      key: "instance_type",
      value: "t3.micro",
    });
  });

  it("extractFile detects .hcl by extension", () => {
    const simple = `server_count = 3\nserver_name = "prod"\n`;
    const entries = extractFile(simple, "config.hcl");
    expect(entries.find((e) => e.source.path === "server_count")).toMatchObject({ value: "3" });
    expect(entries.find((e) => e.source.path === "server_name")).toMatchObject({ value: "prod" });
  });

  it("extractFile detects .tfvars by extension", () => {
    const vars = `region = "eu-west-1"\ncount  = 5\n`;
    const entries = extractFile(vars, "terraform.tfvars");
    expect(entries.find((e) => e.source.path === "region")).toMatchObject({ value: "eu-west-1" });
    expect(entries.find((e) => e.source.path === "count")).toMatchObject({ value: "5" });
  });

  // ---------------------------------------------------------------------------
  // computeApply / verifySources round-trip
  // ---------------------------------------------------------------------------

  it("apply/verify hit the right resource by label after reorder", () => {
    const data: SheetData = {
      sheets: [
        {
          name: "Infra",
          file_path: "main.tf",
          categories: [
            {
              name: "Compute",
              params: [
                {
                  key: "instance_type",
                  value: "t3.micro",
                  source: { path: "resource.aws_instance.web.instance_type" },
                },
              ],
            },
          ],
        },
      ],
    };

    const reviews: ReviewItem[] = [
      {
        id: "r1",
        status: "pending",
        target: { sheet: "Infra", category: "Compute", param: "instance_type", field: "value" },
        changes: [{ field: "value", current: "t3.micro", suggested: "t3.large" }],
      },
    ];

    const out = computeApply(data, reviews, (path) => {
      if (path === "main.tf") return tfReordered;
      return null;
    });

    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain('"t3.large"');
    // db resource must be untouched
    expect(out.files[0].content).toContain('"t3.small"');

    // verifySources on the original (unedited) tf
    const vr = verifySources(data, (path) => {
      if (path === "main.tf") return tf;
      return null;
    });
    expect(vr.ok).toBe(1);
  });
});
