# generic

Last-resort fallback; tries = then : as delimiter; always matches.

## Detection

**Files:** anything else (fallback)

**Detection:** always (fallback, priority -100)

**Delimiter:** `= or :`

**Comments:** `# ; !`

## Path style

flat key; the format has no sections, so a row reports no category and one is decided elsewhere

## Notes

- Matches everything — lowest priority (-100).
- Tries = first, then : as delimiter.
- # ; ! start comment lines.

## Examples

```
key=value
key: value
```
