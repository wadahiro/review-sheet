// Tests for the "layered" recipe (src/recipes/layered.ts): the IaC-agnostic
// base+overlay core split out of "ansible" (see CLAUDE.md). Byte-identical
// reuse by "ansible" itself is covered
// by tests/recipe-ansible.test.ts (the three examples' input.json comparison
// already exercises the delegation).

import { describe, it, expect, beforeEach } from "bun:test";
import { getRecipe, type RecipeIO } from "../src/recipe";
import "../src/recipes/index";
import type { ValueLayer } from "../src/assemble";
import { stubNonBuiltInProviders } from "./only-builtin-providers.js";
import { assembleFromSpec } from "../src/assemble-spec";
import { loadBuildSpec } from "../src/spec";
import type { InstanceParameter, SimpleParameter } from "../src/types";

function layeredRecipe() {
  const r = getRecipe("layered");
  if (!r) throw new Error("layered recipe is not registered");
  return r;
}

function baseOf(si: ReturnType<ReturnType<typeof layeredRecipe>["load"]>) {
  const l = si.layers.find((l): l is Extract<ValueLayer, { kind: "base" }> => l.kind === "base")!;
  return l.entries;
}

function overlayOf(si: ReturnType<ReturnType<typeof layeredRecipe>["load"]>, instance: string) {
  const l = si.layers.find((l): l is Extract<ValueLayer, { kind: "overlay" }> => l.kind === "overlay" && l.instance === instance);
  return l?.entries;
}

describe("layered recipe: plain base+overlay (no Ansible/Jinja2 involved)", () => {
  const files: Record<string, string> = {
    "/r/default.env": "SSO_IDLE=1800\nSSO_SMTP_FROM=noreply@example.com\n",
    "/r/staging.env": "SSO_IDLE=3600\n",
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: ["local", "staging"],
  };

  it("builds one base layer and per-instance overlays, every row keyed by its extracted identity (no keyMap)", () => {
    const si = layeredRecipe().load(
      { name: "realm", recipe: "layered", defaults: "default.env", overlays: { staging: "staging.env" } },
      io
    );
    expect(si.keyMap).toBeUndefined();
    expect([...baseOf(si).keys()].sort()).toEqual(["SSO_IDLE", "SSO_SMTP_FROM"]);
    expect(overlayOf(si, "staging")?.get("SSO_IDLE")?.value).toBe("3600");
    // The defaults file is a file in THIS repository, so it is the sheet's
    // source_file. file_path means where the configuration lands on the target
    // (types.ts), and a layered sheet has no way to know that.
    expect(si.sourceFile).toBe("/r/default.env");
    expect(si.filePath).toBeUndefined();
  });

  it("omitting defaults yields an empty base — every key becomes Pattern B, no filePath", () => {
    const si = layeredRecipe().load(
      { name: "realm", recipe: "layered", overlays: { staging: "staging.env" } },
      io
    );
    expect(baseOf(si).size).toBe(0);
    expect(si.filePath).toBeUndefined();
    expect(overlayOf(si, "staging")?.get("SSO_IDLE")?.value).toBe("3600");
  });
});

describe("layered recipe: multiple files merged into one base (the ECS taskdef + Dockerfile case)", () => {
  const files: Record<string, string> = {
    "/r/base.yml": "a: 1\nb: 2\n",
    "/r/extra.yml": "b: 20\nc: 30\n", // overrides b, adds c
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: [],
  };

  it("merges multiple defaults sources in order, later overriding earlier", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", defaults: ["base.yml", "extra.yml"] },
      io
    );
    const base = baseOf(si);
    expect(base.get("a")?.value).toBe("1");
    expect(base.get("b")?.value).toBe("20"); // extra.yml wins
    expect(base.get("c")?.value).toBe("30");
    // Display fallback is the FIRST source only, and it is a source_file.
    expect(si.sourceFile).toBe("/r/base.yml");
  });

  it("merges multiple sources within a single overlay instance the same way", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", overlays: { staging: ["base.yml", "extra.yml"] } },
      io
    );
    const ov = overlayOf(si, "staging")!;
    expect(ov.get("a")?.value).toBe("1");
    expect(ov.get("b")?.value).toBe("20");
    expect(ov.get("c")?.value).toBe("30");
  });
});

describe("layered recipe: declarative key transform (the Terraform variables.tf case)", () => {
  // hcl's `variable "x" { default = ... }` yields one Entry per scalar
  // attribute (default/description/type), Entry.key is the LEAF attribute
  // name only ("default"), and the full address lives in Entry.source.path
  // ("variable.<name>.default"). A tfvars file is
  // flat, so its keys are already the bare variable name.
  const files: Record<string, string> = {
    "/r/variables.tf": [
      'variable "vpc_cidr" {',
      '  description = "VPC CIDR block"',
      '  default     = "10.0.0.0/16"',
      "}",
      "",
    ].join("\n"),
    "/r/staging.tfvars": 'vpc_cidr = "10.1.0.0/16"\n',
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: ["staging"],
  };

  const KEY: { from: "path"; steps: [{ pattern: string; replace: string; on_no_match: "drop" }] } = {
    from: "path",
    steps: [{ pattern: "^variable\\.(.+)\\.default$", replace: "$1", on_no_match: "drop" }],
  };

  it("keeps only the .default attribute, keyed by the variable name, dropping description/type", () => {
    const si = layeredRecipe().load(
      {
        name: "infra",
        recipe: "layered",
        defaults: { path: "variables.tf", key: KEY },
        overlays: { staging: "staging.tfvars" },
      },
      io
    );
    const base = baseOf(si);
    expect([...base.keys()]).toEqual(["vpc_cidr"]);
    expect(base.get("vpc_cidr")?.value).toBe("10.0.0.0/16");
    // The tfvars overlay's bare key now lines up with the transformed base key.
    expect(overlayOf(si, "staging")?.get("vpc_cidr")?.value).toBe("10.1.0.0/16");
  });

  it("warns when a drop-configured key transform pattern never matches anything", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      layeredRecipe().load(
        {
          name: "infra",
          recipe: "layered",
          defaults: {
            path: "variables.tf",
            key: { from: "path", steps: [{ pattern: "^nope\\.(.+)$", replace: "$1", on_no_match: "drop" }] },
          },
        },
        io
      );
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toContain("^nope");
  });
});

describe("layered recipe: same-file key collision (P3 — a TOML [[array-of-tables]] with a shared leaf name)", () => {
  // The fedlens repro (see CLAUDE.md / src/recipes/layered.ts's own doc):
  // [[oidc]] and [[saml]] both have a bare `base_url` leaf. Entry.key is that
  // leaf name for both — without a key transform, `buildMapFromSources` used
  // to fold the second one over the first with no error or warning.
  const toml = [
    "[[oidc]]",
    'name = "poc-oidc"',
    'base_url = "https://oidc-dev.example.com"',
    "",
    "[[saml]]",
    'name = "poc-saml"',
    'base_url = "https://saml-dev.example.com"',
    "",
  ].join("\n");
  const files: Record<string, string> = { "/r/config.toml": toml };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: ["local"],
  };

  it("throws instead of silently dropping the shadowed row", () => {
    expect(() =>
      layeredRecipe().load({ name: "fedlens", recipe: "layered", defaults: "config.toml" }, io)
    ).toThrow(/key collision|maps more than one structural location to the same key/);
  });

  it("a POSITIONAL index is kept in the suggested replacement — dropping it would rebuild the collision", () => {
    // `[name=poc-oidc]` can be dropped because the segment name itself still
    // tells the paths apart. `servers[0]` vs `servers[1]` cannot: the index is
    // the ONLY difference, so a suggestion that strips it maps both to one key
    // and reproduces the very collision it claims to fix.
    const yaml = [
      "http:",
      "  services:",
      "    keycloak:",
      "      loadBalancer:",
      "        servers:",
      '          - url: "http://kc-node1:80"',
      '          - url: "http://kc-node2:80"',
      "",
    ].join("\n");
    const listIo: RecipeIO = {
      readFile: (p) => (p === "/r/lb.yml" ? yaml : null),
      specDir: "/r",
      resolve: (p) => `/r/${p.split("/").pop()}`,
      instances: ["local"],
    };
    try {
      layeredRecipe().load({ name: "alb", recipe: "layered", defaults: "lb.yml" }, listIo);
      throw new Error("expected a collision error");
    } catch (e) {
      const msg = (e as Error).message;
      const replaces = [...msg.matchAll(/replace: '([^']+)'/g)].map((m) => m[1]);
      expect(replaces.length).toBe(2);
      // The whole point: the two replacements must not be the same string.
      expect(new Set(replaces).size).toBe(2);
      expect(replaces[0]).toContain("servers.0.");
      expect(replaces[1]).toContain("servers.1.");
    }
  });

  it("the thrown error names the colliding key, both structural paths, and a paste-able key-transform fix", () => {
    try {
      layeredRecipe().load({ name: "fedlens", recipe: "layered", defaults: "config.toml" }, io);
      throw new Error("expected a collision error");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('"base_url"');
      expect(message).toContain("oidc[name=poc-oidc].base_url");
      expect(message).toContain("saml[name=poc-saml].base_url");
      expect(message).toContain("from: path");
      expect(message).toContain("oidc.$1");
      expect(message).toContain("saml.$1");
    }
  });

  it("a per-source key transform (from: path) resolves the collision, keeping both rows distinct", () => {
    const si = layeredRecipe().load(
      {
        name: "fedlens",
        recipe: "layered",
        defaults: {
          path: "config.toml",
          key: {
            from: "path",
            steps: [
              { pattern: "^oidc\\[name=poc-oidc\\]\\.(.+)$", replace: "oidc.$1" },
              { pattern: "^saml\\[name=poc-saml\\]\\.(.+)$", replace: "saml.$1" },
            ],
          },
        },
      },
      io
    );
    const base = baseOf(si);
    expect(base.get("oidc.base_url")?.value).toBe("https://oidc-dev.example.com");
    expect(base.get("saml.base_url")?.value).toBe("https://saml-dev.example.com");
  });

  it("does NOT collide when the same shape is read as a static_file (keyed by structural path already)", () => {
    const si = layeredRecipe().load(
      { name: "fedlens", recipe: "layered", static_files: [{ path: "config.toml" }] },
      io
    );
    expect(si.embedded.map((e) => e.key).sort()).toEqual(["oidc[name=poc-oidc].base_url", "saml[name=poc-saml].base_url"]);
  });

  it("does NOT throw when the same key repeats across DECLARED sources (the documented later-wins merge)", () => {
    // Two files, not one file's own extraction — this is the intentional
    // "ECS taskdef + Dockerfile" override case (see the describe block above),
    // must stay unaffected by the same-file collision check.
    const twoFiles: Record<string, string> = { "/r/a.toml": 'base_url = "a"\n', "/r/b.toml": 'base_url = "b"\n' };
    const io2: RecipeIO = { readFile: (p) => twoFiles[p] ?? null, specDir: "/r", resolve: (p) => `/r/${p.split("/").pop()}`, instances: [] };
    const si = layeredRecipe().load({ name: "s", recipe: "layered", defaults: ["a.toml", "b.toml"] }, io2);
    expect(baseOf(si).get("base_url")?.value).toBe("b");
  });
});

describe("layered recipe: static_files (embedded literals, unaffected by base/overlay logic)", () => {
  const files: Record<string, string> = {
    "/r/defaults.yml": "port: 80\n",
    "/r/extra.yml": "banner: hello\nnested:\n  flag: true\n",
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: [],
  };

  // The context panel's file, for a static file that declares NO `substitution:`
  // — which is most of them. The preview build once sat AFTER the substitution
  // branch, whose non-substitution arm `continue`s, so a plain static file was
  // silently previewless: three of a real project's six such sheets had no way
  // to open the very file their rows were read from, and nothing said so.
  it("previews a static file that declares no substitution", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", defaults: "defaults.yml", static_files: [{ path: "extra.yml" }] },
      io
    );
    const preview = (si.artifacts ?? []).find((a) => a.source_file.endsWith("extra.yml"));
    expect(preview).toBeDefined();
    expect(preview!.lines.map((l) => l.text)).toEqual(["banner: hello", "nested:", "  flag: true", ""]);
    // …and its rows can find themselves in it, both directions.
    expect(preview!.lines.find((l) => l.text === "banner: hello")?.key).toBe("banner");
    expect(preview!.lines.find((l) => l.text === "  flag: true")?.key).toBe("nested.flag");
  });

  it("defaults a static file's key to the structural path, like ansible's static_files always did", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", defaults: "defaults.yml", static_files: [{ path: "extra.yml" }] },
      io
    );
    expect(si.embedded.map((e) => e.key).sort()).toEqual(["banner", "nested.flag"]);
  });

  // `origin: default` files a whole file as "the product's own defaults, which
  // our deliverable does not set" — the file is an extracted record of the
  // product, not part of what we ship.
  it("files a static file's rows as product defaults when origin: default is declared", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", defaults: "defaults.yml", static_files: [{ path: "extra.yml", origin: "default" }] },
      io
    );
    expect(si.embedded.every((e) => e.origin === "default")).toBe(true);
  });

  it("leaves rows embedded when origin is not declared (the pre-existing behaviour)", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", defaults: "defaults.yml", static_files: [{ path: "extra.yml" }] },
      io
    );
    expect(si.embedded.every((e) => e.origin === undefined)).toBe(true);
  });

  // A substitution merges the file's rows into base-layer variables our
  // deliverable DOES set, so the two declarations contradict each other.
  it("refuses origin: default together with substitution", () => {
    expect(() =>
      layeredRecipe().load(
        { name: "s", recipe: "layered", defaults: "defaults.yml", static_files: [{ path: "extra.yml", origin: "default", substitution: { pattern: "\\{\\{ (\\w+) \\}\\}" } }] },
        io
      )
    ).toThrow(/origin "default" cannot be combined with "substitution"/);
  });
});

describe("layered recipe: include/exclude apply to the final (post-transform) key", () => {
  const files: Record<string, string> = {
    "/r/group_vars.yml": "kc_db_url: jdbc:postgresql://db/kc\nkcr_env: staging\nhttpd_port: 8080\n",
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: ["staging"],
  };

  it("filters the overlay (and would filter the base identically) by glob", () => {
    const si = layeredRecipe().load(
      { name: "httpd", recipe: "layered", overlays: { staging: "group_vars.yml" }, include: ["httpd_*"] },
      io
    );
    expect([...overlayOf(si, "staging")!.keys()]).toEqual(["httpd_port"]);
  });

  it("warns about an include/exclude pattern that matched nothing, same as ansible's", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      layeredRecipe().load(
        { name: "httpd", recipe: "layered", overlays: { staging: "group_vars.yml" }, exclude: ["nope_*"] },
        io
      );
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toContain("nope_*");
  });
});

// T6: static_files' opt-in `substitution:` declaration (see
// SKILL.md) — a regex that recognizes a value as a reference
// into the sheet's own base/overlay layers and merges it in, using the SAME
// keyMap/under_key vocabulary the "ansible" recipe already uses for
// `{{ var }}`. PoC-shaped fixture: one whole-value reference (merges), one
// composed reference (stays embedded, gains a ref site on the var's own
// row), one dangling reference (stays embedded, warns), one plain literal
// (untouched).
describe("layered recipe: static_files substitution (T6 — opt-in reference merge)", () => {
  // keycloak-config-cli's own syntax — same PATTERN as tests/substitution.test.ts.
  const PATTERN = String.raw`\$\(env:([A-Za-z_][A-Za-z0-9_]*)\)`;

  const files: Record<string, string> = {
    "/r/default.env": "SSO_SAML_HOST=sso.example.com\n",
    "/r/poc.yml": [
      "ssoSessionIdleTimeout: $(env:SSO_SESSION_IDLE_TIMEOUT)",
      "redirectUris:",
      "  - https://$(env:SSO_SAML_HOST)/saml/acs",
      "pipelineSecret: $(env:PIPELINE_SECRET)",
      "sslRequired: external",
      "",
    ].join("\n"),
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    // SSO_SESSION_IDLE_TIMEOUT lives only in the "local" overlay — a
    // whole-value reference resolves via base OR overlay (see
    // substitution.ts's resolvesInLayers), and this is the shape the design
    // doc's own PoC example uses (a per-environment session timeout).
    instances: ["local"],
  };

  function load(withSubstitution: boolean) {
    return layeredRecipe().load(
      {
        name: "realm",
        recipe: "layered",
        defaults: "default.env",
        overlays: { local: "local.env" },
        static_files: [{ path: "poc.yml", ...(withSubstitution ? { substitution: { pattern: PATTERN } } : {}) }],
      },
      io
    );
  }

  const localFiles: Record<string, string> = { ...files, "/r/local.env": "SSO_SESSION_IDLE_TIMEOUT=300\n" };
  const ioWithLocal: RecipeIO = { ...io, readFile: (p) => localFiles[p] ?? null };

  function loadWithLocal(withSubstitution: boolean) {
    return layeredRecipe().load(
      {
        name: "realm",
        recipe: "layered",
        defaults: "default.env",
        overlays: { local: "local.env" },
        static_files: [{ path: "poc.yml", ...(withSubstitution ? { substitution: { pattern: PATTERN } } : {}) }],
      },
      ioWithLocal
    );
  }

  it("row 2 — merges the whole-value reference into a keyMap entry, keyed by the field path, and drops the embedded row", () => {
    const si = loadWithLocal(true);
    expect(si.embedded.map((e) => e.key)).not.toContain("ssoSessionIdleTimeout");
    expect(si.keyMap).toEqual([{ boundKey: "ssoSessionIdleTimeout", variable: "SSO_SESSION_IDLE_TIMEOUT" }]);
  });

  it("row 2 — the merged row's ref site is filed under the VARIABLE, pointing at the static file", () => {
    const si = loadWithLocal(true);
    const rs = si.referenceSites?.find((r) => r.variable === "SSO_SESSION_IDLE_TIMEOUT");
    expect(rs).toBeDefined();
    expect(rs!.sites).toEqual([
      {
        file: "/r/poc.yml",
        line: 1,
        path: "ssoSessionIdleTimeout",
        ref: "$(env:SSO_SESSION_IDLE_TIMEOUT)",
        anchor: "$(env:SSO_SESSION_IDLE_TIMEOUT)",
      },
    ]);
  });

  it("row 4 — a composed value's row stays embedded, keyed by its structural path, AND the referenced variable's row gets a checked ref site", () => {
    const si = loadWithLocal(true);
    expect(si.embedded.map((e) => e.key)).toContain("redirectUris[0]");
    const rs = si.referenceSites?.find((r) => r.variable === "SSO_SAML_HOST");
    expect(rs).toBeDefined();
    expect(rs!.sites[0].ref).toBe("$(env:SSO_SAML_HOST)");
    expect(rs!.sites[0].path).toBe("redirectUris[0]");
  });

  it("row 5 — a dangling reference survives embedded, unmerged, with a warning naming the missing variable", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    let si: ReturnType<typeof loadWithLocal>;
    try {
      si = loadWithLocal(true);
    } finally {
      console.warn = original;
    }
    expect(si.embedded.map((e) => e.key)).toContain("pipelineSecret");
    expect(warnings.join("\n")).toContain("PIPELINE_SECRET");
  });

  it("row 1 — a plain literal is left completely untouched", () => {
    const si = loadWithLocal(true);
    const literal = si.embedded.find((e) => e.key === "sslRequired");
    expect(literal?.value).toBe("external");
  });

  it("emits one summary tally line for the sheet, naming merged/composed/dangling counts", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      loadWithLocal(true);
    } finally {
      console.warn = original;
    }
    const tally = warnings.find((w) => w.includes("substitution:") && w.includes("merged,"));
    expect(tally).toBeDefined();
    expect(tally).toContain("1 merged, 1 composed left embedded, 1 dangling");
  });

  it("opt-in guarantee: with no substitution: declared, the static file is read exactly as before (no keyMap, no referenceSites)", () => {
    const withoutSub = loadWithLocal(false);
    expect(withoutSub.keyMap).toBeUndefined();
    expect(withoutSub.referenceSites).toBeUndefined();
    expect(withoutSub.embedded.map((e) => e.key).sort()).toEqual(
      ["pipelineSecret", "redirectUris[0]", "sslRequired", "ssoSessionIdleTimeout"].sort()
    );
    // And the WITH-substitution run must not have touched anything this run
    // didn't also produce, other than the merge itself — same literal/
    // composed/dangling rows survive unchanged either way.
    const withSub = loadWithLocal(true);
    expect(withSub.embedded.find((e) => e.key === "sslRequired")).toEqual(
      withoutSub.embedded.find((e) => e.key === "sslRequired")
    );
  });
});

// T6 (ansible reachability): ansible.ts delegates static_files reading to
// layeredRecipe.load(), but validates a sheet's OWN fields against its OWN
// schema (spec.ts validates per-recipe, never against a delegate's schema —
// see spec.ts's per-sheet loop) — and ansible's static_files item schema
// (recipes/ansible.ts) was deliberately NOT extended with `substitution`.
// `substitution:` is therefore unreachable from an `ansible` sheet: declaring
// it is rejected at spec-validation time, before ansibleRecipe.load() (and
// therefore layeredRecipe.load()) ever runs.
describe("layered recipe: substitution is NOT reachable from the ansible recipe (T6 scope decision)", () => {
  const SPEC_PATH = "/r/build.yml";
  const BUILD_YML = `
version: 1
instances: [local]
sheets:
  - name: app
    recipe: ansible
    defaults: defaults.yml
    static_files:
      - path: poc.yml
        substitution:
          pattern: '\\$\\(env:([A-Za-z_][A-Za-z0-9_]*)\\)'
`;
  const files: Record<string, string> = {
    [SPEC_PATH]: BUILD_YML,
    "/r/defaults.yml": "kc_hostname: localhost\n",
    "/r/poc.yml": "sslRequired: external\n",
  };
  const readFile = (p: string): string | null => files[p] ?? null;

  it("rejects the field as unknown for the ansible recipe's own static_files schema", () => {
    expect(() => loadBuildSpec(SPEC_PATH, { readFile })).toThrow(/substitution/);
  });
});

// T6 end-to-end: the migration signal (design's Q7) — the moment a sheet
// gains a keyMap entry (via substitution merging one), assemble.ts's existing
// "keyMap without under_key" hard error fires exactly as it does for
// ansible's `{{ var }}` binding. This is not this recipe's own check —
// proving it fires end to end (through the real spec -> assembleFromSpec
// path) is the point.
describe("layered recipe: substitution end to end via assembleFromSpec (T6 — the under_key migration signal)", () => {
  beforeEach(stubNonBuiltInProviders);

  const SPEC_PATH = "/r/build.yml";
  const BUILD_YML = `
version: 1
instances: [local]
enrich:
  project: sheet.yml
sheets:
  - name: realm
    recipe: layered
    defaults: default.env
    overlays: { local: local.env }
    static_files:
      - path: poc.yml
        substitution:
          pattern: '\\$\\(env:([A-Za-z_][A-Za-z0-9_]*)\\)'
`;
  const POC_YML = [
    "ssoSessionIdleTimeout: $(env:SSO_SESSION_IDLE_TIMEOUT)",
    "sslRequired: external",
    "",
  ].join("\n");

  const NO_UNDER_KEY_PROJECT = `
categories: [Realm]
params:
  sslRequired:
    category: Realm
    description: SSL requirement
`;

  const WITH_UNDER_KEY_PROJECT = `
under_key:
  id: env_var
  label: { en: "Env var", ja: "環境変数" }
categories: [Realm]
params:
  ssoSessionIdleTimeout:
    category: Realm
    description: Session idle timeout
  sslRequired:
    category: Realm
    description: SSL requirement
`;

  function filesWith(projectYaml: string): Record<string, string> {
    return {
      [SPEC_PATH]: BUILD_YML,
      "/r/sheet.yml": projectYaml,
      "/r/default.env": "SSO_SESSION_IDLE_TIMEOUT=1800\n",
      "/r/local.env": "SSO_SESSION_IDLE_TIMEOUT=300\n",
      "/r/poc.yml": POC_YML,
    };
  }

  it("fails, naming the sheet, when sheet.yml declares no under_key", () => {
    const readFile = (p: string): string | null => filesWith(NO_UNDER_KEY_PROJECT)[p] ?? null;
    const spec = loadBuildSpec(SPEC_PATH, { readFile });
    expect(() => assembleFromSpec(spec, { readFile, specDir: "/r" })).toThrow(/"realm".*keyMap.*under_key/);
  });

  it("succeeds once under_key is declared — the merged row is keyed by the field path, carries the under_key extra, and a ref additional source", () => {
    const readFile = (p: string): string | null => filesWith(WITH_UNDER_KEY_PROJECT)[p] ?? null;
    const spec = loadBuildSpec(SPEC_PATH, { readFile });
    const input = assembleFromSpec(spec, { readFile, specDir: "/r" });

    const allParams = input.sheets[0].categories.flatMap((c) => c.params ?? []);
    expect(allParams.map((p) => p.key).sort()).toEqual(["sslRequired", "ssoSessionIdleTimeout"]);

    const merged = allParams.find((p) => p.key === "ssoSessionIdleTimeout") as InstanceParameter;
    // Pattern B: SSO_SESSION_IDLE_TIMEOUT is set in both defaults and the
    // local overlay, so the merged row still carries its per-instance shape.
    expect(merged.origin).toBe("overlay");
    expect(merged.extra?.env_var).toBe("SSO_SESSION_IDLE_TIMEOUT");
    expect(merged.additional_sources).toEqual([
      {
        file: "/r/poc.yml",
        line: 1,
        path: "ssoSessionIdleTimeout",
        ref: "$(env:SSO_SESSION_IDLE_TIMEOUT)",
        anchor: "$(env:SSO_SESSION_IDLE_TIMEOUT)",
      },
    ]);

    // The un-referenced literal is unaffected by any of this.
    const literal = allParams.find((p) => p.key === "sslRequired") as SimpleParameter;
    expect(literal.origin).toBe("embedded");
    expect(literal.value).toBe("external");

    // The under_key column itself is now on the model, same mechanism
    // ansible's own {{ var }} binding uses.
    expect(input.columns).toEqual([
      // header_lang is what lets the viewer print this heading in the reader's
      // own language beside the value — without it the sub-line is a bare
      // identifier next to another bare identifier (the row's key).
      { field: "env_var", header: "Env var", header_lang: { ja: "環境変数", en: "Env var" }, place: "under_key" },
    ]);
  });
});

// A static file's keys used to be its structural paths, which never collide —
// so nothing checked. A `key:` transform can rename them, and two rows landing
// on one key silently became one row. Scoped by component, because that is
// what a component is for.
describe("layered recipe: static-file key collisions", () => {
  const TWO_CLIENTS = JSON.stringify({
    clients: [
      { clientId: "app-a", protocol: "openid-connect" },
      { clientId: "app-b", protocol: "saml" },
    ],
  });
  const STRIP_CLIENT = {
    from: "path" as const,
    steps: [{ pattern: "^clients\\[clientId=([^\\]]+)\\]\\.(.+)$", replace: "$2", on_no_match: "drop" as const }],
  };
  const BY_CLIENT = {
    from: "path" as const,
    steps: [{ pattern: "^clients\\[clientId=([^\\]]+)\\]\\..*$", replace: "$1", on_no_match: "drop" as const }],
  };

  function load(component?: Record<string, unknown>) {
    const files: Record<string, string> = { "/p/clients.json": TWO_CLIENTS };
    const io = {
      readFile: (p: string) => files[p] ?? null,
      specDir: "/p",
      resolve: (p: string) => `/p/${p.replace(/^\.\//, "")}`,
      instances: ["staging"],
      extractOptions: { idFields: ["clientId"] },
      ...(component ? { component } : {}),
    };
    const layeredRecipe = getRecipe("layered")!;
    return layeredRecipe.load(
      { name: "S", static_files: [{ path: "clients.json", format: "json", key: STRIP_CLIENT }] } as never,
      io as never
    );
  }

  it("fails when a rename collapses two rows onto one key", () => {
    // No component: both clients share one scope, so the two `protocol` rows
    // are a genuine collision.
    expect(() => load()).toThrow(/protocol/);
  });

  it("accepts the same rename once each row belongs to its own component", () => {
    const si = load(BY_CLIENT);
    // Two rows with the SAME key, told apart by the component each carries —
    // which is why the component rides on the entry and not in a map keyed by
    // the key. A map could hold only one of these.
    expect(si.embedded.map((e) => e.key)).toEqual(["protocol", "protocol"]);
    expect(si.embedded.map((e) => e.component)).toEqual(["app-a", "app-b"]);
  });
});

// Two files holding the SAME kind of document — two realms, two of anything —
// produce identical keys and identical structural paths. What tells their rows
// apart is which file they came from, which no transform over the row can see,
// so the file says it outright. Same shape as the ansible recipe's `templates:`.
describe("layered recipe: static_files[].component", () => {
  const files: Record<string, string> = {
    "/r/defaults.yml": "port: 80\n",
    "/r/master.yml": "realm: master\nsslRequired: external\nbruteForceProtected: true\n",
    "/r/poc.yml": "realm: poc\nsslRequired: external\nbruteForceProtected: false\n",
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: [],
  };
  const load = (): ReturnType<ReturnType<typeof layeredRecipe>["load"]> =>
    layeredRecipe().load(
      {
        name: "realms",
        recipe: "layered",
        defaults: "defaults.yml",
        static_files: [
          { path: "master.yml", component: "master" },
          { path: "poc.yml", component: "poc" },
        ],
      },
      io
    );

  it("keeps both files' rows, each tagged with the file's component", () => {
    const si = load();
    const bySource = si.embedded.map((e) => `${e.component}:${e.key}=${e.value}`).sort();
    expect(bySource).toEqual([
      "master:bruteForceProtected=true",
      "master:realm=master",
      "master:sslRequired=external",
      "poc:bruteForceProtected=false",
      "poc:realm=poc",
      "poc:sslRequired=external",
    ]);
  });

  it("does not treat the shared key names as a collision, because they are in different components", () => {
    // The same three keys twice. Without the component scope this is exactly
    // the in-file/one-keyspace clash the recipe hard-errors on — and losing one
    // realm's rows silently is the failure that check exists to prevent.
    expect(() => load()).not.toThrow();
    expect(load().embedded.filter((e) => e.key === "sslRequired")).toHaveLength(2);
  });

  it("leaves a file that names no component to the sheet's own transform", () => {
    const si = layeredRecipe().load(
      {
        name: "realms",
        recipe: "layered",
        defaults: "defaults.yml",
        static_files: [{ path: "master.yml", component: "master" }, { path: "poc.yml" }],
      },
      io
    );
    expect(si.embedded.filter((e) => e.component === undefined).map((e) => e.key).sort()).toEqual([
      "bruteForceProtected",
      "realm",
      "sslRequired",
    ]);
  });
});

// A whole-value merge does not keep the static file's entry — the BASE-layer
// row is renamed to the product key instead. So a file's literal component has
// to survive that hand-off, or the merged rows land in no component while every
// other row on the sheet has one.
describe("layered recipe: a merged row keeps the component of the file that referenced it", () => {
  const files: Record<string, string> = {
    "/r/default.env": "IDLE=1800\nMAXLIFE=36000\n",
    "/r/poc.yml": "realm: poc\nssoSessionIdleTimeout: $(env:IDLE)\n",
    "/r/other.yml": "realm: other\nssoSessionMaxLifespan: $(env:MAXLIFE)\n",
  };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: [],
  };
  const load = (): ReturnType<ReturnType<typeof layeredRecipe>["load"]> =>
    layeredRecipe().load(
      {
        name: "realms",
        recipe: "layered",
        defaults: "default.env",
        static_files: [
          { path: "poc.yml", format: "yaml", component: "poc", substitution: { pattern: "\\$\\(env:([A-Za-z_][A-Za-z0-9_]*)\\)" } },
          { path: "other.yml", format: "yaml", component: "other", substitution: { pattern: "\\$\\(env:([A-Za-z_][A-Za-z0-9_]*)\\)" } },
        ],
      },
      io
    );

  it("files the renamed base row under the referencing file's component", () => {
    const si = load();
    // The merged rows are no longer embedded: they are base-layer keys renamed
    // through keyMap, so componentOf — keyed by the PRE-rename key, which is
    // what assemble looks them up by — is the only place the component can live.
    expect(si.keyMap).toEqual([
      { boundKey: "ssoSessionIdleTimeout", variable: "IDLE" },
      { boundKey: "ssoSessionMaxLifespan", variable: "MAXLIFE" },
    ]);
    expect(si.componentOf?.get("IDLE")).toBe("poc");
    expect(si.componentOf?.get("MAXLIFE")).toBe("other");
  });

  it("warns when two components merge the same variable, instead of picking one", () => {
    const warnings: string[] = [];
    const spy = console.warn;
    console.warn = (m: string) => void warnings.push(String(m));
    try {
      layeredRecipe().load(
        {
          name: "realms",
          recipe: "layered",
          defaults: "default.env",
          static_files: [
            { path: "poc.yml", format: "yaml", component: "poc", substitution: { pattern: "\\$\\(env:([A-Za-z_][A-Za-z0-9_]*)\\)" } },
            // Same variable as poc.yml's, from a different component.
            { path: "dup.yml", format: "yaml", component: "other", substitution: { pattern: "\\$\\(env:([A-Za-z_][A-Za-z0-9_]*)\\)" } },
          ],
        },
        { ...io, readFile: (p) => (p === "/r/dup.yml" ? "realm: other\nssoSessionIdleTimeout: $(env:IDLE)\n" : files[p] ?? null) }
      );
    } finally {
      console.warn = spy;
    }
    expect(warnings.join("\n")).toContain('"IDLE" is merged by two components (poc, other)');
  });
});

// `split:` — the sheet-level declaration standing in for the `key:` +
// `component:` pair that an identity-keyed list otherwise needs, written twice
// against the tool's own address grammar.
describe("layered recipe: split (an identity-keyed list of components)", () => {
  const yaml = [
    "clients:",
    "  - clientId: alpha",
    "    enabled: true",
    "    attributes:",
    "      pkce: S256",
    "  - clientId: beta",
    "    enabled: false",
    "",
  ].join("\n");
  const files: Record<string, string> = { "/r/realm.yml": yaml, "/r/env.properties": "SSO_HOST=example.com\n" };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: (p) => `/r/${p.split("/").pop()}`,
    instances: [],
  };

  it("makes each member a component and keys rows by the rest of the address", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", split: { at: "clients", by: "clientId" }, static_files: [{ path: "realm.yml" }] },
      io
    );
    expect(si.embedded.map((e) => `${e.component}/${e.key}`).sort()).toEqual([
      "alpha/attributes.pkce",
      "alpha/enabled",
      "beta/enabled",
    ]);
  });

  it("reviews only the members `only` names, and leaves non-members alone", () => {
    const si = layeredRecipe().load(
      {
        name: "s",
        recipe: "layered",
        split: { at: "clients", by: "clientId", only: ["alpha"] },
        defaults: "env.properties",
        static_files: [{ path: "realm.yml" }],
      },
      io
    );
    expect(si.embedded.map((e) => `${e.component}/${e.key}`).sort()).toEqual(["alpha/attributes.pkce", "alpha/enabled"]);
    // The env file on the same sheet is not a member of the list and survives.
    const base = si.layers.find((l) => l.kind === "base")!;
    expect([...base.entries.keys()]).toEqual(["SSO_HOST"]);
  });

  // Same two-way rule as `names:`: a selection naming something no row produced
  // reviews less than it claims, and says so.
  it("refuses a selection naming a member no row produced", () => {
    expect(() =>
      layeredRecipe().load(
        {
          name: "s",
          recipe: "layered",
          split: { at: "clients", by: "clientId", only: ["alpha", "gamma"] },
          static_files: [{ path: "realm.yml" }],
        },
        io
      )
    ).toThrow(/split selects a member no row produced: gamma/);
  });

  // Composed, not refused: a sheet can hold rows that are not members of the
  // list and still belong to one — the env variable feeding a member's field.
  it("composes a component transform after the split", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", split: { at: "clients", by: "clientId" }, defaults: "env.properties", static_files: [{ path: "realm.yml" }] },
      { ...io, component: { steps: [{ pattern: "^SSO_HOST$", replace: "alpha" }] } }
    );
    expect(si.componentOf?.get("SSO_HOST")).toBe("alpha");
    expect(si.componentOf?.get("enabled")).toBe("beta");
  });

  it("composes the source's own steps after the split", () => {
    const si = layeredRecipe().load(
      {
        name: "s",
        recipe: "layered",
        split: { at: "clients", by: "clientId" },
        static_files: [{ path: "realm.yml", key: { steps: [{ pattern: "^attributes\\..*$", replace: "", on_no_match: "keep" }, { pattern: "^$", replace: "", on_no_match: "keep" }, { pattern: "^(.+)$", replace: "$1", on_no_match: "drop" }] } }],
      },
      io
    );
    expect(si.embedded.map((e) => `${e.component}/${e.key}`).sort()).toEqual(["alpha/enabled", "beta/enabled"]);
  });
});

// `data_maps:` — a path whose CHILDREN are data, not fields of a schema. The
// key has to say so, or a dotted data key reads as structure.
describe("layered recipe: data_maps", () => {
  const yaml = ["attributes:", "  saml.client.signature: 'true'", "  plain: x", "port: 8080", ""].join("\n");
  const files: Record<string, string> = { "/r/c.yml": yaml };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: () => "/r/c.yml",
    instances: [],
    dataMaps: ["attributes"],
  };

  it("brackets a key under a declared data map and leaves everything else alone", () => {
    const si = layeredRecipe().load({ name: "s", recipe: "layered", static_files: [{ path: "c.yml" }] }, io);
    expect(si.embedded.map((e) => e.key).sort()).toEqual([
      'attributes["plain"]',
      'attributes["saml.client.signature"]',
      "port",
    ]);
  });

  it("does nothing when the spec declares no data map", () => {
    const si = layeredRecipe().load({ name: "s", recipe: "layered", static_files: [{ path: "c.yml" }] }, { ...io, dataMaps: undefined });
    expect(si.embedded.map((e) => e.key)).toContain("attributes.plain");
  });
});

// `component: { map: ... }` — a literal assignment for the rows a transform
// cannot reach: an env variable feeding one member's field is not addressed as
// part of the list, so nothing about its name derives the member.
describe("layered recipe: component map", () => {
  const files: Record<string, string> = { "/r/env.properties": "SSO_LDAP_CORP_PASSWORD=x\nOTHER=y\n" };
  const io: RecipeIO = {
    readFile: (p) => files[p] ?? null,
    specDir: "/r",
    resolve: () => "/r/env.properties",
    instances: [],
    component: { map: { SSO_LDAP_CORP_PASSWORD: "corp-ldap" } },
  };

  it("files a named key under the component it is assigned to", () => {
    const si = layeredRecipe().load({ name: "s", recipe: "layered", defaults: "env.properties" }, io);
    expect(si.componentOf?.get("SSO_LDAP_CORP_PASSWORD")).toBe("corp-ldap");
    expect(si.componentOf?.get("OTHER")).toBeUndefined();
  });

  it("warns about an assignment no row produced", () => {
    const warnings: string[] = [];
    const spy = console.warn;
    console.warn = (m: string) => warnings.push(String(m));
    try {
      layeredRecipe().load(
        { name: "s", recipe: "layered", defaults: "env.properties" },
        { ...io, component: { map: { SSO_LDAP_CORP_PASSWORD: "corp-ldap", GONE: "corp-ldap" } } }
      );
    } finally {
      console.warn = spy;
    }
    expect(warnings.join("\n")).toContain("component map names 1 key(s) no row produced: GONE");
  });
});

// `key: { from: value }` end to end: a scalar list becomes one row per member,
// named by the member, valued by its presence — and a repeated member fails the
// build rather than merging two rows into one.
describe("layered recipe: a list keyed by its own values", () => {
  const io = (files: Record<string, string>): RecipeIO => ({
    readFile: (p) => files[p] ?? null,
    specDir: "/spec",
    resolve: (p) => p,
    instances: [],
  });

  const load = (yaml: string, key?: unknown) => {
    const r = getRecipe("layered")!;
    return r.load(
      { name: "s", recipe: "layered", defaults: [{ path: "/vars.yml", ...(key ? { key } : {}) }] } as never,
      io({ "/vars.yml": yaml })
    );
  };

  it("names each row after the member, not after its position", () => {
    const out = load("services:\n  - ssh\n  - http\n", { from: "value" });
    const keys = [...(out.layers[0].entries as Map<string, unknown>).keys()];
    expect(keys).toEqual(["ssh", "http"]);
  });

  // The row is about MEMBERSHIP: `- ssh` is how the file writes "ssh is
  // permitted", so the value is presence and the SITE keeps the member's own
  // text — which is what verify confirms there and what stops the key and the
  // value from being one string in two slots.
  it("holds presence, and keeps the member on the source", () => {
    const out = load("services:\n  - ssh\n", { from: "value" });
    const row = (out.layers[0].entries as Map<string, { value: string; source: { member?: string } }>).get("ssh")!;
    expect(row.value).toBe("true");
    expect(row.source.member).toBe("ssh");
  });

  // Without it, the same list keys by position and a member's identity is
  // wherever it happens to sit.
  it("keys by position when nothing asks otherwise", () => {
    const out = load("services:\n  - ssh\n  - http\n");
    const keys = [...(out.layers[0].entries as Map<string, unknown>).keys()];
    expect(keys).not.toEqual(["ssh", "http"]);
  });

  // Two members with one name is a list that cannot be keyed this way, and
  // silently keeping one of them would drop a row nobody was told about.
  it("refuses a list with a repeated member", () => {
    expect(() => load("services:\n  - ssh\n  - ssh\n", { from: "value" })).toThrow(/ssh/);
  });
});

// `at:` end to end: one file, two kinds of thing, one source declaration.
describe("layered recipe: a transform scoped to part of a file", () => {
  const io = (files: Record<string, string>): RecipeIO => ({
    readFile: (p) => files[p] ?? null,
    specDir: "/spec",
    resolve: (p) => p,
    instances: [],
  });
  const YAML = "mode: enforcing\nservices:\n  - ssh\n  - http\n";
  const load = (key: unknown, yaml = YAML) => {
    const r = getRecipe("layered")!;
    return r.load({ name: "s", recipe: "layered", defaults: [{ path: "/vars.yml", key }] } as never, io({ "/vars.yml": yaml }));
  };
  const keysOf = (out: { layers: { entries: Map<string, { value: string }> }[] }) => [...out.layers[0].entries.entries()].map(([k, v]) => `${k}=${v.value}`);

  it("keys the named list by value and leaves the rest alone", () => {
    expect(keysOf(load({ from: "value", at: "services" }) as never)).toEqual(["mode=enforcing", "ssh=true", "http=true"]);
  });

  // Without it the whole file is keyed by value, and a scalar's own name is
  // replaced by whatever it happens to be set to.
  it("would rename every scalar without it", () => {
    expect(keysOf(load({ from: "value" }) as never)).toEqual(["enforcing=true", "ssh=true", "http=true"]);
  });

  // A transform applying to nothing renames nothing, and a silent no-op is how
  // a sheet quietly comes up short.
  it("refuses an at: that matches nothing in the file", () => {
    expect(() => load({ from: "value", at: "nosuchlist" })).toThrow(/no entry in the file sits under that address/);
  });
});
