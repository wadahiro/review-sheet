// The shared preview engine (src/preview.ts), tested directly and in
// isolation from either producer that will eventually call it. Ships dark
// (T1): nothing under src/recipes/ calls this yet, so these tests are the
// spec the follow-up wiring task has to preserve.
//
// The `previewRendered` cases mirror tests/artifact-preview.test.ts's
// semantics one for one, since previewRendered is a MOVE of the ansible
// recipe's renderPreview + dedupe loop, not a rewrite.

import { describe, it, expect } from "bun:test";
import {
  MAX_PREVIEW_BYTES,
  addLineKey,
  previewId,
  previewFile,
  previewRendered,
  type LineKeys,
  type PreviewSource,
} from "../src/preview";

function src(overrides: Partial<PreviewSource> = {}): PreviewSource {
  return { id: "os", sheet: "os", source_file: "/config/app.conf", ...overrides };
}

describe("previewId", () => {
  it("is the sheet name alone with no component", () => {
    expect(previewId("os")).toBe("os");
  });

  it("is sheet::component when there is a component", () => {
    expect(previewId("os", "httpd")).toBe("os::httpd");
  });

  it("appends a file-basename discriminator only when a file is given", () => {
    expect(previewId("os", "httpd", "roles/httpd/templates/httpd.conf.j2")).toBe("os::httpd::httpd.conf.j2");
    expect(previewId("os", undefined, "roles/os/vars/main.yml")).toBe("os::main.yml");
  });
});

describe("addLineKey", () => {
  it("no-ops when the line is undefined", () => {
    const keys: LineKeys = new Map();
    addLineKey(keys, undefined, "some.key");
    expect(keys.size).toBe(0);
  });

  it("attaches a key at its 1-based line", () => {
    const keys: LineKeys = new Map();
    addLineKey(keys, 3, "some.key");
    expect(keys.get(3)).toEqual(["some.key"]);
  });

  it("is last-wins on a collision", () => {
    const keys: LineKeys = new Map();
    addLineKey(keys, 3, "first");
    addLineKey(keys, 3, "second");
    expect(keys.get(3)).toEqual(["second"]);
  });

  // A `{% for %}` writes its body once per element, and each copy is its own
  // row wanting its own line. Keyed by line alone, the copies collided: the
  // last member's key was kept and hung on the FIRST copy, so one row linked to
  // another row's line and the rest had no line at all.
  it("keeps one key per element of a loop, in element order", () => {
    const keys: LineKeys = new Map();
    addLineKey(keys, 3, "--region[1]", 0);
    addLineKey(keys, 3, "--region[2]", 1);
    expect(keys.get(3)).toEqual(["--region[1]", "--region[2]"]);
  });
});

describe("previewFile: the size gate", () => {
  it("refuses content over MAX_PREVIEW_BYTES, warning and returning undefined", () => {
    const warnings: string[] = [];
    const big = "x".repeat(MAX_PREVIEW_BYTES + 1);
    const result = previewFile(src(), big, new Map(), (m) => warnings.push(m));
    expect(result).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("/config/app.conf");
    expect(warnings[0]).toContain("KB");
    expect(warnings[0]).toContain(`${Math.round(MAX_PREVIEW_BYTES / 1024)} KB`);
  });

  it("accepts content at or under the limit without warning", () => {
    const warnings: string[] = [];
    const ok = "x".repeat(MAX_PREVIEW_BYTES);
    const result = previewFile(src(), ok, new Map(), (m) => warnings.push(m));
    expect(result).toBeDefined();
    expect(warnings).toEqual([]);
  });
});

describe("previewFile: a committed file is verbatim by identity", () => {
  it("reproduces every line, including blank ones, untouched", () => {
    const content = "line one\n\n# a comment\nlast line";
    const result = previewFile(src(), content, new Map(), () => {})!;
    expect(result.lines.map((l) => l.text)).toEqual(["line one", "", "# a comment", "last line"]);
    expect(result.lines.every((l) => l.kind === "verbatim")).toBe(true);
  });

  it("attaches a row's key at its line via LineKeys, and leaves other lines bare", () => {
    const content = "a\nb\nc";
    const keys: LineKeys = new Map();
    addLineKey(keys, 2, "the.row.key");
    const result = previewFile(src(), content, keys, () => {})!;
    expect(result.lines[0].key).toBeUndefined();
    expect(result.lines[1].key).toBe("the.row.key");
    expect(result.lines[2].key).toBeUndefined();
  });

  it("carries id/sheet/component/deployed_path/source_file from PreviewSource", () => {
    const result = previewFile(
      src({ id: "os::httpd", sheet: "os", component: "httpd", deployed_path: "/etc/httpd/httpd.conf" }),
      "content",
      new Map(),
      () => {}
    )!;
    expect(result.id).toBe("os::httpd");
    expect(result.sheet).toBe("os");
    expect(result.component).toBe("httpd");
    expect(result.deployed_path).toBe("/etc/httpd/httpd.conf");
    expect(result.source_file).toBe("/config/app.conf");
  });

  it("omits component/deployed_path entirely when not given, rather than undefined", () => {
    const result = previewFile(src(), "content", new Map(), () => {})!;
    expect("component" in result).toBe(false);
    expect("deployed_path" in result).toBe(false);
  });
});

describe("previewRendered: the size gate", () => {
  it("refuses a template over MAX_PREVIEW_BYTES, warning and returning []", () => {
    const warnings: string[] = [];
    const big = "x".repeat(MAX_PREVIEW_BYTES + 1);
    const result = previewRendered(src(), big, [], () => undefined, new Map(), new Set(), (m) => warnings.push(m));
    expect(result).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("KB");
  });
});

describe("previewRendered: line kinds", () => {
  const resolve = (vars: Record<string, string>) => (_i: string | undefined, n: string) => vars[n];

  it("a line with no Jinja is verbatim", () => {
    const [p] = previewRendered(src(), "a plain line", [], resolve({}), new Map(), new Set(), () => {});
    expect(p.lines).toEqual([{ text: "a plain line", kind: "verbatim" }]);
  });

  it("a resolved {{ var }} is substituted", () => {
    const [p] = previewRendered(src(), "host = {{ hostname }}", [], resolve({ hostname: "example.com" }), new Map(), new Set(), () => {});
    expect(p.lines).toEqual([{ text: "host = example.com", kind: "substituted" }]);
  });

  it("a line inside a false {% if %} is absent, with its condition as the reason", () => {
    const template = "{% if enabled %}\nfeature on\n{% endif %}";
    const [p] = previewRendered(src(), template, [], resolve({ enabled: "false" }), new Map(), new Set(), () => {});
    const line = p.lines.find((l) => l.text === "feature on")!;
    expect(line.kind).toBe("absent");
    expect(line.reason).toBe("enabled");
  });

  it("a line whose {{ var }} nothing resolves is unrendered, shown wholly as written", () => {
    const [p] = previewRendered(src(), 'x = "{{ missing }}" trailing', [], resolve({}), new Map(), new Set(), () => {});
    expect(p.lines).toEqual([
      { text: 'x = "{{ missing }}" trailing', kind: "unrendered", cause: "engine", reason: "{{ missing }}" },
    ]);
  });

  it("a {% ... %} tag line itself produces no output line", () => {
    const template = "{% if x %}\ninside\n{% endif %}";
    const [p] = previewRendered(src(), template, [], resolve({ x: "true" }), new Map(), new Set(), () => {});
    expect(p.lines.map((l) => l.text)).toEqual(["inside"]);
  });

  it("attaches keys by the TEMPLATE's own line number, even though {% %} lines are skipped in the output", () => {
    // line 1: {% if x %} (skipped in output), line 2: the row, line 3: {% endif %}
    const template = "{% if x %}\nkey line\n{% endif %}";
    const keys: LineKeys = new Map();
    addLineKey(keys, 2, "row.key");
    const [p] = previewRendered(src(), template, [], resolve({ x: "true" }), keys, new Set(), () => {});
    expect(p.lines.find((l) => l.text === "key line")?.key).toBe("row.key");
  });
});

describe("previewRendered: unrendered cause", () => {
  it("is deploy-time only when EVERY unresolved name is declared deploy-time", () => {
    const [p] = previewRendered(
      src(),
      "{{ ansible_managed }}",
      [],
      () => undefined,
      new Map(),
      new Set(["ansible_managed"]),
      () => {}
    );
    expect(p.lines[0].kind).toBe("unrendered");
    expect(p.lines[0].cause).toBe("deploy-time");
  });

  it("is engine when ANY unresolved name is not declared deploy-time", () => {
    const [p] = previewRendered(
      src(),
      "{{ ansible_managed }} and {{ app_secret }}",
      [],
      () => undefined,
      new Map(),
      new Set(["ansible_managed"]),
      () => {}
    );
    expect(p.lines[0].kind).toBe("unrendered");
    expect(p.lines[0].cause).toBe("engine");
  });
});

describe("previewRendered: per-instance dedupe", () => {
  it("falls back to a single undefined instance when instances is empty", () => {
    const resolve = (_i: string | undefined, n: string) => (n === "v" ? "1" : undefined);
    const previews = previewRendered(src(), "x = {{ v }}", [], resolve, new Map(), new Set(), () => {});
    expect(previews.length).toBe(1);
    expect(previews[0].instances).toBeUndefined();
  });

  it("merges identical renderings into one preview listing the instances that share them", () => {
    const resolve = (_i: string | undefined, n: string) => (n === "v" ? "same-for-both" : undefined);
    const previews = previewRendered(src(), "x = {{ v }}", ["local", "prod"], resolve, new Map(), new Set(), () => {});
    expect(previews.length).toBe(1);
    expect(previews[0].instances).toEqual(["local", "prod"]);
  });

  it("emits a separate preview per distinct rendering", () => {
    const values: Record<string, string> = { local: "1", prod: "2" };
    const resolve = (i: string | undefined, n: string) => (n === "v" ? values[i!] : undefined);
    const previews = previewRendered(src(), "x = {{ v }}", ["local", "prod"], resolve, new Map(), new Set(), () => {});
    expect(previews.length).toBe(2);
    const byInstance = new Map(previews.map((p) => [p.instances?.[0], p.lines[0].text]));
    expect(byInstance.get("local")).toBe("x = 1");
    expect(byInstance.get("prod")).toBe("x = 2");
  });

  it("carries id/sheet/component/deployed_path/source_file onto every emitted preview", () => {
    const [p] = previewRendered(
      src({ id: "os::app", sheet: "os", component: "app", deployed_path: "/etc/app.conf" }),
      "plain",
      [],
      () => undefined,
      new Map(),
      new Set(),
      () => {}
    );
    expect(p.id).toBe("os::app");
    expect(p.sheet).toBe("os");
    expect(p.component).toBe("app");
    expect(p.deployed_path).toBe("/etc/app.conf");
    expect(p.source_file).toBe("/config/app.conf");
  });
});
