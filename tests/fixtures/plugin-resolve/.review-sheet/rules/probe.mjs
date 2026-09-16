// A plugin exactly as one is documented: it names the tool by its package name
// and nothing else. Whether that resolves is what the fixture is for.
import { registerProbeRule } from "review-sheet/src/channel.ts";
// …and a reader from under channels/, which is the half a thin plugin exists to
// reuse — and the half whose absence made the missing resolution worth
// reporting, since registerProbeRule alone can be had by other means.
import { clusterMembers } from "review-sheet/src/channels/keycloak.ts";

registerProbeRule({
  name: "fixture.cluster-formed",
  covers: (id) => id === "cluster-formed",
  verdict: (probe, ctx) => {
    const n = clusterMembers(probe.text);
    if (n === undefined) return { ok: false, why: "no cluster view in the output" };
    return n === ctx.observedHosts ? { ok: true } : { ok: false, why: `${n} member(s), expected ${ctx.observedHosts}` };
  },
});
