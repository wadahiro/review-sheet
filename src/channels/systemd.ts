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
