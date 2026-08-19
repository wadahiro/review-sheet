# XML

Element text and attributes; reorder-robust paths via identity attributes.

## Detection

**Files:** *.xml

**Detection:** extension (.xml)

## Path style

server.connector.@port — attribute; services.service[name=web].port — element by identity

## Blocks

Every element is a block. One carrying `name`/`id`/`key` promotes it into the address (`local-cache[name=realms]`) and becomes a row valued by that attribute, whose own attribute row is then suppressed — the fact is stated once. Promotion does not depend on how many siblings the element has.

## Notes

- Attribute values addressed with .@attr suffix.
- Repeated elements addressed by identity attribute (name/id/key) → reorder-robust.
- Positional [i] fallback when no identity attribute exists.
- Mixed content and CDATA sections are skipped.

## Examples

```
server.connector.@port
services.service[name=web].port
beans.bean[id=myBean].property.@value
```
