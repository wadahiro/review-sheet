# systemd

[Section]+Key=Value unit files; repeated keys indexed.

## Detection

**Files:** *.service *.timer *.socket *.mount *.target *.path *.slice *.scope *.automount *.netdev *.network *.link

**Detection:** extension (.service, .timer, .socket, .mount, .target, …)

**Delimiter:** `Key=Value`

**Comments:** `# ;`

## Path style

Service.ExecStartPre[1] — Section.Key; repeated keys indexed

## Blocks

Each `[Section]` is a block. Sections take no argument, so none becomes a row. Keys written before any header belong to an ASSUMED section, which the file never writes — so it carries no line and no row can point at it.

## Notes

- [Section] headings become category path segments.
- Repeated keys are indexed: Service.ExecStartPre[1].
- Unique param key is Section.Key (or Section.Key[i] for repeats).

## Examples

```
Service.ExecStart
Service.ExecStartPre[1]
Unit.Description
```
