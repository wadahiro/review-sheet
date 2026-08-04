// Side-effect imports: each module registers its metadata provider(s) at module
// load time. Import this file once (enrich.ts does) to populate the registry
// before calling resolveMetadata().

import { listMetadataProviders } from "../metadata.js";

import "./project.js";
import "./argument-specs.js";
import "./terraform-variables.js";
import "./dictionary.js";

// What counts as a built-in, snapshotted the moment the imports above have run
// and before anything else can register — this module loads at enrich.ts's
// module scope, while custom providers load later (cli.ts's --providers-dir).
// Deriving it means adding a provider above cannot leave a stale list behind;
// six test files used to keep hand-written copies of these names, and the one
// that added terraform-variables silently disabled it wherever a copy was
// missed.
export const BUILT_IN_PROVIDER_NAMES: readonly string[] = listMetadataProviders().map((p) => p.name);
