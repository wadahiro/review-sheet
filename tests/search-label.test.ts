// THE SEARCH LABEL NAMES THE SCOPE, NEVER THE FIELDS.
//
// It said "見出し・設定項目・コメント" / "headings, parameters, comments" while
// the index already held the key, the value and every per-instance value, the
// default, the description, the remarks, every `extra` field, the sheet's own
// names, the category path, and every line of a document sheet's markdown down
// to its table cells and its fenced blocks.
//
// The drift is the point: a label that lists what is searched has to be edited
// every time something is added to the index, and nothing makes anyone do it.
// This is the check that would have caught it — three of the fields it did not
// mention, asked for by name.

import { describe, it, expect } from "bun:test";
import { getMessages } from "../src/html/i18n";

// Words that only appear in a label enumerating what gets searched. `検索`
// itself is fine, and so is naming the document.
const FIELD_WORDS = [
  "見出し", "設定項目", "コメント", "備考", "説明", "値", "既定値",
  "headings", "parameters", "comments", "remarks", "description", "values", "defaults",
];

describe("what the search control says it searches", () => {
  for (const lang of ["ja", "en"] as const) {
    it(`names no field in ${lang}`, () => {
      const t = getMessages(lang);
      for (const w of FIELD_WORDS) {
        expect(t.navSearchTip, `navSearchTip (${lang}) lists "${w}"`).not.toContain(w);
        expect(t.navSearchPlaceholder, `navSearchPlaceholder (${lang}) lists "${w}"`).not.toContain(w);
      }
    });

    // …and still says what it is and how to reach it: a placeholder that says
    // nothing is not an improvement on one that says the wrong thing.
    it(`still says it is a search, and the shortcut, in ${lang}`, () => {
      const t = getMessages(lang);
      const word = lang === "ja" ? "検索" : "Search";
      expect(t.navSearchTip).toContain(word);
      expect(t.navSearchTip).toContain("Cmd/Ctrl+K");
      expect(t.navSearchPlaceholder).toContain(word);
    });
  }
});
