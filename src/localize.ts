// A document, resolved to ONE language.
//
// `description`/`remarks`/`label`/`note` and the rest of the prose are carried
// through the pipeline as `LangText` — a `{ en, ja }` map — because their two
// halves come from different places: a native channel (a Terraform
// `description`, an Ansible argument_spec) writes one, the project's sheet.yml
// writes the other. A READER holds one language, and which one is decided when
// the document is generated: the viewer has no toggle, and the markdown
// projection could not have carried a second language anyway. Deciding it once,
// here, is what keeps the two projections saying the same thing.
//
// `pickLang`'s cross-language fallback applies throughout: showing the English
// text to a Japanese reader beats showing nothing, which is what an unresolved
// field would be. What fell back is COUNTED rather than hidden — see
// `langFallbacks`.
//
// Pure: no DOM. Idempotent — a field already resolved to a plain string passes
// through `pickLang` unchanged — so running it twice costs a walk and changes
// nothing.

import { pickLang, type OutOfScope } from "./types.js";
import type { SheetData, CategoryData, ParamData } from "./prompt.js";
import type { Lang } from "./html/i18n.js";

export // Resolve every LangText prose field (description / remarks) in a sheet tree to
// the active display language. Done once per (data, lang) at the top of Root so
// the whole downstream pipeline — rendering, search, and diff — sees plain
// strings, and flipping the language toggle re-resolves them live.
// An out-of-scope reason is prose written by the project (often in Japanese),
// so it is resolved for the active language exactly like description/remarks —
// otherwise the English UI shows a translated label in front of untranslated
// text. The owner is a team name and stays as authored.
function localizeOutOfScope(oos: OutOfScope | undefined, lang: Lang): OutOfScope | undefined {
  return oos === undefined ? undefined : { ...oos, reason: pickLang(oos.reason, lang) ?? "" };
}
export function localizeParam(p: ParamData, lang: Lang): ParamData {
  if (
    p.label === undefined &&
    p.description === undefined &&
    p.remarks === undefined &&
    p.out_of_scope === undefined &&
    p.options === undefined
  )
    return p;
  return {
    ...p,
    label: pickLang(p.label, lang),
    description: pickLang(p.description, lang),
    remarks: pickLang(p.remarks, lang),
    out_of_scope: localizeOutOfScope(p.out_of_scope, lang),
    // `value` is identity and is never touched; only the option's LABEL is
    // resolved, and pickLang's cross-language fallback matters here more than
    // anywhere else — a product translates its field labels long before its
    // option lists, so a Japanese reader routinely sees an English option name
    // beside a Japanese description. Showing the English one beats showing
    // nothing, which is what a bare code already was.
    options: p.options?.map((o) => ({ value: o.value, label: pickLang(o.label, lang) })),
    // The product's word for presence, resolved like every other LangText the
    // viewer shows — without this the cell falls back to the neutral word even
    // where the dictionary supplied a better one.
    presence_label: pickLang(p.presence_label, lang),
    // The control's name and its choices, resolved here like every other
    // LangText the viewer shows — so the viewer compares VALUES (which are not
    // language-dependent) and prints text it does not have to resolve.
    ...(p.composite === undefined
      ? {}
      : {
          composite: {
            ...p.composite,
            control: pickLang(p.composite.control, lang) ?? "",
            ...(p.composite.description === undefined
              ? {}
              : { description: pickLang(p.composite.description, lang) ?? "" }),
            // …and the OTHER language beside it. A description is read; this is
            // a value somebody compares with a screen, and which language that
            // screen is in is not knowable here — a reader holding a Japanese
            // sheet in front of an English console needs the other spelling to
            // match them up. Carried, not shown: the cell prints one and offers
            // the other on hover, so the column a reader scans stays one value
            // wide.
            modes: p.composite.modes.map((m) => ({
              ...m,
              label: pickLang(m.label, lang) ?? "",
              ...(typeof m.label === "string" || pickLang(m.label, lang === "ja" ? "en" : "ja") === pickLang(m.label, lang)
                ? {}
                : { label_other: pickLang(m.label, lang === "ja" ? "en" : "ja") }),
            })),
          },
        }),
  };
}
export function localizeCategory(c: CategoryData, lang: Lang): CategoryData {
  return {
    ...c,
    // `name` is identity and is never touched; `display` is what the reader
    // sees, resolved here alongside every other LangText so the language
    // toggle switches a component's heading live — see types.ts's Category.
    display: (c.label ? pickLang(c.label, lang) : undefined) ?? c.name,
    // Resolved here with every other LangText, so what reaches the render is a
    // plain string and the language toggle re-resolves it live.
    note: pickLang(c.note, lang),
    out_of_scope: localizeOutOfScope(c.out_of_scope, lang),
    params: c.params?.map((p) => localizeParam(p, lang)),
    categories: c.categories?.map((sc) => localizeCategory(sc, lang)),
  };
}
export function localizeGroups(groups: SheetData["groups"], lang: Lang): SheetData["groups"] {
  // Recursive: a chapter inside a chapter has a label of its own, and one left
  // unresolved would show its name — the identity, not the words a reader was
  // meant to see.
  return groups?.map((g) => ({
    ...g,
    display: (g.label ? pickLang(g.label, lang) : undefined) ?? g.name,
    ...(g.groups ? { groups: localizeGroups(g.groups, lang) } : {}),
  }));
}
export // A column's heading is a LangText when the project declared one (an under_key
// label). Resolved here with the rest, so everything downstream sees a plain
// string and the language toggle re-resolves it live.
function localizeColumns(columns: SheetData["columns"], lang: Lang): SheetData["columns"] {
  return columns?.map((c) => (c.header_lang ? { ...c, header: pickLang(c.header_lang, lang) ?? c.header } : c));
}
export function localizeSheets(sheets: SheetData["sheets"], lang: Lang): SheetData["sheets"] {
  return sheets.map((s) => ({
    ...s,
    // Same split as a category's: `name` is identity and is never touched (it
    // is the review target, the diff key and the outline's search text), while
    // `display` is what the reader sees and switches with the language toggle.
    display: (s.label ? pickLang(s.label, lang) : undefined) ?? s.name,
    categories: s.categories.map((c) => localizeCategory(c, lang)),
  }));
}

// Every version of a document, resolved.
//
// Called ONCE, by generate.ts, before the data is embedded — which is what
// makes the payload carry one language instead of two, and what makes the
// markdown projection and the HTML say the same words.
export function localizeVersions<T extends { sheets: SheetData["sheets"]; columns?: SheetData["columns"]; groups?: SheetData["groups"] }>(
  versions: T[],
  lang: Lang
): T[] {
  return versions.map((v) => ({
    ...v,
    sheets: localizeSheets(v.sheets, lang),
    ...(v.columns ? { columns: localizeColumns(v.columns, lang) } : {}),
    ...(v.groups ? { groups: localizeGroups(v.groups, lang) } : {}),
  }));
}

// Prose this document has in the OTHER language only.
//
// `pickLang` falls back across languages so a reader sees something rather than
// nothing — right, and silent: a Japanese sheet quietly showing English text
// reads as a broken toggle rather than as a translation nobody wrote. Counted
// here and reported by the CLI, because a document is now generated in one
// language and this is the moment the gap is visible.
export function langFallbacks(
  versions: { sheets: SheetData["sheets"] }[],
  lang: Lang
): { sheet: string; key: string; field: string }[] {
  const other: Lang = lang === "ja" ? "en" : "ja";
  const out: { sheet: string; key: string; field: string }[] = [];
  const check = (sheet: string, key: string, field: string, t: unknown): void => {
    if (t === undefined || typeof t === "string") return;
    const map = t as Record<string, string | undefined>;
    if ((map[lang] ?? "") === "" && (map[other] ?? "") !== "") out.push({ sheet, key, field });
  };
  const walk = (sheet: string, cats: CategoryData[] | undefined): void => {
    for (const c of cats ?? []) {
      for (const p of c.params ?? []) {
        check(sheet, p.key, "description", p.description);
        check(sheet, p.key, "remarks", p.remarks);
      }
      walk(sheet, c.categories);
    }
  };
  for (const v of versions) for (const s of v.sheets) walk(s.name, s.categories);
  return out;
}
