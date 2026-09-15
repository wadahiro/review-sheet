// Which previewed file a row belongs to, and where in it the row's line sits.
//
// Pure, and shared, because two different consumers ask it: the viewer, to
// decide whether a row gets a "show me this line in the file" affordance at
// all, and `md-set`, to write that affordance down as a LINK into the carried
// set. The two must never disagree — a row the viewer offers a file for and the
// markdown does not is the same document answering one question two ways
// depending on which of them a reader happens to be holding.
//
// It lived in `html/app.ts` first, as two `useMemo`s and a `useCallback`. What
// moved here is the resolution; the memoisation stays with the caller that
// needs it.

import type { ArtifactPreview } from "./types.js";

// Not a character any of the parts can contain: a sheet name, a component and
// a key are all text somebody typed. Written as an escape, never as the byte
// itself — this repository refuses a control character in its source.
const SEP = "\u0000";

export type ArtifactIndex = {
  // The PREVIEW a row's line lives in, or undefined where none has a line for
  // it — a product default, a variable-axis sheet. A row with no file gets no
  // affordance rather than one that opens nothing.
  //
  // The preview and not its id, because an id does not always identify one
  // file. Two previews of one sheet are meant to share an id only when they are
  // instance variants of the SAME file (the viewer draws those as tabs), and a
  // producer that omits the file discriminator `previewId` offers can hand two
  // genuinely different files one id — measured on a shipped fixture, an
  // Ansible sheet with both a `template:` and a `static_files:` entry. The
  // viewer survives that (it opens the id and the reader sees tabs); a link
  // written into a markdown set does not, because it has to name ONE file on
  // disk. Resolving to the preview is right either way.
  previewFor: (sheet: string, categoryPath: string, key: string) => ArtifactPreview | undefined;
  // Same lookup, as the viewer asks it.
  idFor: (sheet: string, categoryPath: string, key: string) => string | undefined;
};

// Deliberately NOT here: which LINE of that file. The viewer opens the panel by
// KEY and lets it find the line; the markdown set writes a `#L<n>` into a file
// it has just written out, and that file is not the preview line for line — an
// `absent` line is not written, because the point of carrying the file is that
// it can be diffed against the real one. Two numberings, each right where it is
// counted, and one shared function returning one of them would be wrong in the
// other place with nothing to notice.

export function buildArtifactIndex(previews: readonly ArtifactPreview[] | undefined): ArtifactIndex {
  // …and never an OBSERVED one. Its lines carry the same keys — it is the same
  // file, read off a host — so admitting it here would make a row's "show me
  // this line" open the evidence or the rendered artifact depending on which
  // was emitted last. The row's document is the one this sheet describes;
  // evidence is reached from the record that cites it.
  const mine = (previews ?? []).filter((a) => a.nature !== "observed");

  // Keyed by sheet AND component, never by key alone. Two components of one
  // sheet share a key space by design — a Keycloak realm sheet has `enabled`
  // under every realm — so a component-scoped index is what stops a row
  // offering to open a file that has no line for it. Measured on a real sheet:
  // 28 lines in one file were matching 46 rows.
  // FIRST wins. Instance variants of one file agree on their id, so which of
  // them answers changes nothing the viewer can see; where two previews of one
  // sheet and component genuinely both claim a key, first-in-model-order is at
  // least the same answer every time this runs, which a link written into a
  // delivered document has to be.
  const byRow = new Map<string, ArtifactPreview>();
  for (const a of mine) {
    for (const line of a.lines) {
      // Every row the line IS, not only the one it jumps back to: a line
      // holding two settings is two rows, and both want the affordance.
      for (const k of line.keys ?? (line.key === undefined ? [] : [line.key])) {
        const at = [a.sheet, a.component ?? "", k].join(SEP);
        if (!byRow.has(at)) byRow.set(at, a);
      }
    }
  }

  // Every name a sheet's outermost category could be wearing, against the
  // component the previews are indexed by.
  //
  // Two things had to go: splitting the category path on "/" to get its head —
  // a component that is a deployed file contains one, so that took the empty
  // string before the leading slash — and then assuming the head IS the
  // component. It need not be. A component is free to be a short alias
  // (`keycloak.conf`) while the category is the file it deploys
  // (`/opt/keycloak/conf/keycloak.conf`), and after the category-naming fixes
  // that is the ordinary case, not a corner. The artifact knows both, so both
  // are keys here.
  const componentByCategory = new Map<string, Map<string, string>>();
  const add = (sheet: string, name: string | undefined, component: string): void => {
    if (name === undefined || name === "") return;
    const m = componentByCategory.get(sheet) ?? new Map<string, string>();
    if (!m.has(name)) m.set(name, component);
    componentByCategory.set(sheet, m);
  };
  for (const a of mine) {
    if (a.component === undefined) continue;
    add(a.sheet, a.component, a.component);
    add(a.sheet, a.deployed_path, a.component);
  }

  const previewFor = (sheet: string, categoryPath: string, key: string): ArtifactPreview | undefined => {
    // The component is the outermost category, exactly as `assembleSheets`
    // resolves it for a per-component binding — and it collapses away on a
    // single-component sheet, which is why the unscoped lookup is the
    // fallback rather than an error.
    //
    // Read off the names that EXIST rather than by splitting the path: the
    // separator is "/" and a category naming a deployed file contains one.
    // Longest first, so a name nested inside another wins.
    const known = [...(componentByCategory.get(sheet)?.entries() ?? [])].sort((a, b) => b[0].length - a[0].length);
    const head =
      known.find(([name]) => categoryPath === name || categoryPath.startsWith(`${name}/`))?.[1] ??
      categoryPath.split("/")[0] ??
      "";
    return (
      byRow.get([sheet, head, key].join(SEP)) ??
      byRow.get([sheet, "", key].join(SEP)) ??
      // …and a document that does not say which sheet it belongs to answers for
      // any of them. That is never a model's preview — a producer always names
      // the sheet, and the scoping above exists because two components of one
      // sheet share a key space. It is what a set read back out of a FOLDER
      // has: one file is one file there, and seven sheets of one real delivery
      // point into the same realm document, so naming a sheet at all would give
      // six of them nothing. The keys are collected from every page that points
      // into it, so the answer is the same whichever asks.
      byRow.get(["", "", key].join(SEP))
    );
  };

  return { previewFor, idFor: (sheet, categoryPath, key) => previewFor(sheet, categoryPath, key)?.id };
}
