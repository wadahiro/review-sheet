// A sheet whose subject is a rendered Terraform plan (`terraform show -json`).
//
// This is `snapshot` with the plan's shape written down. Every project reviewing
// a plan was otherwise writing the same three patterns over the same address
// grammar — Terraform's, not this tool's, but no more the project's to
// re-derive for that:
//
//   resource_changes[address="module.ec2.aws_instance.node[0]"].change.after.ami
//     key       -> ec2.aws_instance.node[0].ami
//     component -> ec2                      (the module)
//     dictionary-> aws_instance.ami         (the provider documents an argument
//                                            of a resource TYPE, not of an
//                                            instance in one module)
//
// The module name STAYS in the key. `aws_lb.this` is unique only WITHIN a
// module, so two ALB modules would otherwise collide on every row; and a plan
// with no modules at all simply produces keys with no module segment.
//
// Nothing here executes Terraform. A plan is an ordinary committed artifact,
// rendered by the project, which is what keeps `import --spec` hermetic — a
// stale plan is a stale sheet, and re-rendering is part of changing the HCL.
import { registerRecipe, type SheetRecipe, type RecipeIO, type JsonValue } from "../recipe.js";
import type { SheetInputs } from "../assemble.js";
import { snapshotRecipe } from "./snapshot.js";
import { keyTransformSchema, type KeyTransform, type KeyTransformStep } from "../keytransform.js";
import { hclAttributeSites } from "../hcl.js";
import { previewFile, previewId, addLineKey, type LineKeys } from "../preview.js";
import type { ArtifactPreview } from "../types.js";

// `address` is quoted in the structural path only when it has to be, exactly as
// everywhere else — which is the detail a hand-written version gets wrong.
const ADDRESS = `^resource_changes\\[address="?(?:module\\.([^.]+?)\\.)?([a-z][a-z0-9_]*)\\.([^"]+?)"?\\]\\.change\\.after\\.(.+)$`;

// One step, so anything that is NOT a resource argument — the plan's own
// bookkeeping: format_version, relevant_attributes, errored, output_changes —
// is dropped by failing to match, rather than by a list of section names
// someone has to keep up with as Terraform adds them.
//
// A resource outside any module gets the module segment `root`, which is what
// Terraform calls it. Left empty instead, the key would start with a dot and
// every downstream rule would need a special case for the shape.
const KEY_STEPS: KeyTransformStep[] = [
  { pattern: ADDRESS, replace: "$1.$2.$3.$4", on_no_match: "drop" },
  { pattern: "^\\.", replace: "root." },
];

const COMPONENT_STEPS: KeyTransformStep[] = [
  { pattern: `^resource_changes\\[address="?module\\.([^.]+?)\\..*$`, replace: "$1", on_no_match: "drop" },
];

// How a plan row relates to the provider's own dictionary, which documents an
// argument of a resource TYPE. Supplied by the recipe because it follows from
// the plan's shape, not from anything this project chose; a binding that
// declares its own `key_steps` still wins.
// The SAME strip normalizeTfKey applies, and for the same reason: the provider
// documents a nested block's argument once (`aws_lb.access_logs.enabled`),
// while a plan addresses each repetition — by index, or by the identifying
// field its elements carry. Both are addressing; the dictionary has neither.
// Only the index was stripped here, so a repeated block whose elements have a
// `name` bound to nothing and arrived with no description at all.
const REPETITION = `\\[(?:[0-9]+|[A-Za-z_][A-Za-z0-9_.-]*=[^\\]]*)\\]`;

const DICT_KEY_STEPS: KeyTransformStep[] = [
  { pattern: `^[^.]+\\.([a-z][a-z0-9_]*)\\.[^.]+\\.(.+)$`, replace: "$1.$2", on_no_match: "drop" },
  { pattern: REPETITION, replace: "", flags: "g" },
];

const schema = {
  type: "object",
  required: ["snapshots"],
  properties: {
    snapshots: { type: "object", minProperties: 1, additionalProperties: { type: "string" } },
    format: { type: "string" },
    // Composed AFTER the plan's own key derivation, for the judgement calls on
    // top of it — the same relationship a `split:` has with a source's steps.
    key: keyTransformSchema,
    empty_means_unset: { type: "boolean" },
    include: { type: "array", items: { type: "string" } },
    exclude: { type: "array", items: { type: "string" } },
    // component id -> a directory of *.tf, resolved relative to the spec. What
    // gets previewed beside the sheet is the module's own SOURCE, never the
    // plan (see the module doc and tfSourceKey below for why): a reviewer
    // judges `load_balancer_type = "application"` against the resource block
    // it sits in, not against a 156 KB machine-generated document whose
    // adjacent lines are punctuation.
    sources: { type: "object", additionalProperties: { type: "string" } },
  },
  additionalProperties: false,
};

export const terraformPlanRecipe: SheetRecipe = {
  name: "terraform-plan",
  schema,
  load(sheetSpec, io: RecipeIO): SheetInputs {
    const declaredKey = sheetSpec.key as KeyTransform | undefined;
    if (declaredKey?.from === "key") {
      throw new Error(`terraform-plan recipe: "key.from" must be "path" — a plan's rows are addressed structurally`);
    }
    const declaredComponent = io.component as (KeyTransform & { names?: unknown }) | undefined;
    const si = snapshotRecipe.load(
      { ...sheetSpec, key: { from: "path", steps: [...KEY_STEPS, ...(declaredKey?.steps ?? [])] } as unknown as JsonValue },
      {
        ...io,
        // A plan's resource_changes are a list addressed by `address`, which is
        // not one of the extractor's built-in identity fields — so without this
        // every row would come out positional (`resource_changes[3]...`) and
        // the patterns below would match nothing. Supplied here rather than
        // asked of the project: it is a fact about the plan format, and the
        // recipe is the thing that knows the format.
        extractOptions: { ...io.extractOptions, idFields: [...(io.extractOptions?.idFields ?? []), "address"] },
        // The module derivation is the recipe's; `names:` (what each module IS
        // to a reader) stays the project's, and a project that needs a
        // different rule can still write its own steps, which run after.
        component: { ...(declaredComponent ?? {}), from: "path", steps: [...COMPONENT_STEPS, ...(declaredComponent?.steps ?? [])] },
      }
    );
    const withDictKeySteps: SheetInputs = { ...si, dictKeySteps: DICT_KEY_STEPS };
    const sourcesSpec = sheetSpec.sources as Record<string, JsonValue> | undefined;
    if (sourcesSpec === undefined) return withDictKeySteps;
    // `sources:` is not merely a preview request — declaring it says "this
    // directory IS the module's authored source", which is exactly the
    // authority `SheetInputs.authoredKeys` needs (assemble.ts): every row the
    // scan below did not find an assignment for is a value the AWS provider
    // resolved, not one anyone here wrote, so it gets demoted to
    // `origin: "default"`. There is no opt-out — a project that names
    // `sources:` is making a factual claim about that directory, not asking
    // for a sidebar.
    const { previews, authoredKeys } = buildSourcePreviews(withDictKeySteps, sourcesSpec, io);
    return { ...withDictKeySteps, artifacts: [...(withDictKeySteps.artifacts ?? []), ...previews], authoredKeys };
  },
};

registerRecipe(terraformPlanRecipe);

// The sheet's own final row keys, normalized -> every raw key that collapses
// onto that normalization, in row order. The snapshot recipe backing this one
// emits an EMPTY base layer (see snapshot.ts's module doc) — a plan's rows
// live entirely in the overlay layers, one per instance — so there is no base
// to look in, only overlays, each already keyed by KEY_STEPS' output.
//
// Grouped rather than collapsed to one winner up front: `normalizeTfKey`
// strips a plan's array index, so `node[0].ami` and `node[1].ami` (two `count`
// instances) land on the same normalized key even though they are two
// genuinely different rows. The FIRST in row order is what a `.tf` line gets
// (see buildFilePreview below), but every other member of the group is kept
// so a file that hits a collapsed group can be told, not left to guess why
// its second `count` instance never lit up.
function buildRowKeyIndex(si: SheetInputs): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const layer of si.layers) {
    if (layer.kind !== "overlay") continue;
    for (const key of layer.entries.keys()) {
      const norm = normalizeTfKey(key);
      const g = groups.get(norm);
      if (g) {
        if (!g.includes(key)) g.push(key);
      } else {
        groups.set(norm, [key]);
      }
    }
  }
  return groups;
}

// One *.tf file, read once, turned into a `LineKeys` map via the bridge
// (tfSourceKey + the row-key index) and handed to `previewFile`. `nature:
// "source"` (types.ts) is what keeps the panel from claiming "Rendered from"
// over an authored file review-sheet never rendered.
//
// An hcl entry that maps to nothing (`tfSourceKey` returns undefined — a
// `variable.`/`locals.`/... declaration, per its own doc comment — or the
// normalized key matches no row) is simply not a row and is skipped with no
// warning: a `variables.tf` is pure context, and a provider default the plan
// surfaced has no authored line, and both are expected and correct — "a row
// the file has no line for gets none" is the rule already in force for every
// other producer in this repo.
function buildFilePreview(
  sheetName: string,
  component: string,
  file: string,
  content: string,
  groups: Map<string, string[]>,
): { preview: ArtifactPreview | undefined; matched: number; collapsed: string[][]; authoredKeys: Set<string> } {
  const keys: LineKeys = new Map();
  // Which normalized-key groups (of size > 1) this FILE actually touched — a
  // `.tf` file that never mentions `count`-indexed siblings never collapses
  // anything, so this is per-file, not a blanket report of every collision the
  // whole sheet's index contains.
  const collapsedHere = new Map<string, string[]>();
  // Every row key an assignment in this file backs — see normalizeTfKey: a
  // `count`-indexed pair like `node[0].ami`/`node[1].ami` collapses onto one
  // normalized form, so a single line can only LABEL one of them (`group[0]`,
  // below), but every member the source assigned is equally authored. Feeding
  // only `group[0]` here would silently claim the sibling was never stated at
  // all, which is exactly the wrong answer for a `count`-replicated resource.
  const authoredKeys = new Set<string>();
  let matched = 0;
  // `hclAttributeSites`, not `extractFile`: what is wanted here is WHERE an
  // attribute is written, and extraction answers a different question — it
  // emits only the attributes it can VALUE, dropping every interpolation and
  // reference, which is right for a row and wrong for a position. Measured on
  // one project's five modules: 140 attributes assigned, 47 valued, so asking
  // the extractor for lines found under a third of the file and left a row
  // like `name_prefix = "app-${var.environment}-node-"` with no
  // context at all. It is also exactly what makes this same walk usable as
  // the authorship discriminator (see `authoredKeys` above): a site is
  // reported for every ASSIGNMENT, not only ones with a literal value, so
  // `skip_final_snapshot = !var.deletion_protection` still counts as authored
  // even though `hclIndex` (extraction) would have skipped it as an
  // expression.
  for (const site of hclAttributeSites(content)) {
    const srcKey = tfSourceKey(component, site.path);
    if (srcKey === undefined) continue;
    const group = groups.get(normalizeTfKey(srcKey));
    if (group === undefined) continue;
    addLineKey(keys, site.line, group[0]);
    matched++;
    for (const k of group) authoredKeys.add(k);
    if (group.length > 1) collapsedHere.set(group.join(SEP), group);
  }
  const preview = previewFile(
    { id: previewId(sheetName, component, file.split("/").pop() ?? file), sheet: sheetName, component, source_file: file, nature: "source" },
    content,
    keys,
    (m) => console.warn(`terraform-plan recipe: ${m}`)
  );
  return { preview, matched, collapsed: [...collapsedHere.values()], authoredKeys };
}

// `si.componentOf` inverted: which row keys belong to each component. This is
// the universe a component's `authored`/`demoted` counts are measured
// against — the scan below only ever ADDS to a component's authored set, so
// without the full membership there would be nothing to subtract it from.
function keysByComponent(si: SheetInputs): Map<string, Set<string>> {
  const byComponent = new Map<string, Set<string>>();
  if (!si.componentOf) return byComponent;
  for (const [key, component] of si.componentOf) {
    let s = byComponent.get(component);
    if (!s) {
      s = new Set<string>();
      byComponent.set(component, s);
    }
    s.add(key);
  }
  return byComponent;
}

// The bridge to a component's own `.tf` source, and — since the same scan
// finds every assignment rather than every literal value (see
// `hclAttributeSites`'s doc and `buildFilePreview` above) — the source of
// truth for which of this sheet's rows are authored vs. provider-resolved.
// Errors name the offender — same discipline as the recipe's `names:`
// two-way check (snapshot.ts): a declaration the sheet cannot back up is a
// build-time mistake, not a silently-empty panel.
//
// Scoped per component (design decision, see the recipe's module doc): a
// component named in `sources:` gets its rows judged by the scan; a
// component that produced rows but has NO `sources:` entry is not evidence
// it authors nothing — it keeps every row at today's overlay/common origin,
// unjudged, but that must be visible rather than indistinguishable from a
// judged component, so it is warned about here too. A row belonging to no
// component at all (a resource outside every module, see COMPONENT_STEPS)
// has no component a `sources:` entry could ever name either, so it is folded
// in the same way, silently — there is nothing to warn about that isn't
// already covered by "this sheet has no modules".
function buildSourcePreviews(
  si: SheetInputs,
  sourcesSpec: Record<string, JsonValue>,
  io: RecipeIO
): { previews: ArtifactPreview[]; authoredKeys: Set<string> } {
  const groups = buildRowKeyIndex(si);
  const byComponent = keysByComponent(si);
  const componentIds = new Set(si.componentOf?.values() ?? []);
  const previews: ArtifactPreview[] = [];
  const authoredKeys = new Set<string>();

  for (const [component, rawDir] of Object.entries(sourcesSpec)) {
    if (typeof rawDir !== "string") {
      throw new Error(`terraform-plan recipe: sheet "${si.name}": sources.${component} must be a string path`);
    }
    if (!io.listDir) {
      throw new Error(
        `terraform-plan recipe: sheet "${si.name}" declares "sources", which needs RecipeIO.listDir — the caller must supply it`
      );
    }
    if (!componentIds.has(component)) {
      throw new Error(
        `terraform-plan recipe: sheet "${si.name}": sources declares component "${component}", which produced no rows on this sheet` +
          (componentIds.size > 0 ? ` (this sheet's modules: ${[...componentIds].sort().join(", ")})` : " (this sheet has no modules)")
      );
    }
    const dir = io.resolve(rawDir);
    const entries = io.listDir(dir);
    if (entries === null) {
      throw new Error(`terraform-plan recipe: sheet "${si.name}": sources.${component} directory not found: ${dir}`);
    }

    // Sorted so preview order (and hence id assignment) is deterministic
    // regardless of what the filesystem happens to hand back.
    const files = entries.filter((f) => f.endsWith(".tf")).sort();
    let componentMatched = 0;
    const componentAuthored = new Set<string>();

    for (const name of files) {
      const path = `${dir}/${name}`;
      const content = io.readFile(path);
      if (content === null) throw new Error(`terraform-plan recipe: sheet "${si.name}": ${path} listed but could not be read`);
      const { preview, matched, collapsed, authoredKeys: fileAuthored } = buildFilePreview(si.name, component, path, content, groups);
      if (preview) previews.push(preview);
      componentMatched += matched;
      for (const k of fileAuthored) componentAuthored.add(k);
      if (collapsed.length > 0) {
        console.warn(
          `terraform-plan recipe: sheet "${si.name}": ${path}: ${collapsed.length} row key group(s) collapse onto one line each ` +
            `(index normalization) — only the first of each is shown: ${collapsed.map((g) => g.join(" / ")).join("; ")}`
        );
      }
    }

    // A declared rule that matched nothing is reported, never left to be
    // noticed — the same stance keyglob.ts's unmatchedPatterns and this file's
    // own `names:` check already take.
    if (componentMatched === 0) {
      console.warn(
        `terraform-plan recipe: sheet "${si.name}": sources.${component} (${dir}) matched no rows in any *.tf file — check the directory is right`
      );
    }

    for (const k of componentAuthored) authoredKeys.add(k);
    // Never silent in either direction: a component judged "fully authored"
    // and one silently missing half its rows must not look the same in the
    // build log — see assemble.ts's SheetInputs.authoredKeys for what
    // "demoted" means for the row (kept instances/value/source, origin ->
    // "default").
    const total = byComponent.get(component)?.size ?? 0;
    const demoted = total - componentAuthored.size;
    console.warn(
      `terraform-plan recipe: sheet "${si.name}": sources.${component}: ${componentAuthored.size} row(s) authored by ${dir}, ` +
        `${demoted} demoted to origin: "default" (a value the provider resolved, not stated in the module source)`
    );
  }

  // A component this sheet produced rows for but that `sources:` never named
  // has no authority behind it either way — it is not evidence the project
  // authored nothing, so its rows keep today's overlay/common origin, but
  // silently leaving it that way would make an unjudged component look
  // exactly like a judged one on the rendered sheet. Warn once per component.
  for (const component of componentIds) {
    if (Object.hasOwn(sourcesSpec, component)) continue;
    const keys = byComponent.get(component);
    if (keys) for (const k of keys) authoredKeys.add(k);
    console.warn(
      `terraform-plan recipe: sheet "${si.name}": component "${component}" has no sources: entry — ` +
        `its origins are unverified (every row stays overlay/common, none demoted to default)`
    );
  }

  // A row belonging to no component at all (a resource outside every
  // module — COMPONENT_STEPS drops it) can never be named by a `sources:`
  // entry, which is keyed by component. It keeps today's behavior the same
  // way an undeclared component does, and there is no component here to warn
  // about.
  for (const rawKeys of groups.values()) {
    for (const key of rawKeys) {
      if (!si.componentOf?.has(key)) authoredKeys.add(key);
    }
  }

  return { previews, authoredKeys };
}

// The other half of the bridge to a module's own `.tf` source, wired up above
// by `buildFilePreview`/`buildSourcePreviews`: a plan row is keyed `<component>.
// <type>.<name>.<rest>` (KEY_STEPS above), while this repo's own hcl parser keys a
// resource block `resource.<type>.<name>.<rest>` — Terraform's own address
// grammar, minus the module segment the source file has no way to state,
// since the module IS the file. Only a `resource.` block can become a row —
// `variable.`/`locals.`/`output.`/`data.`/`terraform.`/`provider.`/`module.`
// are declarations, defaults and metadata a plan never reproduces as a
// `resource_changes` entry, so there is nothing on the plan side for them to
// line up with.
// A separator that cannot occur in a key. Written as an escape rather than as
// the byte itself: a literal NUL in the source makes the whole file "binary" to
// grep and diff, so it silently drops out of every search — which is how it
// went unnoticed here until a search for a function in this file returned
// nothing at all.
const SEP = "\u0000";

export function tfSourceKey(component: string, hclPath: string): string | undefined {
  const segments = hclPath.split(".");
  // Need at least `resource`, `<type>`, `<name>`, and one more segment to
  // carry the argument itself — anything shorter names a resource but no
  // particular value in it, so there is no row to point at.
  if (segments[0] !== "resource" || segments.length < 4) return undefined;
  const [, type, name, ...rest] = segments;
  return [component, type, name, ...rest].join(".");
}

// Strips the ADDRESSING a repeated block is reached by, from either side.
//
// The same normalization this file's own `DICT_KEY_STEPS` (above) applies when
// relating a plan row to the provider's dictionary, and needed here for the
// same reason: a nested block is addressed differently in the two documents
// that have to line up.
//
//   .tf source   parameter[0].value              — the parser indexes repeats
//   plan JSON    parameter[name=max_connections].value
//
// Both are ways of saying WHICH repetition, and neither side can produce the
// other's: the plan's list elements carry an identifying field, so the
// extractor addresses them by it (`name`/`id`/`key` are identity fields
// whether or not a spec declares any), while the HCL source has only their
// order. Stripping the index alone left every such row unmatched, so a value
// the module plainly writes was published as one nobody sets — the worst way
// to be wrong, since an unset row is hidden by default.
//
// A quoted map key (`tags["Name"]`) is NOT addressing and is left alone: it is
// content both documents can state, and collapsing it would merge two settings
// into one.
export function normalizeTfKey(key: string): string {
  return key.replace(new RegExp(REPETITION, "g"), "");
}
