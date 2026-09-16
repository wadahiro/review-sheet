// How a project's plugin reaches back into the tool that loaded it.
//
// A plugin under `.review-sheet/{rules,parsers,providers,recipes}` is written
// against this tool's own modules — `registerProbeRule` from `channel.ts`, and
// the readers under `channels/` that are the whole reason a plugin is thin.
// It names them the one way there is to name a package:
//
//     import { registerProbeRule } from "review-sheet/src/channel.ts";
//
// That resolves only where the tool sits in a `node_modules` the plugin can
// see. A project that has no `node_modules` at all — one that keeps the tool's
// path in an environment variable and runs `bun run "$DIR/src/cli.ts"`, which
// is the whole of what the tool needs — had no way to write that line, and no
// other way either: `loadPluginModules` imports the plugin FILE by absolute
// path, but the `import` statements inside it are the runtime's business.
//
// So the tool answers for its own name. A resolver installed before any plugin
// is imported points `review-sheet/…` at the files this process is running out
// of, and the one documented import form works in both configurations.
//
// AND IT RESOLVES TO THE RUNNING TOOL, which is a change of precedence and not
// only of reach: where a `node_modules` copy exists and is a DIFFERENT one, the
// plugin used to extend that copy — registering into a registry this process
// does not read, which is the failure `loadPluginModules` has a whole paragraph
// of warning about. A plugin extends the tool that loaded it. There is no
// reading of "extend" under which the other copy is the right answer.
//
// The boundary: this covers the plugins the CLI imports. A project script run
// directly by bun (`bun ./scripts/something.mjs`) is not this process and still
// resolves the way its own directory says.

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives in src/, so one level up is the package.
const root = (): string => realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// What a bare `review-sheet` means, read from the package's own declaration
// rather than restated here — there is one place that decides the entry point
// and it is not this file.
function entryOf(at: string): string {
  const main = (JSON.parse(readFileSync(join(at, "package.json"), "utf-8")) as { main?: string }).main;
  return join(at, main ?? "src/index.ts");
}

let installed = false;

// True when a plugin can now write `review-sheet/…` and have it mean this
// process. False when the runtime offers no way to say so — in which case
// nothing is done and nothing is claimed: such a plugin fails to import, by
// name, at the line that names the module, which says more than a warning here
// could.
export function installSelfResolver(): boolean {
  if (installed) return true;
  if (typeof Bun === "undefined" || typeof Bun.plugin !== "function") return false;
  const at = root();
  const entry = entryOf(at);
  Bun.plugin({
    name: "review-sheet-self",
    setup(build) {
      // Anchored, so a package whose name merely STARTS with ours — a
      // `review-sheet-foo` — resolves the ordinary way.
      build.onResolve({ filter: /^review-sheet(\/.*)?$/ }, (args) => ({
        path: args.path === "review-sheet" ? entry : join(at, args.path.slice("review-sheet/".length)),
      }));
    },
  });
  installed = true;
  return true;
}

// For a test that needs to know what the resolver would answer without
// installing it into the process it is running in.
export function selfResolves(specifier: string): string | undefined {
  if (!/^review-sheet(\/.*)?$/.test(specifier)) return undefined;
  const at = root();
  return specifier === "review-sheet" ? entryOf(at) : join(at, specifier.slice("review-sheet/".length));
}
