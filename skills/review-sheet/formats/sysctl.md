# sysctl

sysctl-style key = value .conf files; # and ; comments.

## Detection

**Files:** *.conf (lower priority than nginx/httpd/haproxy)

**Detection:** extension (.conf, priority 5 — beaten by nginx/httpd/haproxy at 60)

**Delimiter:** `=`

**Comments:** `# ;`

## Path style

flat key; the format has no sections, so a row reports no category and one is decided elsewhere

## Notes

- Lower priority than nginx/httpd/haproxy for .conf files.
- # and ; start comment lines.
- No sections, so no row carries a category of its own — see the properties parser.

## Examples

```
net.ipv4.tcp_fin_timeout
vm.swappiness
```
