// Several recipes, one sheet.
//
// A sheet is one page of a review, and a page of an incumbent parameter sheet
// is a HOST: `/etc/sysctl.d/override.conf`, then `/etc/chrony.conf`, then
// `/etc/logrotate.d/…`, read top to bottom. Which of those a tool happens to
// read from Ansible variables and which it reads as lines of a rendered file is
// an accident of how the project is built, and until now it decided the tab
// layout — one recipe per sheet meant one tab per recipe, so a reader had to
// hold "the host" together in their head across tabs the tool split for its own
// convenience.
//
// So a sheet may declare PARTS, each with its own recipe, and their results are
// merged into one. The merge is the whole of this module, and it is pure: every
// part is already a finished SheetInputs by the time it arrives.
//
// What makes it safe is that a part is scoped to COMPONENTS — the scoping the
// model already has. Rows are unique within a component, so two parts can only
// collide by both claiming one, and that is REPORTED rather than resolved: two
// recipes quietly overwriting each other's rows is the failure this project
// exists around.

import type { SheetInputs, ValueLayer, ExtractedMap } from "./assemble.js";

export type ComposeResult = { input: SheetInputs; conflicts: string[] };

// A part and what to call it in a conflict. Every part carries the SHEET's
// name — that is what makes them one sheet — so the name cannot tell two of
// them apart, and a report naming both sides identically is no report at all.
export type ComposePart = { label: string; input: SheetInputs };

const mergeMaps = <K, V>(maps: (Map<K, V> | undefined)[]): Map<K, V> | undefined => {
  const present = maps.filter((m): m is Map<K, V> => m !== undefined);
  if (present.length === 0) return undefined;
  const out = new Map<K, V>();
  for (const m of present) for (const [k, v] of m) out.set(k, v);
  return out;
};

const concat = <T>(lists: (T[] | undefined)[]): T[] | undefined => {
  const present = lists.filter((l): l is T[] => l !== undefined);
  return present.length === 0 ? undefined : present.flat();
};

// Which component a row belongs to, for collision reporting. An entry may name
// its own; otherwise the part's map answers, and failing both the part is
// single-component and its name stands in.
const componentOfKey = (si: SheetInputs, key: string, entryComponent: string | undefined): string =>
  entryComponent ?? si.componentOf?.get(key) ?? si.name;

export function composeSheet(name: string, declared: ComposePart[]): ComposeResult {
  const parts = declared.map((p) => p.input);
  const labelOf = new Map(declared.map((p) => [p.input, p.label]));
  const conflicts: string[] = [];
  // (component, key) -> the part that already claimed it.
  const claimed = new Map<string, string>();
  const claim = (component: string, key: string, part: string): boolean => {
    const k = `${component}\u0000${key}`;
    const first = claimed.get(k);
    if (first !== undefined) {
      conflicts.push(
        `sheet "${name}": "${key}" is produced by two parts (${first} and ${part})` +
          (component === name ? "" : ` under component "${component}"`) +
          " — scope each part to its own component, or drop one of them"
      );
      return false;
    }
    claimed.set(k, part);
    return true;
  };

  // One base layer, and one overlay per instance: the shape assembleSheets
  // requires, rebuilt rather than concatenated, because two parts each hand
  // over a base of their own.
  const base: ExtractedMap = new Map();
  const overlays = new Map<string, ExtractedMap>();
  for (const si of parts) {
    for (const layer of si.layers) {
      if (layer.kind === "base") {
        for (const [key, entry] of layer.entries) {
          if (!claim(componentOfKey(si, key, entry.component), key, labelOf.get(si)!)) continue;
          base.set(key, entry);
        }
        continue;
      }
      // An overlay restates a key the base already has, per environment; it is
      // not a second claim on that key.
      const into = overlays.get(layer.instance) ?? new Map();
      overlays.set(layer.instance, into);
      for (const [key, entry] of layer.entries) into.set(key, entry);
    }
  }

  const embedded = parts.flatMap((si) =>
    si.embedded.filter((e) => claim(componentOfKey(si, e.key, e.component), e.key, labelOf.get(si)!))
  );

  const layers: ValueLayer[] = [
    { kind: "base", entries: base },
    ...[...overlays].map(([instance, entries]): ValueLayer => ({ kind: "overlay", instance, entries })),
  ];

  // A part's own `filePath`/`sourceFile` is a SHEET-level display fallback and
  // there is no longer one sheet's worth of it — the parts are different files,
  // which is the point. Each part's per-component files survive in
  // componentFiles, which is where a multi-file sheet has always kept them.
  const documents = parts.filter((si) => si.document !== undefined);
  if (documents.length > 1) {
    conflicts.push(`sheet "${name}": more than one part renders a document, and a sheet has room for one`);
  }

  // Every part's account of how a dictionary's keys relate to its rows. One
  // sheet has one, so parts that disagree cannot both be honoured — said out
  // loud, with the way out named, rather than the first one quietly winning.
  const stepSets = new Set(parts.map((si) => JSON.stringify(si.dictKeySteps ?? null)));
  if (stepSets.size > 1) {
    conflicts.push(
      `sheet "${name}": its parts imply different dictionary key rewrites — declare "key_steps" on each dictionary binding instead, where it can be scoped to a component`
    );
  }

  const input: SheetInputs = {
    name,
    dimension: parts.find((si) => si.dimension !== undefined)?.dimension,
    // Every part was handed the SHEET's instances, so they already agree; the
    // first is as good as any.
    instances: parts[0]?.instances ?? [],
    layers,
    embedded,
    artifacts: concat(parts.map((si) => si.artifacts)),
    document: documents[0]?.document,
    dictKeySteps: parts.find((si) => si.dictKeySteps !== undefined)?.dictKeySteps,
    templateVariables: concat(parts.map((si) => si.templateVariables)),
    keyMap: concat(parts.map((si) => si.keyMap)),
    componentOf: mergeMaps(parts.map((si) => si.componentOf)),
    componentLabels: mergeMaps(parts.map((si) => si.componentLabels)),
    componentFiles: mergeMaps(parts.map((si) => si.componentFiles)),
    deployedFiles: mergeMaps(parts.map((si) => si.deployedFiles)),
    // Declaration order across parts: the sheet is read top to bottom and the
    // parts are written in the order they should be read.
    componentOrder: concat(parts.map((si) => si.componentOrder)),
    referenceSites: concat(parts.map((si) => si.referenceSites)),
    nestedMembers: mergeMaps(parts.map((si) => si.nestedMembers)),
    authoredKeys: parts.some((si) => si.authoredKeys !== undefined)
      ? new Set(parts.flatMap((si) => [...(si.authoredKeys ?? [])]))
      : undefined,
  };
  return { input, conflicts };
}
