// What the palette searches, said where it is opened.
//
// It began as an outline jump and grew to cover parameters and comments
// (`paletteEntries` is categories + params + comments); the words on the button
// and in the field stayed behind, promising less than the thing does. A label
// that undersells is the same defect as one that oversells — both send the
// reader somewhere else to do what they were already standing in front of.
import { describe, it, expect } from "bun:test";
import { getMessages } from "../src/html/i18n";

describe("the search control says what it searches", () => {
  const named: Record<"ja" | "en", string[]> = {
    ja: ["見出し", "設定項目", "コメント"],
    en: ["heading", "parameter", "comment"],
  };
  for (const lang of ["ja", "en"] as const) {
    it(`names headings, parameters and comments (${lang})`, () => {
      const t = getMessages(lang);
      for (const text of [t.navSearchTip, t.navSearchPlaceholder]) {
        for (const what of named[lang]) expect(text.toLowerCase()).toContain(what.toLowerCase());
      }
    });
  }
});
