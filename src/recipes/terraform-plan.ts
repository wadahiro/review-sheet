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
const DICT_KEY_STEPS: KeyTransformStep[] = [
  { pattern: `^[^.]+\\.([a-z][a-z0-9_]*)\\.[^.]+\\.(.+)$`, replace: "$1.$2", on_no_match: "drop" },
  { pattern: `\\[[0-9]+\\]`, replace: "", flags: "g" },
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
    return { ...si, dictKeySteps: DICT_KEY_STEPS };
  },
};

registerRecipe(terraformPlanRecipe);
