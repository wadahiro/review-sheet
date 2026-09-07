# dotenv

.env KEY=value files; export prefix stripped; surrounding quotes read as syntax; `KEY=` kept as a row; # comments.

## Detection

**Files:** *.env

**Detection:** extension (.env)

**Delimiter:** `=`

**Comments:** `#`

## Path style

flat key; the format has no sections, so a row reports no category and one is decided elsewhere

## Notes

- Leading export keyword is stripped.
- # starts comment lines.
- No sections, so no row carries a category of its own — see the properties parser.
- A matching pair of SURROUNDING quotes is the reader's syntax, not part of the value: `NAME="IAM Platform"` extracts as `IAM Platform`. This reversed an earlier decision to keep them, on a measurement rather than an argument — the product held `IAM Platform` where the sheet showed `"IAM Platform"`, so the sheet was displaying a value nothing downstream has, and it compared unequal to every unquoted dictionary default. Apply does not have to re-quote to write such a value back: the row's value is a substring of the line, so the edit lands INSIDE the existing quotes and leaves them alone. A lone quote has no partner and stays part of the value.
- `KEY=` is a row whose value is the empty string, not an absent row. A variable set to nothing is a statement, and in a layered project it is usually the one that matters — an environment overriding a shared default back to empty. Dropped, the row keeps the shared value and the sheet claims something that environment does not have. Such a row is located by the assignment itself (the value is nowhere on the line), so it resolves against `KEY=` and never against `KEY=something`, and applying a value to it writes it after the `=`.
- No shell semantics: `$VAR` interpolation, escapes and multi-line values are taken literally.

## Examples

```
DATABASE_URL
APP_PORT
```
