// What chrony says about the clock — the daemon's own words, not a policy.
//
// The two readings that used to live in a project's judging script: which
// labelled line answers "is the clock disciplined", and what `Normal` means.

import { describe, it, expect } from "bun:test";
import { trackingFields, isSynchronised, registerChronyRules } from "../src/channels/chrony";
import { listProbeRules } from "../src/channel";

const TRACKING = [
  "Reference ID    : C0A80001 (ntp.internal)",
  "Stratum         : 3",
  "Ref time (UTC)  : Mon Jan 06 11:22:33 2025",
  "System time     : 0.000012345 seconds slow of NTP time",
  "Root dispersion : 0.001234567 seconds",
  "Leap status     : Normal",
  "",
].join("\n");

describe("chronyc tracking", () => {
  // The labels contain spaces, so splitting on whitespace loses every
  // multi-word one — which is all the interesting ones.
  it("keeps a multi-word label whole", () => {
    const f = trackingFields(TRACKING);
    expect(f.get("Leap status")).toBe("Normal");
    expect(f.get("Root dispersion")).toBe("0.001234567 seconds");
    expect(f.get("Stratum")).toBe("3");
  });

  // `Ref time (UTC)` has colons in its VALUE. The label is what precedes the
  // first one; everything after it is the value, colons and all.
  it("splits on the first colon only", () => {
    expect(trackingFields(TRACKING).get("Ref time (UTC)")).toBe("Mon Jan 06 11:22:33 2025");
  });

  // `Normal` is the only value that means synchronised — not "anything that
  // is not the words Not synchronised". A pending leap second is chrony saying
  // it is about to step the clock, and a host should not be sitting in that
  // state when somebody asks.
  it("calls only Normal synchronised", () => {
    expect(isSynchronised("Normal")).toBe(true);
    expect(isSynchronised("Not synchronised")).toBe(false);
    expect(isSynchronised("Insert second")).toBe(false);
    expect(isSynchronised("Delete second")).toBe(false);
    expect(isSynchronised(undefined)).toBe(false);
  });
});

describe("the rule a project binds to its own item", () => {
  const ruleFor = (id: string) => {
    registerChronyRules({ time_synced: id, sheet: "os" });
    const r = listProbeRules().find((x) => x.covers(id));
    if (r === undefined) throw new Error("no rule covers " + id);
    return r;
  };
  const ctx = { host: "h1", held: {}, hosts: 1 };

  it("passes a disciplined clock and points at the line", () => {
    const v = ruleFor("chrony.time-synced.1").verdict({ text: TRACKING }, ctx);
    expect(v.ok).toBe(true);
    expect(v.line).toBe(6);
  });

  it("fails a clock the daemon says is not synchronised", () => {
    const out = TRACKING.replace("Normal", "Not synchronised");
    const v = ruleFor("chrony.time-synced.2").verdict({ text: out }, ctx);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("Not synchronised");
  });

  // The daemon not answering is not a clock fault, and the reason has to send
  // the reader to the daemon rather than to the time.
  it("says the daemon answered nothing when the line is missing", () => {
    const v = ruleFor("chrony.time-synced.3").verdict({ text: "Cannot talk to daemon" }, ctx);
    expect(v.ok).toBe(false);
    expect(v.why).toContain("said nothing about the leap status");
    expect(v.line).toBeUndefined();
  });

  // A binding that names no item registers nothing. The failure this guards is
  // not a spare rule sitting unused: a rule registered under the same name
  // REPLACES the one already there, so an unbound binding loaded after a bound
  // one would silently take the working rule away from the item it covered.
  it("leaves a bound rule alone when a later binding names no item", () => {
    ruleFor("chrony.time-synced.4");
    registerChronyRules({});
    const still = listProbeRules().find((x) => x.covers("chrony.time-synced.4"));
    expect(still).toBeDefined();
    expect(still?.verdict({ text: TRACKING }, ctx).ok).toBe(true);
  });
});
