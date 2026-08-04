// Ansible argument_specs.yml metadata provider: reads role
// meta/argument_specs.yml files (explicit paths, no directory walking) for
// per-option `description` (and `type`). Community-grade — these documents
// ship with the role, written by its authors.
//
// argument_specs.yml is written in ANSIBLE VARIABLE names (kc_hostname,
// httpd_max_request_workers), not the row's display key — a role's own
// documentation of its own variables. Since S2 (per-row product-key naming
// via keyMap) a row's display key can be the PRODUCT's key instead
// (`hostname`, `ServerTokens`), so this provider tries `query.key` first (the
// pre-S2 behaviour, still right for a role with no keyMap at all) and falls
// back to `query.variable` — the row's original variable name, when keyMap
// renamed it (see metadata.ts's MetadataQuery.variable) — so a
// keyMap-renamed row still reaches the same argument_specs.yml entry its
// variable has always lived under, instead of that entry going permanently
// unreachable the moment the display key stops matching it.

import { parse } from "yaml";
import { registerMetadataProvider, nativeLangText, type MetadataProvider, type MetadataContext, type MetadataQuery, type MetadataResult } from "../metadata.js";

type ArgumentSpecOption = {
  description?: string | string[];
  type?: string;
};

type ArgumentSpecEntrypoint = {
  options?: Record<string, ArgumentSpecOption>;
};

type ArgumentSpecsDoc = {
  argument_specs?: Record<string, ArgumentSpecEntrypoint>;
};

function cachedDoc(path: string, ctx: MetadataContext): ArgumentSpecsDoc {
  const cacheKey = "argspecs:" + path;
  const cached = ctx.cache.get(cacheKey);
  if (cached) return cached as ArgumentSpecsDoc;
  const content = ctx.readFile(path);
  if (content === null) throw new Error("argument_specs not found: " + path);
  const doc = (parse(content) ?? {}) as ArgumentSpecsDoc;
  ctx.cache.set(cacheKey, doc);
  return doc;
}

function findOption(path: string, key: string, ctx: MetadataContext): ArgumentSpecOption | undefined {
  const doc = cachedDoc(path, ctx);
  const entrypoints = doc.argument_specs ?? {};
  for (const name of Object.keys(entrypoints)) {
    const option = entrypoints[name].options?.[key];
    if (option) return option;
  }
  return undefined;
}

const argumentSpecsProvider: MetadataProvider = {
  name: "argument-specs",
  priority: 50,
  resolve(query: MetadataQuery, ctx: MetadataContext): MetadataResult | undefined {
    for (const path of ctx.argumentSpecs) {
      // `key` first — the row's own key, still right whenever this role has
      // no keyMap at all (or this particular row wasn't renamed). `variable`
      // is only consulted as a fallback, and only when it differs from `key`
      // (nothing to gain from looking the same name up twice).
      const option =
        findOption(path, query.key, ctx) ??
        (query.variable !== undefined && query.variable !== query.key ? findOption(path, query.variable, ctx) : undefined);
      if (!option) continue;
      const description = Array.isArray(option.description)
        ? option.description.join(" ")
        : option.description;
      return {
        // argument_specs.yml has no language tag of its own — wrap it as
        // ctx.nativeLang so resolveMetadata's per-language merge treats it as
        // ONE language's text, not a language-agnostic complete description
        // (see MetadataContext.nativeLang / nativeLangText in metadata.ts).
        description: description === undefined ? undefined : nativeLangText(ctx.nativeLang, description),
        type: option.type,
        provenance: "community",
      };
    }
    return undefined;
  },
};
registerMetadataProvider(argumentSpecsProvider);
