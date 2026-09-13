// A folder dropped on the page, read.
//
// This is how a recipient who has no toolchain looks at what they have edited.
// They hold a folder of markdown; the viewer holds the model it was written
// from. Dropping the folder replaces what is on screen with what the folder
// says — which is the only way the two can be kept honest, since nothing else
// in their hands can regenerate the page.
//
// Reading a DIRECTORY out of a drop is not `DataTransfer.files`: that flattens
// to the files a browser chose to expose and loses the tree the chapters are.
// `webkitGetAsEntry` walks it, and is what every browser implements under that
// name — the standardised `getAsFileSystemHandle` is not everywhere yet, and
// the fallback below covers a drop that is plain files anyway.

export type DroppedFile = { path: string; text: string };

type Entry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader: () => { readEntries: (cb: (es: Entry[]) => void, err: (e: unknown) => void) => void };
};

// The entry API rejects with a bare DOMException that names nothing, so a
// failure reads as "EncodingError" and the reader is left guessing which of
// fifty-nine files the browser refused — or whether it refused all of them.
// The path is attached here, where it is known.
const readFile = (e: Entry, at: string): Promise<File> =>
  new Promise((ok, no) =>
    e.file(ok, (err: unknown) => {
      const name = err instanceof Error ? err.name : "Error";
      const message = err instanceof Error ? err.message : String(err);
      no(new Error(`${at}: ${name}: ${message}`));
    })
  );

// A directory reader hands back a BATCH and has to be asked again until it
// hands back none — a hundred entries at a time in Chrome. Reading once looks
// like it works until a chapter has more files than the batch.
const readAll = (e: Entry): Promise<Entry[]> =>
  new Promise((ok, no) => {
    const out: Entry[] = [];
    const reader = e.createReader();
    const step = (): void =>
      reader.readEntries((es) => {
        if (es.length === 0) return ok(out);
        out.push(...es);
        step();
      }, (err: unknown) => {
        const name = err instanceof Error ? err.name : "Error";
        no(new Error(`${e.name}/: ${name}: ${err instanceof Error ? err.message : String(err)}`));
      });
    step();
  });

async function walk(entry: Entry, at: string, out: DroppedFile[]): Promise<void> {
  const here = at === "" ? entry.name : `${at}/${entry.name}`;
  if (entry.isFile) {
    // The whole folder except the page itself: the sheets, and the artifacts
    // and evidence they link to. Those are read as well because a page that
    // EMBEDS the set has to be able to open them — a link into the folder
    // resolves by itself only while the folder is beside the page.
    if (here.endsWith(".html")) return;
    out.push({ path: here, text: await (await readFile(entry, here)).text() });
    return;
  }
  if (!entry.isDirectory) return;
  for (const child of await readAll(entry)) await walk(child, here, out);
}

// Every markdown file of a dropped folder, keyed by its path WITHIN the folder
// — the dropped directory's own name is dropped, so `sheet/README.md` and
// `README.md` read the same whether the folder or its contents were dragged.
export async function filesFromDrop(dt: DataTransfer): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const items = [...dt.items].filter((i) => i.kind === "file");
  const entries = items
    .map((i) => (i as unknown as { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.() ?? null)
    .filter((e): e is Entry => e !== null);

  if (entries.length > 0) {
    for (const e of entries) await walk(e, "", out);
    // A folder was dragged, so every path starts with its name. Taking it off
    // makes the set look the same as one whose files were dragged loose.
    const roots = new Set(out.map((f) => f.path.split("/")[0]));
    if (roots.size === 1 && entries.length === 1 && entries[0]!.isDirectory) {
      const root = `${[...roots][0]!}/`;
      return out.map((f) => ({ ...f, path: f.path.slice(root.length) }));
    }
    return out;
  }

  // No entry API — a plain multi-file drop. The names are all there is.
  for (const f of [...dt.files]) {
    if (f.name.endsWith(".html")) continue;
    out.push({ path: f.name, text: await f.text() });
  }
  return out;
}

// The same set, from a folder the reader PICKED rather than dragged.
//
// Dragging uses the entry API, and a page opened by double-clicking a file is
// a `file://` page — where Chrome refuses to list a dropped directory at all.
// Measured on a real delivery: the very first `readEntries` came back
// `EncodingError`, before any file was touched, so the whole gesture the
// markdown hand-over rests on did nothing in exactly the setting it was built
// for. A recipient with no toolchain opens the page by double-clicking it;
// there is no other way for them.
//
// `<input type="file" webkitdirectory>` does not go through the entry API.
// Every File it yields carries `webkitRelativePath` — the path WITHIN the
// chosen folder, which is the same thing `walk` reconstructs a directory at a
// time — so this is the shorter road to the same place, and the one that works
// where the reader actually is.
export async function filesFromPicker(list: ArrayLike<File>): Promise<DroppedFile[]> {
  const files = [...(list as unknown as File[])];
  const out: DroppedFile[] = [];
  for (const f of files) {
    // `webkitRelativePath` is "" for a plain multi-file selection; the name is
    // then all there is, exactly as in the no-entry-API drop below.
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    const path = rel !== undefined && rel !== "" ? rel : f.name;
    if (path.endsWith(".html")) continue;
    out.push({ path, text: await f.text() });
  }
  // The chosen folder's own name prefixes every path, the same way a dragged
  // folder's does — taken off so a set reads the same whichever way it arrived.
  const roots = new Set(out.map((f) => f.path.split("/")[0]));
  if (roots.size === 1 && out.some((f) => f.path.includes("/"))) {
    const root = `${[...roots][0]!}/`;
    return out.map((f) => ({ ...f, path: f.path.slice(root.length) }));
  }
  return out;
}
