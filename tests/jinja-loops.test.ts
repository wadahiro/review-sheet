// A loop is the one Jinja shape that turns ONE template line into several lines
// of the deployed file. Read here so the recipe can expand it; the stance is the
// conditions' — support the plain shape and REPORT the rest, because a guess
// puts lines on the sheet that the deployed file does not have.

import { describe, it, expect } from "bun:test";
import { jinjaLoops } from "../src/jinja2";
import { getRecipe, type RecipeIO } from "../src/recipe";
import "../src/recipes/index.js";

const at = (content: string, line: number) => jinjaLoops(content).get(line);

describe("jinjaLoops", () => {
  it("reads the plain shape, and says what each line repeats over", () => {
    const t = "{% for s in ntp_servers %}\nserver {{ s }} iburst\n{% endfor %}\n";
    expect(at(t, 2)).toEqual({ supported: true, variable: "s", list: "ntp_servers" });
  });

  it("says nothing about lines outside any loop", () => {
    const t = "driftfile /var/lib/chrony/drift\n{% for s in ntp %}\nserver {{ s }}\n{% endfor %}\nrtcsync\n";
    expect(at(t, 1)).toBeUndefined();
    expect(at(t, 5)).toBeUndefined();
    expect(at(t, 3)).toMatchObject({ supported: true });
  });

  // Each of these would need an evaluator this one is not: a filter changes the
  // sequence, tuple unpacking binds two names, and a nested loop repeats a line
  // over two axes at once while a row is addressed by one index.
  it("refuses a filter, tuple unpacking and a nested loop", () => {
    expect(at("{% for s in ntp | sort %}\nx {{ s }}\n{% endfor %}\n", 2)).toMatchObject({ supported: false });
    expect(at("{% for k, v in items %}\nx {{ k }}\n{% endfor %}\n", 2)).toMatchObject({ supported: false });
    expect(at("{% for a in xs %}\n{% for b in ys %}\nx {{ b }}\n{% endfor %}\n{% endfor %}\n", 3)).toMatchObject({ supported: false });
  });

  // The arm's own membership is a negation this deliberately does not compute —
  // the same rule the conditions follow for `{% else %}`.
  it("refuses a loop with an else arm", () => {
    expect(at("{% for s in ntp %}\nx {{ s }}\n{% else %}\ny\n{% endfor %}\n", 2)).toMatchObject({ supported: false });
  });
});

// The expansion end to end. A loop renders ONE template line as several lines
// of the deployed file, and each of them belongs to one element of a vars file
// — which is where a reviewer changes it, so that is where the row points.
describe("ansible recipe: a template line inside a {% for %}", () => {
  const FILES: Record<string, string> = {
    "/vars.yml": "ntp:\n  - a.example.invalid\n  - b.example.invalid\n",
    "/chrony.conf.j2": "{% for s in ntp %}\nserver {{ s }} iburst\n{% endfor %}\ndriftfile /var/lib/chrony/drift\n",
  };
  const io: RecipeIO = { readFile: (p) => FILES[p] ?? null, specDir: "/", resolve: (p) => p, instances: [] };
  const load = () =>
    getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: [{ path: "/vars.yml", key: { from: "path" } }],
        templates: [{ path: "/chrony.conf.j2", component: "chrony", deployed_path: "/etc/chrony.conf", format: "space" }],
      } as never,
      io
    );
  type Emb = { key: string; value: string; source: { file?: string; line?: number; path?: string; substituted?: boolean } };
  const embedded = () => (load().embedded ?? []) as Emb[];

  it("renders one row per member, named by the directive the line writes", () => {
    expect(embedded().map((e) => e.key)).toEqual(["server", "server[1]", "driftfile"]);
  });

  it("gives each row the line it renders to, not the variable behind it", () => {
    expect(embedded()[0].value).toBe("a.example.invalid iburst");
    expect(embedded()[1].value).toBe("b.example.invalid iburst");
  });

  // The point of expanding at all. The template holds the structure; the value
  // a reviewer would change is the element, in another file.
  it("points each row at its own element of the vars file", () => {
    const [first, second] = embedded();
    expect(first.source).toMatchObject({ file: "/vars.yml", path: "ntp[0]", substituted: true });
    expect(second.source).toMatchObject({ file: "/vars.yml", path: "ntp[1]", substituted: true });
  });

  // Left in the base map as well, each element would be a second row for one
  // setting: one under the file it renders into, one under the variable.
  it("does not also leave the elements as variable rows", () => {
    const base = [...(load().layers[0] as { entries: Map<string, unknown> }).entries.keys()];
    expect(base.filter((k) => k.startsWith("ntp["))).toEqual([]);
  });
});

// A vars file writes lists of MAPS as readily as lists of scalars, and the
// template says which it expects: `{{ v.secret_name }}`. Its fields arrive as
// their own entries, so a member is the set of them.
describe("ansible recipe: a {% for %} over a list of maps", () => {
  const FILES: Record<string, string> = {
    "/vars.yml":
      "secrets:\n  - key: corp\n    realm: poc\n    secret_name: app/corp\n  - key: partner\n    realm: poc\n    secret_name: app/partner\n",
    "/fetch.sh.j2":
      "#!/bin/sh\n{% for v in secrets %}\naws get --secret-id {{ v.secret_name }}\ncp x --out /run/vault/{{ v.realm }}_{{ v.key }}\n{% endfor %}\n",
  };
  const io: RecipeIO = { readFile: (p) => FILES[p] ?? null, specDir: "/", resolve: (p) => p, instances: [] };
  const load = () =>
    getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: [{ path: "/vars.yml", key: { from: "path" } }],
        templates: [{ path: "/fetch.sh.j2", component: "fetch.sh", deployed_path: "/usr/local/bin/fetch.sh" }],
      } as never,
      io
    );
  type Emb = { key: string; value: string; source: { file?: string; line?: number; path?: string; substituted?: boolean } };
  const embedded = () => (load().embedded ?? []) as Emb[];

  it("renders one row per element, with the fields the line names resolved", () => {
    const rows = embedded().filter((e) => e.key.startsWith("--secret-id"));
    expect(rows.map((e) => e.value)).toEqual(["app/corp", "app/partner"]);
  });

  // The key names a place in the RENDERED file, so it has to be a key that
  // file's own parse can produce: three `--secret-id` occurrences after
  // rendering are [0], [1], [2]. Keying by the element instead — which is
  // stabler, and tempting for exactly that reason — re-bases the row's identity
  // onto the vars file, and no parse of the artifact under review can yield it.
  // The element's stable identity is the row's SOURCE, checked just below.
  it("continues the occurrence numbering the rendered file has", () => {
    const rows = embedded().filter((e) => e.key.startsWith("--secret-id"));
    expect(rows.map((e) => e.key)).toEqual(["--secret-id", "--secret-id[1]"]);
  });

  // KNOWN GAP, pinned rather than described: the numbering continues the
  // TEMPLATE's, and a key the template holds once carries no number to
  // continue. Rendered, that key repeats — and a parser that indexes repeats
  // (shell does; the space format does not index them at all) then addresses
  // the first copy `--secret-id[0]` where the sheet says `--secret-id`.
  //
  // It bites only when a key occurs exactly once in the template AND lands
  // inside a loop; two occurrences, which is the shape that raised all this,
  // line up exactly (checked just below). Closing it properly means deriving an
  // artifact row's key from a parse of the RENDERED text rather than the
  // template's — which is the honest form of "addressed the way the file
  // addresses it" and is a change to every artifact sheet, not to loops.
  it("does not yet index the first copy when the template held the key only once", () => {
    const rows = embedded().filter((e) => e.key.startsWith("--secret-id"));
    expect(rows[0].key).toBe("--secret-id");
    expect(rows[0].key).not.toBe("--secret-id[0]");
  });

  // The whole point of expanding: the value a reviewer would change is the
  // field, in the vars file.
  it("points a row at the FIELD its line used, not at the element", () => {
    const rows = embedded().filter((e) => e.key.startsWith("--secret-id"));
    expect(rows[0].source).toMatchObject({ file: "/vars.yml", path: "secrets[key=corp].secret_name", substituted: true });
    expect(rows[1].source).toMatchObject({ file: "/vars.yml", path: "secrets[key=partner].secret_name", substituted: true });
  });

  // `key` is the field the format folded into the element's ADDRESS to
  // identify it, so it renders and has no site of its own. A line composed of
  // it and a real field points at the field — the first thing the value
  // interpolated that HAS a site, which is the rule the ordinary multi-variable
  // line already follows. Pointing at the template instead would send verify at
  // `{{ … }}` with a rendered value in hand.
  it("points a composed line at the first of its parts that has a site", () => {
    const rows = embedded().filter((e) => e.key.startsWith("--out"));
    expect(rows.map((e) => e.value)).toEqual(["/run/vault/poc_corp", "/run/vault/poc_partner"]);
    expect(rows[0].source).toMatchObject({ file: "/vars.yml", path: "secrets[key=corp].realm", substituted: true });
  });

  // A loop line may interpolate an ordinary variable and no member field at all
  // — the same value on every rendered copy. It is sourced where any other line
  // using that variable would be.
  it("points a line that used no member field at the variable it did use", () => {
    const FILES2: Record<string, string> = {
      ...FILES,
      "/vars.yml": FILES["/vars.yml"] + "region: ap-northeast-1\n",
      "/fetch.sh.j2": "#!/bin/sh\n{% for v in secrets %}\naws get --secret-id {{ v.secret_name }} --region {{ region }}\n{% endfor %}\n",
    };
    const si = getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: [{ path: "/vars.yml", key: { from: "path" } }],
        templates: [{ path: "/fetch.sh.j2", component: "fetch.sh", deployed_path: "/usr/local/bin/fetch.sh" }],
      } as never,
      { readFile: (p: string) => FILES2[p] ?? null, specDir: "/", resolve: (p: string) => p, instances: [] }
    );
    const rows = ((si.embedded ?? []) as Emb[]).filter((e) => e.key.startsWith("--region"));
    expect(rows.map((e) => e.value)).toEqual(["ap-northeast-1", "ap-northeast-1"]);
    expect(rows[0].source).toMatchObject({ file: "/vars.yml", path: "region", substituted: true });
  });

  // The row would read ap-northeast-1 in an environment whose overlay says
  // otherwise. Rendering a loop from the defaults is the existing choice; going
  // quiet about what that costs is not.
  it("says so when an overlay overrides a variable a loop line interpolates", () => {
    const warn: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warn.push(String(a[0]));
    try {
      const FILES3: Record<string, string> = {
        "/vars.yml": FILES["/vars.yml"] + "region: ap-northeast-1\n",
        "/local.yml": "region: us-east-1\n",
        "/fetch.sh.j2": "#!/bin/sh\n{% for v in secrets %}\naws get --secret-id {{ v.secret_name }} --region {{ region }}\n{% endfor %}\n",
      };
      getRecipe("ansible")!.load(
        {
          name: "s",
          recipe: "ansible",
          rows: "artifact",
          defaults: [{ path: "/vars.yml", key: { from: "path" } }],
          overlays: { local: "/local.yml" },
          templates: [{ path: "/fetch.sh.j2", component: "fetch.sh", deployed_path: "/usr/local/bin/fetch.sh" }],
        } as never,
        { readFile: (p: string) => FILES3[p] ?? null, specDir: "/", resolve: (p: string) => p, instances: ["local"] }
      );
    } finally {
      console.warn = orig;
    }
    const said = warn.find((w) => w.includes("interpolates region"));
    expect(said).toBeDefined();
    expect(said).toContain("local");
    expect(said).toContain("ap-northeast-1");
  });

  // The preview is the same claim as the rows, about the same lines. It walked
  // the list itself, counting list[0] upward, so a list of maps read as empty
  // and the panel said the loop could not be computed while its rows were on
  // the sheet.
  it("renders the loop in the preview too, once per element", () => {
    const [preview] = load().artifacts ?? [];
    const rendered = preview.lines.filter((l) => l.text.includes("--secret-id"));
    expect(rendered.map((l) => l.kind)).toEqual(["substituted", "substituted"]);
    expect(rendered.map((l) => l.text)).toEqual([
      "aws get --secret-id app/corp",
      "aws get --secret-id app/partner",
    ]);
    expect(preview.lines.every((l) => l.kind !== "unrendered")).toBe(true);
  });

  it("does not also leave the fields as variable rows", () => {
    const base = [...(load().layers[0] as { entries: Map<string, unknown> }).entries.keys()];
    expect(base.filter((k) => k.startsWith("secrets["))).toEqual([]);
  });
});

// What the preview CLAIMS about a file, checked against how Jinja actually
// writes it. Each of these was measured wrong first, by rendering a real
// template with the real toolchain and diffing.
describe("preview: a loop block, and the condition around it", () => {
  const FILES: Record<string, string> = {
    // Two fields per element on purpose: a list of maps whose elements carry
    // ONLY their identifying field yields no entries at all — the address is
    // where that field went — and such a list is one this sheet genuinely
    // reads no elements of.
    "/vars.yml": "items:\n  - name: one\n    mode: a\n  - name: two\n    mode: b\n",
    // A body of SEVERAL lines, which is what tells the two orders apart.
    "/app.conf.j2": "head\n{% if items %}\nbefore the loop\n{% for v in items %}\nopen {{ v.name }}\nclose {{ v.name }}\n{% endfor %}\n{% endif %}\ntail\n",
  };
  const run = (files: Record<string, string>, instances: string[] = []) =>
    getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: [{ path: "/vars.yml", key: { from: "path" } }],
        templates: [{ path: "/app.conf.j2", component: "app", deployed_path: "/etc/app.conf", format: "space" }],
      } as never,
      { readFile: (p: string) => files[p] ?? null, specDir: "/", resolve: (p: string) => p, instances }
    );
  const texts = (files = FILES) => (run(files).artifacts ?? [])[0].lines.map((l) => `${l.kind[0]} ${l.text}`);

  // Jinja repeats the BODY: element one's whole block, then element two's. A
  // renderer that only knew "which loop is this line in" emitted every copy of
  // line 1, then every copy of line 2 — invisible until a body had two lines.
  it("repeats the whole body per element, in the order the file has", () => {
    expect(texts()).toEqual([
      "v head",
      "v before the loop",
      "s open one",
      "s close one",
      "s open two",
      "s close two",
      "v tail",
      "v ",
    ]);
  });

  // `{% if items %}` over a LIST. It has no scalar value, so asking for one
  // answered undefined and the block was struck through as absent — while the
  // loop inside it rendered from the very elements the condition could not
  // see. The preview asserted the block was both taken and not taken.
  it("reads a list with elements as true", () => {
    expect(texts()).toContain("v before the loop");
  });

  // `absent` is a positive claim that the deployed file does not contain the
  // line, and for a name this sheet cannot read there is no evidence for it:
  // "the deployment leaves it unset" and "the sheet was never pointed at the
  // file that sets it" are indistinguishable, and only the first makes the line
  // absent.
  it("says it does not know, rather than claiming absent, when it cannot read the condition at all", () => {
    const files = { ...FILES, "/app.conf.j2": "head\n{% if nothing_reads_this %}\ninside\n{% endif %}\ntail\n" };
    const line = (run(files).artifacts ?? [])[0].lines.find((l) => l.text === "inside")!;
    expect(line.kind).toBe("unrendered");
    expect(line.cause).toBe("engine");
    expect(line.reason).toContain("nothing_reads_this");
    expect(line.reason).toContain("reads no value for it");
  });

  // A readable variable that IS falsy keeps its absent — that outcome is a real
  // per-environment difference and the common case.
  it("still marks a line absent when the condition is readable and false", () => {
    const files = {
      "/vars.yml": "items:\n  - name: one\n    mode: a\nflag: false\n",
      "/app.conf.j2": "head\n{% if flag %}\ninside\n{% endif %}\ntail\n",
    };
    const line = (run(files).artifacts ?? [])[0].lines.find((l) => l.text === "inside")!;
    expect(line.kind).toBe("absent");
  });
});

// The same question on the ROW side. A row inside `{% if the_list %}` was
// dropped and the list reported as a variable the sheet does not read — while
// the `{% for the_list %}` in the same block was producing rows from its
// elements.
describe("rows: a {% if %} on a list the sheet reads through its elements", () => {
  const FILES: Record<string, string> = {
    "/vars.yml": "items:\n  - name: one\n    mode: a\n  - name: two\n    mode: b\n",
    "/app.conf.j2": "head x\n{% if items %}\nguard on\n{% for v in items %}\nopen {{ v.mode }}\n{% endfor %}\n{% endif %}\n",
  };
  const load = () =>
    getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: [{ path: "/vars.yml", key: { from: "path" } }],
        templates: [{ path: "/app.conf.j2", component: "app", deployed_path: "/etc/app.conf", format: "space" }],
      } as never,
      { readFile: (p: string) => FILES[p] ?? null, specDir: "/", resolve: (p: string) => p, instances: [] }
    );

  it("keeps the row the block guards, and says nothing about the list", () => {
    const warn: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warn.push(String(a[0]));
    let keys: string[];
    try {
      keys = (load().embedded ?? []).map((e) => e.key);
    } finally {
      console.warn = orig;
    }
    expect(keys).toContain("guard");
    expect(warn.filter((w) => w.includes("which this sheet does not read"))).toEqual([]);
  });
});


// Numbering a repeated key the way the RENDERED file does, which is what lets
// the project-level check ("every row key equals a key parsed from the file the
// toolchain really wrote") hold over a template with a loop in it.
describe("rows: occurrence numbers a loop multiplied", () => {
  const FILES: Record<string, string> = {
    "/vars.yml": "items:\n  - name: one\n    mode: a\n  - name: two\n    mode: b\n",
    // `--opt` occurs three times in the TEMPLATE: before the loop, inside it,
    // and after. Rendered, that is four — the loop contributes two.
    "/app.sh.j2":
      "#!/bin/sh\nx --opt first\n{% for v in items %}\nx --opt {{ v.mode }}\n{% endfor %}\nx --opt last\n",
  };
  const keys = () =>
    (getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: [{ path: "/vars.yml", key: { from: "path" } }],
        templates: [{ path: "/app.sh.j2", component: "app", deployed_path: "/usr/local/bin/app.sh" }],
      } as never,
      { readFile: (p: string) => FILES[p] ?? null, specDir: "/", resolve: (p: string) => p, instances: [] }
    ).embedded ?? []).map((e) => e.key);

  // The shape that raised this, and the one a real template has: the key is
  // already repeated, so the parser numbered it and the loop continues that
  // numbering — every key here is one the rendered file's own parse yields.
  it("numbers the copies in file order and moves what follows them along", () => {
    expect(keys()).toEqual(["--opt[0]", "--opt[1]", "--opt[2]", "--opt[3]"]);
  });
});


// A flag that only ever appears in a `{% if %}` test is the automation's input,
// not the deployed state: "true in production" and "the block is in
// production's file" are one fact in two vocabularies, and the reviewed file's
// wins. It stops being a row — and that is not a silent drop, because the row
// it decides carries its name.
describe("ansible recipe: a variable that only decides a block's presence", () => {
  const FILES: Record<string, string> = {
    "/vars.yml": "some_flag: false\nbackend: http://127.0.0.1:9000\n",
    "/dev.yml": "{}\n",
    "/prod.yml": "some_flag: true\n",
    "/proxy.conf.j2": 'ProxyPreserveHost On\n{% if some_flag %}\nProxyPass "{{ backend }}"\n{% endif %}\n',
  };
  const load = (spec: Record<string, unknown> = {}, files = FILES) => {
    const si = getRecipe("ansible")!.load(
      {
        name: "web",
        recipe: "ansible",
        rows: "artifact",
        defaults: "/vars.yml",
        overlays: { dev: "/dev.yml", prod: "/prod.yml" },
        templates: [{ path: "/proxy.conf.j2", component: "web.conf", deployed_path: "/etc/httpd/conf.d/proxy.conf", format: "space" }],
        ...spec,
      } as never,
      { readFile: (p: string) => files[p] ?? null, specDir: "/", resolve: (p: string) => p, instances: ["dev", "prod"] } as never
    );
    const base = si.layers.find((l) => l.kind === "base") as { entries: Map<string, unknown> } | undefined;
    const overlayKeys = si.layers.filter((l) => l.kind === "overlay").flatMap((l) => [...(l as never as { entries: Map<string, unknown> }).entries.keys()]);
    // Either layer is a row: the rescue puts a variable only defaults set into
    // the base map, and one an overlay sets is recovered from the overlay by
    // assemble's own sweep. Suppression has to reach both, so a test asking
    // "does it still have a row" has to look at both.
    return { rows: [...(base?.entries.keys() ?? []), ...overlayKeys], embedded: si.embedded ?? [] };
  };

  it("is not a row of its own, in the base map or recovered from an overlay", () => {
    expect(load().rows).not.toContain("some_flag");
  });

  it("survives on the row it decides, which is what keeps it from being a silent drop", () => {
    const pp = load().embedded.find((e) => e.key === "ProxyPass")!;
    expect(pp.present_when).toEqual([{ variable: "some_flag" }]);
    expect(pp.instances?.map((i) => i.name)).toEqual(["prod"]);
    expect(pp.absent_where_unlisted).toBe(true);
  });

  // The author asking for it BY NAME knows something the derivation does not:
  // the VALUE may be the reviewable fact even when the block's presence tells
  // the same story — an endpoint override whose URL is the whole difference.
  it("keeps its row when the sheet's include: names it literally", () => {
    expect(load({ include: ["some_flag", "backend"] }).rows).toContain("some_flag");
  });

  // A glob is not a name: it admits whatever happens to match, which is not the
  // author pointing at this variable.
  it("does not keep it for a glob that happens to match", () => {
    expect(load({ include: ["some_*", "backend"] }).rows).not.toContain("some_flag");
  });

  // Nothing carries the name here, so nothing may be suppressed: the condition
  // is one the evaluator does not read, so no row got a present_when.
  it("keeps its row when the condition is one the evaluator cannot read", () => {
    const odd = { ...FILES, "/proxy.conf.j2": 'ProxyPreserveHost On\n{% if some_flag and backend %}\nProxyPass "{{ backend }}"\n{% endif %}\n' };
    expect(load({}, odd).rows).toContain("some_flag");
  });
});


// The same conditional block on a sheet that covers ONE template. Its rows do
// not go through the per-component path, and the `{% if %}` was ignored there:
// the row was left in the base map, which holds one value per key, and the
// overlay pass then rendered the line for every environment — `Require ip `
// with the allow-list empty, which denies everyone, in the environments whose
// files have no such line at all.
describe("ansible recipe: a conditional block on a single-template sheet", () => {
  const FILES: Record<string, string> = {
    "/vars.yml": 'allow_from: ""\nbackend: http://127.0.0.1:8080\n',
    "/dev.yml": "{}\n",
    "/prod.yml": 'allow_from: "10.0.0.0/8"\n',
    "/httpd.conf.j2":
      'ProxyPreserveHost On\n{% if allow_from %}\n<LocationMatch "^/admin/">\n    Require ip {{ allow_from }}\n</LocationMatch>\n{% endif %}\n',
  };
  const load = () => {
    const si = getRecipe("ansible")!.load(
      {
        name: "web",
        recipe: "ansible",
        rows: "artifact",
        defaults: "/vars.yml",
        overlays: { dev: "/dev.yml", prod: "/prod.yml" },
        // ONE template, named directly: no components, so the rows take the
        // single-template path.
        template: "/httpd.conf.j2",
        deployed_path: "/etc/httpd/conf/httpd.conf",
      } as never,
      { readFile: (p: string) => FILES[p] ?? null, specDir: "/", resolve: (p: string) => p, instances: ["dev", "prod"] } as never
    );
    const base = si.layers.find((l) => l.kind === "base") as { entries: Map<string, unknown> } | undefined;
    const overlays = si.layers.filter((l) => l.kind === "overlay").flatMap((l) => [...(l as never as { entries: Map<string, unknown> }).entries.keys()]);
    return { si, rows: [...(base?.entries.keys() ?? []), ...overlays], embedded: si.embedded ?? [] };
  };

  it("renders the block for the environments that have it, and no others", () => {
    const req = load().embedded.find((e) => e.key.endsWith(".Require"))!;
    expect(req.instances?.map((i) => `${i.name}=${i.value}`)).toEqual(["prod=ip 10.0.0.0/8"]);
    expect(req.absent_where_unlisted).toBe(true);
    expect(req.present_when).toEqual([{ variable: "allow_from" }]);
  });

  // The base map holds one value per key; a row that is not in every file
  // cannot be stated there, and leaving it there is what produced the empty
  // directive.
  it("does not leave the directive in the base map for the overlay pass to re-render", () => {
    expect(load().rows.some((k) => k.endsWith(".Require"))).toBe(false);
  });

  it("does not leave the variable behind as a row of its own either", () => {
    expect(load().rows).not.toContain("allow_from");
  });
});


// Pinned so nobody "fixes" it into a rendered line: an absent line keeps the
// TEMPLATE's text. Rendering it with the environment's own values would print
// a line no file contains — `Require ip` with an empty allow-list denies
// everyone — and the strikethrough would be the only thing standing between a
// reader and the opposite of the truth.
describe("preview: an absent line is not rendered", () => {
  it("keeps the template's own text where the block is not deployed", () => {
    const FILES: Record<string, string> = {
      "/vars.yml": 'allow: ""\n',
      "/prod.yml": 'allow: "10.0.0.0/8"\n',
      "/app.conf.j2": '{% if allow %}\nRequire ip {{ allow }}\n{% endif %}\n',
    };
    const si = getRecipe("ansible")!.load(
      {
        name: "s",
        recipe: "ansible",
        rows: "artifact",
        defaults: "/vars.yml",
        overlays: { dev: "/dev.yml", prod: "/prod.yml" },
        templates: [{ path: "/app.conf.j2", component: "app", deployed_path: "/etc/app.conf", format: "space" }],
      } as never,
      { readFile: (p: string) => (FILES[p] ?? (p === "/dev.yml" ? "{}\n" : null)), specDir: "/", resolve: (p: string) => p, instances: ["dev", "prod"] } as never
    );
    const dev = (si.artifacts ?? []).find((a) => (a.instances ?? []).includes("dev"))!;
    const line = dev.lines.find((l) => l.text.includes("Require"))!;
    expect(line.kind).toBe("absent");
    expect(line.text).toBe("Require ip {{ allow }}");
    expect(line.text).not.toContain("Require ip \n");
  });
});
