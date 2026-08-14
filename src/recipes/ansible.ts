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
import {
  baseFileName,
  jinjaVariables,
  substituteJinja,
  jinjaConditions,
  truthyJinja,
  type LineCondition,
} from "../jinja2.js";
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type {
  SheetInputs,
  ExtractedMap,
  ExtractedEntry,
  ValueLayer,
  EmbeddedEntry,
  KeyMapEntry,
} from "../assemble.js";
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
    // What a row IS on this sheet. `variable` (the default, and every existing
    // sheet) keys a row by the Ansible variable behind it. `artifact` keys it
    // by the LINE of the deployed file — see the module doc.
    rows: { enum: ["variable", "artifact"] },
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
    const rowsArtifact = sheetSpec.rows === "artifact";

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

    // A variable AS ONE INSTANCE SEES IT: that instance's overlay when it sets
    // it, the defaults otherwise. This is the same resolution the overlay
    // re-keying below already does; naming it makes the condition evaluation
    // and the value substitution provably agree.
    const valueIn = (instance: string | undefined, nm: string): string | undefined =>
      ((instance === undefined ? undefined : overlayLayers.find((l) => l.instance === instance))?.entries.get(nm) ??
        defaultsMap.get(nm))?.value;
    // Does the `{% if %}` around a line hold for this instance? An unsupported
    // condition never holds — the caller reports it and leaves the line out,
    // rather than guessing at a comparison or a loop.
    const holds = (cond: LineCondition | undefined, instance: string | undefined): boolean =>
      cond === undefined
        ? true
        : cond.supported
          ? cond.tests.every((t) => truthyJinja(valueIn(instance, t.variable)) !== t.negated)
          : false;
    const conditionOf = (entry: Entry, conditions: Map<number, LineCondition>): LineCondition | undefined =>
      entry.source.conditional && entry.source.line !== undefined ? conditions.get(entry.source.line) : undefined;
    // Which instances render this line. `undefined` means "every one of them",
    // which is both the unconditional case and a condition that holds
    // everywhere — a row with no per-instance story to tell.
    const renderedIn = (cond: LineCondition | undefined): string[] | undefined => {
      if (cond === undefined) return undefined;
      const names = io.instances.length > 0 ? io.instances : [undefined];
      const rendering = names.filter((i) => holds(cond, i));
      return rendering.length === names.length ? undefined : (rendering as string[]);
    };
    // The definition site of a variable AS THIS INSTANCE SETS IT, so a
    // per-instance row's source points at the file that actually decides its
    // value — the overlay when it overrides, the defaults otherwise. Without
    // this an instance-specific row would send apply and verify at the base
    // file, which does not hold that value.
    const overlayEntryFor = (instance: string, nm: string): ExtractedEntry | undefined =>
      overlayLayers.find((l) => l.instance === instance)?.entries.get(nm) ?? defaultsMap.get(nm);
    const rendersSomewhere = (entry: Entry, conditions: Map<number, LineCondition>): boolean => {
      const cond = conditionOf(entry, conditions);
      if (cond === undefined) return true;
      const names = io.instances.length > 0 ? io.instances : [undefined];
      return names.some((i) => holds(cond, i));
    };

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
          // What governs each line's PRESENCE, so a conditional line can be a
          // row for the instances that render it instead of no row at all.
          conditions: jinjaConditions(t.content),
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
      // Under `rows: artifact`, each template line becomes a row and its
      // per-instance value has to be re-derived: an overlay is keyed by
      // VARIABLE, and these rows are keyed by the line.
      const artifactRows: { key: string; text: string; vars: string[]; component?: string }[] = [];
      // Every variable an artifact row consumed. Such a variable is not
      // invisible — it is the under_key of the line it renders into — so the
      // rescue below must not give it a row of its own as well.
      const consumedVars = new Set<string>();
      // Every artifact row and which instances render it, for the index check
      // after the loop (see checkRepeatIndices).
      const presence: { key: string; onlyIn?: string[] }[] = [];
      const entryKeysByVariable = new Map<string, string[]>();
      for (const { entries, structured, conditions } of read) {
        for (const entry of entries) {
          // Same rule as pass 2: under the artifact axis a conditional line
          // counts when some instance renders it; under the variable axis it
          // never counts, as before.
          if (entry.source.conditional && !(rowsArtifact && rendersSomewhere(entry, conditions))) continue;
          const variable = entry.source.templateVar;
          if (variable === undefined || !defaultsMap.has(variable)) continue;
          const keys = entryKeysByVariable.get(variable);
          if (keys) keys.push(productKeyOf(entry, structured));
          else entryKeysByVariable.set(variable, [productKeyOf(entry, structured)]);
        }
      }
      for (const [variable, keys] of entryKeysByVariable) {
        // Not a problem under the artifact axis, and saying so would be
        // misleading: a variable driving four directives yields four rows
        // there, which is the point. The warning belongs to the variable axis,
        // where one row has to stand for all of them.
        if (rowsArtifact) break;
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
      for (const { spec, file, entries, structured, conditions } of read) {
        if (spec.component !== undefined) componentLabels.set(spec.component, spec.component);
        for (const entry of entries) {
          // A line inside `{% if %}`/`{% for %}`. Under the ARTIFACT axis the
          // row IS the line, so whether it is in the deployed file is the
          // row's own existence — it is evaluated per instance, and the row
          // exists for the instances that render it. A condition the evaluator
          // does not understand, or one that holds nowhere, still leaves the
          // line out and says which line: a row claiming the file has a line it
          // may not is the failure this is avoiding, and a guess at a
          // comparison or a loop would be one.
          //
          // Under the VARIABLE axis the row is the variable, whose existence
          // does not depend on any `{% if %}`, and whose value would be the
          // same row twice if a conditional line also claimed it. Unchanged
          // there: the line is skipped, as it always has been.
          const cond = conditionOf(entry, conditions);
          if (!rowsArtifact) {
            if (cond !== undefined) {
              console.warn(`skipped (conditional — presence depends on a {% ... %} block): ${entry.key}`);
              continue;
            }
          } else if (cond !== undefined && !cond.supported) {
            console.warn(
              `skipped (presence depends on ${cond.expr}, which is not a plain {% if variable %}): ${entry.key}`
            );
            continue;
          } else if (cond !== undefined) {
            // A test variable this sheet cannot see at all. Jinja would call an
            // undefined variable falsy, and silently agreeing would drop the
            // line for a reason that has nothing to do with the template: an
            // `include:`/`exclude:` filter narrows the variables a sheet reads,
            // and the ones a template needs only in order to RENDER are exactly
            // the ones an author forgets to keep. Saying which variable turns a
            // vanished row into a one-line fix.
            const blind = cond.tests
              .map((t) => t.variable)
              .filter((v) => (io.instances.length > 0 ? io.instances : [undefined]).every((i) => valueIn(i, v) === undefined));
            if (blind.length > 0) {
              console.warn(
                `ansible recipe: sheet "${name}": ${entry.key} is inside {% if %} on ${blind.join(", ")}, which this ` +
                  `sheet does not read — add it to include: (it needs to be resolvable, not to be a row) or the line ` +
                  `is left out`
              );
              continue;
            }
          }
          const onlyIn = rowsArtifact ? renderedIn(cond) : undefined;
          if (onlyIn !== undefined && onlyIn.length === 0) {
            console.warn(`skipped (its {% if %} holds in no instance, so no environment renders it): ${entry.key}`);
            continue;
          }
          if (rowsArtifact) {
            // The row IS this line of the artifact. Its value is the line's own
            // text with each `{{ var }}` resolved, so the literal text a
            // template puts around a variable — `"…" proxied`, the quotes, the
            // path prefix in `ProxyPass "/" "{{ b }}/"` — survives into the
            // sheet, and a variable used by four lines yields four rows instead
            // of one. Both were losses the variable axis could not avoid: it
            // has one row per variable, so it has nowhere to put either.
            // Addressed the way the FILE addresses it — by structural path,
            // not the leaf. Under this axis the row IS the line, so
            // `IfModule.StartServers` is its name: that is what a reader
            // matching the sheet against the file sees, and it is the only
            // spelling that keeps two `<IfModule>` blocks with the same
            // directive apart. (`productKeyOf` keys by the leaf for a format
            // the tool does not call structured, which is right for the
            // variable axis and wrong here.)
            // The KEY is substituted too, not only the value: a format whose
            // container — or whose directive — is itself templated addresses
            // the rendered line by a name that only exists after substitution
            // (a logrotate block keyed by `{{ keycloak_home }}/data/log/…`, a
            // directive that IS a variable, as `{{ httpd_logrotate_frequency }}`
            // renders to `daily`). The row's identity is its address in the
            // RENDERED file, so it has to be rendered as well.
            const rawKey = entry.source.path ?? entry.key;
            const keySub = substituteJinja(rawKey, (n) => defaultsMap.get(n)?.value);
            const key = keySub.text;
            // And the row's heading, which for a format whose containers are
            // templated is the same string one level up (a logrotate block is
            // named by the log path it rotates). A tab reading `{{ keycloak_home
            // }}/data/log/...` names a file nobody has.
            const categoryPath = entry.categoryPath.map(
              (c) => substituteJinja(c, (n) => defaultsMap.get(n)?.value).text
            );
            // The value's variables and the key's are counted SEPARATELY. Both
            // are consumed — neither should be rescued into a row of its own —
            // but only a variable the VALUE came from can be the row's source:
            // verify asks whether the site's value still appears in the row's
            // value, and a variable that only spells the row's address (a
            // logrotate block's `{{ keycloak_home }}`) is never there.
            const valueVars = [...new Set(jinjaVariables(entry.value))];
            const vars = [...new Set([...jinjaVariables(rawKey), ...valueVars])];
            const { text, unresolved: valueUnresolved } = substituteJinja(entry.value, (n) => defaultsMap.get(n)?.value);
            const unresolved = [...keySub.unresolved, ...valueUnresolved];
            if (unresolved.length > 0) {
              console.warn(
                `ansible recipe: sheet "${name}": ${key} left unresolved (${unresolved.join(", ")}) — ` +
                  `only a plain {{ var }} and the pure filters are substituted, and a guess here would be a value ` +
                  `that looks rendered and is wrong`
              );
            }
            // The variable's own definition site, so `apply` still has
            // something it can edit — the rendered file does not exist in the
            // repository. A line mixing several variables has no single one, so
            // it points at the template and apply will hold.
            const only = valueVars.length === 1 ? defaultsMap.get(valueVars[0]) : undefined;
            for (const v of vars) consumedVars.add(v);
            const source = only ? { ...only.source, substituted: true } : { ...entry.source, file };
            if (scoped) {
              // Two units both have `Unit.Description`, and the base map is
              // keyed by the row's own name — so on a sheet covering several
              // artifacts these rows go to `embedded`, whose entries each carry
              // their component, exactly as literals already do.
              //
              // Such a row used to be flatly single-valued, which cost it the
              // instance axis twice over: a line whose variable an overlay
              // overrides was displayed at its BASE value with a warning, and a
              // line inside `{% if %}` was left out entirely. Both are the same
              // question — what does THIS instance's file say — so both are
              // answered the same way, by rendering the line once per instance.
              const perInstance = (onlyIn ?? io.instances).map((instance) => {
                const site = valueVars.length === 1 ? overlayEntryFor(instance, valueVars[0]) : undefined;
                return {
                  name: instance,
                  value: substituteJinja(entry.value, (n) => valueIn(instance, n)).text,
                  source: site ? { ...site.source, substituted: true } : { ...entry.source, file },
                };
              });
              // Collapsed back to one value when there is nothing to tell
              // apart: every instance renders the line and renders it the same.
              // A sheet that has never had a per-environment difference keeps
              // exactly the rows it had.
              const varies =
                onlyIn !== undefined || perInstance.some((i) => i.value !== perInstance[0]?.value);
              if (varies && perInstance.length > 0) {
                embedded.push({ key, value: text, source, component: spec.component, categoryPath, instances: perInstance });
              } else {
                embedded.push({ key, value: text, source, component: spec.component, categoryPath });
              }
            } else {
              bound.set(key, { value: text, source });
            }
            if (only && !scoped) keyMap.push({ boundKey: key, variable: vars[0] });
            if (spec.component !== undefined) {
              for (const v of vars) {
                const seenIn = templateOfVariable.get(v);
                templateOfVariable.set(v, seenIn === undefined ? spec.component : seenIn === spec.component ? seenIn : null);
              }
            }
            if (!scoped) artifactRows.push({ key, text: entry.value, vars, component: spec.component });
            presence.push({ key, ...(onlyIn !== undefined ? { onlyIn } : {}) });
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
            embedded.push({ key: literalKey, value: entry.value, source, component: spec.component, categoryPath: entry.categoryPath });
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
        if (rowsArtifact && consumedVars.has(variable)) continue;
        bound.set(variable, def);
      }
      baseMap = bound;

      // A repeated directive is indexed by its position IN THE TEMPLATE, where
      // every line exists. If one of them is conditional and a later sibling is
      // not, the rendered file for an instance that skips it numbers the rest
      // differently — the sheet would say `Environment[2]` for a line the file
      // has as `Environment[0]`. The indices only stay honest while the absent
      // members are a suffix of the group, which they are in the ordinary case
      // (one `{% if %}` block at the end of a run). Anything else is reported
      // rather than left to be found by diffing a rendered file.
      const groups = new Map<string, { key: string; onlyIn?: string[] }[]>();
      for (const row of presence) {
        const base = row.key.replace(/\[\d+\]$/, "");
        if (base === row.key) continue; // not one of a repeated set
        (groups.get(base) ?? groups.set(base, []).get(base)!).push(row);
      }
      for (const [base, members] of groups) {
        if (!members.some((m) => m.onlyIn !== undefined)) continue;
        for (const instance of io.instances) {
          const rendered = members.map((m) => m.onlyIn === undefined || m.onlyIn.includes(instance));
          const firstAbsent = rendered.indexOf(false);
          if (firstAbsent !== -1 && rendered.slice(firstAbsent).some(Boolean)) {
            console.warn(
              `ansible recipe: sheet "${name}": ${base} is written more than once and a conditional one comes before a ` +
                `line ${instance} does render — the [n] indices on this sheet are the template's, so they do not match ` +
                `that instance's file. Move the {% if %} block after the unconditional lines.`
            );
            break;
          }
        }
      }

      // Re-key the overlays onto the artifact's lines. An overlay says "this
      // INSTANCE sets this variable"; a row keyed by the line differs for that
      // instance exactly when one of the variables it mentions is overridden
      // there. An instance that overrides none leaves the row Pattern A, which
      // is the truth: every environment gets the same line.
      if (rowsArtifact && scoped) {
        // A SCOPED sheet's artifact rows carry their own per-instance values
        // (they are `embedded` entries with an `instances` list — see above),
        // so there is nothing to re-key. What is left is the mirror of the
        // rescue: an overlay entry for a variable an artifact row consumed must
        // not survive, or assemble's own "keys seen only in overlays" sweep
        // gives it a second row — the variable beside the line it renders into,
        // which is the duplication this axis exists to remove.
        for (const layer of overlayLayers) {
          for (const v of consumedVars) layer.entries.delete(v);
        }
      } else if (rowsArtifact) {
        for (const layer of overlayLayers) {
          const rekeyed: ExtractedMap = new Map();
          for (const row of artifactRows) {
            const overridden = row.vars.filter((v) => layer.entries.has(v));
            if (overridden.length === 0) continue;
            const { text } = substituteJinja(row.text, (n) => (layer.entries.get(n) ?? defaultsMap.get(n))?.value);
            const only = overridden.length === 1 ? layer.entries.get(overridden[0]) : undefined;
            rekeyed.set(row.key, { value: text, source: only ? { ...only.source, substituted: true } : { file: "" } });
          }
          // A variable this sheet's templates never mention stays a row of its
          // own (the rescue above keeps its base value), so its overlay entry
          // has to survive too.
          for (const [k, v] of layer.entries) if (!artifactRows.some((r) => r.vars.includes(k))) rekeyed.set(k, v);
          layer.entries = rekeyed;
        }
      }
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
