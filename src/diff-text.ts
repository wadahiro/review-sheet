// A unified diff over lines.
//
// A LEAF: it imports nothing of this package, so anything may use it. That is
// the whole reason it is its own file — the prompt builder, the apply core and
// the CLI all need to state "what changed in this text", and the alternative
// (prompt.ts reaching into the full-edit machinery, which reaches back into
// edits.ts, which imports prompt.ts) is a cycle.
//
// Its own implementation rather than a dependency: this is the one place the
// tool needs one, and the documents it runs over are a few hundred lines.

// A unified diff, so what could not be mapped is still stated exactly. Its own
// implementation (an LCS over lines) rather than a dependency: this is the one
// place the tool needs one, and two ~300-line documents are small.
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: { kind: " " | "-" | "+"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ kind: "-", text: a[i++] });
    } else {
      ops.push({ kind: "+", text: b[j++] });
    }
  }
  while (i < a.length) ops.push({ kind: "-", text: a[i++] });
  while (j < b.length) ops.push({ kind: "+", text: b[j++] });

  // Only what changed, with a few lines around it: a whole 300-line document
  // says nothing about what somebody did to it.
  //
  // Each run of kept lines is a HUNK, headed the way a unified diff heads one —
  // `@@ -12,7 +12,8 @@` — because the reader of this is going to open the file
  // and go there. Without the numbers they have to find the passage by eye, in
  // a document that may repeat it.
  const keep = new Set<number>();
  ops.forEach((op, n) => {
    if (op.kind === " ") return;
    for (let k = Math.max(0, n - context); k <= Math.min(ops.length - 1, n + context); k++) keep.add(k);
  });

  // Where each op sits in each side, 1-based, so a hunk can say where it starts.
  const oldLine: number[] = [];
  const newLine: number[] = [];
  let oi = 1;
  let ni = 1;
  for (const op of ops) {
    oldLine.push(oi);
    newLine.push(ni);
    if (op.kind !== "+") oi++;
    if (op.kind !== "-") ni++;
  }

  const out: string[] = [];
  let n = 0;
  while (n < ops.length) {
    if (!keep.has(n)) {
      n++;
      continue;
    }
    const start = n;
    while (n < ops.length && keep.has(n)) n++;
    const run = ops.slice(start, n);
    const oldCount = run.filter((op) => op.kind !== "+").length;
    const newCount = run.filter((op) => op.kind !== "-").length;
    // An empty side starts at the line BEFORE the hunk, which is what every
    // diff tool writes for a pure insertion or deletion.
    const oldStart = oldCount === 0 ? oldLine[start] - 1 : oldLine[start];
    const newStart = newCount === 0 ? newLine[start] - 1 : newLine[start];
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of run) out.push(`${op.kind}${op.text}`);
  }
  return out.join("\n");
}
