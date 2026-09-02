// Stable DOM ids for the things the outline and the search palette jump to.
//
// A leaf module (it imports nothing of this package) because two renderers need
// the SAME ids: the sheet's own, and the one that draws a sheet from the
// markdown it was handed over as. An id computed twice, differently, is an
// outline entry that jumps nowhere — which is exactly the failure this project
// treats as unacceptable everywhere else.

export function encodeIdPart(s: string): string {
  return s.replace(/[^A-Za-z0-9\u00A0-\uFFFF-]/g, (c) =>
    c === "_" ? "_5F" : `_${c.codePointAt(0)!.toString(16).toUpperCase().padStart(2, "0")}`
  );
}

export function navAnchorId(sheetIndex: number, path: string): string {
  return `nav-${sheetIndex}-${encodeIdPart(path)}`;
}

export function paramAnchorId(sheetIndex: number, path: string, key: string): string {
  return `${navAnchorId(sheetIndex, path)}--${encodeIdPart(key)}`;
}
