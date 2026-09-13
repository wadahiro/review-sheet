// The documents a sheet's rows are ABOUT, as files of the set — and where in
// each of them a row's value is written.
//
// Pure, and its own module rather than a corner of the CLI, because the second
// half is a claim that has to be checkable: a link naming a line of a file is
// right or wrong, and wrong quietly. What decides it is this file's own rule
// about which lines are WRITTEN OUT, so the count lives beside the filter it
// depends on and nowhere else.

import type { ArtifactPreview } from "./types.js";
import { slug, modelStamp } from "./md-set.js";

// The documents a sheet's rows are about, as files of the set.
//
// Three kinds, told apart by the directory they land in rather than by a header
// in the file — the file has to BE the file, so it can be diffed against the
// real one:
//
//   artifacts/  what the deployed file says, rendered
//   sources/    the authored file it was rendered from
//   evidence/   the bytes a host was found holding, and when
//
// All three relative to the SHEET'S own directory, so the chapter that
// describes a file holds it. A single bucket at the root would be a second,
// type-shaped arrangement laid over the chapters the document already has.
// A command, as one path segment. Readable rather than hashed — a reader
// scanning the directory should see which command a file holds — and cut to a
// length every filesystem takes.
//
// A cut name gets the command's own digest on the end. Without it two long
// commands that agree for their first sixty characters are one file, and the
// second is dropped: measured on a real record, two `.well-known` fetches that
// differ only past the cut. The digest is only on the names that needed it, so
// a short command stays exactly itself.
function commandFile(command: string): string {
  const one = command.replace(/\s+/g, " ").trim();
  const named = slug(one).trim();
  if (named.length <= 60) return `${named}.txt`;
  return `${named.slice(0, 60).trim()}-${modelStamp(one).slice(0, 8)}.txt`;
}

// …and where in each of them a row's value is written, counted HERE, over the
// very lines this function joins. A link into one of these files names a line
// number, and the file is NOT the preview line for line — an `absent` line is
// not written out — so a second count kept somewhere else would be right until
// the first template with a `{% if %}` in it, and wrong from then on, silently.
export type CarriedDocument = {
  path: string;
  text: string;
  sheet: string;
  label: string;
  lineOf: (key: string) => number | undefined;
};

export function carriedDocuments(previews: ArtifactPreview[], instances: string[]): CarriedDocument[] {
  const strip = (f: string): string => f.replace(/^\/+/, "");
  return previews.map((p) => {
    // An `absent` line is one this environment does not render. The file on
    // disk does not have it, so neither does this — the point of writing it out
    // is that it can be compared with the real thing.
    const kept = p.lines.filter((l) => l.kind !== "absent");
    const text = kept.map((l) => l.text).join("\n");
    const at = new Map<string, number>();
    kept.forEach((l, i) => {
      for (const k of l.keys ?? (l.key === undefined ? [] : [l.key])) if (!at.has(k)) at.set(k, i + 1);
    });
    const lineOf = (key: string): number | undefined => at.get(key);
    if (p.nature === "observed") {
      const from = p.deployed_path ?? p.source_file;
      const host = p.observed?.host ?? "host";
      const instance = p.instances?.[0] ?? "";
      const under = `evidence/${instance === "" ? "" : `${instance}/`}${host}`;
      // A collected FILE is named by the absolute path the host holds it at —
      // that is how a host names a file, and it makes the tree under `evidence`
      // read like the machine it came from. Everything else is the output of a
      // COMMAND, and a command is not a path: it has quotes, spaces and
      // newlines in it, and used as a filename it produced directories nobody
      // asked for and one write that failed outright.
      const isFile = from.startsWith("/");
      const named = isFile ? strip(from) : `commands/${commandFile(from)}`;
      return { sheet: p.sheet, path: `${under}/${named}`, text, label: `${host} ${from}`, lineOf };
    }
    if (p.nature === "source") {
      return { sheet: p.sheet, path: `sources/${strip(p.source_file)}`, text, label: p.source_file, lineOf };
    }
    // An artifact rendered identically everywhere is written once; one that
    // differs per environment is written per environment, under the names it
    // covers — which is what having a file per environment means.
    const covers = p.instances ?? [];
    const everywhere = covers.length === 0 || instances.every((i) => covers.includes(i));
    const to = strip(p.deployed_path ?? p.source_file);
    return {
      sheet: p.sheet,
      path: `artifacts/${everywhere ? "" : `${covers.join("+")}/`}${to}`,
      text,
      label: `${p.deployed_path ?? p.source_file}${everywhere ? "" : ` (${covers.join(", ")})`}`,
      lineOf,
    };
  });
}

// The address a row's link carries: the file, and the line in it.
//
// `candidates` is the document the row resolved to, then the other copies of
// the SAME file in model order — one per environment, where the file differs by
// environment. The first that actually holds the row's line wins.
//
// That preference is the whole reason this takes a list. A row whose line this
// environment does not render has no line in this environment's copy, because
// the line is not written out — the file on disk does not have it. Another
// environment's copy does, and that is where a reader asking "show me this
// setting" has to be sent: an address with no line opens the file at the top,
// which is the affordance-that-opens-nothing this project keeps refusing to
// ship. Measured on a real delivery: three rows, one of them the
// `<LocationMatch>` the admin console sits behind.
//
// Which environment they are then looking at is said by the file's own name
// (`artifacts/production/…`) and by the row's own value columns. A row NO copy
// renders — a branch this deployment never takes — keeps the plain address,
// since there is no line anywhere to send anyone to.
export function addressOf(candidates: readonly CarriedDocument[], key: string): string | undefined {
  const first = candidates[0];
  if (first === undefined) return undefined;
  const doc = candidates.find((d) => d.lineOf(key) !== undefined) ?? first;
  const line = doc.lineOf(key);
  return `${doc.path}${line === undefined ? "" : `#L${line}`}`;
}
