// The parser registry is process-wide (registry.ts keys it off `Symbol.for`),
// so a parser registered by ANY test file is visible to every other one, in
// whatever order bun runs them. Five test files register one. A test that
// asserts what the SHIPPED parsers extract wants only the built-ins answering —
// otherwise it passes alone and fails in the suite, which is worse than failing
// outright because it looks like flakiness rather than a missing guard.
//
// The set of built-ins is NOT written down here: it comes from parsers/index.ts,
// the file that decides what a built-in is. Same shape as
// `only-builtin-providers.ts`, for the same reason.
import { listParsers, registerParser } from "../src/parser.js";
import { BUILT_IN_PARSER_NAMES } from "../src/parsers/index.js";

const NEVER = {
  detect: () => false,
  extract: () => [],
  locate: () => ({ error: "stubbed" }) as never,
  edit: () => ({ status: "error", reason: "stubbed" }) as never,
};

export function stubNonBuiltInParsers(): void {
  const builtIn = new Set(BUILT_IN_PARSER_NAMES);
  for (const p of listParsers()) {
    if (!builtIn.has(p.name)) registerParser({ name: p.name, ...NEVER });
  }
}

export const isBuiltInParser = (name: string): boolean => BUILT_IN_PARSER_NAMES.includes(name);
