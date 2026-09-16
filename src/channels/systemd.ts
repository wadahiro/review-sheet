import { registerProbeRule } from "../channel.js";
import { wordsFor, type ChannelWords } from "../channel-words.js";

// What systemctl says about a unit.
//
// Two readings every project running systemd needs, and neither is about any
// one deployment:
//
//   `systemctl is-enabled a b c` prints one WORD per unit, in the order asked,
//   and a unit the host does not have is not a finding — it says `not-found`
//   (with `Failed to get unit file state … No such file or directory` on
//   stderr). A project that reads that as "not enabled" reports every optional
//   unit as a defect.
//
//   an action leaves the unit in a state that action MEANS. `stop` means
//   inactive, `start` and `restart` mean active — systemd's vocabulary, not a
//   project's choice.
//
// The unit FILE is parsed elsewhere (`src/systemd.ts`); this is what the
// running system says about it.

// Unit -> the word systemctl printed for it.
export function unitStates(text: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of (text ?? "").split("\n")) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim());
    if (m !== null) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

export const isEnabled = (state: string | undefined): boolean => /^enabled/.test(state ?? "");

// A unit this host does not have at all. Not a failure: an image without
// firewalld is not a misconfigured one, and only the project knows whether it
// expected the unit to be there.
export const isAbsent = (state: string | undefined): boolean =>
  /No such file|not-found/i.test(state ?? "");

// What each action means for the state that follows it.
export const AFTER: Record<string, string> = {
  stop: "inactive",
  start: "active",
  restart: "active",
};

// One step of a lifecycle run: what was asked, what the command returned, and
// what the unit was in afterwards.
//
// The LINE SHAPE is the collector's printf and is read loosely on purpose —
// `<action> rc=<n> is-active=<state>` with anything else on the line ignored —
// because the one thing this must not do is decide how a collector prints. What
// it reads is the three facts systemd's own vocabulary is about.
//
// `ActiveEnterTimestamp` comes with the step when the collector took it. It is
// the evidence that a `restart` actually restarted: a restart that silently did
// nothing leaves the unit `active` exactly as a restart that worked does, and rc
// 0 with `is-active=active` is what both look like. systemd stamps the moment
// the unit last entered `active`, so the stamp after the restart being NEWER
// than the one after the start is the only thing in the output that tells them
// apart.
export type LifecycleStep = { action: string; rc: number; active: string; enteredAt?: number };

export function lifecycleSteps(text: string | null | undefined): Map<string, LifecycleStep> {
  const out = new Map<string, LifecycleStep>();
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*(\w+)\s+rc=(\d+)\s+is-active=(\S*)/.exec(line);
    if (m === null) continue;
    // A timestamp systemd could not give (the unit never started) is printed as
    // `n/a`, which is not a moment and must not become one.
    const stamp = /ActiveEnterTimestamp=(.+?)\s*$/.exec(line)?.[1]?.trim();
    const at = stamp === undefined || stamp === "" || stamp === "n/a" ? NaN : Date.parse(stamp);
    out.set(m[1]!, {
      action: m[1]!,
      rc: Number(m[2]),
      active: m[3]!,
      ...(Number.isNaN(at) ? {} : { enteredAt: at }),
    });
  }
  return out;
}

// Every step ran, returned 0, and left the unit in the state that step MEANS —
// and the restart left a unit that really entered `active` again.
//
// A step with no line at all is a step that did not run, which is not the same
// as one that ran and failed; both are findings and the reason says which.
export function lifecycleFaults(
  steps: Map<string, LifecycleStep>,
  order = ["stop", "start", "restart"],
  w: ChannelWords = wordsFor(undefined)
): string[] {
  const bad: string[] = [];
  for (const action of order) {
    const step = steps.get(action);
    if (step === undefined) bad.push(w.stepDidNotRun(action));
    // `rc=5` is the command's own answer and is quoted, not written.
    else if (step.rc !== 0) bad.push(`${action}: rc=${step.rc}`);
    else if (AFTER[action] !== undefined && step.active !== AFTER[action]) {
      bad.push(w.stepLeftWrongState(action, step.active, AFTER[action]!));
    }
  }
  const started = steps.get("start")?.enteredAt;
  const restarted = steps.get("restart")?.enteredAt;
  // Only when BOTH were stamped: a collector that does not take the stamp is
  // not reporting a defect, and inventing one from a missing field would fail
  // every project that prints the shorter line.
  if (started !== undefined && restarted !== undefined && restarted <= started) {
    bad.push(w.restartDidNotRestart());
  }
  return bad;
}

// Every unit the host HAS is enabled. Which units were asked about is the
// collector's decision and travels in the output itself; that a unit the host
// does not have is not a finding is systemd's, and is the only judgement here.
export function registerSystemdRules(binding: { units_enabled?: string; lifecycle?: string; sheet?: string }): void {
  if (binding.lifecycle !== undefined) {
    registerProbeRule({
      name: "systemd.lifecycle",
      covers: (x) => x === binding.lifecycle,
      ...(binding.sheet === undefined ? {} : { sheet: binding.sheet }),
      verdict: (probe, ctx) => {
        const w = wordsFor(ctx.lang);
        const steps = lifecycleSteps(probe.text);
        // Nothing parsed at all is not three failed steps: the run produced no
        // output this can read, and saying "stop, start and restart all failed"
        // about it sends a reader to the unit instead of to the collector.
        if (steps.size === 0) {
          return { ok: false, why: w.noLifecycleSteps((probe.text ?? "").slice(0, 120)) };
        }
        const bad = lifecycleFaults(steps, undefined, w);
        return bad.length === 0 ? { ok: true } : { ok: false, why: bad.join("; ") };
      },
    });
  }
  const id = binding.units_enabled;
  if (id === undefined) return;
  registerProbeRule({
    name: "systemd.units-enabled",
    covers: (x) => x === id,
    ...(binding.sheet === undefined ? {} : { sheet: binding.sheet }),
    verdict: (probe) => {
      const bad = [...unitStates(probe.text)].filter(([, state]) => !isEnabled(state) && !isAbsent(state));
      return bad.length === 0 ? { ok: true } : { ok: false, why: bad.map(([u, st]) => `${u} = ${st}`).join(", ") };
    },
  });
}
