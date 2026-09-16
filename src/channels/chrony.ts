// What chrony says about the clock.
//
// A product's knowledge is not one project's. `chronyc tracking` prints a
// block of labelled lines, and the one that answers "is this host's time
// actually being disciplined" is `Leap status` — the field NTP itself defines,
// which chrony sets to `Normal` only once the clock is synchronised and no leap
// second is pending. Every other line in that block is a measurement (the
// stratum, the offset, the root dispersion) whose acceptable range is a
// project's policy; this one is the product stating whether it is doing its job
// at all.
//
// Nothing here is a deployment's business, which is why it had no place to live
// and was written into each project's judging script instead — copied per
// project, held by no test anywhere.
//
// The chrony.conf FILE is parsed elsewhere (`src/line-config.ts`'s `chrony`
// entry); this is what the running daemon says.

import { registerProbeRule } from "../channel.js";

// One labelled line of `chronyc tracking`, by its label.
//
// The output is `Label<spaces>: value`, and a label contains spaces of its own
// (`Leap status`, `Root dispersion`) — so the split is on the FIRST colon and
// not on whitespace, which is what a naive reading gets wrong on every
// multi-word label in the block.
export function trackingFields(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const label = line.slice(0, at).trim();
    if (label === "") continue;
    // `Ref time (UTC)` carries colons of its own in the value; the label is
    // everything before the first one, which is why the value is the rest
    // rather than a second field.
    if (!out.has(label)) out.set(label, line.slice(at + 1).trim());
  }
  return out;
}

// Whether the daemon says the clock is disciplined.
//
// `Normal` is the only value that means it. The others are chrony's own words
// for "not synchronised" (`Not synchronised`) and for a leap second it is about
// to apply (`Insert second`, `Delete second`) — all of them states a host
// should not be sitting in when somebody asks, and none of them a project
// decides the meaning of.
export const isSynchronised = (leap: string | undefined): boolean => leap === "Normal";

// The line the leap status was reported on, so a verdict points at the words
// rather than at the block.
function lineOfLeap(text: string | null | undefined): number | undefined {
  const at = (text ?? "").split("\n").findIndex((l) => /^\s*Leap status\s*:/.test(l));
  return at < 0 ? undefined : at + 1;
}

// Is this host's clock being disciplined? The reading is chrony's; that a
// project WANTS it disciplined is the one thing it does not have to say, which
// is why this takes an id and nothing else.
export function registerChronyRules(binding: { time_synced?: string; sheet?: string }): void {
  const id = binding.time_synced;
  if (id === undefined) return;
  registerProbeRule({
    name: "chrony.time-synced",
    covers: (x) => x === id,
    ...(binding.sheet === undefined ? {} : { sheet: binding.sheet }),
    verdict: (probe) => {
      const leap = trackingFields(probe.text).get("Leap status");
      // No such line is not "not synchronised": the daemon did not answer at
      // all — it is not running, the host has no chrony on it, or the command
      // could not reach it. That is the host saying it cannot be asked, which
      // is a third answer and never a failure; calling it a clock problem sends
      // a reader to the time instead of to the host.
      if (leap === undefined) {
        return { ok: null, why: `chronyc tracking said nothing about the leap status: ${(probe.text ?? "").slice(0, 120)}` };
      }
      const at = lineOfLeap(probe.text);
      return isSynchronised(leap)
        ? { ok: true, why: `Leap status: ${leap}`, ...(at === undefined ? {} : { line: at }) }
        : { ok: false, why: `Leap status: ${leap}`, ...(at === undefined ? {} : { line: at }) };
    },
  });
}
