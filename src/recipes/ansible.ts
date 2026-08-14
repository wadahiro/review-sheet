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
import type { SheetInputs, ExtractedMap, ValueLayer, EmbeddedEntry, KeyMapEntry } from "../assemble.js";
import type { LangText } from "../types.js";
import { layeredRecipe, sourceOrListSchema, splitSchema } from "./layered.js";

const schema = {
  type: "object",
  required: ["defaults"],
  properties: {
    // `defaults`/`overlays` take layered.ts's SHARED shapes, not copies of
    // them: `load` below hands both straight to `layeredRecipe.load`, which
    // has accepted a list of sources for a while, so declaring `{ type:
    // "string" }` here restricted nothing — it only refused, with a "must be
    // string" message, a declaration the code would have handled. (Found by a
    // sheet that genuinely needs two: a systemd unit template interpolates
    // both the role's defaults/ and its vars/.)
    defaults: sourceOrListSchema,
    // Same shared shape as layered's, for the same reason `defaults` is: this
    // recipe hands the sheet straight to `layeredRecipe.load`, so a narrower
    // copy here would only refuse a declaration that already works.
    split: splitSchema,
    // One template, or several. `template`/`deployed_path` describe a sheet
    // that IS one deployed artifact; `templates` describes a sheet that covers
    // several, each becoming a component (see the module doc). Declaring both
    // is rejected rather than merged — which of the two the deployed_path
    // belonged to would be a guess.
    template: { type: "string" },
    deployed_path: { type: "string" },
    templates: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          deployed_path: { type: "string" },
          // Defaults to the template's file name without `.j2`
          // (keycloak.conf.j2 -> keycloak.conf), which is what a reviewer calls
          // the artifact. Override when that is not the name they use.
          component: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    // `static_files` deliberately does NOT take layered's shape. Its
    // per-file `substitution:` is a scope decision (T6) — unreachable from an
    // ansible sheet on purpose, guarded by a test in recipe-layered.test.ts —
    // so this one stays a narrower local schema, and narrowing is the point
    // rather than drift. Widen it only by revisiting that decision.
    static_files: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, format: { type: "string" } },
        additionalProperties: false,
      },
    },
    overlays: { type: "object", additionalProperties: sourceOrListSchema },
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

// One template's declaration, however it was written. `template:` yields a
// single entry with no component — a sheet that IS one artifact needs no level
// above its categories. `templates:` yields one per entry, each a component,
// because a sheet covering several artifacts must be able to say which row came
// from which, and because two of them routinely share a row key (two systemd
// units both have Unit.Description).
type TemplateSpec = { path: string; deployedPath?: string; component?: string };

// A template's format is the DEPLOYED artifact's format. The template's own
// name is normally a good proxy (`keycloak.conf.j2` -> `.conf`... which is
// exactly where the proxy fails: a bare `.conf` is claimed by nothing, while
// the path it lands at, `/etc/systemd/journald.conf.d/iam-platform.conf`, is
// unambiguous). Consulted only when the template name yields nothing, so no
// existing sheet changes parser.
function formatOf(spec: TemplateSpec): string | undefined {
  if (structuredFormat(baseFileName(spec.path)) !== null) return undefined;
  const deployed = spec.deployedPath === undefined ? null : structuredFormat(spec.deployedPath);
  return deployed === null ? undefined : deployed;
}

function templateSpecs(sheetSpec: Record<string, JsonValue>, name: string): TemplateSpec[] {
  const single = sheetSpec.template;
  const many = sheetSpec.templates;
  if (single !== undefined && many !== undefined) {
    throw new Error(
      `ansible recipe: sheet "${name}" declares both "template" and "templates" — use one. ` +
        `"templates" is the general form; a single-element list behaves like "template" except ` +
        `that its rows are grouped under a component.`
    );
  }
  if (single !== undefined) {
    return [
      {
        path: asString(single, "template"),
        ...(sheetSpec.deployed_path !== undefined
          ? { deployedPath: asString(sheetSpec.deployed_path, "deployed_path") }
          : {}),
      },
    ];
  }
  if (many === undefined) return [];
  if (sheetSpec.deployed_path !== undefined) {
    throw new Error(
      `ansible recipe: sheet "${name}" declares a sheet-wide "deployed_path" alongside "templates" — ` +
        `each template lands somewhere different, so declare deployed_path inside each entry.`
    );
  }
  return (many as JsonValue[]).map((raw) => {
    const t = raw as Record<string, JsonValue>;
    const path = asString(t.path, "templates[].path");
    return {
      path,
      ...(t.deployed_path !== undefined ? { deployedPath: asString(t.deployed_path, "templates[].deployed_path") } : {}),
      // app.conf.j2 -> app.conf: the artifact's own name, which is what a
      // reviewer calls it.
      component: t.component !== undefined ? asString(t.component, "templates[].component") : baseFileName(path).split("/").pop()!,
    };
  });
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
    const componentOf = new Map<string, string>();
    const componentLabels = new Map<string, LangText>();
    let baseMap: ExtractedMap = defaultsMap;
    let filePath: string | undefined;
    let sourceFile: string | undefined;
    const componentFiles = new Map<string, { filePath?: string; sourceFile?: string }>();

    const specs = templateSpecs(sheetSpec as Record<string, JsonValue>, name);
    // `templates:` means the sheet covers several artifacts, so every row has
    // to say which one it came from. `template:` means the sheet IS one, and a
    // component level would name it a second time above every category.
    const scoped = specs.some((t) => t.component !== undefined);

    if (specs.length > 0) {
      const read = specs.map((spec) => {
        const t = readRequired(io, spec.path, "template file");
        return {
          spec,
          file: t.file,
          // Format from the DEPLOYED path when the template's own name cannot
          // answer: `journald-iam-platform.conf.j2` is a bare `.conf`, which is
          // far too common a suffix to claim, while the artifact it becomes —
          // `/etc/systemd/journald.conf.d/iam-platform.conf` — says exactly
          // what it is. The template name stays the SOURCE either way; only the
          // parser choice moves.
          entries: extractFile(t.content, t.file, undefined, { ...io.extractOptions, baseFormat: formatOf(spec) }),
          // A `.j2` resolves to its base format by name (realm-corp.json.j2 ->
          // .json), which is also what decides whether a row's identity is its
          // path or its leaf — see productKeyOf.
          structured: structuredFormat(baseFileName(t.file)) !== null || formatOf(spec) !== undefined,
        };
      });

      if (specs.length === 1) {
        const only = read[0];
        if (only.spec.deployedPath !== undefined) {
          // The sheet shows where the rendered file lands on the managed host and
          // records the template as the local source. NOT io.resolve()d: this is
          // a path over there, not a file in the control repository.
          filePath = only.spec.deployedPath;
          sourceFile = only.file;
        } else {
          filePath = only.file;
        }
      } else {
        // Several templates: the sheet-wide pair cannot answer for all of them,
        // so each COMPONENT carries its own. Without this the per-template
        // `deployed_path` was accepted by the schema and then dropped — a sheet
        // covering three deployed files said nothing about where any of them
        // went, which is the one question a reviewer of a rendered artifact
        // asks first.
        for (const { spec, file } of read) {
          const component = spec.component!;
          componentFiles.set(component, {
            ...(spec.deployedPath !== undefined ? { filePath: spec.deployedPath } : {}),
            sourceFile: file,
          });
        }
      }

      // Pass 1, over EVERY template: a variable earns a product key only when
      // it backs exactly one entry. The rule is unchanged; the count is now
      // taken across the whole sheet: one variable spelling a directive in one
      // template and its equivalent in a second is the same situation as
      // httpd's ProxyPass/ProxyPassReverse sharing a backend variable — no
      // single product key can honestly claim it. Filing it under
      // the LAST entry seen would mislabel the row as that one directive while
      // quietly dropping the others, so it is filed under its own name and
      // reported.
      const entryKeysByVariable = new Map<string, string[]>();
      for (const { entries, structured } of read) {
        for (const entry of entries) {
          if (entry.source.conditional) continue;
          const variable = entry.source.templateVar;
          if (variable === undefined || !defaultsMap.has(variable)) continue;
          const keys = entryKeysByVariable.get(variable);
          if (keys) keys.push(productKeyOf(entry, structured));
          else entryKeysByVariable.set(variable, [productKeyOf(entry, structured)]);
        }
      }
      for (const [variable, keys] of entryKeysByVariable) {
        const unique = [...new Set(keys)];
        if (unique.length > 1) {
          console.warn(
            `keyed by variable (not 1:1): {{ ${variable} }} used by ${unique.join(", ")} -> filed as "${variable}"`
          );
        }
      }

      // Which template each 1:1 variable came from. A variable shared by
      // several templates deliberately gets NO component: it belongs to all of
      // them, and claiming one would be a guess. Such a row sits outside every
      // component heading, which is the honest place for "this value feeds
      // more than one file".
      const templateOfVariable = new Map<string, string | null>();

      // Pass 2: build the base map, consulting pass 1's grouping to decide
      // whether an entry earns its product key or falls back to the variable
      // name.
      const bound: ExtractedMap = new Map();
      for (const { spec, file, entries, structured } of read) {
        if (spec.component !== undefined) componentLabels.set(spec.component, spec.component);
        for (const entry of entries) {
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
            if (spec.component !== undefined) {
              const seenIn = templateOfVariable.get(variable);
              templateOfVariable.set(variable, seenIn === undefined ? spec.component : seenIn === spec.component ? seenIn : null);
            }
            const unique = new Set(entryKeysByVariable.get(variable) ?? []);
            if (unique.size === 1) {
              keyMap.push({ boundKey: productKeyOf(entry, structured), variable });
            }
            continue;
          }
          const literalKey = entry.source.path ?? entry.key;
          const source = { ...entry.source, file };
          if (scoped) {
            // A literal cannot go into the base map once a sheet has several
            // templates: that map is keyed by the row's own name, and two
            // systemd units both have Unit.Description. `embedded` is a list,
            // and each entry carries its component, so both survive — the same
            // mechanism static_files already uses for several files on one
            // sheet. The cost is ordering: embedded rows are appended after the
            // base layer rather than interleaved at their template position,
            // so within a component the variables come first. Grouping by
            // component reorders them anyway.
            embedded.push({ key: literalKey, value: entry.value, source, component: spec.component });
            continue;
          }
          // Keyed by the full structural path, not the leaf name (entry.key) —
          // a nested/blocked format (nginx's `http.include` vs.
          // `http.server.include`) repeats leaf names across containers, and
          // keying by the leaf alone silently collided one over the other. Same
          // convention "layered"'s static_files and this recipe's own
          // "source"-only (no template) embedded path already use.
          bound.set(literalKey, { value: entry.value, source, origin: "embedded" });
        }
      }
      for (const [variable, component] of templateOfVariable) {
        if (component !== null) componentOf.set(variable, component);
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

    if (sheetSpec.deployed_path !== undefined && specs.length === 0) {
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
      ...(componentOf.size > 0 ? { componentOf } : {}),
      ...(componentLabels.size > 0 ? { componentLabels } : {}),
      ...(componentFiles.size > 0 ? { componentFiles } : {}),
      ...(specs.length > 1
        ? { componentOrder: specs.map((t) => t.component).filter((c): c is string => c !== undefined) }
        : {}),
    };
  },
};

registerRecipe(ansibleRecipe);
