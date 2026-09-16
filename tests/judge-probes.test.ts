// One functional item, across every host — the loop, and nothing about any
// product or any project.
//
// What is asserted here is the part every project doing infrastructure tests
// used to write for itself: ask every host rather than the first, take the
// worst answer and name the host that produced it, and keep "did not run",
// "cannot be asked here" and "ran and failed" apart.

import { describe, it, expect } from "bun:test";
import { judgeProbes, type ProbeResult, type ObservedHost, type Observation } from "../src/judge";
import type { TestPlan } from "../src/testplan";

const held = (probes: Record<string, ProbeResult>): ObservedHost => ({ files: {}, probes });

const item = { unit: "u", id: "ports", text: "every designed port is listening", instance: "stg" };
const two = (a: ProbeResult, b: ProbeResult) => ({ web01: held({ ports: a }), web02: held({ ports: b }) });
const ran = (over: Partial<ProbeResult> = {}): ProbeResult => ({ how: "ss -lntp", ran: true, text: "LISTEN 80", ...over });

const judge = (
  hosts: Record<string, ObservedHost>,
  rule: (p: ProbeResult, c: { host: string }) => { ok: boolean | null; why?: string } = () => ({ ok: true })
) => judgeProbes(item, hosts, rule, { lang: "ja", sheet: "os baseline", at: "X" });

describe("one functional item across every host", () => {
  // A fleet is only as configured as its least configured node, and one item
  // can hold only one answer — so the failing host is the one it names.
  it("takes the worst answer and names the host that produced it", () => {
    const got = judge(two(ran(), ran()), (_p, c) => (c.host === "web02" ? { ok: false, why: "8080 が開いていない" } : { ok: true }));
    expect(got.answer.status).toBe("fail");
    expect(got.answer.reason).toBe("web02: 8080 が開いていない");
    expect(got.answer.evidence?.host).toBe("web02");
    expect(got.answer.detail).toBe("ss -lntp（2 ホスト）");
  });

  it("passes only when every host that ran passed", () => {
    expect(judge(two(ran(), ran())).answer.status).toBe("pass");
  });

  // The three ways a host can fail to answer, kept apart. Collapsing any of
  // them into a failure is the whole reason this needed writing.
  it("keeps a host that could not be asked out of the verdict rather than failing it", () => {
    // …the rule itself saying so (no chronyc on this host)
    const byRule = judge(two(ran(), ran()), (_p, c) => (c.host === "web02" ? { ok: null, why: "chronyc が無い" } : { ok: true }));
    expect(byRule.answer.status).toBe("pass");
    // …the collector saying so
    const byCollector = judge(two(ran(), { how: "ss -lntp", ran: false, why: "収集できなかった" }));
    expect(byCollector.answer.status).toBe("pass");
    // …and nobody having asked at all
    const never = judgeProbes(item, { web01: held({}) }, () => ({ ok: true }), { lang: "ja", at: "X" });
    expect(never.answer.status).toBe("not_run");
    expect(never.answer.reason).toBe("この実行では確認していない");
  });

  it("is not run, with the first host's reason, when no host ran it", () => {
    const got = judge(two({ ran: false, why: "収集できなかった" }, { ran: false, why: "収集できなかった" }));
    expect(got.answer.status).toBe("not_run");
    expect(got.answer.reason).toBe("収集できなかった");
  });

  // An intrusive item nobody ran did not fall through a gap — answering it
  // disturbs the running system, and the runner decides.
  it("says an intrusive item was not consented to rather than not collected", () => {
    const got = judgeProbes({ ...item, intrusive: true }, { web01: held({ ports: { ran: false } }) }, () => ({ ok: true }), {
      lang: "ja",
      at: "X",
    });
    expect(got.answer.reason).toBe("実行者が明示的に許可したときだけ実施する");
    // …and the collector's own words still win where it gave any.
    const said = judgeProbes({ ...item, intrusive: true }, { web01: held({ ports: { ran: false, why: "許可されていない（--allow-intrusive）" } }) }, () => ({ ok: true }), { lang: "ja", at: "X" });
    expect(said.answer.reason).toBe("許可されていない（--allow-intrusive）");
    // …and an EMPTY reason is not a reason: a collector that always writes the
    // field would otherwise put a blank where the record has to say which.
    const blank = judgeProbes({ ...item, intrusive: true }, { web01: held({ ports: { ran: false, why: "" } }) }, () => ({ ok: true }), { lang: "ja", at: "X" });
    expect(blank.answer.reason).toBe("実行者が明示的に許可したときだけ実施する");
  });

  it("carries what each host produced, filed under the sheet it answers for", () => {
    const got = judge(two(ran({ text: "a" }), ran({ text: "b" })));
    expect(got.documents.map((d) => [d.host, d.sheet, d.command, d.text])).toEqual([
      ["web01", "os baseline", "ss -lntp", "a"],
      ["web02", "os baseline", "ss -lntp", "b"],
    ]);
    // A host that did not run produced nothing to carry.
    expect(judge(two(ran({ text: "a" }), { ran: false, why: "x" })).documents.length).toBe(1);
  });

  it("points at the line a rule read its answer at", () => {
    const got = judge(two(ran(), ran()), () => ({ ok: false, why: "no", line: 12 }));
    expect(got.answer.evidence?.line).toBe(12);
  });
});

// A rule with no project fact in it is the PRODUCT's, and the tool's own fold
// runs it — so a project supplies no loop, no answers file and no exit code.
describe("a rule the tool itself holds", () => {
  const clear = (): void => {
    for (const k of ["review-sheet.probe-rules.v1", "review-sheet.functional-channels.v1"]) {
      const arr = (globalThis as Record<symbol, unknown>)[Symbol.for(k)] as unknown[];
      if (Array.isArray(arr)) arr.length = 0;
    }
  };

  it("answers the item it was bound to, across every host, and files its evidence", async () => {
    clear();
    const { registerModelChannels, judgeFunctional } = await import("../src/judge");
    registerModelChannels({ functional_rules: [{ rule: "systemd", units_enabled: "service-enabled", sheet: "os baseline" }] });
    const plan = {
      metadata: { title: "t" },
      units: [{ name: "u", declaration: { method: { ja: "m" } }, sheets: ["s"] }],
      items: [],
      functional: [{ unit: "u", id: "service-enabled", text: "every unit is enabled", instance: "stg", intrusive: false }],
    } as unknown as TestPlan;
    const obs = [{
      environment: "stg",
      collected_at: "X",
      hosts: {
        web01: { files: {}, probes: { "service-enabled": { how: "systemctl is-enabled a b", ran: true, text: "a enabled\nb enabled\n" } } },
        // …and the one that is not: the fleet is as configured as its least
        // configured node, and the tool's fold is what says so.
        web02: { files: {}, probes: { "service-enabled": { how: "systemctl is-enabled a b", ran: true, text: "a enabled\nb disabled\n" } } },
      },
    }] as unknown as Observation[];
    const got = judgeFunctional(plan, obs, { lang: "ja" });
    expect(got.answers[0]!.status).toBe("fail");
    expect(got.answers[0]!.reason).toContain("web02");
    expect(got.answers[0]!.reason).toContain("b = disabled");
    expect(got.evidence.map((d) => [d.host, d.sheet])).toEqual([["web01", "os baseline"], ["web02", "os baseline"]]);
  });

  // Every rule the tool holds has to be reachable from a spec that binds it.
  // A registration sitting in a branch nothing takes is indistinguishable from
  // a working one by any check short of running it.
  it("reaches a rule bound by name in the spec", async () => {
    clear();
    const { registerModelChannels, judgeFunctional } = await import("../src/judge");
    registerModelChannels({ functional_rules: [{ rule: "chrony", time_synced: "clock-disciplined" }] });
    const plan = {
      metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { ja: "m" } }, sheets: ["s"] }], items: [],
      functional: [{ unit: "u", id: "clock-disciplined", text: "x", instance: "stg", intrusive: false }],
    } as unknown as TestPlan;
    const at = (leap: string): Observation[] =>
      [{ environment: "stg", hosts: { web01: { files: {}, probes: { "clock-disciplined": { ran: true, text: `Stratum : 3\nLeap status     : ${leap}\n` } } } } }] as unknown as Observation[];
    expect(judgeFunctional(plan, at("Normal"), { lang: "ja" }).answers[0]!.status).toBe("pass");
    expect(judgeFunctional(plan, at("Not synchronised"), { lang: "ja" }).answers[0]!.status).toBe("fail");
  });

  // A unit the host does not have is not a finding — that is systemd's, and
  // the only judgement in the rule.
  it("does not fail a unit the host does not have", async () => {
    clear();
    const { registerModelChannels, judgeFunctional } = await import("../src/judge");
    registerModelChannels({ functional_rules: [{ rule: "systemd", units_enabled: "service-enabled" }] });
    const plan = {
      metadata: { title: "t" }, units: [{ name: "u", declaration: { method: { ja: "m" } }, sheets: ["s"] }], items: [],
      functional: [{ unit: "u", id: "service-enabled", text: "x", instance: "stg", intrusive: false }],
    } as unknown as TestPlan;
    const obs = [{ environment: "stg", hosts: { web01: { files: {}, probes: { "service-enabled": { ran: true, text: "a enabled\nfw Failed to get unit file state for fw.service: No such file or directory\n" } } } } }] as unknown as Observation[];
    expect(judgeFunctional(plan, obs, { lang: "ja" }).answers[0]!.status).toBe("pass");
  });
});
