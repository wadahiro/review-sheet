# YAML

Nested leaves get a structural path; list-of-maps addressed by identity.

## Detection

**Files:** *.yaml *.yml

**Detection:** extension (.yaml, .yml)

**Delimiter:** `key: value`

**Comments:** `#`

## Path style

services[name=web].port — list-of-maps by identity field; scalar lists by [i]

## Notes

- Nested map keys produce a dotted path (e.g. database.host).
- List-of-maps addressed by identity: services[name=web].port.
- Scalar list items addressed by index: items[0].
- Structural path edit survives key/list reordering.

## Examples

```
database.host
services[name=web].port
items[0]
```
