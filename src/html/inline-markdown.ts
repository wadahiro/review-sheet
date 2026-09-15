// Inline markdown, for one cell.
//
// Its own renderer, deliberately: a cell is a name, a value or a sentence —
// code spans, emphasis, links — and handing each of a sheet's ~1500 cells to a
// full markdown parser costs more than it returns. Everything not recognised is
// escaped and shown as written, which is the only safe reading of text somebody
// typed.
//
// Its own MODULE because it is what a second renderer left behind. The sheet
// draws every page now, markdown-backed or not, and a cell's prose goes through
// here either way — a helper reached through the file it happened to be born in
// is a file kept alive for one function.

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => ESCAPE[c]);

export function inlineMarkdown(text: string): string {
  const out: string[] = [];
  // Code spans first and whole: their content is literal, so nothing inside one
  // may be re-read as markup.
  for (const part of text.split(/(`[^`]*`)/g)) {
    if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
      out.push(`<code>${escapeHtml(part.slice(1, -1))}</code>`);
      continue;
    }
    out.push(
      escapeHtml(part)
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        // A newline inside a cell was written as <br> by the projection and
        // escaped back to text on the way in; this is the display end of it.
        .replace(/\n/g, "<br>")
    );
  }
  return out.join("");
}
