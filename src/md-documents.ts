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
// The level that says WHICH environments a carried file is for, when it is all
// of them. `common` is the word this model already uses for one value that
// holds everywhere (types.ts's `origin: "common"`).
const COMMON = "common";

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

// One path per document, decided HERE and nowhere else.
//
// Every consumer resolves a link through the CarriedDocument it holds — the row
// addresses (`addressOf`), the set's own files — so a path renamed anywhere
// downstream would move the file and leave the links behind.
//
// The collision is real rather than theoretical: the per-environment level
// shares a namespace with the paths themselves. A file written only for
// `staging` lands at `artifacts/staging/…`, and so does one whose own path
// simply begins with `staging/` — which is what a repository laying its
// configuration out per environment looks like. Rather than restructure every
// delivered path for it, the second document is given a name of its own, the
// same way `commandFile` separates two long commands that agree to the
// character it cuts at.
function withDistinctPaths(docs: CarriedDocument[]): CarriedDocument[] {
  const taken = new Map<string, string>();
  return docs.map((d) => {
    const already = taken.get(d.path);
    if (already === undefined) {
      taken.set(d.path, d.text);
      return d;
    }
    // The same bytes at one path is one document emitted twice: nothing to
    // choose between, and one file is the right answer.
    if (already === d.text) return d;
    const at = d.path.lastIndexOf(".");
    const cut = at > d.path.lastIndexOf("/") ? at : d.path.length;
    const moved = `${d.path.slice(0, cut)}-${modelStamp(d.text).slice(0, 8)}${d.path.slice(cut)}`;
    taken.set(moved, d.text);
    return { ...d, path: moved };
  });
}

export function carriedDocuments(previews: ArtifactPreview[], instances: string[]): CarriedDocument[] {
  return withDistinctPaths(carriedDocumentsRaw(previews, instances));
}

function carriedDocumentsRaw(previews: ArtifactPreview[], instances: string[]): CarriedDocument[] {
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
    //
    // WHICH environments is ALWAYS a level of its own, `common` when the file
    // is the same in all of them. It used to appear only when the file
    // differed, which put the environment names in the same namespace as the
    // paths: a file written for `staging` alone landed at
    // `artifacts/staging/…`, and so did one whose own path simply begins with
    // `staging/` — which is what a repository laying its configuration out per
    // environment looks like. Two different files, one path. A level that is
    // always there cannot be mistaken for a path segment, and it reads better
    // besides: every file says which environments it is for instead of leaving
    // the reader to infer it from the absence of a directory.
    const covers = p.instances ?? [];
    const everywhere = covers.length === 0 || instances.every((i) => covers.includes(i));
    const to = strip(p.deployed_path ?? p.source_file);
    return {
      sheet: p.sheet,
      path: `artifacts/${everywhere ? COMMON : covers.join("+")}/${to}`,
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
