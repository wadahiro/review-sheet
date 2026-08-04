# nginx

Directives and {} blocks; labeled blocks by label; repeats indexed.

## Detection

**Files:** nginx.conf *.conf (content-detected)

**Detection:** content (nginx block syntax) or filename nginx.conf; use --format nginx to force

**Delimiter:** `directive args;`

**Comments:** `#`

## Path style

http.server.location[/api].proxy_pass — block by label; repeats indexed

## Notes

- Detected by content (block syntax), not just extension.
- Labeled blocks addressed by label: http.server.location[/api].proxy_pass.
- Repeated directives indexed.
- `if (...)` blocks are addressed positionally instead — http.server.location[/api].if[0] — and the condition is extracted as its own reviewable/editable row (key `if`), so editing the condition never reshuffles the paths of the directives inside it.
- No reliable dedicated extension; .conf collides with sysctl/haproxy.

## Examples

```
http.server.listen
http.server.location[/api].proxy_pass
http.upstream[backend].server[0]
http.server.location[/api].if[0]
```
