// Deliberately does NOT call registerParser — stands in for the #17 failure
// mode, where a plugin file imports and executes without error but whatever
// it registers never lands in the registry this process reads (e.g. it
// resolved a stale/duplicate copy of review-sheet). Used by
// tests/plugin-load-warning.test.ts to prove `loadPluginModules()` warns on
// a net-zero registration count instead of staying silent about it.
export const noop = true;
