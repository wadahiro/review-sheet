// The metadata provider registry is process-wide (registry.ts keys it off
// Symbol.for), so a provider registered by ANY test file is visible to every
// other one, in whatever order bun happens to run them. A test that asserts on
// resolved metadata wants only the built-ins answering.
//
// The set of built-ins is NOT written down here: it comes from
// providers/index.ts, the file that decides what a built-in is.
import { listMetadataProviders, registerMetadataProvider } from "../src/metadata.js";
import { BUILT_IN_PROVIDER_NAMES } from "../src/providers/index.js";

export function stubNonBuiltInProviders(): void {
  const builtIn = new Set(BUILT_IN_PROVIDER_NAMES);
  for (const p of listMetadataProviders()) {
    if (!builtIn.has(p.name)) registerMetadataProvider({ name: p.name, resolve: () => undefined });
  }
}
