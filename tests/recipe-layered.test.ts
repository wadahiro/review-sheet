// Tests for the "layered" recipe (src/recipes/layered.ts): the IaC-agnostic
// base+overlay core split out of "ansible" (see CLAUDE.md). Byte-identical
// reuse by "ansible" itself is covered
// by tests/recipe-ansible.test.ts (the three examples' input.json comparison
// already exercises the delegation).

import { describe, it, expect } from "bun:test";
import { getRecipe, type RecipeIO } from "../src/recipe";
import "../src/recipes/index";
import type { ValueLayer } from "../src/assemble";

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
    expect(si.filePath).toBe("/r/default.env"); // display fallback: the defaults file
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
    // Display fallback is the FIRST source only.
    expect(si.filePath).toBe("/r/base.yml");
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

  it("defaults a static file's key to the structural path, like ansible's static_files always did", () => {
    const si = layeredRecipe().load(
      { name: "s", recipe: "layered", defaults: "defaults.yml", static_files: [{ path: "extra.yml" }] },
      io
    );
    expect(si.embedded.map((e) => e.key).sort()).toEqual(["banner", "nested.flag"]);
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
