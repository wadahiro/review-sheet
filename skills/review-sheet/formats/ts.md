# TypeScript (annotations)

In-source `@rs` annotations on TS/TSX config-as-code (CDK, Pulumi); value = the RHS expression.

## Detection

**Files:** *.ts *.tsx *.mts *.cts (with @rs annotations)

**Detection:** extension (.ts/.tsx/.mts/.cts)

## Path style

StorageStack.Data.bucketName — class/construct-id/declarator names + property key

## Notes

- Only `@rs`-annotated properties are extracted (explicit opt-in).
- value is the verbatim right-hand-side expression (literal or wrapped, e.g. Duration.seconds(30)); strings shown unquoted.
- Edits replace the RHS node range and are re-parsed; a change that breaks syntax is rejected.
- Category accumulates by lexical scope (`@rs:category`), outer→inner.

## Examples

```
storage.bucketName
StorageStack.Sessions.readCapacity
```
