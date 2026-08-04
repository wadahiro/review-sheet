# Python (annotations)

In-source `@rs` annotations on Python config-as-code (CDK for Python, Pulumi, settings); value = the RHS expression.

## Detection

**Files:** *.py (with @rs annotations)

**Detection:** extension (.py)

## Path style

config.read_capacity — assignment/class/construct-id names + key

## Notes

- Only `@rs`-annotated assignments / keyword-arguments / dict entries are extracted.
- value is the verbatim RHS (literal, `Duration.seconds(30)`, enum, …); strings shown unquoted.
- Python grammar is registered dynamically via @ast-grep/lang-python.

## Examples

```
MAX_CONN
config.read_capacity
```
