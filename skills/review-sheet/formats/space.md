# space

Whitespace-delimited files (e.g. sshd_config); force-only, not auto-detected.

## Detection

**Files:** (force only — no dedicated extension)

**Detection:** force only (use --format space or getParser('space'))

**Delimiter:** `whitespace`

**Comments:** `#`

## Path style

flat key (category always Parameters)

## Notes

- Not auto-detected; must be forced with --format space.
- First whitespace run splits key from value.
- Useful for sshd_config, MaxClients-style files.

## Examples

```
MaxClients
PermitRootLogin
```
