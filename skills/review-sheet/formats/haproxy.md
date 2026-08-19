# haproxy

Sections and directives; named sections + repeated directive by 1st arg.

## Detection

**Files:** haproxy.cfg *.cfg (content-detected)

**Detection:** content (haproxy section keywords) or filename haproxy.cfg; use --format haproxy to force

**Delimiter:** `key value (space-separated under section)`

**Comments:** `#`

## Path style

backend[app].server[web1] — named section + directive by 1st arg

## Blocks

Each section is a block; a labelled one (`backend app`) is addressed and rowed by its label.

## Notes

- Detected by haproxy section keywords (frontend/backend/global/defaults).
- Named sections: frontend[http-in], backend[app].
- Repeated directive addressed by first argument: server[web1].
- .cfg collides with ini; .conf collides with nginx/sysctl.

## Examples

```
global.maxconn
frontend[http-in].bind
backend[app].server[web1]
```
