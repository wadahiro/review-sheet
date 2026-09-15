// One control of the product's own screen whose value is a TUPLE over several
// rows — see types.ts's `composite` for what it means and why the rows are not
// folded into one.
//
// Its own module because there are now TWO readers of it: the viewer draws the
// control as a row above the rows that spell it, and the markdown projection
// writes the same row into a handed-over set. A document that showed the
// control in one reading and not the other would be one model saying two
// different things depending on which half of this tool the reader is holding —
// the asymmetry `md-set.ts` exists to remove.
//
// Everything here is DERIVED and stored nowhere: which choice a tuple spells is
// read off the rows every time, so the sheet and the screen cannot drift.

import { pickLang, type LangText } from "./types.js";
import type { Lang } from "./html/i18n.js";

// The shape both readers need. Deliberately not `ParamData` or `Parameter`: the
// viewer's row type and the model's are different types with the same fields,
// and this asks for exactly the four it uses.
export type ControlRow = {
  key: string;
  value?: string;
  default?: string;
  baseline?: string;
  instances?: { name: string; value?: string }[];
  composite?: {
    control: LangText | string;
    description?: LangText | string;
    of: string[];
    modes: { label: LangText | string; label_other?: string; values: Record<string, string> }[];
  };
};

// Which control a row belongs to, as text: the control's name and the fields it
// writes. Two controls of one product with the same name over different fields
// are different controls, and a sheet can hold both.
export const controlKey = (p: ControlRow, lang: Lang): string =>
  p.composite === undefined ? "" : `${pickLang(p.composite.control, lang) ?? ""}\u0000${p.composite.of.join(",")}`;

// The rows that spell each control, keyed by every one of them.
//
// Grouped by the CONTROL and never by adjacency: on a real realm the
// dictionary's order puts six unrelated settings between the three that spell
// the brute force mode, so a run-based grouping found no control at all. Two
// components of one sheet are two categories and therefore two calls, so
// nothing here can mix them.
//
// Only a group carrying EVERY field the control writes. A sheet scoped to part
// of a product has some of them and not the rest, and a tuple missing a member
// matches no choice — which would announce "no matching choice" over a screen
// that is perfectly ordinary (measured on a real upgrade sheet carrying one of
// three). What the sheet cannot read, it does not claim.
export function controlGroups<T extends ControlRow>(params: readonly T[], lang: Lang): Map<T, T[]> {
  const byControl = new Map<string, T[]>();
  for (const p of params) {
    const ck = controlKey(p, lang);
    if (ck === "") continue;
    const at = byControl.get(ck);
    if (at === undefined) byControl.set(ck, [p]);
    else at.push(p);
  }
  const out = new Map<T, T[]>();
  for (const run of byControl.values()) {
    const of = run[0]!.composite!.of;
    if (of.every((k) => run.some((p) => p.key === k))) for (const p of run) out.set(p, run);
  }
  return out;
}

// A control's fields, brought together at the first of them, in the order the
// product's own source sets them (`composite.of`).
//
// The product's screen shows them as ONE control; the sheet files them by the
// dictionary's order, and scattered they make the control head a block that is
// not one. Only within the group: everything else keeps its place.
export function withControlsTogether<T extends ControlRow>(rows: readonly T[], groups: Map<T, T[]>): T[] {
  if (groups.size === 0) return [...rows];
  const here = new Set(rows);
  const placed = new Set<T>();
  const out: T[] = [];
  for (const p of rows) {
    if (placed.has(p)) continue;
    const g = groups.get(p);
    if (g === undefined) {
      out.push(p);
      continue;
    }
    const members = g.filter((m) => here.has(m));
    const byKey = new Map(members.map((m) => [m.key, m]));
    for (const k of p.composite!.of) {
      const m = byKey.get(k);
      if (m !== undefined && !placed.has(m)) {
        out.push(m);
        placed.add(m);
      }
    }
    for (const m of members)
      if (!placed.has(m)) {
        out.push(m);
        placed.add(m);
      }
  }
  return out;
}

// What a row of the tuple holds when nobody set it.
export const defaultOf = (p: ControlRow): string | undefined => p.baseline ?? p.default;

// What a row of the tuple HOLDS, for an environment.
//
// A row nobody set holds its default, which is the whole point: two of
// Keycloak's three brute force fields are normally unset, and reading them as
// empty would leave every realm unresolvable.
export const heldValue = (p: ControlRow, instance: string | undefined): string | undefined => {
  const own = instance === undefined ? p.value : (p.instances?.find((i) => i.name === instance)?.value ?? p.value);
  if (own !== undefined && own !== "") return own;
  return defaultOf(p);
};

export type Mode = { label: string; other?: string };

// The choice a set of values spells, or none of them.
//
// NEVER the nearest match. A realm configured through the API can hold a
// combination the console cannot produce, and naming that after a screen the
// product would not show is the sheet inventing one.
export function modeSpelledBy(rows: readonly ControlRow[], held: Map<string, string | undefined>, lang: Lang): Mode | undefined {
  const c = rows[0]?.composite;
  if (c === undefined) return undefined;
  for (const m of c.modes) {
    if (c.of.every((k) => held.get(k) !== undefined && held.get(k) === m.values[k])) {
      const label = pickLang(m.label, lang) ?? "";
      const other = m.label_other;
      return other === undefined ? { label } : { label, other };
    }
  }
  return undefined;
}

// The choice this deployment spells, for one environment.
export const modeOf = (rows: readonly ControlRow[], instance: string | undefined, lang: Lang): Mode | undefined =>
  modeSpelledBy(rows, new Map(rows.map((r) => [r.key, heldValue(r, instance)])), lang);

// The choice a FRESH install spells — the control's own default, read off the
// rows' defaults exactly as the value columns are read off their values.
// Nothing in the dictionary states it: "Disabled" is what false/false/0 comes
// to, and computing it is how the two can never disagree.
export const defaultModeOf = (rows: readonly ControlRow[], lang: Lang): Mode | undefined =>
  modeSpelledBy(rows, new Map(rows.map((r) => [r.key, defaultOf(r)])), lang);
