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
