# TOML

Tables and array-of-tables; reorder-robust paths; scalar values only.

## Detection

**Files:** *.toml

**Detection:** extension (.toml)

**Delimiter:** `key = value`

**Comments:** `#`

## Path style

service[name=web].replicas — array-of-tables by identity; table.key — nested

## Notes

- [table] headers become nested path segments.
- [[array-of-tables]] addressed by identity predicate: service[name=web].replicas.
- Scalar values only (strings, numbers, booleans, dates).
- Reorder-robust for tables and identity-keyed arrays.

## Examples

```
database.host
service[name=web].replicas
server.port
```
