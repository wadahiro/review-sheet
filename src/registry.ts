// Process-wide backing store for the plugin registries (parsers, recipes,
// metadata providers).
//
// WHY THIS EXISTS: a plugin file writes `import { registerParser } from
// "review-sheet"`, and that bare specifier is resolved from the PLUGIN's own
// location — i.e. through the consumer project's node_modules. When the CLI is
// running from somewhere else (a sibling checkout, `bun run
// ../review-sheet/src/cli.ts`, a linked workspace, two versions in one
// dependency tree), the plugin ends up importing a DIFFERENT copy of
// parser.ts than the CLI did. ES module identity is keyed by resolved file
// path, so those two copies each get their own module-scope `registry` array:
// `registerParser()` succeeds against an array that `getParser()` never reads.
// The failure is silent — no error, the parser is simply never found.
//
// Keying the array off `Symbol.for()` puts it in the JS engine's cross-realm
// global symbol registry, which every copy of the module reaches by name, so
// all copies share one array regardless of how each was resolved.
//
// The `.v1` suffix is a compatibility discriminator, not the package version:
// bump it only when the registered object's shape changes incompatibly, so an
// old copy of review-sheet sharing a process with a new one keeps its own
// array instead of being handed entries it cannot use.
export function sharedRegistry<T>(name: string): T[] {
  const host = globalThis as { [key: symbol]: T[] | undefined };
  return (host[Symbol.for(name)] ??= []);
}

// NOTE: this module used to also export a second helper — a process-wide
// backing cell for single mutable settings (extract.ts's identity-fields
// override, annotation.ts's active marker). It existed because those
// settings were process-wide `let`s that a second, separately-resolved copy
// of the module couldn't see — the same problem sharedRegistry solves for
// registration, but for configuration instead of registered plugins. It was
// a stopgap: the real fix is threading configuration into
// `extract()`/`extractTree()` as an ordinary argument (`ExtractOptions`, see
// parser.ts), which every call site now does. There is no longer any
// process-wide mutable configuration in this package — only
// `sharedRegistry`, for registration, remains.
