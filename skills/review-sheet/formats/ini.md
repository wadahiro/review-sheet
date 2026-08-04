# ini

INI/CFG [section] files; sections become categories.

## Detection

**Files:** *.ini *.cfg

**Detection:** extension (.ini, .cfg)

**Delimiter:** `= or :`

**Comments:** `# ;`

## Path style

flat key within section category

## Notes

- [section] headers become category path segments.
- Keys are flat within each section.
- # and ; start comment lines.

## Examples

```
database.host
server.port
```
