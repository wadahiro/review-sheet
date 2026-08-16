// Normalizer: keycloak-realm-<version>.json  ->  keycloak-realm@<version>.yml
//
// The input JSON is produced by the `keycloak-config-extractor` skill
// (github.com/wadahiro/agent-skills), `scripts/extract.sh <version> --realm`.
// It combines four sources, each authoritative for one thing:
//
//   - field space, types, @Deprecated  : the RealmRepresentation class in the image
//   - label and help text, en AND ja   : the admin console's own message bundles
//   - grouping                         : the console tab/section the field sits under
//   - default                          : an empty realm created and read back
//
// The Japanese is what makes this different from every other dictionary here:
// it is KEYCLOAK'S OWN translation, shipped in the product, not something this
// repo wrote. So unlike keycloak@26.7.0.yml — where 18 keys are hand-translated
// and marked accordingly — the realm dictionary's `ja` carries the same
// `provenance: extracted` as its `en`.
//
// Regenerate after a Keycloak upgrade:
//   /wadahiro-agent-skills:keycloak-config-extractor   (or run its
//     scripts/extract.sh 26.7.0 --realm) > keycloak-realm-26.7.0.json
//   bun run review-sheet/metadata/build-realm-dict.ts

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDictionary, type DictionaryDoc, type DictionaryParam } from "../../../../src/index.js";

const VERSION = "26.7.0";
const here = dirname(fileURLToPath(import.meta.url));

type LangText = { en?: string; ja?: string };
type Raw = {
  representation: string;
  field: string;
  type: string;
  deprecated: boolean;
  default?: string | number | boolean | unknown[];
  keys_expanded?: boolean;
  label?: LangText;
  description?: LangText;
  group?: LangText;
  nested_in?: string;
};
const doc = JSON.parse(readFileSync(resolve(here, `keycloak-realm-${VERSION}.json`), "utf8")) as {
  keycloak_version: string;
  parameters: Record<string, Raw>;
};

// This sheet reviews a REALM export, so the dictionary covers
// RealmRepresentation and nothing else. The same extraction also carries
// ClientRepresentation and the user-profile config; those are a different key
// space (a client's `enabled` is not a realm's `enabled`), and mixing them into
// one flat dictionary would let a client field materialize as a realm row.
// Excluded here rather than at extraction time, so the snapshot stays complete
// and the decision stays visible — and counted, below.
const KEEP = "RealmRepresentation";

// Keycloak's Java types, rendered for someone reading a sheet rather than the
// class. Everything not listed keeps the extraction's own spelling.
const TYPE_LABEL: Record<string, string> = {
  Integer: "int",
  Long: "long",
  Boolean: "boolean",
  String: "string",
  "List<String>": "list of string",
  "Set<String>": "list of string",
  "Map<String, String>": "map",
};

// A field that HOLDS other objects (clients, groups, authenticationFlows) has no
// value of its own — "what is its default?" has no answer for a container. The
// dictionary says so with `kind: container`, which keeps materialize from
// asserting a default such a field does not have (see src/assemble.ts). The test
// is the element type: a list of representations is structure, a list of strings
// (eventsListeners, supportedLocales) is an ordinary multi-valued setting.
function isContainer(type: string): boolean {
  const inner = type.match(/<(.+)>$/)?.[1] ?? type;
  return inner
    .split(",")
    .map((s) => s.trim())
    .some((t) => /Representation$/.test(t) || /^UP[A-Z]/.test(t) || t === "JsonNode");
}

const params: Record<string, DictionaryParam> = {};
let skippedOtherRepresentations = 0;
let containers = 0;

for (const raw of Object.values(doc.parameters)) {
  if (raw.representation !== KEEP) {
    skippedOtherRepresentations++;
    continue;
  }
  const entry: DictionaryParam = {};

  // Description: the console's help text. Where Keycloak ships no help for a
  // field, its LABEL is still the product naming the thing, and a reviewer
  // reading "Wait increment" beside `waitIncrementSeconds` is better served
  // than by an empty cell — but a label is not a description, so it is only
  // used when there is no help text at all.
  const text = raw.description ?? raw.label;
  if (text && (text.en || text.ja)) entry.description = text;

  // Decided before the default is read, because it DECIDES whether there is one
  // to read: a container holds other objects and has no value of its own, so
  // `{"policies": []}` is the empty shape of what it holds, not its default.
  // Carrying it put an object where the field may only be a scalar, and the
  // resolver String()s a default it hands out.
  const container = isContainer(raw.type) || raw.keys_expanded === true;
  if (!container && raw.default !== undefined && !Array.isArray(raw.default)) {
    entry.default = raw.default as string | number | boolean;
  }
  entry.type = TYPE_LABEL[raw.type] ?? raw.type;
  // English, like every other dictionary here: `group` is a plain string (the
  // sheet's tab name), not a LangText the viewer can switch, so a Japanese
  // group would pin the tabs to one language while every other tab in this
  // project reads English.
  if (raw.group?.en || raw.group?.ja) entry.group = raw.group.en ?? raw.group.ja;
  // A map whose keys the extractor turned into rows of their own (it says so
  // with keys_expanded, having checked it rather than left it to convention) is
  // a container in the same sense: browserSecurityHeaders is not a setting, its
  // seven keys are.
  if (container) {
    entry.kind = "container";
    containers++;
  }
  entry.docs_url = "https://www.keycloak.org/docs-api/latest/rest-api/index.html#RealmRepresentation";
  params[raw.field] = entry;
}

const dict: DictionaryDoc = {
  product: "keycloak-realm",
  version: VERSION,
  // Both languages are the product's own words — the admin console's message
  // bundles ship with Keycloak.
  provenance: "extracted",
  // The field space comes from reflection over RealmRepresentation itself, so
  // it is an enumeration and not a selection. What it cannot enumerate is
  // stated in the header notes below rather than left for a reader to find.
  coverage: "full",
  generated_by:
    "keycloak-config-extractor skill (scripts/extract.sh --realm) — RealmRepresentation + admin console " +
    "message bundles and tab structure, quay.io/keycloak/keycloak:" +
    VERSION,
  docs_url: "https://www.keycloak.org/docs-api/latest/rest-api/index.html#RealmRepresentation",
  parameters: params,
};

const described = Object.values(params).filter((p) => p.description).length;
const bilingual = Object.values(params).filter(
  (p) => typeof p.description === "object" && p.description.ja && p.description.en
).length;
const defaulted = Object.values(params).filter((p) => p.default !== undefined).length;

const yaml = renderDictionary(dict, {
  generator: `build-realm-dict.ts from keycloak-realm-${VERSION}.json`,
  notes: [
    "Descriptions AND their Japanese are Keycloak's own: the admin console's message bundles, shipped in the product.",
    `Covers every field RealmRepresentation declares, plus the keys the admin console edits inside its map-typed ` +
      `fields (smtpServer.*). ${described} of ${Object.keys(params).length} carry the console's wording ` +
      `(${bilingual} bilingual); the rest are fields the console does not expose as a simple form control.`,
    `NOT enumerable: keys under the free-form 'attributes' map — a realm may carry any key there, so the product ` +
      `has no finite list of them. The entries present are those the console itself exposes.`,
    `${containers} field(s) are marked kind: container (they hold other objects — clients, groups, ` +
      `authenticationFlows — and have no value of their own, so materialize must not invent a default for them).`,
    `realm 'enabled' deliberately carries no default: the value depends on the creation request, and the ` +
      `admin console always sends true while a bare API create leaves it false.`,
    `Client and user-profile settings are in the same extraction snapshot but excluded here ` +
      `(${skippedOtherRepresentations} entries): they are a different key space and this sheet reviews a realm.`,
  ],
});
writeFileSync(resolve(here, `keycloak-realm@${VERSION}.yml`), yaml);
console.log(
  `wrote keycloak-realm@${VERSION}.yml (${Object.keys(params).length} params, ` +
    `${described} described, ${bilingual} bilingual, ${defaulted} with a product default, ` +
    `${containers} containers, ${skippedOtherRepresentations} client/user-profile entries excluded)`
);
