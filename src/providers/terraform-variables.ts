// Terraform variables.tf metadata provider: reads `variable "<name>" { description = ... }`
// blocks (explicit paths, no directory walking) for per-variable `description`.
// Community-grade — these files ship with the module, written by its authors,
// the exact same standing as Ansible's argument_specs.yml (see argument-specs.ts).
//
// No new HCL parsing here: the hcl parser (src/parsers/hcl.ts, via hcl.ts) already
// emits a `description` entry for every `variable "<name>" { description = "..." }`
// block, keyed by `source.path === "variable.<name>.description"`. This provider
// is a thin lookup over extractFile()'s output, mirroring argument-specs.ts's
// shape (cached doc parse, first-file-wins across multiple paths).

import { extractFile } from "../extract.js";
import { registerMetadataProvider, nativeLangText, type MetadataProvider, type MetadataContext, type MetadataQuery, type MetadataResult } from "../metadata.js";

function cachedEntries(path: string, ctx: MetadataContext): ReturnType<typeof extractFile> {
  const cacheKey = "tfvars:" + path;
  const cached = ctx.cache.get(cacheKey);
  if (cached) return cached as ReturnType<typeof extractFile>;
  const content = ctx.readFile(path);
  if (content === null) throw new Error("terraform variables file not found: " + path);
  const entries = extractFile(content, path);
  ctx.cache.set(cacheKey, entries);
  return entries;
}

function findDescription(path: string, key: string, ctx: MetadataContext): string | undefined {
  const entries = cachedEntries(path, ctx);
  const target = `variable.${key}.description`;
  return entries.find((e) => e.source.path === target)?.value;
}

const terraformVariablesProvider: MetadataProvider = {
  name: "terraform-variables",
  // Same priority as argument-specs: both are the ecosystem's own metadata
  // channel for the value next door (a Terraform module's variables.tf /
  // an Ansible role's meta/argument_specs.yml), authored by whoever wrote the
  // module/role — same standing, same rank.
  priority: 50,
  resolve(query: MetadataQuery, ctx: MetadataContext): MetadataResult | undefined {
    for (const path of ctx.terraformVariables) {
      const description = findDescription(path, query.key, ctx);
      if (description === undefined) continue;
      // `type` is deliberately not sourced here: Terraform's `type = string`
      // is an unquoted identifier (not a quoted string/number/bool literal),
      // which hcl.ts's parseScalar treats as an expression and skips — so
      // there is no `variable.<name>.type` entry to read in the first place.
      return {
        // variables.tf's `description = "..."` has no language tag of its own
        // — wrap it as ctx.nativeLang (see MetadataContext.nativeLang in
        // metadata.ts) so it merges as ONE language's text, not a
        // language-agnostic complete description.
        description: nativeLangText(ctx.nativeLang, description),
        provenance: "community",
      };
    }
    return undefined;
  },
};
registerMetadataProvider(terraformVariablesProvider);
