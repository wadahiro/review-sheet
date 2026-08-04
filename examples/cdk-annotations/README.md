# cdk-annotations — in-source `@rs` annotations (imperative IaC)

Config-as-code where the parameter sheet is described **inline** with `@rs`
annotations, so the sheet stays next to the code that owns the value. Shown in
both TypeScript (AWS CDK) and Python.

## Files

| File | Demonstrates |
| --- | --- |
| `cdk-ts/storage-stack.ts` | `@rs:config` / `@rs:category` / inline `@rs <desc>` with `@rs:default`, `@rs:remarks` on a CDK stack |
| `cdk-ts/env/dev.ts`, `env/prod.ts` | same sheet, two `instance:` values (Pattern B — per-environment columns) |
| `cdk-py/storage_stack.py` | the same annotation grammar in Python (`#` comments) |

## Run

```sh
# 1. extract a draft model (with source maps) from the annotated sources
bun run ../../src/cli.ts import \
  -f cdk-ts/storage-stack.ts cdk-ts/env/dev.ts cdk-ts/env/prod.ts cdk-py/storage_stack.py \
  -o input.json

# 2. confirm every source map resolves in the real files
bun run ../../src/cli.ts verify -i input.json

# 3. render the reviewable HTML sheet
bun run ../../src/cli.ts generate -i input.json -o sheet.html
```

`input.json` and `sheet.html` are generated artifacts (git-ignored); regenerate
them with the commands above.
