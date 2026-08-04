# JSON

Same as YAML including minified JSON; no comments.

## Detection

**Files:** *.json

**Detection:** extension (.json)

**Delimiter:** `"key": value`

## Path style

services[name=web].port — same as YAML

## Notes

- Handles minified JSON.
- No comment syntax.
- Path semantics identical to YAML.

## Examples

```
database.host
services[name=web].port
```
