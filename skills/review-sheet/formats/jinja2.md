# Jinja2

Templates (.j2): base-format structure + the {{ variable }} behind each value (extraction aid).

## Detection

**Files:** *.j2

**Detection:** extension (.j2)

**Delimiter:** `(base format, detected from the name minus .j2)`

**Comments:** `(base format)`

## Path style

delegates to the base format; adds source.templateVar / source.conditional hints

## Blocks

Whatever the base format reports, with template tokens restored — so a block named by a variable reads as the file writes it. Character ranges are NOT carried through: masking preserves lines but not columns, the same reason edits are not delegated.

## Notes

- Strips .j2 and detects the base format from the remaining name (keycloak.conf.j2 -> .conf).
- Each value keeps the base format's line/anchor/path; a `{{ var }}` value also records source.templateVar.
- Lines inside {% if %}/{% for %} blocks are flagged source.conditional (their rendered line numbers are unstable).
- Brace-structured base formats (nginx/httpd) are supported: {{ }}/{% %} are masked before delegation, so a {{ var }} directive value is captured (not mis-read as a block brace) and {% %} lines do not leak as parameters.
- Intended as an extraction aid: a conversion script resolves templateVar against the variable file (defaults/group_vars), not the template.
- verify/apply on a .j2 itself fall back to line+anchor; the primary flow points source at the variable file.

## Examples

```
{{ keycloak_hostname }} -> source.templateVar: keycloak_hostname
a line inside {% if … %} -> source.conditional: true
```
