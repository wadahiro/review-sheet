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

// Which document CITES each evidence id, by sheet name. Two things at once,
// and deliberately one map rather than two: the set of ids decides what has to
// travel whatever `instances` says (see the narrowing below), and the sheet
// each is under decides WHERE it travels to (see `sheet` below). Both are
// answers to "who points at this", and splitting them would let a delivery
// carry a document it then files away from the record that named it.
export type CitedBy = ReadonlyMap<string, string>;

export function evidencePreviews(
  results: TestResults,
  instances: string[] | undefined,
  cited?: CitedBy
): ArtifactPreview[] {
  const out: ArtifactPreview[] = [];
  // Two documents at one address is a judge bug, and a silent one: the link a
  // verdict carries resolves to whichever was emitted first, so a reader can be
  // shown bytes that are not the ones that verdict was read from. Reported
  // rather than deduped — which of the two is right is not this tool's to
  // decide, and quietly picking one is exactly the failure it would be hiding.
  const seen = new Map<string, number>();
  for (const e of results.evidence ?? []) seen.set(idOf(e), (seen.get(idOf(e)) ?? 0) + 1);
  const twice = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  if (twice.length > 0) {
    console.error(
      `evidence: ${twice.length} document(s) carried more than once, so a verdict citing one gets whichever came first — ` +
        twice.slice(0, 3).join(", ") + (twice.length > 3 ? ", …" : "")
    );
  }
  for (const e of results.evidence ?? []) {
    // `--instances` narrows evidence exactly as it narrows values: an
    // environment a delivery does not cover is NOT IN THE FILE. The same claim
    // `restrictInstances` makes about columns — never a hidden section.
    //
    // …unless a document THIS delivery carries already cites it. A unit-test
    // record is a document sheet: its verdicts are baked in at import and
    // `--instances` does not narrow them, so a delivery for staging and
    // production still hands over every verdict read on `local` — and dropping
    // the bytes those verdicts name left 346 links opening nothing on one real
    // delivery. A record that travels and evidence that does not is one
    // document contradicting itself.
    //
    // Carrying it adds no exposure the record did not already have: the judge
    // decided what may travel and redacted before this file was written (see
    // this module's own contract), and the verdict citing the address is in the
    // reader's hands either way.
    if (instances !== undefined && !instances.includes(e.instance) && cited?.has(idOf(e)) !== true) continue;
    out.push({
      id: idOf(e),
      // BESIDE THE RECORD THAT CITES IT — never beside the rows it is about.
      //
      // `e.sheet` is the parameter sheet whose values this evidence answers
      // for, and for everything the judge does that is the right anchor. It is
      // the wrong one for a document SET, where a carried file is written under
      // its sheet's own chapter: the bytes then land in the design chapter
      // while the unit-test record holding every link to them sits in another,
      // so the reader follows a link out of the chapter they are reading and
      // the record's own directory holds nothing it refers to.
      //
      // The rule the set already follows is "artifacts beside the chapter that
      // describes the file, evidence beside the record that cites it"
      // (md-set.ts); this is the half that was stated and not implemented.
      // Moving it also gives the record a route a plain markdown reader can
      // follow — the file list under its title becomes relative links into its
      // own chapter — which the inline `rs-evidence:` links never were.
      //
      // Evidence NOTHING cites keeps `e.sheet`: there is no record to sit
      // beside, and the rows it answers for are the only anchor left.
      sheet: cited?.get(idOf(e)) ?? e.sheet,
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

// The model with the collected evidence taken back out — the model as the file
// on disk holds it.
//
// Evidence is carried BESIDE a model and is never part of one: `--evidence`
// reads a separate results file and appends observed documents to each
// version's `artifacts` at generate time, and the model an import wrote has
// never held them. Anything that IDENTIFIES the model therefore has to take
// them back out, or it identifies the delivery's flags instead.
//
// Which is not hypothetical: a markdown set's stamp is taken over the model and
// `verify --md` re-takes it over the model FILE, so every evidence-carrying
// delivery was reported stale the moment it was written — a gate that could
// only fail, with nothing the reader could do to make it pass. Both sides go
// through this one function, so the two can never disagree about what the model
// is.
type WithArtifacts = { artifacts?: ArtifactPreview[] };

function withoutObserved<V extends WithArtifacts>(v: V): V {
  const held = v.artifacts;
  if (held === undefined) return v;
  const kept = held.filter((a) => a.nature !== "observed");
  // Nothing left is NO KEY, whether or not there was one before. This is the
  // exact inverse of appending — which creates the key on a model that had
  // none — and an `artifacts: []` a model genuinely carries is stamped the same
  // way on both sides, which is all the check asks of it.
  if (kept.length === 0) {
    const { artifacts: _dropped, ...rest } = v;
    return rest as V;
  }
  return kept.length === held.length ? v : { ...v, artifacts: kept };
}

export function withoutEvidence<T extends WithArtifacts & { versions?: WithArtifacts[] }>(model: T): T {
  if (model.versions === undefined) return withoutObserved(model);
  return { ...model, versions: model.versions.map(withoutObserved) };
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
  answer: { instance: string; evidence?: { host?: string; file?: string; line?: number; command?: string } } | undefined,
  carried: NonNullable<TestResults["evidence"]>
): string {
  const ev = answer?.evidence;
  if (ev === undefined) return "";
  const text = [ev.host, ev.file === undefined ? undefined : `${ev.file}${ev.line === undefined ? "" : `:${ev.line}`}`, ev.command]
    .filter((x): x is string => x !== undefined)
    .join(" ");
  const doc = carried.find(
    (d) =>
      d.instance === answer!.instance &&
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
  return `[${text}](${EVIDENCE_SCHEME}${ref(`${idOf(doc)}${at}`)})`;
}

// An id, as a markdown link destination.
//
// `encodeURIComponent` leaves PARENTHESES alone and a destination ends at the
// first `)`, so an id with a bracket in it produced a link that stopped inside
// itself — measured on a real record: one HTTP request whose id names the Host
// header it was sent with, whose link therefore opened nothing AND whose
// truncated id matched no document, so the bytes it named were dropped from the
// delivery as uncited. The same fix `md-set.ts`'s `href` makes for a path, for
// the same reason; separate because that one encodes a PATH and this encodes
// one whole component.
const ref = (id: string): string => encodeURIComponent(id).replace(/\(/g, "%28").replace(/\)/g, "%29");

// The href an evidence link carries. Not a real scheme and not meant to be:
// nothing outside this page can resolve it, which is the point — the click is
// handled here or it does nothing.
export const EVIDENCE_SCHEME = "rs-evidence:";
