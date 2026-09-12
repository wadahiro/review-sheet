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
// Two things at the top of a delivery, with one role each: the file you open
// and the folder you drag. They used to be one folder, so the thing to drag was
// the folder holding the page you were looking at — which works and reads as a
// riddle. A ROLE rather than a chapter, so it is named in neither language.
export const SET_DIR = "sheet";

export const SET_BLOCK_ID = "sheet-md-set";

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
