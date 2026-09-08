// The raw material a test result points at, turned into documents the record
// carries.
//
// A verdict names an address — `web01 /etc/httpd/conf/httpd.conf:12` — and
// the thing that address names lived only on a machine nobody reading the
// record can reach. This is the answer the artifact panel already gave the
// sheet's rows, one journey over: a row has an address, so give it a file to
// open; a verdict has an address, so give it the file it was read from.
//
// WHAT MAY TRAVEL IS NOT DECIDED HERE. The judge writing `results.evidence`
// knows which of a host's bytes may be published — it is the layer that already
// redacts a credential before it leaves the node — and this module carries what
// it is given. A tool deciding instead would be deciding for every project at
// once, on a rule none of them wrote.

import type { ArtifactPreview } from "./types.js";
import type { TestResults } from "./testresults.js";

// One document per (environment, host, subject). Never merged across hosts even
// when the bytes agree: the moment they were taken differs, and a record that
// merges them can no longer say which host a verdict was read from.
const idOf = (e: { instance: string; host: string; path?: string; command?: string }): string =>
  `observed ${e.instance} ${e.host} ${e.path ?? e.command ?? ""}`;

export function evidencePreviews(results: TestResults, instances: string[] | undefined): ArtifactPreview[] {
  const out: ArtifactPreview[] = [];
  for (const e of results.evidence ?? []) {
    // `--instances` narrows evidence exactly as it narrows values: an
    // environment a delivery does not cover is NOT IN THE FILE. The same claim
    // `restrictInstances` makes about columns — never a hidden section.
    if (instances !== undefined && !instances.includes(e.instance)) continue;
    out.push({
      id: idOf(e),
      sheet: e.sheet,
      ...(e.component === undefined ? {} : { component: e.component }),
      // A collected file's source IS the path it was read from — literally
      // true, and what the panel's header shows beside the host and the moment.
      // A command has no path on the host; the command itself is what it is.
      source_file: e.path ?? e.command ?? "",
      nature: "observed",
      observed: { host: e.host, at: e.at },
      instances: [e.instance],
      // Every line as collected. No `key` on any of them, deliberately: an
      // observed document is kept out of the row->preview index (app.ts), and a
      // key here is the one thing that could put it back in.
      lines: e.text
        .replace(/\n$/, "")
        .split("\n")
        .map((text) => ({ text, kind: "verbatim" as const })),
    });
  }
  return out;
}

// A verdict's evidence cell: the address it always carried, made a LINK to the
// document that address names — when that document is actually being carried.
//
// The rule is the artifact panel's own, applied one journey over: an affordance
// that opens nothing is worse than none. A delivery built without `--evidence`,
// or one whose environments were narrowed away, keeps the address as plain
// text — which is exactly what it was before any of this existed.
//
// The HOST is part of the match rather than decoration: two hosts hold the same
// file, a verdict was read from one of them, and a link to the other one's copy
// would show a reader bytes nobody judged.
export function evidenceCell(
  answer: { target: { instance: string }; evidence?: { host?: string; file?: string; line?: number; command?: string } } | undefined,
  carried: NonNullable<TestResults["evidence"]>
): string {
  const ev = answer?.evidence;
  if (ev === undefined) return "";
  const text = [ev.host, ev.file === undefined ? undefined : `${ev.file}${ev.line === undefined ? "" : `:${ev.line}`}`, ev.command]
    .filter((x): x is string => x !== undefined)
    .join(" ");
  const doc = carried.find(
    (d) =>
      d.instance === answer!.target.instance &&
      d.host === ev.host &&
      (ev.file !== undefined ? d.path === ev.file : d.command === ev.command)
  );
  if (doc === undefined) return text;
  const at = ev.line === undefined ? "" : `#L${ev.line}`;
  // A MARKDOWN link, not an `<a>`: the record is markdown a project owns, and
  // the renderer escapes raw HTML in it — deliberately, since the document's
  // text is not this tool's to inject markup into. An `<a>` came out as visible
  // `&lt;a href=…` in the cell, which is worse than the plain address it
  // replaced. The scheme is what the viewer listens for; the id holds spaces
  // and slashes, so it is encoded whole.
  return `[${text}](${EVIDENCE_SCHEME}${encodeURIComponent(`${idOf(doc)}${at}`)})`;
}

// The href an evidence link carries. Not a real scheme and not meant to be:
// nothing outside this page can resolve it, which is the point — the click is
// handled here or it does nothing.
export const EVIDENCE_SCHEME = "rs-evidence:";
