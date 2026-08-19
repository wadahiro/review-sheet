# space

Whitespace-delimited files (e.g. sshd_config); force-only, not auto-detected.

## Detection

**Files:** (force only — no dedicated extension)

**Detection:** force only (use --format space or getParser('space'))

**Delimiter:** `whitespace`

**Comments:** `#`

## Path style

flat key; the format has no sections, so a row reports no category and one is decided elsewhere

## Notes

- Not auto-detected; must be forced with --format space.
- First whitespace run splits key from value.
- Useful for sshd_config, chrony.conf, MaxClients-style files.
- A directive with NO argument is a row whose value is `true`: in a whitespace format the file says the thing by naming it (`rtcsync`) and says nothing by leaving it out, so presence IS the value. Delimited formats (properties/dotenv/sysctl/ini/generic) deliberately do not do this — there a line with no delimiter is prose or a typo, not a flag.
- Such a row is verified by the line being EXACTLY that directive, not by finding its value on the line (the value is nowhere in the file). Apply HOLDS it: turning a flag off means deleting its line and turning one on means inventing a position for it, neither of which is the literal replacement apply performs.

## Examples

```
MaxClients
PermitRootLogin
rtcsync
```
