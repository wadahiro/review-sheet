// Document-level display switches: decided once when the file was generated,
// read wherever they apply.
//
// A module value rather than a prop threaded through every component, because
// that is what it is — one answer for the whole document, fixed before the
// first render, the same for every row. Threading it would put a boolean in
// eight signatures to reach three places that read it.
//
// Set from the embedded config at startup (see init), and by `Root` from its
// own prop so a test can render a document either way without a DOM config
// block.

let sources = true;

export function setShowSources(on: boolean): void {
  sources = on;
}

// Whether to show WHERE a value is written: the file name under a row's key,
// the "rendered from" line under a sheet's heading, the source line in a
// preview's header. See GenerateOptions.sources for why a reader might not want
// them — and for why the source map itself stays in the document either way.
export function showSources(): boolean {
  return sources;
}
