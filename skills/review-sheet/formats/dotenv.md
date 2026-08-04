# dotenv

.env KEY=value files; export prefix stripped; quotes KEPT; # comments.

## Detection

**Files:** *.env

**Detection:** extension (.env)

**Delimiter:** `=`

**Comments:** `#`

## Path style

flat key (category always Parameters)

## Notes

- Leading export keyword is stripped.
- # starts comment lines.
- All keys in the Parameters category.
- Quotes are NOT stripped: `NAME="IAM Platform"` extracts as `"IAM Platform"`, quotes included. The value is the file's text, which is what apply must put back — stripping them would make a quoted and an unquoted value indistinguishable, and re-quoting on apply a guess. Two consequences worth knowing: the sheet shows the quotes to reviewers, and such a value never compares equal to an unquoted dictionary default.
- No shell semantics: `$VAR` interpolation, escapes and multi-line values are taken literally.

## Examples

```
DATABASE_URL
APP_PORT
```
