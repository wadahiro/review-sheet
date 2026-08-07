// Ansible recipe: the "layered" recipe (layered.ts) plus Jinja2 template
// resolution and deployed_path — the parts that are genuinely
// Ansible-specific. Base+overlay+static_files+include/exclude reading is
// delegated to "layered" wholesale (see its module doc); this file's own job
// starts where that leaves off.
//
// S2: there is no per-sheet "keying" switch. What identity a row is filed
// under is derived PER ROW, from what the template (if any) does with the
// backing variable — the sheet-wide "source" vs "bound" choice used to force
// authors to pick a granularity finer than what they were actually deciding.
// When there is no `template` at all, every row simply keeps its extracted
// identity (the `defaults`/overlay key) — the base layer is `defaults` itself
// (via "layered"), in its own declaration order.
//
// When there IS a `template`, it becomes the base sequence (a role's template
// is usually the more legible map of "what this config key means", vs.
// defaults.yml's Ansible-variable grouping) and each entry resolves to one of:
//   - a bare literal (no `{{ var }}`) — filed AT ITS TEMPLATE POSITION as a
//     fixed "embedded" entry (ExtractedEntry.origin — see assemble.ts), not
//     appended after every other row, since it may sit between two config
//     keys the template author grouped together (e.g. Keycloak's
//     `db=postgres` right before `db-url=…`).
//   - `{{ var }}` backing EXACTLY ONE template entry — earns a keyMap entry
//     (assemble.ts's SheetInputs.keyMap), so the row is named after the
//     PRODUCT's own key for that directive (e.g. Keycloak's `db-url`), with
//     the variable surfaced via the sheet's `under_key` column.
//   - `{{ var }}` backing MORE than one template entry (e.g. httpd's
//     ProxyPass and ProxyPassReverse both driven by the same backend
//     variable) has no single product key to legitimately claim — there is
//     no way to pick one of the directives to name the row after without
//     misrepresenting the other(s). Left OUT of keyMap, so it is filed under
//     ITS OWN NAME instead (resolveKey's fallback — see assemble.ts), and
//     reported with a warning naming the variable and every entry key it
//     drives — never decided silently.
//   - a `defaults` variable the template never resolves into a row at all —
//     never referenced, or referenced only inside a Jinja `{% if %}`/`{% for
//     %}` test that never itself interpolates it — is rescued into the base
//     map ONLY when it would otherwise be entirely invisible: no overlay sets
//     it either (this project's "never lose a row" rule — e.g. nginx's
//     nginx_gzip, only ever set in defaults). Appended after every
//     template-derived row, in `defaults`'s own declaration order, under its
//     own name (there is no template position to give it). A variable SOME
//     overlay does set is left alone here: assemble.ts's own "keys seen only
//     in overlays" sweep already recovers it, with its true historical shape
//     (a Pattern B row covering only the instances that actually set it) —
//     rescuing it into the base map too would additionally manufacture a
//     base value for every instance that never set it, which is a real
//     behavior change, not a fix.
//
// A template entry that sits inside a Jinja `{% if %}`/`{% for %}` block is
// not a 1:1 mapping (its rendered position/presence can vary) — skipped, with
// a warning; a composed (multi-variable) value would need the same treatment
// and isn't handled here either (a hand-written build script is the escape
// hatch for that case — see the SKILL.md ladder). Likewise, a template
// variable with no counterpart in `defaults` is skipped with a warning
// (nothing to resolve its value from).
//
// This recipe never reads the project metadata: categories, out_of_scope, and
// descriptions are the assembler/enrich()'s job (see assemble.ts), not this
// recipe's.

import { extractFile } from "../extract.js";
import type { Entry } from "../parser.js";
import { structuredFormat } from "../structural.js";
import { baseFileName } from "../jinja2.js";
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type { SheetInputs, ExtractedMap, ExtractedEntry, ValueLayer, EmbeddedEntry, KeyMapEntry } from "../assemble.js";
import { layeredRecipe } from "./layered.js";

const schema = {
  type: "object",
  required: ["defaults"],
  properties: {
    defaults: { type: "string" },
    template: { type: "string" },
    deployed_path: { type: "string" },
    static_files: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, format: { type: "string" } },
        additionalProperties: false,
      },
    },
    overlays: { type: "object", additionalProperties: { type: "string" } },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
    // under_key (the backing-variable column) lives in the project metadata
    // (sheet.yml's under_key:, P7): a display fact, not a data-source one.
    // assemble.ts enforces "any keyMap entry requires an under_key" at
    // assembly time, reading it off sheet.yml.
  },
  additionalProperties: false,
};

function asString(v: JsonValue | undefined, field: string): string {
  if (typeof v !== "string") throw new Error(`ansible recipe: "${field}" must be a string`);
  return v;
}

// The product's own name for a template entry, which is not the same kind of
// thing in every format:
//
//   - In a STRUCTURED document (JSON/YAML/TOML/XML) the path IS the identity.
//     A realm export's `smtpServer.host` is not "host"; there is no such realm
//     setting, and a sheet row called `host` names nothing a reader can look
//     up. Keycloak's own admin console agrees — it documents that field as
//     smtpServer.host.
//   - In a DIRECTIVE format (Apache, nginx, haproxy, keycloak.conf) the
//     directive name is the identity and the enclosing block is context, not a
//     namespace. `StartServers` inside `<IfModule mpm_event_module>` is still
//     the StartServers directive; keying it `IfModule[…].StartServers` renames
//     a product key into something the product never calls it (measured: doing
//     that stranded all six of ansible-httpd's mpm rows from their sheet.yml
//     entries at once).
//
// Embedded literals below always key by path, because they have no variable
// name to fall back to and a repeated leaf would overwrite itself.
function productKeyOf(entry: Entry, structured: boolean): string {
  return structured ? (entry.source.path ?? entry.key) : entry.key;
}

function readRequired(io: RecipeIO, path: string, what: string): { file: string; content: string } {
  const file = io.resolve(path);
  const content = io.readFile(file);
  if (content === null) throw new Error(`ansible recipe: ${what} not found: ${file}`);
  return { file, content };
}

export const ansibleRecipe: SheetRecipe = {
  name: "ansible",
  schema,
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const name = asString(sheetSpec.name, "name");

    // Defaults + overlays + static_files + include/exclude: identical shape
    // and semantics to "layered" — every row keyed by its extracted identity.
    // Template-driven product-key naming (below) is layered on top of this,
    // never changes what "layered" itself produces.
    const core = layeredRecipe.load(sheetSpec as Record<string, JsonValue>, io);
    const defaultsMap = (core.layers.find((l): l is Extract<ValueLayer, { kind: "base" }> => l.kind === "base") as Extract<
      ValueLayer,
      { kind: "base" }
    >).entries;
    const overlayLayers = core.layers.filter(
      (l): l is Extract<ValueLayer, { kind: "overlay" }> => l.kind === "overlay"
    );

    const embedded: EmbeddedEntry[] = [...core.embedded]; // static_files' embedded entries
    const keyMap: KeyMapEntry[] = [];
    let baseMap: ExtractedMap = defaultsMap;
    let filePath: string | undefined;
    let sourceFile: string | undefined;

    const deployedPath = sheetSpec.deployed_path === undefined ? undefined : asString(sheetSpec.deployed_path, "deployed_path");

    if (sheetSpec.template !== undefined) {
      const template = readRequired(io, asString(sheetSpec.template, "template"), "template file");
      if (deployedPath !== undefined) {
        // The sheet shows where the rendered file lands on the managed host and
        // records the template as the local source. NOT io.resolve()d: this is
        // a path over there, not a file in the control repository.
        filePath = deployedPath;
        sourceFile = template.file;
      } else {
        filePath = template.file;
      }
      const templateEntries = extractFile(template.content, template.file, undefined, io.extractOptions);
      // A `.j2` resolves to its base format by name (realm-corp.json.j2 -> .json),
      // which is also what decides whether a row's identity is its path or its
      // leaf — see productKeyOf.
      const structured = structuredFormat(baseFileName(template.file)) !== null;

      // The template IS the base sequence here (see module doc): a {{ var }}
      // passthrough resolves its value from `defaults`, keyed by the
      // variable (so overlay lookups in assembleSheets still find it); a
      // bare literal is filed at its template position (origin: "embedded",
      // not appended after — see ExtractedEntry in assemble.ts).
      //
      // Pass 1: a variable only earns a product key (keyMap entry) when it
      // backs exactly one template entry. A variable that drives more than
      // one directive (e.g. httpd's ProxyPass/ProxyPassReverse sharing the
      // same backend variable) has no single product key to be — filing it
      // under the LAST entry seen would silently mislabel the row as that
      // directive while quietly dropping the others. Left out of keyMap,
      // resolveKey (assemble.ts) falls back to the variable name itself, so
      // the row is named honestly.
      const entryKeysByVariable = new Map<string, string[]>();
      for (const entry of templateEntries) {
        if (entry.source.conditional) continue;
        const variable = entry.source.templateVar;
        if (variable === undefined || !defaultsMap.has(variable)) continue;
        const keys = entryKeysByVariable.get(variable);
        if (keys) keys.push(productKeyOf(entry, structured));
        else entryKeysByVariable.set(variable, [productKeyOf(entry, structured)]);
      }
      for (const [variable, keys] of entryKeysByVariable) {
        const unique = [...new Set(keys)];
        if (unique.length > 1) {
          console.warn(
            `keyed by variable (not 1:1): {{ ${variable} }} used by ${unique.join(", ")} -> filed as "${variable}"`
          );
        }
      }

      // Pass 2: build the base map, consulting pass 1's grouping to decide
      // whether an entry earns its product key or falls back to the
      // variable name.
      const bound: ExtractedMap = new Map();
      for (const entry of templateEntries) {
        if (entry.source.conditional) {
          console.warn(`skipped (not 1:1): ${entry.key}`);
          continue;
        }
        const variable = entry.source.templateVar;
        if (variable !== undefined) {
          const def = defaultsMap.get(variable);
          if (!def) {
            console.warn(`skipped (no default for {{ ${variable} }}): ${entry.key}`);
            continue;
          }
          bound.set(variable, def);
          const unique = new Set(entryKeysByVariable.get(variable) ?? []);
          if (unique.size === 1) {
            keyMap.push({ boundKey: productKeyOf(entry, structured), variable });
          }
          continue;
        }
        const literal: ExtractedEntry = {
          value: entry.value,
          source: { ...entry.source, file: template.file },
          origin: "embedded",
        };
        // Keyed by the full structural path, not the leaf name (entry.key) —
        // a nested/blocked format (nginx's `http.include` vs.
        // `http.server.include`) repeats leaf names across containers, and
        // keying by the leaf alone silently collided one over the other. Same
        // convention "layered"'s static_files and this recipe's own
        // "source"-only (no template) embedded path already use.
        bound.set(entry.source.path ?? entry.key, literal);
      }
      // `defaults` variables the template never resolved into `bound` above —
      // never referenced at all, or referenced only inside a conditional
      // block (skipped, warned, above) — still need a row: this project never
      // silently drops one. But only rescue one that would otherwise be
      // INVISIBLE (no base entry AND no overlay entry anywhere, e.g. nginx's
      // nginx_gzip — only ever set in defaults, never overridden): a variable
      // that DOES appear in some overlay is already recovered, unaided, by
      // buildDrafts' own "keys seen only in overlays" sweep (assemble.ts) —
      // with exactly its historical shape (only the instances that actually
      // set it). Rescuing it here too would additionally manufacture a BASE
      // value for every instance that never set it, turning what was a
      // legitimate partial Pattern B (only `local` sets
      // kc_bootstrap_admin_username, say) into a full one with a fabricated
      // "" for every other instance — a real behavior change, not a fix. No
      // template position for a rescued row to slot into, so it is appended
      // after every template-derived row, in `defaults`'s own declaration
      // order, under its own name (see module doc).
      for (const [variable, def] of defaultsMap) {
        if (bound.has(variable)) continue;
        if (overlayLayers.some((ov) => ov.entries.has(variable))) continue;
        bound.set(variable, def);
      }
      baseMap = bound;
    }

    const layers: ValueLayer[] = [{ kind: "base", entries: baseMap }, ...overlayLayers];

    if (deployedPath !== undefined && sheetSpec.template === undefined) {
      throw new Error(
        `ansible recipe: sheet "${name}" declares deployed_path but has no template — ` +
          `there is no rendered file to deploy`
      );
    }

    return {
      name,
      ...(filePath ? { filePath } : {}),
      ...(sourceFile ? { sourceFile } : {}),
      instances: io.instances,
      layers,
      embedded,
      ...(keyMap.length > 0 ? { keyMap } : {}),
    };
  },
};

registerRecipe(ansibleRecipe);
