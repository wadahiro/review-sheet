# Dockerfile

The instructions that decide something a reviewer signs — the base image, the environment, the ports, the user, what it runs.

## Detection

**Files:** Dockerfile, Containerfile (any suffix), *.dockerfile

**Detection:** filename

## Path style

The name the instruction carries (`KC_DB` for `ENV KC_DB=…`), or the instruction's own name lowercased (`from`, `user`, `entrypoint`). A multi-stage build prefixes the stage (`build.PATH`); a repeat is indexed.

## Notes

- `FROM` is a row of the file and has no counterpart in `docker inspect`: the built image does not carry what it was built FROM (buildkit records no parent), so that row is judged against the build, not against the image.
- `RUN` is a build step, not a setting: what it changes is inside the layer it produces, and reading its shell as configuration would put a package manager's arguments on a parameter sheet.
- A continued instruction (`\` at end of line) is ONE instruction — `ENV A=1 \` + `B=2` is two values of one ENV, and reading the second line alone would make a row out of a fragment.
- `ENV NAME value` (the older, unequalled form) is read too, with the value running to end of line.

## Examples

```
KC_DB
from
entrypoint
build.PATH
EXPOSE
```
