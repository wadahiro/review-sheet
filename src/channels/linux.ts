// What the kernel and the usual userland report about a running process.
//
// Both readings below are formats, not policies: `/proc/<pid>/limits` prints a
// fixed three-column table, and `ss -lntp` prints an address and a port in a
// column whose position is the only thing that says which is which. A project
// re-deriving either gets one regex right and the next one subtly wrong — and a
// wrong column reads as a perfectly good answer.

// `Max open files   <soft>   <hard>   files` — the limit the process actually
// got, which is what a unit's `LimitNOFILE` is a claim about.
export function maxOpenFiles(text: string | null | undefined): { soft: string; hard: string } | undefined {
  const m = /^Max open files\s+(\S+)\s+(\S+)/m.exec(text ?? "");
  return m === null ? undefined : { soft: m[1]!, hard: m[2]! };
}

// The ports something is listening on, from `ss -lntp`. The address column
// carries the interface too (`127.0.0.1:8080`, `*:443`, `[::]:80`), and the
// PORT is what a design states — so the address is dropped here rather than in
// each caller's own copy of the split.
export function listeningPorts(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const line of (text ?? "").split("\n")) {
    const m = /^\S+\s+\S+\s+\S+\s+(\S+):(\d+)\s/.exec(line.trim());
    if (m !== null) out.add(m[2]!);
  }
  return out;
}
