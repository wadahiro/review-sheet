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
//
//     Under `rows: artifact` the row is already keyed by the line, so keyMap
//     renames nothing there — it answers only "which variable backs this
//     line", for the under_key column and for the "is this line part of the
//     artifact" test `group_by: file` makes (assemble.ts's fileCategory). It
//     is emitted for a SCOPED sheet (`templates:` with components) as well,
//     with one restriction that scope alone creates: keyMap is one flat table
//     per sheet, so a row key two components back with DIFFERENT variables
//     (`Service.User` in two units) has no honest entry and is dropped with a
//     warning naming both. The variable taken is the one the line's VALUE came
//     from — never one that merely spells its KEY, as a logrotate block's
//     `{{ app_log_dir }}` does — and it counts whether the variable is set in
//     `defaults:` or only in an overlay: where a value is DEFINED (what apply
//     edits) and which variable backs a line are two questions.
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
//
// `baseline:` (rows: artifact only) states the delta from a vendor's shipped
// file explicitly, for the common infrastructure practice of taking the RPM's
// config, editing some values, and commenting out the rest: without it, a
// directive the vendor shipped that this project disabled has no row at all
// (visible only as an absence), and a value this project changed looks
// identical to one it inherited untouched. No comment parsing — the baseline's
// ACTIVE directives are the row set, matched by the SAME key each artifact row
// already uses (structural path, or the leaf when the format has none); see
// architecture.md for why comment-scraping was measured and refused. Per key:
// baseline AND deployed both have it -> the existing row gets `baseline` set
// alongside its `value`; baseline has it and deployed does not -> a NEW row,
// `origin: "baseline"`, value "" (nothing is in effect); deployed has it and
// baseline does not -> unchanged (this project added it). Unscoped only (a
// single `template:`) — see the "baseline" block below for why.

import { extractFile } from "../extract.js";
import { resolveParser, getParser, listParsers } from "../parser.js";
import type { Entry } from "../parser.js";
import { structuredFormat, STRUCTURED_FORMATS, parseSteps } from "../structural.js";
import {
  baseFileName,
  jinjaVariables,
  substituteJinja,
  jinjaConditions,
  jinjaLoops,
  truthyJinja,
  type LineCondition,
  type LineLoop,
} from "../jinja2.js";
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import { previewRendered, previewId, addLineKey, type LineKeys } from "../preview.js";
import type { ArtifactPreview, LangText, SourceLocation } from "../types.js";
import type {
  SheetInputs,
  ExtractedMap,
  ExtractedEntry,
  ValueLayer,
  EmbeddedEntry,
  KeyMapEntry,
} from "../assemble.js";
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
    // The DEPLOYED artifact's format, when no name can say it — the singular
    // form of `templates[].format` below. See formatOf.
    format: { type: "string" },
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
          // Which parser reads the deployed artifact, when neither the
          // template's name nor its deployed path can say. Same field and same
          // meaning as `static_files[].format`. See formatOf.
          format: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    // `static_files` deliberately does NOT take layered's shape. Its
    // per-file `substitution:` is a scope decision (T6) — unreachable from an
    // ansible sheet on purpose, guarded by a test in recipe-layered.test.ts —
    // so this one stays a narrower local schema, and narrowing is the point
    // rather than drift. Widen it only by revisiting that decision.
    //
    // `component` is not that decision and is allowed: `templates:` already
    // names a component per rendered artifact, and a sheet that compares a
    // rendered artifact against a FILE — the same product two releases apart,
    // one still a template and one recorded as it runs — needs to name the
    // file's side too. Refusing it would leave that comparison expressible
    // only by splitting the two halves across two sheets, which is the
    // comparison not happening.
    static_files: {
      type: "array",
      items: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, format: { type: "string" }, component: { type: "string" } },
        additionalProperties: false,
      },
    },
    overlays: { type: "object", additionalProperties: sourceOrListSchema },
    include: { type: "array", items: { type: "string" } },
    // Same field, same meaning as layered's: the reading order for components,
    // when the sheet's own sources cannot say it — one side a template, the
    // other a file.
    component_order: { type: "array", items: { type: "string" }, minItems: 1 },
    exclude: { type: "array", items: { type: "string" } },
    // under_key (the backing-variable column) lives in the project metadata
    // (sheet.yml's under_key:, P7): a display fact, not a data-source one.
    // assemble.ts enforces "any keyMap entry requires an under_key" at
    // assembly time, reading it off sheet.yml.
    //
    // A committed copy of what the vendor's package shipped (a distro's
    // conf.d/*.conf before this project touched it), compared against the
    // deployed artifact's row set — see the module doc's "baseline" section.
    // Valid only under `rows: artifact` (rejected otherwise below, in `load`):
    // "variable" rows have no LINE for a baseline key to be absent from, so
    // "the vendor has this and we don't" is not a fact that axis can state.
    baseline: {
      type: "object",
      required: ["file"],
      properties: { file: { type: "string" } },
      additionalProperties: false,
    },
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
type TemplateSpec = { path: string; deployedPath?: string; component?: string; format?: string };

// A template's format is the DEPLOYED artifact's format. The template's own
// name is normally a good proxy (`keycloak.conf.j2` -> `.conf`... which is
// exactly where the proxy fails: a bare `.conf` is claimed by nothing, while
// the path it lands at, `/etc/systemd/journald.conf.d/app.conf`, is
// unambiguous). Consulted only when the template name yields nothing, so no
// existing sheet changes parser.
function inferredFormat(spec: TemplateSpec): string | undefined {
  if (structuredFormat(baseFileName(spec.path)) !== null) return undefined;
  const deployed = spec.deployedPath === undefined ? null : structuredFormat(spec.deployedPath);
  return deployed === null ? undefined : deployed;
}

// …and when no name can say it, the spec does. `space` (sshd_config's
// `Key value` grammar) is the case that forces this: it is deliberately
// force-only — nothing about a file's name or content distinguishes it from
// prose — so a template deploying one is read by the `generic` fallback, which
// finds no `=` and yields NO ROWS. The variable behind a line is then rescued
// as a plain variable row and a line with no variable in it disappears with
// nothing said, which is the one outcome this tool exists to prevent.
//
// Same field, same meaning as `static_files[].format` — a template is not a
// different kind of file for having `.j2` on the end.
function formatOf(spec: TemplateSpec): string | undefined {
  return spec.format ?? inferredFormat(spec);
}

// Whether rows from this template are addressed by a structural PATH. A
// declared format answers for itself; it must NOT make a line-oriented format
// (`space`, `properties`) claim a path it has no notion of, which is what
// asking "did formatOf return anything" would have done.
function isStructured(spec: TemplateSpec, templateFile: string): boolean {
  if (structuredFormat(baseFileName(templateFile)) !== null) return true;
  const f = formatOf(spec);
  return f !== undefined && STRUCTURED_FORMATS.has(f);
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
        ...(sheetSpec.format !== undefined ? { format: checkedFormat(sheetSpec.format, name, "format") } : {}),
      },
    ];
  }
  if (many === undefined) {
    if (sheetSpec.format !== undefined) {
      throw new Error(
        `ansible recipe: sheet "${name}" declares "format" with no "template" — a format says how to read a ` +
          `template's deployed artifact, and this sheet has none. Did you mean static_files[].format?`
      );
    }
    return [];
  }
  if (sheetSpec.format !== undefined) {
    throw new Error(
      `ansible recipe: sheet "${name}" declares a sheet-wide "format" alongside "templates" — each template ` +
        `deploys a different artifact, so declare format inside each entry.`
    );
  }
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
      ...(t.format !== undefined ? { format: checkedFormat(t.format, name, "templates[].format") } : {}),
    };
  });
}

// A format that names no parser is a typo, and a typo that fell through to
// auto-detection would look like the feature simply not working — the format
// was declared precisely because detection does not reach this file.
function checkedFormat(raw: JsonValue, sheet: string, where: string): string {
  const format = asString(raw, where);
  if (getParser(format) !== undefined) return format;
  const known = listParsers()
    .map((p) => p.name)
    .sort()
    .join(", ");
  throw new Error(`ansible recipe: sheet "${sheet}" ${where}: no parser named "${format}" — known formats: ${known}`);
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
    const baselineSpec = sheetSpec.baseline as Record<string, JsonValue> | undefined;
    if (baselineSpec !== undefined && !rowsArtifact) {
      throw new Error(
        `ansible recipe: sheet "${name}" declares "baseline", which is valid only with rows: artifact — a ` +
          `"variable" row has no LINE for a vendor key to be absent from`
      );
    }

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
    // Does the `{% if %}` around a line hold for this instance? THREE answers,
    // not two — see the same function in preview.ts, which decides what a
    // preview line CLAIMS and carries the reasoning in full.
    //
    // "unknown" is a name this sheet can read no value for, and it used to be
    // spelled false: the row simply did not exist, for a reason that has
    // nothing to do with the template. A list is read through its elements,
    // because a list has no scalar value and the sheet demonstrably knows what
    // is in it — that is what the `{% for %}` in the same block renders from.
    const condState = (
      cond: Extract<LineCondition, { supported: true }>,
      instance: string | undefined
    ): "holds" | "fails" | "unknown" => {
      for (const t of cond.tests) {
        const scalar = valueIn(instance, t.variable);
        const truth =
          scalar !== undefined ? truthyJinja(scalar) : loopMembers(t.variable, instance).length > 0 ? true : undefined;
        if (truth === undefined) return "unknown";
        if (truth === t.negated) return "fails";
      }
      return "holds";
    };
    // An unsupported condition never holds — the caller reports it and leaves
    // the line out, rather than guessing at a comparison or a loop. Nor does an
    // unknown one, and the caller reports that too.
    const holds = (cond: LineCondition | undefined, instance: string | undefined): boolean =>
      cond === undefined ? true : cond.supported ? condState(cond, instance) === "holds" : false;
    const conditionOf = (entry: Entry, conditions: Map<number, LineCondition>): LineCondition | undefined =>
      entry.source.conditional && entry.source.line !== undefined ? conditions.get(entry.source.line) : undefined;
    const loopOf = (entry: Entry, loops: Map<number, LineLoop>): LineLoop | undefined =>
      entry.source.line === undefined ? undefined : loops.get(entry.source.line);

    // The members of a `{% for %}`'s list, as this sheet can see them.
    //
    // A list reaches the sheet as one entry per element, addressed by index
    // (`common_ntp_servers[0]`) — the shape a structural key transform
    // produces. Walked from 0 until the addresses run out, per instance,
    // because an overlay may give an environment a different list.
    //
    // Each member carries its OWN source. That is the point of expanding at
    // all: the line `server {{ s }} iburst` exists once in the template, but
    // the row it renders to belongs to one element of one vars file, and that
    // is where a reviewer edits it.
    //
    // A member is a SCALAR or a MAP, because a vars file writes both and the
    // template says which it expects: `{{ s }}` for a list of hostnames,
    // `{{ v.secret_name }}` for a list of maps. A map's fields arrive as their
    // own entries (`kc_vault_secrets[key=corp-ldap-bind].secret_name`), so the
    // member is the set of them and the loop variable resolves per field.
    type LoopMember = {
      // The whole member, when it IS one value. Absent for a map.
      value?: string;
      // field name -> that field's own entry. Absent for a scalar.
      fields?: Map<string, { value: string; source: SourceLocation }>;
      // The field the FORMAT folded into the element's address to identify it
      // (`secrets[name=app/corp]` -> name = app/corp). It has no entry of its
      // own — the address is where it went — so it resolves for rendering and
      // can never be a row's site: there is no line to point at, and inventing
      // one is the thing this module refuses everywhere else.
      identifier?: { field: string; value: string };
      // Where the member is written. A scalar has one site; a map has one per
      // field, and which of them a row points at depends on which the line
      // consumed — see the expansion below.
      source: SourceLocation;
    };
    const loopMembers = (list: string, instance: string | undefined): LoopMember[] => {
      const read = (nm: string) => (instance === undefined ? defaultsMap.get(nm) : overlayEntryFor(instance, nm));
      const out: LoopMember[] = [];
      for (let i = 0; ; i++) {
        const hit = read(`${list}[${i}]`);
        if (hit === undefined) break;
        out.push({ value: hit.value, source: hit.source });
      }
      if (out.length > 0) return out;
      // Map elements. Their addresses are the parser's, not this module's — a
      // YAML list of maps is keyed by an identifying field where the format has
      // one (`[key=corp-ldap-bind]`) and by index otherwise — so they are read
      // off the map in file order rather than counted up from 0. Grouped by the
      // element's own address, which is everything before the first `.` after
      // the bracket.
      const byElement = new Map<string, Map<string, { value: string; source: SourceLocation }>>();
      const head = new RegExp(`^(${list.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\[[^\\]]*\\])\\.(.+)$`);
      const names = instance === undefined ? [...defaultsMap.keys()] : [...new Set([...defaultsMap.keys(), ...(overlayLayers.find((l) => l.instance === instance)?.entries.keys() ?? [])])];
      for (const nm of names) {
        const m = head.exec(nm);
        if (!m) continue;
        const hit = read(nm);
        if (hit === undefined) continue;
        const fields = byElement.get(m[1]) ?? new Map<string, { value: string; source: SourceLocation }>();
        // Only a member's OWN fields, never a nested map's: `v.a.b` is a shape
        // the substitution below does not resolve, and admitting it here would
        // make the member look complete when a line using it cannot render.
        if (!m[2].includes(".")) fields.set(m[2], { value: hit.value, source: hit.source });
        byElement.set(m[1], fields);
      }
      for (const [addr, fields] of byElement) {
        const first = [...fields.values()][0];
        if (first === undefined) continue;
        const last = parseSteps(addr).at(-1);
        out.push({
          fields,
          ...(last?.kind === "filter" ? { identifier: { field: last.field, value: last.value } } : {}),
          source: first.source,
        });
      }
      return out;
    };
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

    // What Ansible's template module injects when it WRITES the file. No vars
    // file could hold these and none is missing — so a line left unrendered by
    // one of them is not the sheet admitting a gap, and must not be counted as
    // one. Declared here, as a list, rather than pattern-matched: the allowance
    // has to be narrow and named, or a typo'd variable becomes benign too.
    // https://docs.ansible.com/ansible/latest/collections/ansible/builtin/template_module.html
    const DEPLOY_TIME_VARS = new Set([
      "ansible_managed",
      "template_host",
      "template_uid",
      "template_path",
      "template_fullpath",
      "template_run_date",
      "template_destpath",
    ]);
    // …except `ansible_managed`, which IS knowable. A project states it in
    // ansible.cfg, and when it does not, Ansible's own documented default
    // applies — `ansible-config dump` calls it DEFAULT_MANAGED_STR and prints
    // `Ansible managed`. That is a product fact of exactly the kind this
    // project reads out of a registry rather than guesses at, and it is the
    // FIRST line of every generated file, so leaving it raw put a `{{ }}` at
    // the top of every preview.
    //
    // Unless it carries python-format placeholders (`Ansible managed on {host}`
    // — Ansible substitutes those itself, per host, at deploy time). Those
    // cannot be known here, so such a value is left unresolved rather than
    // printed with its braces showing.
    const ANSIBLE_MANAGED_DEFAULT = "Ansible managed";
    const ansibleManaged = ((): string | undefined => {
      let declared: string | undefined;
      for (const p of ["ansible.cfg", "../ansible.cfg", "../../ansible.cfg"]) {
        const cfg = io.readFile(io.resolve(p));
        if (cfg === null) continue;
        const m = /^\s*ansible_managed\s*=\s*(.*)$/m.exec(cfg);
        if (m) {
          declared = m[1].trim();
          break;
        }
      }
      const value = declared ?? ANSIBLE_MANAGED_DEFAULT;
      return /\{[a-z_]+\}/.test(value) ? undefined : value;
    })();

    // static_files' own previews (the layered core reads committed files, which
    // need no rendering) plus this recipe's rendered templates, below. Each
    // template's rendering itself goes through `previewRendered` (src/preview.ts),
    // the same engine every artifact row's value comes from — which is what
    // makes it cheap AND what makes it honest: a line with no Jinja on it IS
    // the deployed line, by identity, so every comment and every blank line
    // comes through untouched.
    const artifacts: ArtifactPreview[] = [...(core.artifacts ?? [])];

    const embedded: EmbeddedEntry[] = [...core.embedded]; // static_files' embedded entries
    const keyMap: KeyMapEntry[] = [];
    // Every variable the template(s) interpolate, filled by pass 1 — see the
    // return, and SheetInputs.templateVariables.
    const templateVariables: string[] = [];
    // The same fact in the ARTIFACT axis's namespace: the row keys pass 1 saw a
    // variable go into. See SheetInputs.variableBackedKeys.
    const variableBackedRowKeys: string[] = [];
    // Candidate row-key -> variable pairs, resolved into `keyMap` once every
    // template has been read. Collected rather than pushed directly because a
    // SCOPED sheet can produce the same row key twice — `Unit.Description`
    // exists in every unit — while keyMap is one flat table per sheet
    // (assemble.ts builds `boundToVariable` from it without a component). A key
    // two components back with DIFFERENT variables therefore has no honest
    // entry, and is dropped with a warning: the same rule this module already
    // applies to one variable backing several directives, applied along the
    // other axis.
    const keyMapCandidates: { key: string; variable: string; component?: string }[] = [];
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
          // answer: `journald-app.conf.j2` is a bare `.conf`, which is
          // far too common a suffix to claim, while the artifact it becomes —
          // `/etc/systemd/journald.conf.d/app.conf` — says exactly
          // what it is. The template name stays the SOURCE either way; only the
          // parser choice moves.
          content: t.content,
          // A DECLARED format is stamped onto every source this template
          // produces. Extraction already knows it (baseFormat, below), but
          // verify/apply resolve their parser from the FILE — and the reason a
          // format had to be declared is that the file does not answer. A
          // force-only format (`space`) is never detected, so without this the
          // row is written by one parser and read back by another.
          //
          // Only `spec.format`, never the inferred one: where detection works
          // this field would be a copy of what the filename already says, on
          // every source of every project.
          entries: extractFile(t.content, t.file, undefined, { ...io.extractOptions, baseFormat: formatOf(spec) }).map(
            (e) => (spec.format === undefined ? e : { ...e, source: { ...e.source, baseFormat: spec.format } })
          ),
          // What governs each line's PRESENCE, so a conditional line can be a
          // row for the instances that render it instead of no row at all.
          conditions: jinjaConditions(t.content),
          // What each line inside a `{% for %}` repeats over, so one template
          // line can become the several lines of the deployed file it renders
          // to — see the expansion below.
          loops: jinjaLoops(t.content),
          // A `.j2` resolves to its base format by name (realm-corp.json.j2 ->
          // .json), which is also what decides whether a row's identity is its
          // path or its leaf — see productKeyOf.
          structured: isStructured(spec, t.file),
        };
      });

      // A template that yielded NOTHING is reported, always. It is not a
      // sheet-shaped statement — "this artifact has no settings" — it is the
      // shape of a template no parser could read: the artifact falls to the
      // `generic` fallback, which finds no `=`/`:`, and every literal line
      // disappears while every variable-backed one comes back as a plain
      // variable row. A sheet of nothing but such lines used to build clean and
      // EMPTY, reporting `0 ok, 0 warn, 0 error` over a review document with no
      // rows in it — the one outcome this tool exists to prevent, reached
      // without a single message.
      //
      // A warning rather than an error: a template really can be all comments,
      // or all `{% if %}` lines that render in no instance (each of which
      // already says so on its own line). Naming the format that WAS used is
      // what turns this from "odd" into a one-line fix, since the answer is
      // almost always `format:`.
      for (const r of read) {
        if (r.entries.length > 0) continue;
        const used = formatOf(r.spec) ?? resolveParser(baseFileName(r.file), r.content)?.name ?? "generic";
        console.warn(
          `ansible recipe: sheet "${name}": ${r.spec.path} produced no rows — it was read as "${used}". ` +
            `If that is the wrong format for what it deploys, declare the right one ` +
            `(templates[].format / format:); a force-only format like "space" is never detected.`
        );
      }

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
      // template path -> (1-based template line -> the row that line is). Both
      // directions of the preview panel hang off this: a row finds its place in
      // the file, and a line finds the row that reviews it.
      const keyAtLine = new Map<string, LineKeys>();
      const rowAtLine = (templatePath: string, line: number | undefined, key: string, member = 0): void => {
        const perFile = keyAtLine.get(templatePath) ?? new Map<number, string[]>();
        addLineKey(perFile, line, key, member);
        keyAtLine.set(templatePath, perFile);
      };
      // Filled by pass 1 below and handed to the model — see the return.
      const entryKeysByVariable = new Map<string, string[]>();
      // The mirror of it. A directive can be driven by SEVERAL variables —
      // `db-url=jdbc:postgresql://{{ db_host }}:5432/{{ db_name }}` — and then
      // no one of them can be named after it either: the row would carry the
      // directive's name and one variable's value, saying `db-url = db.internal`.
      // That is the same misrepresentation the many-directives case is refused
      // for, seen from the other side, and it was the one direction nothing
      // checked.
      const variablesByEntryKey = new Map<string, Set<string>>();
      for (const { entries, structured, conditions } of read) {
        for (const entry of entries) {
          // Same rule as pass 2: under the artifact axis a conditional line
          // counts when some instance renders it; under the variable axis it
          // never counts, as before.
          if (entry.source.conditional && !(rowsArtifact && rendersSomewhere(entry, conditions))) continue;
          // EVERY variable the line's value interpolates, not just
          // `source.templateVar`. That field is the parser's answer to "which
          // variable IS this value" and it takes the FIRST one, which is a
          // claim a mixed line cannot keep: on
          // `db-url=jdbc:…{{ db_host }}:5432/{{ db_name }}` it names db_host
          // and says nothing at all about db_name. Counting from it made a
          // two-variable line look like a 1:1 line whose second variable the
          // template never mentions.
          const lineVars = [...new Set(jinjaVariables(entry.value))].filter((v) => defaultsMap.has(v));
          if (lineVars.length === 0) continue;
          const productKey = productKeyOf(entry, structured);
          for (const variable of lineVars) {
            const keys = entryKeysByVariable.get(variable);
            if (keys) keys.push(productKey);
            else entryKeysByVariable.set(variable, [productKey]);
          }
          const vars = variablesByEntryKey.get(productKey) ?? new Set<string>();
          if (vars.size === 0) variableBackedRowKeys.push(productKey);
          for (const variable of lineVars) vars.add(variable);
          variablesByEntryKey.set(productKey, vars);
        }
      }
      templateVariables.push(...entryKeysByVariable.keys());
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
      // ...and the same, said from the directive's side, so a line mixing
      // variables is reported once rather than once per variable.
      if (!rowsArtifact) {
        for (const [entryKey, backers] of variablesByEntryKey) {
          if (backers.size < 2) continue;
          console.warn(
            `keyed by variable (not 1:1): ${entryKey} is built from ${[...backers].join(", ")} -> each filed under its own name`
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
      for (const { spec, file, entries, structured, conditions, loops } of read) {
        // The heading a reader wants is the file on the host, not the id this
        // spec files rows under: `logrotate-httpd` is the template's name,
        // `/etc/logrotate.d/httpd` is the thing being reviewed. The id stays
        // the category's identity — bindings, per-component params and every
        // diff join key still read it — and only the display changes.
        if (spec.component !== undefined) componentLabels.set(spec.component, spec.deployedPath ?? spec.component);
        // A `{% for %}` renders ONE template line as several lines of the
        // deployed file, so the entry read from the template stands for a row
        // per member of the list. Expanded here, before anything else looks at
        // it: downstream every one of them is an ordinary line whose value
        // happens to come from one element of a vars file, which is a relation
        // the model already has.
        //
        // Only under the ARTIFACT axis, where a row IS a line. Under the
        // variable axis the row is the variable, and the list is already one
        // row — expanding would file the same value twice.
        // The entries this loop expansion produced. A row's ADDRESS is where
        // its line lands in the deployed file; its SOURCE is where the value is
        // written, which for a loop member is an element of a vars file. Both
        // live on the entry, and the address must not be read off the source —
        // doing so named these rows after the list they came from.
        const expandedFromLoop = new Set<Entry>();
        // How far a repeated key's occurrence number has been pushed by the
        // loops before it. A parser numbers repeats as it reads them
        // (`--region[0]`, `--region[1]`); expanding one occurrence into three
        // moves every later one along by two, exactly as the rendered file
        // reads. `undefined` means "leave the key alone", which is the ordinary
        // case: a key that occurs once carries no number to move.
        const indexShift = new Map<string, number>();
        // Entries whose key was renumbered for the RENDERED file. Their
        // `source.path` still addresses the template, where the occurrence
        // number is the one the template has — the two legitimately differ, and
        // the row's identity is the rendered file's.
        const renumbered = new Set<Entry>();
        const splitIndex = (key: string): { base: string; index: number; bare: boolean } | undefined => {
          const m = /^(.*)\[(\d+)\]$/.exec(key);
          return m ? { base: m[1], index: Number(m[2]), bare: false } : { base: key, index: 0, bare: true };
        };
        // The key an expanded row takes: the base's own occurrence number, plus
        // this member's position among the elements, in the parser's own
        // spelling (a first occurrence some formats write bare).
        const renumber = (boundKey: string, member: number): string | undefined => {
          const at = splitIndex(boundKey);
          if (at === undefined) return undefined;
          const n = at.index + (indexShift.get(at.base) ?? 0) + member;
          return n === 0 && at.bare ? undefined : `${at.base}[${n}]`;
        };
        // The TEMPLATE line an expanded row came from. Its source now points at
        // the vars file element — which is where the value is written — but the
        // preview links a row to the line of the template it renders, and that
        // line is the only thing that can still be pointed at.
        const expandedAtLine = new Map<Entry, number | undefined>();
        // Which element of the list a row is. The preview writes the body once
        // per element, and each copy carries its own row's key.
        const expandedMember = new Map<Entry, number>();
        const expanded: Entry[] = [];
        for (const entry of entries) {
          const loop = rowsArtifact ? loopOf(entry, loops) : undefined;
          if (loop === undefined) {
            // A later occurrence of a key a loop above it multiplied. The
            // rendered file counts every copy, so this one is no longer the
            // occurrence the template made it.
            const at = splitIndex(entry.key);
            const moved = at !== undefined && (indexShift.get(at.base) ?? 0) > 0;
            if (!moved) {
              expanded.push(entry);
              continue;
            }
            const shifted = { ...entry, key: `${at!.base}[${at!.index + indexShift.get(at!.base)!}]` };
            renumbered.add(shifted);
            expanded.push(shifted);
            continue;
          }
          if (!loop.supported) {
            console.warn(`skipped (inside ${loop.expr}, which is not a plain {% for name in list %}): ${entry.key}`);
            continue;
          }
          // The list as the DEFAULTS see it decides how many rows there are.
          // An overlay that gives one environment a longer list is a real
          // difference, and it is reported rather than silently producing rows
          // for one environment only: a per-instance row SET is a shape the
          // artifact axis does not have (Pattern B varies a value, not the
          // existence of a line), so agreeing on the length is the honest
          // requirement.
          const members = loopMembers(loop.list, undefined);
          if (members.length === 0) {
            console.warn(
              `ansible recipe: sheet "${name}": ${entry.key} repeats over ${loop.list}, which this sheet reads no ` +
                `elements of — add it to include: (it needs to be resolvable, not to be a row) or the lines are left out`
            );
            continue;
          }
          for (const inst of io.instances) {
            const n = loopMembers(loop.list, inst).length;
            if (n !== members.length) {
              console.warn(
                `ansible recipe: sheet "${name}": ${loop.list} has ${members.length} element(s) in the defaults and ` +
                  `${n} in ${inst} — the rows this loop renders are taken from the defaults, so ${inst}'s extra or ` +
                  `missing lines are not on the sheet`
              );
            }
          }
          // The list's elements are now lines of the artifact. Left in the
          // base map as well, each would be a second row for the same setting —
          // one under the file it renders into and one under the variable it is
          // written as — which is the duplication the artifact axis exists to
          // avoid.
          members.forEach((m, i) => {
            if (m.fields === undefined) consumedVars.add(`${loop.list}[${i}]`);
            // A map member's fields are its rows-that-would-have-been, each
            // under its own address, so every one of them has to be spoken for.
            else for (const f of m.fields.values()) if (f.source.path !== undefined) consumedVars.add(f.source.path);
          });
          members.forEach((m, i) => {
            // The loop variable resolves to THIS member; everything else keeps
            // resolving as it did. Substituted into the key as well as the
            // value, because a templated directive addresses the rendered line
            // by a name that only exists after substitution.
            // What each name in the template resolves to. The loop variable
            // itself for a scalar member; one of the member's fields for a map;
            // the field the format folded into the element's ADDRESS to
            // identify it (which renders and has no site of its own, the
            // address being where it went); and anything else the way every
            // other line resolves it.
            const memberSite = (nm: string): SourceLocation | undefined => {
              if (nm === loop.variable) return m.source;
              if (m.fields !== undefined && nm.startsWith(`${loop.variable}.`)) {
                return m.fields.get(nm.slice(loop.variable.length + 1))?.source;
              }
              return defaultsMap.get(nm)?.source;
            };
            const bind = (t: string): string =>
              substituteJinja(t, (nm) => {
                if (nm === loop.variable) return m.value;
                if (m.fields !== undefined && nm.startsWith(`${loop.variable}.`)) {
                  const field = nm.slice(loop.variable.length + 1);
                  const f = m.fields.get(field);
                  if (f !== undefined) return f.value;
                  return m.identifier?.field === field ? m.identifier.value : undefined;
                }
                return defaultsMap.get(nm)?.value;
              }).text;
            const boundKey = bind(entry.key);
            const boundCategories = entry.categoryPath.map(bind);
            const boundValue = bind(entry.value);
            // The site the row POINTS AT: the first thing its VALUE
            // interpolated that has a definition site. Deterministic, and the
            // same rule the ordinary path uses a few hundred lines below for a
            // line composed of several variables — which is what a loop line
            // is too, once the member's fields are among them.
            //
            // Not the template line. The row's value is the RENDERED line and
            // the template holds `{{ … }}`, so verify would search rendered
            // text in an unrendered file and every such row would fail. Only a
            // line that interpolated nothing resolvable keeps it, and such a
            // line is literal, so the check holds.
            // A loop line is rendered from the DEFAULTS, members and ordinary
            // variables alike — the same choice the member count already makes
            // ("the list as the defaults see it decides how many rows there
            // are"). An overlay that overrides one of those variables is then a
            // difference the row does not show, so it is said out loud rather
            // than left to be discovered by reading the host.
            for (const nm of jinjaVariables(entry.value)) {
              if (nm === loop.variable || nm.startsWith(`${loop.variable}.`)) continue;
              const base = defaultsMap.get(nm)?.value;
              const differs = io.instances.filter((inst) => overlayEntryFor(inst, nm)?.value !== base);
              if (differs.length > 0 && i === 0) {
                console.warn(
                  `ansible recipe: sheet "${name}": ${boundKey} repeats over ${loop.list} and interpolates ${nm}, ` +
                    `which ${differs.join("/")} override(s) — a line inside a loop is rendered from the defaults, so ` +
                    `the row shows ${JSON.stringify(base)} for every environment`
                );
              }
            }
            const siteOf = jinjaVariables(entry.value).map(memberSite).find((x) => x !== undefined);
            const site =
              siteOf === undefined
                ? entry.source
                : {
                    ...siteOf,
                    // The row's value is the whole rendered line and this site
                    // holds only the member inside it — the relation the model
                    // already has for a value substituted into a template's text.
                    substituted: true,
                  };
            const made: Entry = {
              ...entry,
              key: boundKey,
              value: boundValue,
              categoryPath: boundCategories,
              // The member's own definition site. The template line is where
              // the STRUCTURE is; this is where the value a reviewer would
              // change lives, which is what verify reads back and apply writes.
              // The member's site, WHOLE — not merged over the template
              // entry's. The site is in another file, read by another format,
              // and inheriting the template's `baseFormat` sent verify at a
              // vars file with the config parser the template declared.
              //
              // Its address travels with it: a substituted row is verified by
              // resolving the site structurally and comparing by containment,
              // so `common_ntp_servers[0]` is how verify reaches the element at
              // all. What it must not become is the row's own name — see
              // `expandedFromLoop` at the key below.
              source: site,
              // Its own address, so two members of one list are two rows — and
              // the address is the one the DEPLOYED FILE has, continuing the
              // occurrence numbering the parser gives that file. A template
              // whose `--secret-id` is the second occurrence, repeated over two
              // elements, is `--secret-id[1]` and `--secret-id[2]` in the
              // rendered script, and a key no parse of that file can produce is
              // a row identity re-based onto another document.
              //
              // The element's own stable identity is not lost: it is the row's
              // SOURCE (`secret_list[key=corp-ldap-bind].secret_name`), which
              // addresses the vars file, where the element genuinely is the
              // identity — and which is where apply writes and verify reads.
              // Keying by it here was aimed at the right fact and the wrong
              // field: a review comment names a place in the file under review,
              // and inserting an element really does change what stands at that
              // place.
              ...(renumber(boundKey, i) === undefined ? {} : { key: renumber(boundKey, i)! }),
            };
            expandedFromLoop.add(made);
            expandedAtLine.set(made, entry.source.line);
            expandedMember.set(made, i);
            expanded.push(made);
          });
          // n elements where the template had one occurrence: everything after
          // it is n-1 further along in the rendered file.
          const base = splitIndex(entry.key)?.base;
          if (base !== undefined) indexShift.set(base, (indexShift.get(base) ?? 0) + members.length - 1);
        }
        for (const entry of expanded) {
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
          // A row the loop MADE is not a row the loop conditions: its existence
          // was already decided, one row per element. Without this a row that
          // fell back to the template line as its source — the line sits inside
          // the `{% for %}`, so it is marked conditional — read as "presence
          // depends on {% for %}, which is not a plain {% if variable %}" and
          // was dropped. Rows sourced at their member never reached here
          // either, for the accidental reason that a vars file line carries no
          // such mark; this says it on purpose.
          const cond = expandedFromLoop.has(entry) ? undefined : conditionOf(entry, conditions);
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
              // A LIST has no scalar value and is not blind for that: the sheet
              // reads it through its elements, which is what the `{% for %}` in
              // the same block renders from. Asking only for a scalar reported
              // a variable the sheet demonstrably knows, and dropped every row
              // inside `{% if the_list %}`.
              .filter((v) =>
                (io.instances.length > 0 ? io.instances : [undefined]).every(
                  (i) => valueIn(i, v) === undefined && loopMembers(v, i).length === 0
                )
              );
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
            const rawKey = expandedFromLoop.has(entry) || renumbered.has(entry) ? entry.key : (entry.source.path ?? entry.key);
            const keySub = substituteJinja(rawKey, (n) => defaultsMap.get(n)?.value);
            const key = keySub.text;
            // And the row's heading, which for a format whose containers are
            // templated is the same string one level up (a logrotate block is
            // named by the log path it rotates). A tab reading `{{ keycloak_home
            // }}/data/log/...` names a file nobody has.
            const sub = (t: string): string => substituteJinja(t, (n) => defaultsMap.get(n)?.value).text;
            const categoryPath = entry.categoryPath.map(sub);
            // And the CHAIN, which is the same names a third time. The row's
            // key is substituted above and the chain has to address the same
            // blocks it does — a chain still reading `{{ keycloak_home }}` is
            // no longer a prefix of the key it belongs to. Exactly the leak the
            // template parser had for its own three copies, one layer up.
            const containers = entry.containers?.map((n) => {
              const subject = n.subject === undefined ? undefined : sub(n.subject);
              // A block whose name the template ASSEMBLES from variables has no
              // single place holding the result: the template writes
              // `{{ app_log_dir }}/*.log` and the deployed file will say
              // `/var/log/app/*.log`, and neither file contains the other. An
              // ordinary row answers this by pointing at the variable instead;
              // a block cannot, because its identity is the whole expression
              // rather than any one variable in it. So it carries no definition
              // site — which is what this tool does everywhere it cannot answer
              // honestly, and costs nothing here, since apply holds a block
              // regardless and the jump into the preview is indexed by line
              // rather than by source.
              const assembled = subject !== undefined && subject !== n.subject;
              return {
                ...n,
                file,
                ...(assembled ? { subjectAssembled: true } : {}),
                ...(n.name === undefined ? {} : { name: sub(n.name) }),
                ...(subject === undefined ? {} : { subject }),
                pathSeg: sub(n.pathSeg),
                headings: n.headings.map(sub),
              };
            });
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
            // The single variable this line's VALUE came from, if there is
            // one. A line mixing several has none, and neither does a line
            // whose only variable spells its KEY (a logrotate block's
            // `{{ keycloak_home }}`) — see the comment above.
            const onlyVar = valueVars.length === 1 ? valueVars[0] : undefined;
            // The site the row POINTS AT. Not `onlyVar`: that one answers "which
            // variable may be shown under this row", which a line mixing several
            // cannot answer honestly — but `substituted` asks something weaker
            // and answerable, "the value at this site is PART of this line"
            // (types.ts's SourceLocation.substituted), and that holds for every
            // variable the line interpolates.
            //
            // It has to point at one of them. Pointing at the TEMPLATE instead
            // is what a multi-variable line used to do, and that claim is false
            // by construction: the row's value is the RENDERED line and the
            // template holds `{{ … }}`, so verify searched the rendered text in
            // an unrendered file and every such row failed —
            // `db-url=jdbc:postgresql://{{ a }}:5432/{{ b }}` could not be put
            // on a sheet at all. The first value variable that has a definition
            // site is deterministic and gives verify a real check; apply holds
            // on `substituted` either way, which is also right, since which
            // part of a composed line a reviewer meant is not knowable.
            const siteVar = valueVars.find((v) => defaultsMap.get(v) !== undefined);
            const only = siteVar !== undefined ? defaultsMap.get(siteVar) : undefined;
            for (const v of vars) consumedVars.add(v);
            // An entry that already carries a file is one this recipe EXPANDED:
            // a `{% for %}` member's row, whose site is the element in the vars
            // file rather than the template line the structure came from. Its
            // own site wins — recomputing here would send verify at the
            // template, which holds `{{ s }}` and not the rendered line.
            const source = only
              ? { ...only.source, substituted: true }
              : { ...entry.source, file: entry.source.file ?? file };
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
                // Same rule per instance, and asked per instance: which
                // variable an overlay overrides is what makes this row differ
                // between environments, so the site is the first one THIS
                // instance actually defines rather than a choice made once for
                // all of them.
                const site = valueVars.reduce<ReturnType<typeof overlayEntryFor>>(
                  (found, v) => found ?? overlayEntryFor(instance, v),
                  undefined
                );
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
                embedded.push({ key, value: text, source, component: spec.component, categoryPath, containers, instances: perInstance, ...(entry.presence ? { presence: true as const } : {}) });
              } else {
                embedded.push({ key, value: text, source, component: spec.component, categoryPath, containers, ...(entry.presence ? { presence: true as const } : {}) });
              }
            } else {
              bound.set(key, { value: text, source });
            }
            // `onlyVar`, not `only`: the under_key column asks WHICH variable
            // backs this line, which is answerable for a variable an overlay
            // alone sets even though there is no base site for apply to edit.
            // And not `vars[0]`, which is the KEY's variable whenever the key
            // is templated too — the row's value is what the column is about.
            if (onlyVar !== undefined) keyMapCandidates.push({ key, variable: onlyVar, component: spec.component });
            if (spec.component !== undefined) {
              for (const v of vars) {
                const seenIn = templateOfVariable.get(v);
                templateOfVariable.set(v, seenIn === undefined ? spec.component : seenIn === spec.component ? seenIn : null);
              }
            }
            if (!scoped) artifactRows.push({ key, text: entry.value, vars, component: spec.component });
            presence.push({ key, ...(onlyIn !== undefined ? { onlyIn } : {}) });
            // Which line of which template this row IS, so the preview can
            // point back at it and the sheet can point into the preview.
            rowAtLine(
              spec.path,
              expandedFromLoop.has(entry) ? expandedAtLine.get(entry) : entry.source.line,
              key,
              expandedMember.get(entry) ?? 0
            );
            // And the BLOCKS around it, at the lines that open them. A block is
            // a row with a real line in this file, so it gets the same jump
            // both ways as any other row — without this it was the one row on
            // the sheet that could not show you where it is.
            (containers ?? []).forEach((n, i) => {
              if (n.subject === undefined) return;
              rowAtLine(spec.path, n.line, (containers ?? []).slice(0, i + 1).map((x) => x.pathSeg).join("."));
            });
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
            // 1:1 in BOTH directions, or the row's name is a claim it cannot
            // keep. One variable driving four directives has no single key to
            // take; one directive driven by two variables has no single
            // variable to give its key to, and handing it to either produces a
            // row named `db-url` whose value is a hostname.
            const backers = variablesByEntryKey.get(productKeyOf(entry, structured));
            if (unique.size === 1 && (backers?.size ?? 1) === 1) {
              keyMap.push({ boundKey: productKeyOf(entry, structured), variable });
            }
            // The VARIABLE axis has a place in the file too, and its row wants
            // the same context an artifact row does — `db-url-host` is judged
            // by the `db` and `db-url-database` lines around it. The row is
            // named for the product key when the variable earned one and for
            // the variable itself when it did not, which is exactly what
            // `resolveKey` decides from `keyMap`. Several lines can map to one
            // row (a variable driving four directives), which is the truth.
            rowAtLine(spec.path, entry.source.line, unique.size === 1 ? productKeyOf(entry, structured) : variable);
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
            embedded.push({ key: literalKey, value: entry.value, source, component: spec.component, categoryPath: entry.categoryPath, containers: entry.containers, ...(entry.presence ? { presence: true as const } : {}) });
            rowAtLine(spec.path, entry.source.line, literalKey);
            continue;
          }
          // Keyed by the full structural path, not the leaf name (entry.key) —
          // a nested/blocked format (nginx's `http.include` vs.
          // `http.server.include`) repeats leaf names across containers, and
          // keying by the leaf alone silently collided one over the other. Same
          // convention "layered"'s static_files and this recipe's own
          // "source"-only (no template) embedded path already use.
          bound.set(literalKey, { value: entry.value, source, origin: "embedded" });
          rowAtLine(spec.path, entry.source.line, literalKey);
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

      // baseline: the vendor's shipped file, compared against the deployed
      // artifact's row set (`presence`, one entry per template line that
      // became a row — see the module doc's "baseline" section and
      // architecture.md). Deliberately unscoped-only (`scoped` false, i.e. a
      // single `template:`, not `templates:`): one baseline file can only
      // honestly answer for one deployed file, and a sheet covering several
      // (`templates:`) would need to say which one each vendor key belongs to,
      // which nothing here decides.
      if (baselineSpec !== undefined) {
        if (scoped) {
          throw new Error(
            `ansible recipe: sheet "${name}" declares "baseline" together with several templates/components — ` +
              `baseline compares one vendor file against one deployed file; use a single "template:" instead`
          );
        }
        const spec = specs[0];
        // The template's own text, for the commented-line search below. `read`
        // holds it already — this sheet has exactly one entry (unscoped).
        const templateText = read[0].content;
        const baselineFile = asString(baselineSpec.file, "baseline.file");
        const { file: resolvedBaselineFile, content: baselineContent } = readRequired(
          io,
          baselineFile,
          `sheet "${name}"'s baseline file`
        );
        // Read with the parser the DEPLOYED artifact resolves to, not the one
        // the baseline's own filename suggests. A pinned vendor copy is named
        // for its package version (`httpd.conf@httpd-2.4.37-43.module+el8…`),
        // which no format detection recognises — it fell through to the generic
        // key=value parser and produced ZERO entries, which the zero-overlap
        // warning then correctly called "almost certainly the wrong file". It
        // was the right file read the wrong way. `formatOf` cannot help here
        // either: it only answers for STRUCTURED formats (yaml/json/xml/toml),
        // and httpd is not one.
        //
        // The baseline IS the deployed artifact, one revision back, so the
        // deployed path is the honest witness to its format.
        const baselineFormat = resolveParser(spec.deployedPath ?? baseFileName(spec.path), baselineContent)?.name as
          | Parameters<typeof extractFile>[2]
          | undefined;
        // No jinja2 masking needed: the vendor's file is never a template.
        const baselineEntries = extractFile(baselineContent, resolvedBaselineFile, baselineFormat, {
          ...io.extractOptions,
          baseFormat: formatOf(spec),
        });
        // Same addressing as an artifact row's own key (rawKey above, minus
        // the jinja substitution a vendor file never needs): the structural
        // path when the format has one, the leaf otherwise — so a baseline key
        // and a deployed row's key are directly comparable strings.
        const baselineKeyOf = (entry: Entry): string => entry.source.path ?? entry.key;
        const baselineMap = new Map<string, Entry>();
        for (const entry of baselineEntries) baselineMap.set(baselineKeyOf(entry), entry);
        const deployedKeys = new Set(presence.map((p) => p.key));

        let unchangedCount = 0;
        let changedCount = 0;
        for (const [key, entry] of baselineMap) {
          if (!deployedKeys.has(key)) continue;
          const row = bound.get(key);
          if (!row) continue; // scoped only, guarded above — never hit here
          row.baseline = entry.value;
          if (row.value === entry.value) unchangedCount++;
          else changedCount++;
        }
        const addedCount = [...deployedKeys].filter((k) => !baselineMap.has(k)).length;
        // Every vendor key the deployed artifact does not have: a NEW row,
        // `origin: "baseline"` — "the vendor shipped this and we do not have
        // it" — value "", the vendor's value recorded on `baseline`. Filed
        // under the vendor file's own container structure (categoryPath),
        // the same last-resort rank a materialized row's fallback gets.
        const missing = [...baselineMap].filter(([k]) => !deployedKeys.has(k));
        // Where the deployed file COMMENTED it out, if it did. A disabled
        // directive is usually still in the file with a `#` in front of it, and
        // that line is the place a reviewer wants to see — with whatever comment
        // the author left above it saying why.
        //
        // Found by exact text, not by parsing comments: the baseline's own line,
        // trimmed, against each template line with its comment marker stripped
        // and trimmed. This is the narrow, safe version of the thing this design
        // otherwise refuses — nothing here DECIDES whether a comment is a
        // directive, it looks for one known string. A line the author reworded
        // while disabling it simply does not match, and the row keeps its
        // meaning with no preview line, which is honest.
        const baselineLines = baselineContent.split("\n");
        const templateLines = templateText.split("\n");
        const disabledLine = (line: number | undefined): number | undefined => {
          const want = (baselineLines[(line ?? 0) - 1] ?? "").trim();
          if (want === "") return undefined;
          const at = templateLines.findIndex((l: string) => {
            const t = l.trim();
            return t.startsWith("#") && t.replace(/^#+\s*/, "").trim() === want;
          });
          return at === -1 ? undefined : at + 1;
        };
        const disabledAt = new Map<string, number>();
        for (const [key, entry] of missing) {
          const at = disabledLine(entry.source.line);
          if (at !== undefined) disabledAt.set(key, at);
        }
        // The BLOCK that holds them, by its own opening line. A container row is
        // synthesized downstream (assembleSheets' containerDrafts, from these
        // entries' `containers`), so nothing else here would ever anchor it —
        // and the block's three settings landing in the preview while the
        // `<Directory>` line above them did not was the visible half of that.
        // Same address the assembler builds, same exact-text rule, and only for
        // a node it will actually emit a row for (one carrying a subject).
        for (const [, entry] of missing) {
          const chain = entry.containers ?? [];
          for (let i = 0; i < chain.length; i++) {
            if (chain[i].subject === undefined) continue;
            const at = disabledLine(chain[i].line);
            if (at !== undefined) rowAtLine(spec.path, at, chain.slice(0, i + 1).map((n) => n.pathSeg).join("."));
          }
        }
        for (const [key, entry] of missing) {
          embedded.push({
            key,
            value: entry.value,
            source: { file: resolvedBaselineFile },
            origin: "baseline",
            categoryPath: entry.categoryPath,
            containers: entry.containers,
          });
          // The row and the commented line point at each other, exactly as an
          // ordinary row and its live line do.
          rowAtLine(spec.path, disabledAt.get(key), key);
        }

        // Never silent: a wrong file looks exactly like "the vendor shipped
        // nothing this project kept" (0 in common) unless it is called out —
        // reported apart from the ordinary count line so it reads as a
        // warning, not a statistic.
        if (unchangedCount + changedCount === 0) {
          console.warn(
            `ansible recipe: sheet "${name}": baseline "${baselineFile}" shares NO keys with the deployed ` +
              `artifact (${baselineMap.size} read from baseline, ${deployedKeys.size} in the deployed artifact) — ` +
              `almost certainly the wrong file`
          );
        } else {
          console.warn(
            `ansible recipe: sheet "${name}": baseline "${baselineFile}" — ${unchangedCount} inherited unchanged, ` +
              `${changedCount} changed, ${addedCount} added (not in the vendor's file), ${missing.length} the ` +
              `vendor ships that this deliverable does not`
          );
        }
      }

      // One preview per template per DISTINCT rendering. Most files do not
      // differ between environments at all, and three identical copies of one
      // file is three times the reading for no information — so instances that
      // render the same text are listed together. `previewRendered` owns the
      // per-instance render + dedupe (and the size gate); `warn` is a plain
      // `console.warn`, matching this recipe's other warnings.
      const warn = (m: string) => console.warn(m);
      for (const { spec, file, content } of read) {
        const keys = keyAtLine.get(spec.path) ?? new Map<number, string[]>();
        artifacts.push(
          ...previewRendered(
            {
              id: previewId(name, spec.component),
              sheet: name,
              ...(spec.component !== undefined ? { component: spec.component } : {}),
              ...(spec.deployedPath !== undefined ? { deployed_path: spec.deployedPath } : {}),
              source_file: file,
            },
            content,
            io.instances,
            (instance, n) => (n === "ansible_managed" ? ansibleManaged : valueIn(instance, n)),
            keys,
            DEPLOY_TIME_VARS,
            warn,
            // The SAME walk the row expansion used. Two walks that must agree
            // are two walks that drift: the preview counted `list[0]`, `list[1]`
            // upward, so a list of maps read as empty and it declared the loop
            // uncomputable while the rows it produced sat on the sheet.
            (list, instance) =>
              loopMembers(list, instance).map((m) => ({
                ...(m.value !== undefined ? { value: m.value } : {}),
                ...(m.fields !== undefined ? { fields: new Map([...m.fields].map(([k, v]) => [k, v.value])) } : {}),
                ...(m.identifier !== undefined ? { identifier: m.identifier } : {}),
              }))
          )
        );
      }

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

    // One entry per row key that resolved to exactly ONE variable across every
    // component. Ambiguity is reported, never resolved by picking a side.
    {
      const byKey = new Map<string, { variables: Set<string>; components: Set<string> }>();
      for (const c of keyMapCandidates) {
        let e = byKey.get(c.key);
        if (!e) byKey.set(c.key, (e = { variables: new Set(), components: new Set() }));
        e.variables.add(c.variable);
        if (c.component !== undefined) e.components.add(c.component);
      }
      for (const [key, e] of byKey) {
        if (e.variables.size === 1) {
          keyMap.push({ boundKey: key, variable: [...e.variables][0] });
          continue;
        }
        console.warn(
          `ansible recipe: sheet "${name}": ${key} is backed by ${[...e.variables].join(", ")} in different ` +
            `components (${[...e.components].join(", ")}), so no single variable can be shown under it — ` +
            `the row keeps its own name and the under_key column stays empty for it`
        );
      }
    }

    const layers: ValueLayer[] = [{ kind: "base", entries: baseMap }, ...overlayLayers];

    if (sheetSpec.deployed_path !== undefined && specs.length === 0) {
      throw new Error(
        `ansible recipe: sheet "${name}" declares deployed_path but has no template — ` +
          `there is no rendered file to deploy`
      );
    }
    const statedOrder = Array.isArray(sheetSpec.component_order)
      ? (sheetSpec.component_order as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    return {
      name,
      ...(filePath ? { filePath } : {}),
      ...(sourceFile ? { sourceFile } : {}),
      instances: io.instances,
      layers,
      embedded,
      ...(keyMap.length > 0 ? { keyMap } : {}),
      // Which variables the template(s) actually interpolate — every one of
      // them, including the second and later variables of a mixed line. Not
      // derivable from `keyMap` downstream: that table answers "which variable
      // may be SHOWN under this row" and is deliberately empty wherever the
      // relationship is not 1:1, so reading it as "is this row's value part of
      // the artifact" made exactly the mixed lines fall out of the artifact
      // they are lines of.
      ...(templateVariables.length > 0 ? { templateVariables } : {}),
      // The row keys pass 1 saw a variable interpolated into — the mirror of
      // the above, in the namespace the artifact axis actually uses. See
      // SheetInputs.variableBackedKeys.
      ...(variableBackedRowKeys.length > 0 ? { variableBackedKeys: variableBackedRowKeys } : {}),
      ...(componentOf.size > 0 ? { componentOf } : {}),
      ...(componentLabels.size > 0 ? { componentLabels } : {}),
      ...(componentFiles.size > 0 ? { componentFiles } : {}),
      // The author's own reading order wins over the one the templates imply:
      // a comparison sheet takes one side from a template and the other from a
      // file, and neither list can state where the other belongs.
      ...(statedOrder.length > 0 || specs.length > 1
        ? { componentOrder: statedOrder.length > 0 ? statedOrder : specs.map((t) => t.component).filter((c): c is string => c !== undefined) }
        : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
  },
};

registerRecipe(ansibleRecipe);
