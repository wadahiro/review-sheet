// GATHERING, through whatever already reaches the host.
//
// The tool does not reach. What it does here is run the command the OPERATOR
// gave it — `docker exec {host} sh -c {cmd}`, `kubectl exec {host} -- sh -c
// {cmd}`, `ssh {host} {cmd}` — so the credentials, the audit trail and the
// network path stay with the thing that already had them, exactly as they do
// when the Ansible role runs `slurp` under Ansible's own identity. What this
// adds is everything that is the same in all of them: which files, which
// commands, following the ones a configuration NAMES, and the shape the judge
// declares.
//
// It is the SECOND way to produce an observation, not a replacement for the
// first: a closed network that has Ansible and nothing else uses the role, and
// a laptop or a CI job with `docker`/`kubectl` on the PATH uses this.

import type { CollectPlan } from "./judge.js";

// What ran, and what it said. `null` is "the host does not have it", which is
// an answer and not a gap — the judge tells it from an empty output.
export type Ran = { ok: boolean; out: string };
export type RunCommand = (host: string, command: string) => Ran;

// A command template with {host} and {cmd} in it. `{cmd}` is substituted with
// the command SHELL-QUOTED, because it travels as one argument of the outer
// command and a space in it would otherwise split into two.
export function reachWith(template: string, host: string, command: string): string[] {
  const quoted = `'${command.replace(/'/g, `'\\''`)}'`;
  const line = template.replace(/\{host\}/g, host).replace(/\{cmd\}/g, quoted);
  return ["sh", "-c", line];
}

const NOT_THERE = /No such file or directory|not found|cannot access|is a directory/i;

// One host's half of an observation. Everything a collector does that is not
// about the project: read the files, run the commands, follow what the files
// name.
export function collectHost(plan: CollectPlan, environment: string, host: string, run: RunCommand): {
  files: Record<string, string | null>;
  included_by: Record<string, string[]>;
  included: Record<string, string | null>;
  commands: Record<string, string | null>;
} {
  const files: Record<string, string | null> = {};
  for (const path of plan.files[environment] ?? []) {
    const r = run(host, `cat ${path}`);
    files[path] = r.ok ? r.out : null;
  }
  const commands: Record<string, string | null> = {};
  for (const command of plan.commands ?? []) {
    const r = run(host, command);
    // A command that FAILED but still printed is kept: `rpm -q` exits non-zero
    // for a batch with one package missing and prints the rest, and discarding
    // that loses every answer it gave.
    //
    // The trailing newline of a COMMAND's output is punctuation and is dropped,
    // as Ansible's own `command` drops it — two collectors of the same host
    // must produce the same bytes, and these were one byte apart, which shows
    // up only when the two records are compared and EVERY command reads as
    // different. A FILE's trailing newline is content and is kept, which is
    // why this happens here and not in whatever runs the command.
    commands[command] = r.ok || r.out !== "" ? r.out.replace(/\r?\n$/, "") : null;
  }
  // …and the files those files NAME, using the product's grammar as the plan
  // states it. The glob is expanded ON THE HOST, because that is where the
  // files are.
  const included_by: Record<string, string[]> = {};
  const included: Record<string, string | null> = {};
  for (const inc of plan.includes ?? []) {
    const text = files[inc.file];
    if (typeof text !== "string") continue;
    const root = inc.root === undefined ? "" : (new RegExp(inc.root, "m").exec(text)?.[1] ?? "");
    const found: string[] = [];
    for (const m of text.matchAll(new RegExp(inc.pattern, "gm"))) {
      const glob = m[1]!;
      const abs = glob.startsWith("/") ? glob : `${root}/${glob}`;
      const ls = run(host, `ls -1 ${abs}`);
      if (!ls.ok) continue;
      for (const p of ls.out.split("\n").map((x) => x.trim()).filter((x) => x !== "" && !NOT_THERE.test(x))) {
        if (found.includes(p)) continue;
        found.push(p);
        const r = run(host, `cat ${p}`);
        included[p] = r.ok ? r.out : null;
      }
    }
    if (found.length > 0) included_by[inc.file] = found;
  }
  return { files, included_by, included, commands };
}
