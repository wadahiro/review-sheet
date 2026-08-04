# sysctl

sysctl-style key = value .conf files; # and ; comments.

## Detection

**Files:** *.conf (lower priority than nginx/httpd/haproxy)

**Detection:** extension (.conf, priority 5 — beaten by nginx/httpd/haproxy at 60)

**Delimiter:** `=`

**Comments:** `# ;`

## Path style

flat key (category always Parameters)

## Notes

- Lower priority than nginx/httpd/haproxy for .conf files.
- # and ; start comment lines.
- All keys in the Parameters category.

## Examples

```
net.ipv4.tcp_fin_timeout
vm.swappiness
```
