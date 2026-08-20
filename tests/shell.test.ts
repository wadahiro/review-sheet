import { describe, it, expect } from "bun:test";
import { shellIndex, shellLocate, shellEdit, isShell } from "../src/shell";
import { extractFile } from "../src/extract";
import "../src/parsers/index.js";

const script = [
  "#!/usr/bin/env bash",
  "# a comment REGION=nope --not=a-flag",
  "set -euo pipefail",
  "",
  "REGION=ap-northeast-1",
  'export APP_NAME="IAM Platform"',
  "EMPTY=",
  "",
  "aws secretsmanager get-secret-value \\",
  "  --secret-id iam/keycloak/db \\",
  "  --region ap-northeast-1 \\",
  "  --verbose \\",
  "  --output=text",
  "",
  "curl -s -X POST --retry 3 https://example.com",
].join("\n");

const byKey = (content: string) => Object.fromEntries(shellIndex(content).map((e) => [e.key, e.value]));

describe("shellIndex", () => {
  const idx = byKey(script);

  it("reads variable assignments, including behind export", () => {
    expect(idx["REGION"]).toBe("ap-northeast-1");
    expect(idx["APP_NAME"]).toBe('"IAM Platform"'); // quotes kept, like dotenv
  });

  it("skips an assignment with no value and anything in a comment line", () => {
    expect(idx["EMPTY"]).toBeUndefined();
    expect(idx["--not"]).toBeUndefined();
  });

  it("reads long options in both spellings, keeping the dashes in the key", () => {
    expect(idx["--secret-id"]).toBe("iam/keycloak/db");
    expect(idx["--region"]).toBe("ap-northeast-1");
    expect(idx["--output"]).toBe("text");
  });

  it("continues a statement across a trailing backslash", () => {
    // Every option above sits on a continuation line; treating those first words
    // as command names would swallow --secret-id and --region entirely.
    expect(shellIndex(script).find((e) => e.key === "--secret-id")!.line).toBe(10);
  });

  it("ignores bare flags, short options and positional arguments", () => {
    expect(idx["--verbose"]).toBeUndefined(); // no value to map or edit
    expect(idx["-X"]).toBeUndefined();
    expect(idx["-s"]).toBeUndefined();
    expect(Object.keys(idx)).not.toContain("https://example.com");
  });

  it("still reads a long option that follows short ones", () => {
    expect(idx["--retry"]).toBe("3");
  });

  it("files assignments and options under separate categories", () => {
    const cats = Object.fromEntries(shellIndex(script).map((e) => [e.key, e.categoryPath[0]]));
    expect(cats["REGION"]).toBe("Variables");
    expect(cats["--region"]).toBe("Options");
  });
});

describe("shellIndex — command substitution", () => {
  const sub = 'PASSWORD=$(aws secretsmanager get-secret-value --region ap-northeast-1 --output text)';

  it("does not take a command substitution as the variable's value", () => {
    expect(byKey(sub)["PASSWORD"]).toBeUndefined();
  });

  it("still reads the options inside it, without the closing paren", () => {
    expect(byKey(sub)["--output"]).toBe("text");
    expect(byKey(sub)["--region"]).toBe("ap-northeast-1");
  });
});

describe("shellIndex — heredocs", () => {
  const doc = ["cat <<'EOF' > /etc/app.conf", "PAYLOAD=not-a-parameter", "--flag also-not", "EOF", "REAL=yes"].join("\n");

  it("skips the body — it is payload, not this script's configuration", () => {
    const idx = byKey(doc);
    expect(idx["PAYLOAD"]).toBeUndefined();
    expect(idx["--flag"]).toBeUndefined();
    expect(idx["REAL"]).toBe("yes");
  });
});

describe("shellIndex — repeated keys", () => {
  const rep = ["docker run --env A=1 --env B=2 img"].join("\n");

  it("indexes repeats by position", () => {
    expect(byKey(rep)).toMatchObject({ "--env[0]": "A=1", "--env[1]": "B=2" });
  });
});

describe("shellLocate / shellEdit", () => {
  it("locates by path and edits in place", () => {
    const out = shellEdit(script, "--region", "ap-northeast-1", "us-east-1");
    expect(out.status).toBe("applied");
    if (out.status !== "applied") throw new Error("unreachable");
    expect(out.content).toContain("--region us-east-1");
    expect(out.content).toContain("REGION=ap-northeast-1"); // the variable is a different key
    expect(shellLocate(out.content, "--region")).toEqual({ value: "us-east-1" });
  });

  it("keeps the original quoting so one argument never becomes two", () => {
    const out = shellEdit(script, "APP_NAME", '"IAM Platform"', "Other Platform");
    if (out.status !== "applied") throw new Error("expected applied");
    expect(out.content).toContain('export APP_NAME="Other Platform"');
  });

  it("refuses when the current value does not match, and is idempotent", () => {
    expect(shellEdit(script, "--region", "wrong", "x").status).toBe("error");
    const once = shellEdit(script, "--region", "ap-northeast-1", "us-east-1");
    if (once.status !== "applied") throw new Error("expected applied");
    expect(shellEdit(once.content, "--region", "ap-northeast-1", "us-east-1").status).toBe("skipped");
  });
});

describe("isShell / parser registration", () => {
  it("detects by extension and by shebang", () => {
    expect(isShell("deploy.sh", "")).toBe(true);
    expect(isShell("deploy", "#!/usr/bin/env bash\n")).toBe(true);
    expect(isShell("app.conf", "listen 80;\n")).toBe(false);
  });

  it("is reachable through extractFile", () => {
    const keys = extractFile("REGION=ap-northeast-1\n", "run.sh").map((e) => e.key);
    expect(keys).toEqual(["REGION"]);
  });

  // The reason this parser exists: `.j2` is stripped before the base format is
  // resolved, so a templated wrapper script becomes reviewable and each argument
  // records the variable behind it.
  it("gives *.sh.j2 a base format, recording each argument's templateVar", () => {
    const tpl = ["#!/usr/bin/env bash", "aws secretsmanager get-secret-value \\", "  --secret-id {{ kc_db_secret_name }} \\", "  --region {{ kc_db_secret_region }}"].join("\n");
    const entries = extractFile(tpl, "keycloak-secrets.sh.j2");
    expect(entries.map((e) => [e.key, e.value, e.source.templateVar])).toEqual([
      ["--secret-id", "{{ kc_db_secret_name }}", "kc_db_secret_name"],
      ["--region", "{{ kc_db_secret_region }}", "kc_db_secret_region"],
    ]);
  });
});

// This module's doc says a `--secret-id {{ kc_db_secret_name }}` argument
// records its templateVar — the recipe parses TEMPLATES with this parser, and
// a `.j2` writes its expressions spaced. Tokenizing on those spaces made every
// such value the two opening braces.
describe("a Jinja expression is one word", () => {
  it("keeps a spaced {{ ... }} whole as an option's value", () => {
    const t = "#!/bin/sh\naws secretsmanager get-secret-value --secret-id {{ kc_db_secret_name }} --region {{ r }}\n";
    const got = shellIndex(t).map((e) => [e.key, e.value]);
    expect(got).toEqual([
      ["--secret-id", "{{ kc_db_secret_name }}"],
      ["--region", "{{ r }}"],
    ]);
  });

  it("keeps one whole when it is part of a larger word", () => {
    const t = "#!/bin/sh\ncp x --out /run/vault/{{ v.realm }}_{{ v.key }}\n";
    expect(shellIndex(t).map((e) => e.value)).toEqual(["/run/vault/{{ v.realm }}_{{ v.key }}"]);
  });

  // An unterminated brace pair is not an expression, and treating it as one
  // would swallow the rest of the line.
  it("leaves an unclosed brace alone", () => {
    expect(shellIndex("#!/bin/sh\nx --opt {{ oops\n").map((e) => e.value)).toEqual(["{{"]);
  });
});
