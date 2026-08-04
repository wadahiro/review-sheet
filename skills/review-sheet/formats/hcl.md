# HCL / Terraform

Blocks by label (resource type+name); scalar attributes only; expressions/lists/maps/heredocs skipped.

## Detection

**Files:** *.tf *.hcl *.tfvars

**Detection:** extension (.tf, .hcl, .tfvars)

**Delimiter:** `key = value (+ {} blocks)`

**Comments:** `# // /* */`

## Path style

resource.aws_instance.web.instance_type — blocks by label; scalar attributes only

## Notes

- Block segments combine the block name and its labels: `resource "aws_instance" "web" {}` → path prefix `resource.aws_instance.web`.
- Repeated unlabeled blocks (e.g. ingress {}) are indexed: ingress[0], ingress[1].
- Only scalar values are emitted: double-quoted string literals, bare numbers, and true/false.
- Lists [...], maps {...}, heredocs <<EOF, interpolations ${...}, and references (var.x, data.x, etc.) are skipped → AI prompt.
- Reorder-robust: resource identity comes from labels (type + name), not line position.
- `Entry.key` is the bare attribute name (`variable "region" { default = ... }` → key `default`, not `variable.region.default`); the full address is `Entry.source.path`. A recipe matching on `key` alone silently matches nothing, or matches every block's `default` at once.

## Examples

```
terraform.required_version
resource.aws_instance.web.instance_type
resource.aws_instance.web.count
variable.region.default
ingress[0].from_port
```
