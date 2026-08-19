# properties

Java .properties key=value files; # and ! comments; no sections, so no category of its own.

## Detection

**Files:** *.properties

**Detection:** extension (.properties)

**Delimiter:** `= or :`

**Comments:** `# !`

## Path style

flat key; the format has no sections, so a row reports no category and one is decided elsewhere

## Notes

- Key=value or key: value (colon variant).
- # and ! start comment lines.
- No sections, so no row carries a category of its own: what to call it is answered by a project declaration, a bound dictionary group, or the file it belongs to — and a row none of those answer for is an error naming it, rather than a tab named after nothing.

## Examples

```
server.port
database.url
```
