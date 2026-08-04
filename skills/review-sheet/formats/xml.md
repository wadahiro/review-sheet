# XML

Element text and attributes; reorder-robust paths via identity attributes.

## Detection

**Files:** *.xml

**Detection:** extension (.xml)

## Path style

server.connector.@port — attribute; services.service[name=web].port — element by identity

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
