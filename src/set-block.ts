// The set, carried inside the page.
//
// A delivered document is read long after anyone can regenerate it, and the
// folder beside it is what the recipient edits. The page has to be able to hold
// that folder — otherwise it shows what it was BUILT with until somebody drags
// something onto it, which is a gesture to repeat after every edit and a
// document that is usually wrong.
//
// So the page carries a block, and one file is the whole delivery: the sheets,
// and the artifacts and evidence they link to. A link naming something the page
// carries opens beside the sheet; one naming anything else is left to the
// browser.
//
// Pure: it builds the text, it does not write it.

// The folder the document is in, beside the page that reads it.
//
// Three things at the top of a delivery, with one role each: the page you open,
// the note that says what this is, and the folder you edit. They used to be one
// folder, so the thing to open was inside the thing to edit — which works and
// reads as a riddle.
//
// The PAGE stays out of it, which is a version-control decision and not a
// tidiness one: it is 1.8 MB against the set's 1.3 MB and it is rewritten byte
// for byte on every regeneration (the model is gzipped into it), so a recipient
// who commits this document and reviews `git diff docs/` would be reading one
// enormous binary change instead of the line somebody corrected. Outside it,
// that diff is the text and nothing else — which is the whole reason this
// format exists. What it costs is stated rather than hidden: a checkout of
// `docs/` alone has no reader in it. The delivery is the folder, the archive
// wraps that folder, and the page can be regenerated; the text cannot.
//
// `docs` in English in both languages: it is a ROLE, and a recipient's own
// tooling, their assistant and this tool's own documentation all have to be
// able to say it without asking which delivery they are in.
export const SET_DIR = "docs";

export const SET_BLOCK_ID = "sheet-md-set";

// The name a page saves itself under, from the name it is open as.
//
// The delivery unpacks to `viewer.html` beside the `docs` folder, and the page
// that writes the set into itself IS that viewer — so saving under its own name
// replaces it. Under any other name every save is a new file and the original
// stays empty, which is what "sheet (1).html" beside an empty viewer was.
//
// A page renamed by whoever received it keeps that name: it is the one they
// will look for. The fallback is for a page opened from somewhere with no file
// name at all (a blob URL, a server route ending in `/`).
export function savedAs(pathname: string): string {
  const here = decodeURIComponent((pathname.split("/").pop() ?? "").trim());
  return here.toLowerCase().endsWith(".html") ? here : "viewer.html";
}

export const SET_BLOCK_OPEN = `<script type="application/json" id="${SET_BLOCK_ID}">`;

// The files, as the block's text.
//
// A `<` ANYWHERE in it would end the script element early and the rest of the
// page would become markup — which reads as a blank document, not as an error.
// Written `<`, which is the same character to anything reading the JSON
// and cannot end an element.
export const setBlockJson = (files: { path: string; text: string }[]): string =>
  JSON.stringify(files).replace(/</g, "\\u003c");

// The page, with the block replaced.
//
// Found by the block's ID rather than by the whole opening tag: an attribute
// written in another order would otherwise be a tag this does not recognise.
// Two indexOf calls and no parse, because the document is megabytes and parsing
// it froze the page for hundreds of milliseconds the last time this was done
// with a DOMParser.
export function spliceSetBlock(html: string, json: string): string {
  const at = html.indexOf(SET_BLOCK_ID);
  if (at < 0) throw new Error("this page does not carry a set — it was written by an older version");
  const from = html.indexOf(">", at) + 1;
  const to = html.indexOf("</script>", from);
  if (from <= 0 || to < 0) throw new Error("this page's set block is not closed");
  return `${html.slice(0, from)}\n${json}\n${html.slice(to)}`;
}

// The folder INPUT the page carries, and the app binds to.
//
// Dragging uses the entry API, which a `file://` page — the only kind a
// recipient with no toolchain can open — is refused by: measured on a real
// delivery, the first directory listing came back EncodingError before a file
// was touched. A picker goes through no entry API at all, so it works where the
// reader actually is. In the page rather than rendered by the app because a
// file input has to exist in the document to be clicked, and the app is a tree
// that redraws.
export const FOLDER_INPUT_ID = "rs-folder";
