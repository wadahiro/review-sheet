// Putting a large payload into the page WITHOUT making the page large.
//
// The output of this tool is one file that gets mailed around and opened from
// disk, and three of the things in it are big: the model (1.5 MB on a real
// project), the viewer, and — where a document draws one — the diagram
// renderer. All three are text, and text of this kind compresses about 5:1.
//
// gzip, decoded in the page by `DecompressionStream`, which every current
// browser has and which needs no network: the bytes travel as base64 inside the
// document, are inflated to a string, and used. Measured on a real sheet:
// 1.67 MB became 0.37 MB, and inflating 3.3 MB of javascript took 4 ms.
//
// base64 costs a third of what it saves back — 0.91 MB of gzip becomes 1.22 MB
// of text — and is still the right encoding: an HTML file is text, and the
// alternatives (a binary blob beside the file, a fetch) each give up the one
// property this output guarantees.
//
// NOT compressed: the review history (`sheet-reviews`). The CLI reads that back
// by scanning the file — `extractReviewsFromHtml` in edits.ts, deliberately
// without a DOM — and the viewer rewrites it on every save. It is small, it is
// the one block a human may want to read in a text editor, and both of those
// stop being true the moment it is bytes.
export function toBase64Gzip(text: string): string {
  return Buffer.from(Bun.gzipSync(Buffer.from(text, "utf-8"), { level: 9 })).toString("base64");
}

// The other half, as source for the page to carry. A plain <script>, not a
// module: it has to run before the module does, since the module IS one of the
// things it inflates.
//
// Everything it needs is standard and local — atob, DecompressionStream, Blob,
// URL.createObjectURL. The blob URL matters: importing a module from a string
// is otherwise impossible, and `blob:` is the browser's own memory, not a
// request.
export const BOOTSTRAP = `
(function () {
  var inflate = function (id) {
    var el = document.getElementById(id);
    if (!el) return null;
    var raw = atob(el.textContent.trim());
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  };
  // Exposed for the app to inflate what it needs LATER — a diagram renderer is
  // 3.3 MB that a reader who never opens the document should not wait for.
  window.__rsInflate = inflate;
  var css = inflate("sheet-style-gz");
  var data = inflate("sheet-data-gz");
  var app = inflate("sheet-app-gz");
  Promise.all([css, data, app]).then(function (parts) {
    if (parts[0]) {
      var style = document.createElement("style");
      style.textContent = parts[0];
      document.head.appendChild(style);
    }
    if (parts[1]) {
      var el = document.createElement("script");
      el.type = "application/json";
      el.id = "sheet-data";
      el.textContent = parts[1];
      document.body.appendChild(el);
    }
    if (parts[2]) {
      var url = URL.createObjectURL(new Blob([parts[2]], { type: "text/javascript" }));
      import(url).then(function () { URL.revokeObjectURL(url); });
    }
  }).catch(function (e) {
    // A browser without DecompressionStream, or a file somebody truncated. The
    // page would otherwise stay blank with nothing said.
    document.body.textContent = "This file needs a browser with DecompressionStream (any current one). " + e;
  });
})();
`;

// The inverse, for anything that wants the payload back out of a generated
// file. The CLI does NOT: what it reads back is the review history, which is
// deliberately left as text (see above). Tests use this, and so would any tool
// that wanted to look inside a delivered sheet.
export function readGzipBlock(html: string, id: string): string | null {
  const marker = html.indexOf(`id="${id}"`);
  if (marker < 0) return null;
  const open = html.indexOf(">", marker);
  const close = html.indexOf("</script>", open);
  if (open < 0 || close < 0) return null;
  // Buffer.from, not Uint8Array#toString — the latter gives "72,101,108" and
  // the mistake is silent until something reads the result.
  return Buffer.from(Bun.gunzipSync(Buffer.from(html.slice(open + 1, close).trim(), "base64"))).toString("utf-8");
}
