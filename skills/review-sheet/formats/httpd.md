# httpd

Apache directives and <Tag> containers by label; repeats indexed.

## Detection

**Files:** httpd.conf .htaccess conf.d/*.conf *.conf (content-detected)

**Detection:** content (<Tag> blocks, or — for a bare *.conf with no <Tag> at all, e.g. conf.d/proxy.conf — CamelCase directive lines outnumbering key=value assignment lines) or filename httpd.conf/.htaccess; use --format httpd to force

**Delimiter:** `Directive args`

**Comments:** `#`

## Path style

VirtualHost[*:80].DocumentRoot — container by label

## Notes

- Detected by <Tag>…</Tag> container syntax.
- Also detected, for a *.conf with no <Tag> block at all (the RHEL conf.d/ layout — one directive-only file per module/vhost), by CamelCase `Name value` lines (no `=`) outnumbering sysctl/ini-style `key = value` lines — sensitive enough for a handful of directives, but a file that is mostly assignments with one incidental capitalized value stays sysctl/generic.
- Containers addressed by label: VirtualHost[*:80].DocumentRoot.
- Repeated directives indexed.
- Conditional containers (If/ElseIf/Else, IfModule, IfDefine, IfVersion, Limit/LimitExcept) are addressed positionally instead — VirtualHost[*:80].If[0] — and their expression is extracted as its own reviewable/editable row (key = the container name, e.g. `If`), so editing the condition never reshuffles the paths of the directives inside it.
- .conf collides with nginx/sysctl; content detection disambiguates.

## Examples

```
VirtualHost[*:80].DocumentRoot
VirtualHost[*:80].ServerName
Directory[/var/www].Options
VirtualHost[*:80].If[0]
```
