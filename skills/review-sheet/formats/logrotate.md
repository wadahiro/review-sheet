# logrotate

`/path/*.log { … }` blocks: flags, `name args`, and script bodies.

## Detection

**Files:** /etc/logrotate.conf, /etc/logrotate.d/*, logrotate-*.j2

**Detection:** path (logrotate.conf, logrotate.d/, a logrotate-* template)

**Delimiter:** `whitespace (`rotate 30`); a bare word is a flag`

**Comments:** `#`

## Path style

/var/log/httpd/*log.rotate — the block's patterns, then the directive

## Notes

- A block's path patterns identify it and become the category path; directives outside any block are filed under (global), which is what logrotate.conf's own defaults are.
- A bare flag's value is `true`: it has no argument, its presence IS the setting, and logrotate's flags come in pairs (compress/nocompress) so which one is written is the row that matters.
- postrotate/prerotate/firstaction/lastaction/preremove keep their script body as the value — what runs around a rotation is exactly what a review asks about.
- Repeated directives in one block are indexed, as everywhere else: postrotate[1].
- apply holds on a flag (nothing to rewrite — add or remove the directive) and on a script body (editing it is a change to what runs on the host, not a parameter change).

## Examples

```
/var/log/httpd/*log.rotate
/var/log/httpd/*log.missingok
/var/log/httpd/*log.postrotate
```
