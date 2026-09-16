import { registerProbeRule } from "../channel.js";
import { wordsFor } from "../channel-words.js";

// What `logrotate -d` says about a configuration it was asked to read.
//
// A debug run prints what it WOULD do and, among it, its complaints about the
// file — `error:`, `unknown option`, `bad …`. Which lines are a complaint is
// logrotate's grammar; whether the file should have been there at all is the
// project's.

export function configErrors(text: string | null | undefined): string[] {
  return (text ?? "").split("\n").filter((l) => /error:|unknown option|bad /i.test(l));
}

// A debug run that complains about nothing is the whole verdict — there is no
// expectation for a project to supply. "not installed" is the host saying it
// cannot be asked, which is a third answer and never a failure.
export function registerLogrotateRules(binding: { config_syntax?: string; sheet?: string }): void {
  const id = binding.config_syntax;
  if (id === undefined) return;
  registerProbeRule({
    name: "logrotate.config-syntax",
    covers: (x) => x === id,
    ...(binding.sheet === undefined ? {} : { sheet: binding.sheet }),
    verdict: (probe, ctx) => {
      if (/not installed/.test(probe.text ?? "")) return { ok: null, why: wordsFor(ctx.lang).logrotateAbsent() };
      const bad = configErrors(probe.text);
      return bad.length === 0 ? { ok: true } : { ok: false, why: bad.slice(0, 2).join(" / ") };
    },
  });
}
