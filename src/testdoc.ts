// The unit test's document: what a person wrote, with the tables put in.
//
// A unit-test specification-and-record is mostly prose only a project can write —
// how this unit is tested, what is deliberately out of scope, what a reader
// should conclude — around tables that only a machine should write, because
// they are a thousand rows long and they change with every run. So this does
// not GENERATE the document. It fills in the parts of one that are marked for
// it, the way scripts/gen-docs.ts already fills the parser tables into README.
//
//     <!-- test:items:start -->
//     …replaced on every run…
//     <!-- test:items:end -->
//
// Both directions are checked, as everywhere else here: a marker nothing fills
// is an error, and a block with nowhere to go is an error. A document that
// silently lost its results table would be the exact failure this file exists
// to prevent, and it would look like an empty section.

import type { LangText } from "./types.js";
import { pickLang } from "./types.js";
import type { TestItem, TestPlan, TestUnit } from "./testplan.js";
import type { TestResult, TestResults } from "./testresults.js";
import { evidenceCell } from "./evidence.js";

export type TestDocLang = "ja" | "en";

type Words = {
  no: string; item: string; expected: string; verdict: string; ran: string; how: string; evidence: string; note: string;
  // The three levels a project's taxonomy declares, spelled the same way HERE — a
  // reader maps the table onto the page by reading the same words twice.
  major: string; middle: string; subject: string;
  pass: string; fail: string; notRun: string;
  isSet: (k: string) => string; isDefault: (k: string) => string; isAbsent: (k: string) => string;
  functional: (t: string) => string;
  count: string; done: string; todo: string; result: string; unstated: string;
  defaults: (n: number, ok: number, ng: number) => string;
  ranAt: (at: string, hosts: string) => string; notRunYet: string;
  excludedHead: string; excludedCols: string[]; taxonomyCols: string[]; taxonomyWhere: string[];
  taxonomyUndeclared: string;
};

const T: Record<TestDocLang, Words> = {
  ja: {
    no: "No.",
    item: "小項目(テスト項目)",
    major: "大項目",
    middle: "中項目",
    subject: "対象",
    expected: "期待結果",
    verdict: "判定",
    ran: "実施日",
    how: "確認方法",
    evidence: "エビデンス",
    note: "備考",
    pass: "OK",
    fail: "NG",
    notRun: "未実施",
    isSet: (k: string) => `\`${k}\` が設定どおりであること`,
    isDefault: (k: string) => `\`${k}\` が製品の既定値のままであること`,
    isAbsent: (k: string) => `\`${k}\` が設定されていないこと`,
    functional: (t: string) => t,
    count: "テスト項目数",
    done: "実施済み",
    todo: "未実施",
    result: "判定",
    unstated: "対象外・確認済み",
    defaults: (n: number, ok: number, ng: number) =>
      `設定していない ${n} 項目が製品の既定値のままであることは、同じ実行で確認している（OK ${ok} / NG ${ng}）。個々の行はパラメータシート側に出る。`,
    ranAt: (at: string, hosts: string) => `実施日時: ${at} ／ 対象ホスト: ${hosts}`,
    notRunYet: "実施日時: — ／ 対象ホスト: — （未実施）",
    excludedHead: "対象外",
    excludedCols: ["設定項目", "理由", "所管"],
    taxonomyCols: ["項番", "項目", "項目の上げ方", "この文書での対応"],
    // The tool's half of each row: where that level is on the page it just
    // wrote. The project's half — what each level is called and how its items
    // are raised — is `TestDeclaration.taxonomy`.
    taxonomyWhere: [
      "この文書の単位。項目表の冒頭に一度だけ書く",
      "詳細設計のシート。`#### 中項目: …` の見出し",
      "表の1行。シートの行から導出（漏れた場合は生成が失敗する）",
    ],
    taxonomyUndeclared: "—",
  },
  en: {
    no: "No.",
    major: "Unit",
    middle: "Component",
    subject: "Subject",
    item: "Setting (test item)",
    expected: "Expected",
    verdict: "Result",
    ran: "Run on",
    how: "Checked by",
    evidence: "Evidence",
    note: "Note",
    pass: "OK",
    fail: "NG",
    notRun: "not run",
    isSet: (k: string) => `\`${k}\` is set as designed`,
    isDefault: (k: string) => `\`${k}\` is still the product's own default`,
    isAbsent: (k: string) => `\`${k}\` is not set at all`,
    functional: (t: string) => t,
    count: "Items",
    done: "Run",
    todo: "Not run",
    result: "Result",
    unstated: "Out of scope, recorded",
    defaults: (n: number, ok: number, ng: number) =>
      `${n} unset parameter(s) were confirmed to be on the product's own default in the same run (OK ${ok} / NG ${ng}); each one appears on the parameter sheet.`,
    ranAt: (at: string, hosts: string) => `Run at: ${at} / hosts: ${hosts}`,
    notRunYet: "Run at: — / hosts: — (not run)",
    excludedHead: "Out of scope",
    excludedCols: ["Parameter", "Reason", "Owner"],
    taxonomyCols: ["No.", "Level", "How items are raised", "In this document"],
    taxonomyWhere: [
      "This document's unit, stated once at the head of the item tables",
      "A sheet of the detailed design — the `#### Component: …` headings",
      "One row of a table, derived from the sheet's rows; a gap fails the build",
    ],
    taxonomyUndeclared: "—",
  },
};

const cell = (s: string | undefined): string => (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n+/g, " ");
const code = (s: string | undefined): string => (s === undefined || s === "" ? "" : `\`${cell(s)}\``);
const table = (head: readonly string[], rows: string[][]): string =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

// The middle level a row belongs to: the sheet it came from, named as the plan names
// it. A plan that predates `sheetLabel` (or an item whose sheet has no label)
// falls back to the sheet's own name rather than to an empty heading.
const middleOf = (i: TestItem, lang: TestDocLang): string =>
  (i.sheetLabel === undefined ? undefined : pickLang(i.sheetLabel, lang)) ?? i.target.sheet;

const verdictOf = (t: Words, r: TestResult | undefined): string =>
  r === undefined ? t.notRun : r.status === "pass" ? t.pass : r.status === "fail" ? t.fail : t.notRun;

// The address a verdict was read at — a LINK to the document that address names
// when the record is carrying it, plain text when it is not. `evidenceCell`
// owns both, so the "an affordance that opens nothing is worse than none" rule
// is decided in one place rather than in each renderer.
const evidenceOf = (r: TestResult | undefined, carried: NonNullable<TestResults["evidence"]>): string =>
  cell(evidenceCell(r, carried)).replace(/\\\|/g, "|");

const dayOf = (r: TestResult | undefined, run: { at?: string } | undefined): string =>
  (r?.at ?? run?.at ?? "").slice(0, 10);

const itemText = (t: Words, i: TestItem): string =>
  i.kind === "default-in-force" ? t.isDefault(i.target.key) : i.kind === "absent" ? t.isAbsent(i.target.key) : t.isSet(i.target.key);

const answerIndex = (results: TestResults): Map<string, TestResult> => {
  const m = new Map<string, TestResult>();
  for (const r of results.results) m.set(`${r.target.sheet}\u0000${r.target.key}\u0000${r.target.instance}`, r);
  return m;
};
const answerFor = (index: Map<string, TestResult>, i: TestItem): TestResult | undefined =>
  index.get(`${i.target.sheet}\u0000${i.target.key}\u0000${i.target.instance}`);

export type TestDocOptions = {
  lang?: TestDocLang;
  // Whether the 2,000-odd "still on the product's default" items are printed as
  // ROWS. Off by default and stated as a count instead: they are a real check
  // and they are not what a reviewer signs — the deliverable enumerates what
  // this project SET. Turning them on is one flag, for a customer who wants the
  // exhaustive list.
  includeDefaults?: boolean;
};

// One rendered block per marker name.
export function renderTestDoc(
  plan: TestPlan,
  results: TestResults,
  unitName: string,
  opts: TestDocOptions = {}
): Record<string, string> {
  const lang: TestDocLang = opts.lang ?? "ja";
  const t = T[lang];
  const unit: TestUnit | undefined = plan.units.find((u) => u.name === unitName);
  if (unit === undefined) {
    throw new Error(`no unit "${unitName}" in this plan — it has ${plan.units.map((u) => u.name).join(", ")}`);
  }
  const mine = plan.items.filter((i) => i.unit === unitName);
  const index = answerIndex(results);
  const instances = [...new Set(mine.map((i) => i.target.instance))];
  const shown = mine.filter((i) => opts.includeDefaults === true || i.kind !== "default-in-force");
  const defaults = mine.filter((i) => i.kind === "default-in-force");

  const blocks: Record<string, string> = {};

  // The method — the project's own words, rendered where the document
  // asks for them rather than written twice. The declaration is what the plan
  // is derived against, so a document that restated it by hand would be a
  // second copy free to drift from the one the build reads.
  const method = unit.declaration.not_tested ?? unit.declaration.method;
  const methodText = pickLang(method, lang);
  if (methodText !== undefined) blocks["test:method"] = methodText.trim();

  // The taxonomy, and what this document does about
  // each level. The third row is the one that matters: it says the coverage is
  // derived, which is a claim the build keeps rather than a sentence.
  // Only when the project stated it. The tool has no classification of its own
  // to offer here — the levels' names and the rule for raising items belong to
  // whoever's test standard this document answers to — so an undeclared
  // taxonomy produces no block, and a document that asks for one anyway gets
  // `injectBlocks`' ordinary "a marker nothing produced" error.
  const declared = unit.declaration.taxonomy;
  if (declared !== undefined && declared.length > 0) {
    blocks["test:taxonomy"] = table(
      t.taxonomyCols,
      declared.map((row, i) => [
        String(i + 1),
        cell(pickLang(row.level, lang)),
        cell(pickLang(row.raised, lang)),
        t.taxonomyWhere[i] ?? t.taxonomyUndeclared,
      ])
    );
  }

  // The counts, computed. A hand-written summary is the first thing to rot.
  const answered = shown.filter((i) => answerFor(index, i) !== undefined && answerFor(index, i)!.status !== "not_run");
  const ok = answered.filter((i) => answerFor(index, i)!.status === "pass").length;
  const ng = answered.length - ok;
  // Per environment AND in total, because the two are not one number divided by
  // the other: a row that states nothing in one environment has an item in the
  // others, so the count differs between them and dividing produced a fraction.
  const per = instances.map((i) => `${i} ${shown.filter((x) => x.target.instance === i).length}`).join(" / ");
  const summary: string[][] = [
    [t.count, `${shown.length}（${per}）`],
    [t.done, String(answered.length)],
    [t.todo, String(shown.length - answered.length)],
    [t.result, `${t.pass} ${ok} / ${t.fail} ${ng}`],
  ];
  const summaryBlock = [table(["", ""], summary)];
  if (defaults.length > 0 && opts.includeDefaults !== true) {
    const dAnswered = defaults.map((i) => answerFor(index, i)).filter((r): r is TestResult => r !== undefined && r.status !== "not_run");
    summaryBlock.push(
      "",
      t.defaults(defaults.length, dAnswered.filter((r) => r.status === "pass").length, dAnswered.filter((r) => r.status === "fail").length)
    );
  }
  blocks["test:summary"] = summaryBlock.join("\n");

  // The items and their results. A taxonomy names three levels, so all three
  // have to be POINTABLE on this page — the reason the sheet renders as a
  // heading at all: it is the declared middle level and used to appear nowhere, while
  // the only heading inside an environment was the COMPONENT, which is
  // addressing detail inside a sheet and read exactly like the level the
  // taxonomy was talking about.
  //
  // The outermost level is stated once rather than repeated down a column: it is constant
  // for the whole document, and the paper form this follows solved that with a
  // merged cell, which markdown has no way to write.
  const sections: string[] = [`${t.major}: ${pickLang(unit.label, lang)}`, ""];
  for (const instance of instances) {
    const run = results.runs?.[instance];
    sections.push(`### ${instance}`, "", run?.at === undefined ? t.notRunYet : t.ranAt(run.at, (run.hosts ?? []).join(", ") || "—"), "");
    let n = 0;
    const here = shown.filter((i) => i.target.instance === instance);
    // By the sheet's LABEL, which is what a reader sees; two sheets sharing one
    // label would be one heading, and that is the same statement the label
    // makes. First-appearance order, like every other grouping here.
    const middles = [...new Set(here.map((i) => middleOf(i, lang)))];
    for (const middle of middles) {
      if (middle !== "") sections.push(`#### ${t.middle}: ${middle}`, "");
      const rows = here
        .filter((i) => middleOf(i, lang) === middle)
        .map((i) => {
          const r = answerFor(index, i);
          n += 1;
          return [
            String(n),
            // The component is what the row is ABOUT, and it belongs in the
            // table rather than in a heading: a client identified by its URL
            // makes an unreadable heading and a perfectly good cell.
            cell(i.component),
            itemText(t, i),
            i.quiet === true ? "—" : code(i.expected),
            verdictOf(t, r),
            dayOf(r, run),
            cell(r?.detail),
            evidenceOf(r, results.evidence ?? []),
            "",
          ];
        });
      sections.push(table([t.no, t.subject, t.item, t.expected, t.verdict, t.ran, t.how, t.evidence, t.note], rows), "");
    }
  }
  blocks["test:items"] = sections.join("\n").trimEnd();

  // The items with no row behind them, which a project wrote by hand and a run
  // answers the same way.
  const functional = unit.declaration.functional ?? [];
  if (functional.length > 0) {
    const rows: string[][] = [];
    let n = 0;
    for (const instance of instances) {
      for (const f of functional) {
        const text = pickLang(f, lang);
        const answer = (results.functional ?? []).find((x) => x.unit === unitName && x.instance === instance && x.item === text);
        n += 1;
        rows.push([
          String(n),
          `${instance}: ${cell(text)}`,
          "",
          answer === undefined ? t.notRun : answer.status === "pass" ? t.pass : answer.status === "fail" ? t.fail : t.notRun,
          (results.runs?.[instance]?.at ?? "").slice(0, 10),
          cell(answer?.detail),
          evidenceOf(answer as TestResult | undefined, results.evidence ?? []),
          "",
        ]);
      }
    }
    blocks["test:functional"] = table([t.no, t.item, t.expected, t.verdict, t.ran, t.how, t.evidence, t.note], rows);
  }

  return blocks;
}

// …and the excluded rows, which need the plan's report rather than the plan.
export function renderExcluded(
  excluded: { unit: string; sheet: string; key: string; reason: LangText; owner?: string }[],
  unitName: string,
  lang: TestDocLang = "ja"
): string {
  const t = T[lang];
  const mine = excluded.filter((e) => e.unit === unitName);
  return table(t.excludedCols, mine.map((e) => [`${cell(e.sheet)} > \`${cell(e.key)}\``, cell(pickLang(e.reason, lang)), cell(e.owner)]));
}

const START = (name: string): string => `<!-- ${name}:start -->`;
const END = (name: string): string => `<!-- ${name}:end -->`;

// Put each block where the document marked a place for it.
//
// Both directions are checked, and they are not symmetric.
//
// A marker nothing fills is ALWAYS an error: it leaves a section that looks
// written and is empty, which is the worst of both.
//
// A block with nowhere to go is an error only when it carries ANSWERS —
// `required`, which the caller names. Losing those is losing the run; losing a
// summary or a taxonomy table is losing a restatement of something the document
// still holds. A document that wants only its item tables is a document a
// project is allowed to write.
export function injectBlocks(markdown: string, blocks: Record<string, string>, required: string[] = []): string {
  let out = markdown;
  const filled = new Set<string>();
  for (const [name, body] of Object.entries(blocks)) {
    const from = out.indexOf(START(name));
    const to = out.indexOf(END(name));
    if (from < 0 || to < 0) continue;
    if (to < from) throw new Error(`${name}: the end marker comes before the start marker`);
    out = out.slice(0, from + START(name).length) + "\n\n" + body + "\n\n" + out.slice(to);
    filled.add(name);
  }
  const missing = required.filter((n) => blocks[n] !== undefined && !filled.has(n));
  const marked = [...markdown.matchAll(/<!--\s*(test:[a-z-]+):start\s*-->/g)].map((m) => m[1]);
  const unknown = marked.filter((n) => blocks[n] === undefined);
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      [
        missing.length > 0 ? `nothing in the document takes the answers: ${missing.join(", ")}` : "",
        unknown.length > 0 ? `the document asks for a block that was not produced: ${unknown.join(", ")}` : "",
      ]
        .filter((x) => x !== "")
        .join("; ") + ` — the markers are ${Object.keys(blocks).map((n) => `<!-- ${n}:start --> … <!-- ${n}:end -->`).join(", ")}`
    );
  }
  return out;
}
