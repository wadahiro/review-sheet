// What `terraform plan` says, and how it says it.
//
// Three pieces of Terraform's own vocabulary that every project asking "does
// the code still match what is built" has to know:
//
//   `-detailed-exitcode` answers in the EXIT CODE — 0 nothing to change, 2
//   changes present, 1 the run failed — so the verdict is not in the output at
//   all, and a project reading the text for it gets "No changes" from a plan
//   that errored before it reached that line.
//
//   a complaint is written in COLOUR, inside a box: the last line of a failed
//   run is the frame, not the reason. The line that says Error is the reason.
//
//   the changed resources are the lines beginning `  # `, which is what turns
//   "3 to change" into something a reader can act on.
//
// None of it is about any one stack, and a project that re-derives it gets the
// exit codes right and the last-line-is-punctuation wrong, or the other way
// round.

const ANSI = /\u001b\[[0-9;]*m/g;

// What a plan run means. `text` is only consulted for the reason of a failure.
export function planOutcome(
  exitCode: number,
  text: string | null | undefined
): { ran: boolean; ok?: boolean; why?: string } {
  if (exitCode === 0) return { ran: true, ok: true };
  if (exitCode === 2) return { ran: true, ok: false };
  return { ran: false, why: complaint(text) };
}

// Terraform's own words for what went wrong, uncoloured and unframed.
export function complaint(text: string | null | undefined): string {
  const lines = (text ?? "")
    .replace(ANSI, "")
    .split("\n")
    .map((l) => l.replace(/^[\u2502\u2577\u2575\s]+/, "").trim())
    .filter((l) => l !== "");
  return (lines.find((l) => /^Error/i.test(l)) ?? lines[0] ?? "").slice(0, 160);
}

// Which resources a plan would touch. The addresses only — what a reader needs
// first is WHICH thing moved, and the diff beneath it is in the output they can
// open.
export function changedResources(text: string | null | undefined): string[] {
  return (text ?? "")
    .replace(ANSI, "")
    .split("\n")
    .map((l) => /^\s*# (\S+) will be/.exec(l)?.[1])
    .filter((x): x is string => x !== undefined);
}

// WHAT A PLAN JSON DESCRIBES, which is one of two things and never both.
//
// With every action `no-op` (or `read`, which observes and changes nothing),
// `change.after` is what the stack HOLDS — that is the whole reason an
// apply-後 plan can answer a sheet's values at all. With anything else in
// there, the same field is what Terraform WOULD MAKE true, and a sheet judged
// against it is being compared with a proposal: every row reads OK for a value
// nothing has yet.
//
// The two are indistinguishable from `change.after` alone, which is why the
// question has to be asked of the actions. Returns the addresses that move —
// WHICH thing moved is what a reader needs first, and the diff under it is in
// the output they can open.
//
// `undefined` when the text is not a plan at all: the caller has a document of
// some other shape and this has nothing to say about it. Narrow on purpose — a
// project's own JSON may well have a `resource_changes` key, and reading that
// as a plan would refuse a document for a reason that is not true of it.
export function proposedChanges(text: string): string[] | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const plan = doc as { resource_changes?: unknown; terraform_version?: unknown; format_version?: unknown };
  if (!Array.isArray(plan.resource_changes)) return undefined;
  if (typeof plan.terraform_version !== "string" && typeof plan.format_version !== "string") return undefined;
  const moving: string[] = [];
  for (const c of plan.resource_changes) {
    if (typeof c !== "object" || c === null) continue;
    const entry = c as { address?: unknown; change?: { actions?: unknown } };
    const actions = entry.change?.actions;
    if (!Array.isArray(actions)) continue;
    if (actions.length === 1 && (actions[0] === "no-op" || actions[0] === "read")) continue;
    moving.push(typeof entry.address === "string" ? entry.address : "(unnamed)");
  }
  return moving;
}
