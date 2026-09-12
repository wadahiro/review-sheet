// A document is generated in ONE language, and says what it could not say in it.
//
// The resolution used to happen in the browser, live, behind a toggle. It moved
// to generation because the markdown projection could not carry a second
// language either — and the moment it is decided once, the gap it papers over
// (prose this project only has in the other language) becomes something that
// can be reported rather than something a reader discovers as English text in
// a Japanese sheet.

import { describe, it, expect } from "bun:test";
import { localizeSheets, localizeVersions, langFallbacks } from "../src/localize";
import type { SheetData } from "../src/prompt";

const sheets = (): SheetData["sheets"] =>
  [
    {
      name: "db",
      categories: [
        {
          name: "memory",
          params: [
            { key: "both", description: { ja: "日本語", en: "English" }, remarks: { ja: "備考", en: "note" } },
            { key: "en_only", description: { en: "English only" } },
            { key: "ja_only", description: { ja: "日本語だけ" } },
          ],
        },
      ],
    },
  ] as unknown as SheetData["sheets"];

const descOf = (s: SheetData["sheets"], key: string): unknown =>
  (s[0].categories[0].params ?? []).find((p) => p.key === key)?.description;

describe("resolving a document to one language", () => {
  it("replaces the map with the words that language has", () => {
    expect(descOf(localizeSheets(sheets(), "ja"), "both")).toBe("日本語");
    expect(descOf(localizeSheets(sheets(), "en"), "both")).toBe("English");
  });

  // Showing the other language beats showing nothing, which is what an
  // unresolved field would be on the page.
  it("falls back across languages rather than leaving a blank", () => {
    expect(descOf(localizeSheets(sheets(), "ja"), "en_only")).toBe("English only");
    expect(descOf(localizeSheets(sheets(), "en"), "ja_only")).toBe("日本語だけ");
  });

  // Running it twice is what happens when the viewer walks an already-resolved
  // payload: it must be the identity, not a second lookup that finds nothing.
  it("is idempotent", () => {
    const once = localizeSheets(sheets(), "ja");
    expect(descOf(localizeSheets(once, "ja"), "both")).toBe("日本語");
  });

  it("carries every version, not only the first", () => {
    const out = localizeVersions([{ sheets: sheets() }, { sheets: sheets() }], "en");
    expect(descOf(out[1].sheets, "both")).toBe("English");
  });
});

describe("what the document could not say in its own language", () => {
  it("names the fields that fell back, in whichever direction", () => {
    expect(langFallbacks([{ sheets: sheets() }], "ja")).toEqual([
      { sheet: "db", key: "en_only", field: "description" },
    ]);
    expect(langFallbacks([{ sheets: sheets() }], "en")).toEqual([
      { sheet: "db", key: "ja_only", field: "description" },
    ]);
  });

  it("says nothing about a field that has both", () => {
    const fell = langFallbacks([{ sheets: sheets() }], "ja");
    expect(fell.some((f) => f.key === "both")).toBe(false);
  });

  // A field already resolved to a plain string cannot have fallen back — it has
  // no other language to have come from.
  it("says nothing about an already-resolved document", () => {
    expect(langFallbacks([{ sheets: localizeSheets(sheets(), "ja") }], "ja")).toEqual([]);
  });
});
