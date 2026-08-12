// Normalizer: keycloak-realm-<version>.json  ->  keycloak-client@<version>.yml
//
// Same extraction snapshot as build-realm-dict.ts (the skill emits realm,
// client and user-profile settings in one document); this script takes the
// ClientRepresentation half. They are two dictionaries rather than one because
// five field names — enabled, description, attributes, id, name — exist in BOTH
// representations, and bind.ts refuses a key that matches two dictionary
// entries at the same tier rather than picking one. Two dictionaries, two
// sheets, no ambiguity to resolve.
//
// Regenerate after a Keycloak upgrade (same snapshot as the realm dictionary):
//   /wadahiro-agent-skills:keycloak-config-extractor   (or run its
//     scripts/extract.sh 26.7.0 --realm) > keycloak-realm-26.7.0.json
//   bun run review-sheet/metadata/build-client-dict.ts

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
};
const doc = JSON.parse(readFileSync(resolve(here, `keycloak-realm-${VERSION}.json`), "utf8")) as {
  parameters: Record<string, Raw>;
};

const TYPE_LABEL: Record<string, string> = {
  Integer: "int",
  Long: "long",
  Boolean: "boolean",
  String: "string",
  "List<String>": "list of string",
  "Map<String, String>": "map",
};

function isContainer(type: string): boolean {
  const inner = type.match(/<(.+)>$/)?.[1] ?? type;
  return inner
    .split(",")
    .map((s) => s.trim())
    .some((t) => /Representation$/.test(t) || t === "JsonNode");
}

// A client's protocol settings live in its `attributes` map, and Keycloak names
// them by their dotted key alone — the docs, the admin console and every realm
// export call it `saml.client.signature`, never `attributes.saml.client.signature`.
// Keying the dictionary that way is also what makes the sheet bind with no
// aliases: a row extracted as `clients[clientId=corp-saml].attributes["saml.client.signature"]`
// reaches this entry through bind.ts's `leaf` tier, which takes the last
// identity-bearing path segment.
function dictKeyOf(field: string): string {
  return field.startsWith("attributes.") ? field.slice("attributes.".length) : field;
}

const params: Record<string, DictionaryParam> = {};
let attributeKeys = 0;
let containers = 0;

for (const raw of Object.values(doc.parameters)) {
  if (raw.representation !== "ClientRepresentation") continue;
  const key = dictKeyOf(raw.field);
  if (key !== raw.field) attributeKeys++;

  const entry: DictionaryParam = {};
  const text = raw.description ?? raw.label;
  if (text && (text.en || text.ja)) entry.description = text;
  if (raw.default !== undefined && !Array.isArray(raw.default)) entry.default = raw.default as string | number | boolean;
  entry.type = TYPE_LABEL[raw.type] ?? raw.type;
  if (raw.group?.en || raw.group?.ja) entry.group = raw.group.en ?? raw.group.ja;
  // A map whose keys the extractor turned into rows of their own (it says so
  // with keys_expanded, having checked it rather than left it to convention) is
  // a container in the same sense: browserSecurityHeaders is not a setting, its
  // seven keys are.
  if (isContainer(raw.type) || raw.keys_expanded === true) {
    entry.kind = "container";
    containers++;
  }
  entry.docs_url = "https://www.keycloak.org/docs-api/latest/rest-api/index.html#ClientRepresentation";
  params[key] = entry;
}

const described = Object.values(params).filter((p) => p.description).length;
const bilingual = Object.values(params).filter(
  (p) => typeof p.description === "object" && p.description.ja && p.description.en
).length;

const dict: DictionaryDoc = {
  product: "keycloak-client",
  version: VERSION,
  provenance: "extracted",
  // The declared field space is reflection over ClientRepresentation — an
  // enumeration. The attribute keys beside it are NOT enumerable (see the
  // header notes); this is stated there rather than left implicit.
  coverage: "full",
  generated_by:
    "keycloak-config-extractor skill (scripts/extract.sh --realm) — ClientRepresentation + admin console " +
    "message bundles and tab structure, quay.io/keycloak/keycloak:" +
    VERSION,
  docs_url: "https://www.keycloak.org/docs-api/latest/rest-api/index.html#ClientRepresentation",
  parameters: params,
};

const yaml = renderDictionary(dict, {
  generator: `build-client-dict.ts from keycloak-realm-${VERSION}.json`,
  notes: [
    "Descriptions AND their Japanese are Keycloak's own: the admin console's message bundles, shipped in the product.",
    `${described} of ${Object.keys(params).length} entries carry the console's wording (${bilingual} bilingual).`,
    `${attributeKeys} are protocol settings from a client's 'attributes' map, keyed the way Keycloak names them ` +
      `(saml.client.signature, not attributes.saml.client.signature).`,
    `Those attribute keys are NOT an enumeration: 'attributes' is a free-form map and a client may carry any key ` +
      `there. The ones present are the ones the admin console itself exposes — which is why this dictionary is ` +
      `not used with materialize, unlike keycloak@${VERSION}.`,
    `Separate from keycloak-realm@${VERSION} because five field names (enabled, description, attributes, id, name) ` +
      `exist in both representations, and one sheet binding both dictionaries would make every one of them ambiguous.`,
  ],
});
writeFileSync(resolve(here, `keycloak-client@${VERSION}.yml`), yaml);
console.log(
  `wrote keycloak-client@${VERSION}.yml (${Object.keys(params).length} params, ${described} described, ` +
    `${bilingual} bilingual, ${attributeKeys} attribute keys, ${containers} containers)`
);
