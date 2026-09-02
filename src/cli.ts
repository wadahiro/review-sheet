#!/usr/bin/env bun

import { Command } from "commander";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, relative, join } from "path";
import { createInterface } from "node:readline/promises";
import { generateHtml, assembleVersions, allDated } from "./html/generate.js";
import { validateInput, validateReview, validateVersionedInput, isVersionedInput } from "./validate.js";
import { findBakedSecrets, formatBakedSecrets } from "./secrets.js";
import { toFullEditInput } from "./full-edit.js";
import type { ParameterSheetInput, VersionedSheetInput, ReviewDocument } from "./types.js";
import { extractReviewsFromHtml, DOCUMENT_FIELD } from "./edits.js";
import { documentEditRange, fullEditChanges } from "./full-edit-apply.js";
import { renderMarkdownChanges } from "./markdown-changes.js";
import { computeApply } from "./apply.js";
import { verifySources } from "./verify.js";
import { diffSheets, type CategoryDiff, type DiffResult } from "./diff.js";
import { buildInputWithReport, type Format, type ExtractOptions } from "./extract.js";
import { getParser, listParsers } from "./parser.js";
import { enrich, ScaffoldableBuildError, renderScaffold } from "./enrich.js";
import { runInteractiveSession, applyInteractiveAnswers, type InteractiveQuestion } from "./interactive.js";
import { assembleFromSpecWithReport } from "./assemble-spec.js";
import { BIND_METHODS } from "./bind.js";
import { listRecipes } from "./recipe.js";
import { listMetadataProviders } from "./metadata.js";
import { parse as parseYaml } from "yaml";
import { parseDictionary, parseOverlay } from "./providers/dictionary.js";
import { suggestNearest } from "./schema-errors.js";

// Every document this CLI can check, which is every document the pipeline
// reads. A typo'd name is an error naming the set rather than a silent
// fall-through to the model schema.
const VALIDATE_SCHEMAS = ["input", "review", "dictionary", "overlay"];
import "./recipes/index.js"; // self-registers built-in recipes
import { loadBuildSpec, specDirOf } from "./spec.js";
import { inspectTs, lintTs } from "./parsers/ts.js";
import { inspectPy, lintPy } from "./parsers/py.js";
import { renderParserPage, renderParserList } from "./parser-docs.js";
import type { Category, ReviewItem } from "./types.js";

// Best-effort open the default browser at a URL (used by `serve`).
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // ignore — the user can open the URL manually
  }
}

// Import every .ts/.js module from an explicit dir (if given) and an auto dir
// (if it exists) — used for custom parser, recipe, and metadata provider
// plugins, which self-register at module load time. Returns how many modules
// were imported, so a caller can tell whether anything was actually loaded.
//
// `kind`/`countRegistered` exist to catch a failure `loaded` alone cannot see:
// every file can import cleanly (so `loaded > 0`) while the registry the rest
// of the CLI reads gains nothing. That happens when a plugin resolves a copy
// of review-sheet whose registry isn't the shared one — e.g. an older
// `node_modules/review-sheet` that predates sharedRegistry (registry.ts), or
// any other stale/duplicate copy in the dependency tree. Nothing throws; the
// only symptom downstream is a much harder-to-diagnose error later (an
// "Unknown recipe", or strict-metadata failing for "no description") that
// points at the wrong place. Comparing the registry's size before and after
// turns that into an immediate, specific warning.
async function loadPluginModules(
  explicitDir: string | undefined,
  autoDir: string,
  kind: string,
  countRegistered: () => number
): Promise<number> {
  const dirs: string[] = [];
  if (explicitDir) dirs.push(resolve(explicitDir));
  try {
    readdirSync(autoDir);
    dirs.push(autoDir);
  } catch {
    // not found — ignore
  }

  const before = countRegistered();
  let loaded = 0;
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(d);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith(".ts") || f.endsWith(".js")) {
        await import(join(d, f));
        loaded++;
      }
    }
  }
  if (loaded > 0 && countRegistered() === before) {
    console.error(
      `Warning: imported ${loaded} ${kind} plugin file(s) from ${dirs.join(", ")}, but the ${kind} registry ` +
        `did not gain any entries (still ${before}). The file(s) loaded without error, so this is not a syntax ` +
        `or path problem — it means whatever they registered landed somewhere this process doesn't read. The ` +
        `usual cause is a stale or duplicate "review-sheet" package copy in node_modules (this process reads a ` +
        `process-wide shared registry — see src/registry.ts — but an old copy of the package predating that, or ` +
        `a copy resolved from a different node_modules tree, still writes into its own separate registry). If ` +
        `you next see "Unknown ${kind}" or a missing-description error, treat THIS warning as the root cause, ` +
        `not that one.`
    );
  }
  return loaded;
}

async function loadCustomParsers(dir?: string): Promise<number> {
  return loadPluginModules(dir, join(process.cwd(), ".review-sheet", "parsers"), "parser", () => listParsers().length);
}

async function loadCustomProviders(dir?: string): Promise<number> {
  return loadPluginModules(dir, resolve("./.review-sheet/providers"), "metadata provider", () => listMetadataProviders().length);
}

async function loadCustomRecipes(dir?: string): Promise<number> {
  return loadPluginModules(dir, join(process.cwd(), ".review-sheet", "recipes"), "recipe", () => listRecipes().length);
}

// The only impure part of `import --interactive` (P8) — real terminal
// prompting. Everything it decides (which question, what results from the
// answer) lives in src/interactive.ts's runInteractiveSession, tested without
// any of this; this function only renders one InteractiveQuestion as text and
// reads back one line.
async function askInTerminal(rl: ReturnType<typeof createInterface>, q: InteractiveQuestion): Promise<string> {
  switch (q.kind) {
    case "category": {
      const bindingNote = q.binding
        ? `（${q.binding.product}@${q.binding.version} ${q.binding.dictKey} にバインド — 説明は辞書側で補完されます）`
        : "（辞書に該当なし）";
      console.log(`\n${q.sheet} > ${q.key}   ${bindingNote}`);
      if (q.invalid !== undefined) {
        console.log(`  "${q.invalid}" は選べません。番号、文字列（絞り込み）、n、s のいずれかを入力してください。`);
      }
      console.log(q.query !== undefined ? `  カテゴリ（絞り込み: "${q.query}"）:` : "  カテゴリ:");
      q.choices.forEach((c, i) => console.log(`    ${i + 1}) ${c}`));
      console.log("    n) 新しいカテゴリを作る");
      console.log("    s) スキップ");
      // Only advertise incremental search when it would actually help — a
      // short list (the common case) is left exactly as it looked before
      // P9, per the task's own condition that search must stay invisible
      // until there's something worth searching.
      if (q.query !== undefined) console.log("    （空Enterで絞り込み解除）");
      else if (q.choices.length > 8) console.log("    （文字を入力すると絞り込めます）");
      return await rl.question("  > ");
    }
    case "newCategoryName": {
      if (q.empty) console.log("  名前を入力してください（空にはできません）。");
      return await rl.question("  新しいカテゴリ名: ");
    }
    case "descriptionEn": {
      const hint = q.allowSkip ? "s=スキップ, 空Enter=TODO" : "空Enter=TODO";
      return await rl.question(`  説明 (en) [${hint}]: `);
    }
    case "descriptionJa":
      return await rl.question("  説明 (ja) [空Enter=TODO]: ");
    case "bulkApply": {
      console.log(`\n  ${q.key} → "${q.category}" に割り当てました`);
      console.log(`\n  同じパターンの未解決キーが ${q.matches.length} 件あります:`);
      console.log(`    ${q.pattern}`);
      const shown = q.expanded ? q.matches : q.matches.slice(0, 3);
      for (const k of shown) console.log(`      ${k}`);
      if (!q.expanded && q.matches.length > shown.length) {
        console.log(`      … 他 ${q.matches.length - shown.length} 件`);
      }
      const opts = q.expanded ? "[y/N]" : "[y/N/l=一覧を全部見る]";
      return await rl.question(`  すべて "${q.category}" にしますか？ ${opts}\n  > `);
    }
  }
}

// Resolves one ScaffoldableBuildError's addable entries (category/description
// — never `unused`, which nothing interactive can fix, see ScaffoldEntry)
// against a real terminal, then writes the answers back into `projectPath`
// (comment-preserving — see interactive.ts's applyInteractiveAnswers).
// Returns whether anything was actually written, so the caller knows whether
// a retry is worth attempting.
async function resolveInteractively(
  e: ScaffoldableBuildError,
  projectPath: string | undefined,
  readFile: (path: string) => string | null,
  writeFile: (path: string, content: string) => void
): Promise<boolean> {
  const addable = e.entries.filter((x) => !x.unused);
  if (addable.length === 0) return false; // nothing an interactive Q&A can fix — fall through to the normal scaffold
  if (!projectPath) {
    console.error(
      "--interactive: nothing to write to — no project metadata file is configured " +
        "(pass --project, or set enrich.project in the build spec)."
    );
    return false;
  }

  console.error(`\n--interactive: ${addable.length} parameter(s) to resolve against ${projectPath}`);
  const content = readFile(projectPath) ?? "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const outcome = await runInteractiveSession(addable, e.categoryChoices, (q) => askInTerminal(rl, q));
    if (outcome.resolved.length === 0) {
      console.error("--interactive: no answers given, nothing written.");
      return false;
    }
    const updated = applyInteractiveAnswers(content, e.shape, outcome.resolved, outcome.newCategoriesBySheet);
    writeFile(projectPath, updated);
    const bulkNote = outcome.bulkApplied > 0 ? `, ${outcome.bulkApplied} via bulk apply` : "";
    console.error(
      `--interactive: wrote ${outcome.resolved.length} answer(s) to ${projectPath}${bulkNote}` +
        (outcome.skipped.length > 0 ? ` (${outcome.skipped.length} skipped)` : "")
    );
    return true;
  } finally {
    rl.close();
  }
}

// Runs `attempt` once; on a ScaffoldableBuildError, when --interactive is on,
// resolves what it can at the terminal and retries `attempt` exactly once
// more. Anything the retry throws — a NEW ScaffoldableBuildError listing
// whatever's still unresolved (entries the reader skipped, most likely), or
// any other error — propagates unchanged, so the `import` action's own catch
// block is the only place that ever prints a scaffold, interactive or not:
// "残りは従来どおり scaffold として出力して非ゼロ終了".
async function runWithInteractiveRetry(
  attempt: () => Promise<void>,
  interactive: boolean,
  projectPath: string | undefined,
  readFile: (path: string) => string | null,
  writeFile: (path: string, content: string) => void
): Promise<void> {
  try {
    await attempt();
  } catch (e) {
    if (!interactive || !(e instanceof ScaffoldableBuildError)) throw e;
    const wrote = await resolveInteractively(e, projectPath, readFile, writeFile);
    if (!wrote) throw e;
    console.error("--interactive: rebuilding...\n");
    await attempt();
  }
}

const program = new Command();

function countParams(categories: Category[]): number {
  return categories.reduce(
    (n, c) => n + (c.params?.length ?? 0) + countParams(c.categories ?? []),
    0
  );
}

program
  .name("review-sheet")
  .description("Generate reviewable parameter sheets")
  .version("0.1.0");

// `review` and `edit` are the two MODES, and deliberately exclusive: different
// jobs done by different people at different times — proposing changes before
// the sheet is handed over, and maintaining values afterwards — and a document
// offering both puts two primary actions on every cell and mixes proposals with
// facts in one file. `prompt` is not a mode; it is one affordance that either
// mode may or may not carry.
const ALLOWED_CAPS = ["review", "edit", "prompt"] as const;

// Displaying WHERE a value is written is not a capability, so it is a flag of
// its own: `--no-sources` hides the file names — the tag under a row's key, the
// "rendered from" line under a sheet's heading, the source line in a preview.
// The source map itself stays in the document; apply and verify resolve every
// change through it.
const EXCLUSIVE_MODES = ["review", "edit"] as const;

// `-r` takes a review.json or the edited sheet HTML. Distinguished by content,
// not by extension: a file renamed on the way back should still work.
function readReviewSource(path: string): ReviewDocument {
  const raw = readFileSync(path, "utf-8");
  if (raw.trimStart().startsWith("<")) {
    const reviews = extractReviewsFromHtml(raw);
    if (reviews.length === 0) {
      console.error(`Error: ${path} is an HTML document with no edits in it (was it generated with --allow edit?)`);
      process.exit(1);
    }
    return validateReview({ schema_version: "2.0", created_at: new Date().toISOString(), reviews });
  }
  return validateReview(JSON.parse(raw));
}

// `--allow a,b`. Returns undefined when the flag was not given at all, so the
// caller can fall back to --no-review. An unknown name is an error, not a
// silently ignored word: a typo here would quietly ship a read-only document.
// The previewed files, left out. A preview is a LENS on the deployed file as it
// was when the document was generated; it does not follow the values a
// recipient edits afterwards, and `--no-previews` is how a delivery says it
// would rather carry no picture than one that ages.
function withoutPreviews<T extends ParameterSheetInput | VersionedSheetInput>(input: T): T {
  if ("versions" in input) {
    return { ...input, versions: input.versions.map((v) => ({ ...v, artifacts: undefined })) };
  }
  return { ...input, artifacts: undefined };
}

function parseAllow(spec: string | undefined): Set<string> | undefined {
  if (spec === undefined) return undefined;
  const names = spec.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const unknown = names.filter((n) => !(ALLOWED_CAPS as readonly string[]).includes(n));
  if (unknown.length > 0) {
    console.error(`Error: unknown --allow value: ${unknown.join(", ")} (known: ${ALLOWED_CAPS.join(", ")})`);
    process.exit(1);
  }
  if (EXCLUSIVE_MODES.every((m) => names.includes(m))) {
    console.error("Error: --allow takes review OR edit, not both. Reviewing a sheet and maintaining one are different jobs; a document that offers both puts two primary actions on every cell.");
    process.exit(1);
  }
  // The prompt is built FROM findings or edits. Without a mode that produces
  // either, asking for it names something the document cannot offer — said out
  // loud rather than quietly ignored.
  if (names.includes("prompt") && !EXCLUSIVE_MODES.some((m) => names.includes(m))) {
    console.error("Error: --allow prompt needs review or edit — the prompt is built from findings or edits, and a document with neither has nothing to put in it.");
    process.exit(1);
  }
  return new Set(names);
}

program
  .command("generate")
  .description("Generate parameter sheet HTML")
  .requiredOption("-i, --input <file...>", "Input JSON file(s); pass several snapshots to build a version history")
  .option("-o, --output <file>", "Output file (default: stdout)")
  .option("--title <title>", "Document title")
  .option("--readonly", "A document that can only be read: no review, no editing, no prompt")
  // Kept working: it named only the review UI, but by the time editing and the
  // prompt existed it meant "none of them" — which is what --readonly says.
  // Same behaviour, so nothing breaks.
  .option("--no-review", "Deprecated spelling of --readonly")
  .option("--allow <caps>", "What the recipient may do: review OR edit, optionally with prompt. Omitted, the default is review,prompt (overrides --no-review)")
  .option("--no-sources", "Hide where each value is written (the file name under a row, the sheet's rendered-from line, a preview's source line). The source map stays in the file — apply and verify still work")
  .option("--lang <lang>", "UI language: ja | en (default: ja)", "ja")
  .option("--no-previews", "Leave the previewed files out: the panel that shows a row's line in its deployed file, and the affordance that opens it. They are the file as it was AT GENERATION — a document maintained by hand afterwards keeps its values current and the preview does not, so a delivery that will be edited for a long time may prefer not to carry a picture that quietly ages. Also the biggest single part of the file (measured on a real document: 1.1 MB of payload against 0.6 MB without)")
  .option("--full-edit", "Hand the sheet over as a document its recipient maintains by hand: every sheet becomes markdown, in ONE language, and the whole page is editable. Implies --allow edit and turns the review affordances OFF (there is no cell to comment on — a note goes in the text). The per-cell review targets and the language toggle for content are not in such a document")
  .action(async (opts: { input: string[]; output?: string; title?: string; review: boolean; readonly?: boolean; allow?: string; sources: boolean; previews: boolean; lang: string; fullEdit?: boolean }) => {
    try {
      const files = opts.input;
      let input: ParameterSheetInput | VersionedSheetInput;
      if (files.length === 1) {
        // A single file: either a single-version model or an explicit versions[] doc.
        const data = JSON.parse(readFileSync(files[0], "utf-8"));
        input = isVersionedInput(data) ? validateVersionedInput(data) : validateInput(data);
      } else {
        // Several files = several snapshots. Each must be a single-version model;
        // they are ordered by date (generated_at), not by argument order.
        const inputs = files.map((file) => ({ file, input: validateInput(JSON.parse(readFileSync(file, "utf-8"))) }));
        if (!allDated(inputs)) {
          console.error("Warning: not every input has metadata.generated_at; keeping the given order. Add dates to order the version history reliably.");
        }
        input = validateVersionedInput(assembleVersions(inputs));
      }

      // Before packaging, not after: this is the moment the model stops being a
      // working file and becomes one self-contained document that carries every
      // value it shows. Always printed, never hidden behind a flag — a list
      // nobody sees is the same as no check.
      const baked = findBakedSecrets(input);
      if (baked.length > 0) console.error(formatBakedSecrets(baked));

      // Dropped HERE, before anything reads them: a preview nobody asked for
      // should not reach the payload, the viewer's index, or the file's size.
      if (opts.previews === false) input = withoutPreviews(input);
      const lang = opts.lang === "en" ? "en" : "ja";
      // The content's language is decided HERE and never again: a full-edit
      // document carries text, not a model, so nothing downstream can re-resolve
      // a description into the other language.
      if (opts.fullEdit === true) input = toFullEditInput(input, lang);
      const caps = parseAllow(opts.allow);
      // Both spellings of "read nothing else into this document".
      const readable = !(opts.readonly === true || opts.review === false);
      const html = await generateHtml(input, {
        title: opts.title,
        // --allow, when given, states the whole permission set; otherwise the
        // older --no-review still decides, with editing off.
        // A hand-maintained document has nothing to comment ON: there is no
        // model behind it, so no cell carries a review target, and a finding
        // written against one would have nowhere to live. What a reader wants
        // to say, they write in the text — which is the whole point of the
        // mode. So the review affordances are off, whatever --allow says.
        review: opts.fullEdit === true ? false : caps ? caps.has("review") : readable,
        // A full-edit document is nothing BUT its editable text; handing one
        // over with editing off would be a page nobody can maintain.
        edit: opts.fullEdit === true || (caps ? caps.has("edit") : false),
        // Naming the set means naming ALL of it: a document handed to someone
        // else should not carry an affordance nobody asked to include.
        // Without --allow, the older behaviour stands and the prompt is there —
        // but never in a document that produces nothing to put in one, where
        // claiming the capability would describe a button that cannot exist.
        prompt: opts.fullEdit === true
          ? caps
            ? caps.has("prompt")
            : readable
          : (caps ? caps.has("prompt") : readable) && (caps ? caps.has("review") || caps.has("edit") : readable),
        // Not a capability — nobody is permitted or forbidden anything by it —
        // so a flag of its own rather than a name in --allow.
        sources: opts.sources,
        lang,
      });

      if (opts.output) {
        writeFileSync(opts.output, html, "utf-8");
        console.error(`Generated: ${opts.output}`);
      } else {
        process.stdout.write(html);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("validate")
  .description("Validate a model, a review document, or a dictionary")
  .requiredOption("-i, --input <file>", "File to validate (JSON or YAML)")
  .option("-s, --schema <type>", `Schema: ${VALIDATE_SCHEMAS.join(" | ")} (default: detected from the document)`)
  .action((opts: { input: string; schema?: string }) => {
    try {
      if (opts.schema !== undefined && !VALIDATE_SCHEMAS.includes(opts.schema)) {
        const hint = suggestNearest(opts.schema, VALIDATE_SCHEMAS);
        throw new Error(
          `unknown schema "${opts.schema}" (expected ${VALIDATE_SCHEMAS.join(", ")})` + (hint ? ` — did you mean "${hint}"?` : "")
        );
      }
      const raw = readFileSync(opts.input, "utf-8");
      // Parsed as YAML, which is a superset of JSON, so one reader covers both
      // — a dictionary is YAML and a model is JSON, and asking the caller to
      // say which is asking about the file's syntax rather than its content.
      const data = parseYaml(raw) as Record<string, unknown> | null;
      if (data === null || typeof data !== "object") throw new Error(`${opts.input}: not a document (expected a map)`);

      // Detected from the shape when not stated. Every kind is recognisable by
      // a field it must have — except an overlay, which is a strict SUBSET of a
      // dictionary and would pass as one silently, saying it checked more than
      // it did. That pair is told apart by the filename the pipeline itself
      // looks the file up under (`<product>@<version>.overlay.yml`, see
      // findOverlayFiles), so this is reading the same convention rather than
      // inventing one.
      const schema =
        opts.schema ??
        ("reviews" in data || "schema_version" in data
          ? "review"
          : "parameters" in data && "product" in data
            ? opts.input.endsWith(".overlay.yml") || opts.input.endsWith(".overlay.yaml")
              ? "overlay"
              : "dictionary"
            : "input");

      if (schema === "review") {
        validateReview(data);
        console.log("Review document: OK");
      } else if (schema === "dictionary") {
        const doc = parseDictionary(opts.input, raw);
        console.log(`Dictionary: OK (${doc.product}@${doc.version}, ${Object.keys(doc.parameters).length} parameter(s))`);
      } else if (schema === "overlay") {
        const doc = parseOverlay(opts.input, raw);
        console.log(`Dictionary overlay: OK (${doc.product}@${doc.version}, ${Object.keys(doc.parameters).length} parameter(s))`);
      } else if (isVersionedInput(data)) {
        const doc = validateVersionedInput(data);
        console.log(`Model: OK (${doc.versions.length} version(s))`);
      } else {
        validateInput(data);
        console.log("Model: OK");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${message}`);
      // A dictionary and its overlay are the one pair no field tells apart, so
      // a document that failed AS a dictionary is exactly where saying this
      // earns its place.
      if (opts.schema === undefined && /unknown (field|key)|must NOT have additional/i.test(message)) {
        console.error(`If this is a dictionary overlay rather than a dictionary, pass -s overlay.`);
      }
      process.exit(1);
    }
  });

// `import --spec` flow: a declarative build.yml (see spec.ts) names a recipe
// per sheet (see recipe.ts); assembleFromSpecWithReport() runs each recipe and
// assembles + enriches the result, then verifySources() confirms the source maps
// resolve before writing input.json. The assembly step is exactly the exported
// library call (assemble-spec.ts), so a project that needs `hooks` gets the same
// pipeline this command runs — no second implementation to drift.
async function runSpecImport(opts: {
  spec: string;
  output?: string;
  recipesDir?: string;
  parsersDir?: string;
  providersDir?: string;
  idFields?: string[];
  annotationMarker?: string;
  bindReport?: string;
  materializeReport?: string;
  interactive?: boolean;
}): Promise<void> {
  // All three plugin kinds, not just recipes: a recipe reaches for extractFile()
  // (custom parsers) and the assembler's enrich() step resolves through the
  // metadata provider registry, so `--spec` needs the same plugins loaded as the
  // `-f/--file` path does. Loading only recipes disabled the other two silently.
  await loadCustomParsers(opts.parsersDir);
  await loadCustomProviders(opts.providersDir);
  await loadCustomRecipes(opts.recipesDir);

  const readFile = (path: string): string | null => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  };
  const writeFile = (path: string, content: string): void => {
    writeFileSync(path, content, "utf-8");
  };
  // readdirSync throws on both a missing path and a non-directory one (ENOENT
  // / ENOTDIR) — one catch covers both "not there" cases RecipeIO.listDir's
  // contract asks for, with no separate existence/type check needed.
  const listDir = (path: string): string[] | null => {
    try {
      return readdirSync(path);
    } catch {
      return null;
    }
  };
  // Same contract as readFile, without the utf-8 decode: an image a document
  // embeds is bytes, and reading it as text would corrupt it silently.
  const readBinary = (path: string): Uint8Array | null => {
    try {
      return new Uint8Array(readFileSync(path));
    } catch {
      return null;
    }
  };

  const specPath = resolve(opts.spec);
  const spec = loadBuildSpec(specPath, { readFile });
  // An explicit flag beats what the file says; otherwise assembleFromSpec
  // applies the spec's own `id_fields`.
  if (opts.idFields) spec.id_fields = opts.idFields;
  const specDir = specDirOf(specPath);

  // The whole build, from assembly through writing input.json — wrapped so
  // `--interactive` can retry it once after writing answers back into
  // `spec.enrich.project` (see runWithInteractiveRetry). A non-interactive
  // run, or one with no ScaffoldableBuildError, behaves exactly as before:
  // this closure runs exactly once.
  const attempt = async (): Promise<void> => {
    // Record source paths relative to the current working directory (matching
    // `import -f`'s convention of storing exactly what was typed) rather than
    // machine-absolute — Node resolves a relative `readFileSync` against CWD
    // just as well, and a committed input.json shouldn't bake in a local
    // filesystem layout. This means verify/apply must be run from the same CWD
    // used for `import --spec`, same as every other path this CLI records.
    const { input, report, unusedProjectParams, materializeReports, uiReports, binding, categoryWarnings, layoutNotes } = assembleFromSpecWithReport(spec, {
      readFile,
      listDir,
      readBinary,
      specDir,
      resolve: (p: string) => relative(process.cwd(), resolve(specDir, p)),
      marker: opts.annotationMarker,
    });

    const perProvider = Object.entries(report.byProvider)
      .map(([name, n]) => `${name}:${n}`)
      .join(", ");
    console.error(`metadata: ${report.filled} parameter(s) enriched${perProvider ? ` (${perProvider})` : ""}`);

    // Never let a dictionary's syntax containers (kind: "container") shrink the
    // materialized ledger silently — see MaterializeReport / materializeDrafts
    // in assemble.ts.
    for (const m of materializeReports) {
      const valueCount = m.total - m.containerSkipped;
      console.error(
        `materialize: ${m.sheet} <- ${m.product}@${m.version} — ${m.total} dictionary entries ` +
          `(${valueCount} value, ${m.containerSkipped} syntax container, not materialized), ` +
          `${m.materialized} added as origin:default` +
          (m.groupExcluded > 0 ? `, ${m.groupExcluded} excluded by the groups filter` : "") +
          (m.noDefault > 0 ? `, ${m.noDefault} skipped (no documented default in the dictionary)` : "")
      );
      // A named group that matched nothing in the dictionary is likely a typo —
      // never dropped silently (see MaterializeBinding.groups).
      if (m.unknownGroups.length > 0) {
        console.error(
          `Warning: materialize: ${m.sheet} <- ${m.product}@${m.version} — groups filter names ` +
            `${m.unknownGroups.length} group(s) not found in the dictionary (typo?): ${m.unknownGroups.join(", ")}`
        );
      }
      // The count above is never the whole story: a dictionary can be silent on
      // a directive that genuinely has a real default (an OS-level fallback, a
      // behavior the docs only state in prose — see AcceptFilter/ErrorDocument/
      // Protocol in httpd's own dictionary). Which keys were skipped must stay
      // discoverable, not just countable — see --materialize-report below.
      if (m.noDefault > 0 && !opts.materializeReport) {
        console.error(
          `  (use --materialize-report <file> to see which ${m.noDefault} key(s) were skipped for sheet "${m.sheet}")`
        );
      }
    }

    // What a dictionary's own `ui` claim did to rows nobody set (see
    // DictionaryParam.ui / UiReport). Dropping a row is exactly the failure
    // this project refuses to let happen quietly, so the keys are printed, not
    // just counted — there are never many, because a claim only ever applies to
    // rows the project does not set.
    for (const u of uiReports) {
      // Rows are counted, keys are listed once: on a sheet with components the
      // same parameter is a row per component, and repeating its name six times
      // says nothing the count does not.
      const names = (keys: string[]): string => [...new Set(keys)].join(", ");
      if (u.absentKeys.length > 0) {
        console.error(
          `ui: ${u.sheet} — ${u.absentKeys.length} unset row(s) dropped, absent from the product's admin UI: ` +
            names(u.absentKeys)
        );
      }
      if (u.readonlyKeys.length > 0) {
        console.error(
          `ui: ${u.sheet} — ${u.readonlyKeys.length} unset row(s) marked out of scope, shown by the product's admin UI ` +
            `but not choosable there: ${names(u.readonlyKeys)}`
        );
      }
    }

    // A parameter the project metadata describes that never showed up: almost
    // always something upstream dropped it without saying so. Not fatal — one
    // metadata file may serve several specs — but it must not be silent.
    if (unusedProjectParams.length > 0) {
      console.error(
        `Warning: ${unusedProjectParams.length} parameter(s) described in the project metadata never appeared in any sheet ` +
          `(a recipe filter that matched nothing? a renamed key?): ${unusedProjectParams.join(", ")}`
      );
    }

    // A category reached only through a bound dictionary's own `group` (no
    // project `category:` written) that isn't on the sheet's declared tab
    // list — a fact about the product, not a project typo, so it only warns
    // (see assemble.ts's fileDrafts / P10 bug 2).
    // Advice, printed before the warnings: it is about the shape of what was
    // just built, not about something being wrong with it.
    for (const n of layoutNotes) console.error(`Note: ${n}`);
    if (categoryWarnings.length > 0) {
      for (const w of categoryWarnings) console.error(`Warning: ${w}`);
    }

    // Dictionary-binding audit: which tier (see bind.ts's BindMethod) resolved
    // each drafted key against a bound product dictionary, or "none" for a key
    // that was evaluated but matched nothing. This is a first-class output, not
    // a debugging aside: `bindKey`'s matching now includes inference (the
    // "normalized" tier — see bind.ts's header comment), and an unnoticed wrong
    // inference is exactly the failure mode this project refuses to leave
    // silent, so every build reports its binding decisions where they can be
    // diffed build-to-build.
    //
    // stdout/stderr split (same discipline as `diff` — see its --description):
    // the per-method tally is PROGRESS ("here is what happened this run"), so
    // it goes to stderr like every other summary line above. The "normalized"
    // rows are DATA: "normalized" means the match only exists because a
    // spelling/delimiter difference was normalized away — the one tier where a
    // guess, not a literal or a declared alias, decided the binding — so every
    // one of them is worth a human or AI glance, printed one per line to
    // stdout, unconditionally (independent of --bind-report). A CI job that
    // wants "did any new inference appear" greps stdout, never stderr.
    const totalBindings = Object.values(binding.byMethod).reduce((a, b) => a + b, 0);
    if (totalBindings > 0) {
      const tally = [...BIND_METHODS, "none" as const].map((m) => `${binding.byMethod[m]} ${m}`).join(", ");
      console.error(`bindings: ${tally}`);
      for (const r of binding.rows) {
        if (r.method === "normalized") {
          console.log(`normalized: ${r.sheet} > ${r.key} -> ${r.product}@${r.version}:${r.dictKey}`);
        }
      }
    }
    // A declared key_steps rewrite that reached no row at all. Not folded into
    // the tally above: a tally shows how many rows bound, and the failure here
    // is that rows the author expected to bind are sitting in the `none`
    // bucket with nothing naming the reason.
    for (const u of binding.unmatchedKeySteps) {
      console.error(
        `sheet "${u.sheet}": key_steps for ${u.product}@${u.version} matched no row: ${u.patterns.join(", ")}`
      );
    }

    // Row-level detail, opt-in via --bind-report: one document (rows + a
    // method summary), like `diff --format json` — a consumer branches on a
    // count, never on stdout emptiness. Written to its own file rather than
    // stdout: unlike the normalized-only lines above, the full report (every
    // drafted key, including ordinary exact/alias hits and "none" misses) is
    // too large to interleave with this command's other stdout/stderr lines,
    // and a file path is what a later `diff -i old-bind-report.json -i
    // new-bind-report.json`-shaped workflow wants anyway.
    // Same shape as --bind-report: an always-on count (above) plus an opt-in
    // full listing, one document per sheet+dictionary binding. The dictionary's
    // own extraction quality is what decides whether a `noDefault` skip is
    // right (a real gap) or wrong (an undocumented default the dictionary
    // missed) — so the report exists to let a human check `noDefaultKeys`
    // against the product's actual docs, not just trust the count.
    if (opts.materializeReport) {
      writeFileSync(opts.materializeReport, JSON.stringify(materializeReports, null, 2) + "\n", "utf-8");
      console.error(`Wrote ${opts.materializeReport}`);
    }

    if (opts.bindReport) {
      writeFileSync(opts.bindReport, JSON.stringify({ rows: binding.rows, summary: binding.byMethod }, null, 2) + "\n", "utf-8");
      console.error(`Wrote ${opts.bindReport}`);
    }

    const outcome = verifySources(input, readFile, { marker: opts.annotationMarker });
    for (const c of outcome.checks) {
      // Fallback hits are `ok`, but this is the flow that writes input.json — a
      // brittle source map should be visible here, not only under an explicit verify.
      if ((c.status !== "ok" && c.status !== "out_of_scope" && c.status !== "default") || c.fallback !== undefined) {
        const t = c.target;
        console.error(`  [${c.fallback !== undefined ? "line-fallback" : c.status}] ${t.sheet} > ${t.category} > ${t.param}${t.instance ? ` (${t.instance})` : ""}: ${c.message}`);
      }
    }
    console.error(
      `verify: ${outcome.ok} ok${outcome.fallback > 0 ? ` (${outcome.fallback} via line fallback)` : ""}, ${outcome.warn} warn, ${outcome.error} error, ${outcome.unmapped} unmapped, ${outcome.out_of_scope} out-of-scope, ${outcome.default} product-default`
    );
    if (outcome.error > 0) {
      throw new Error("source verification failed — not writing output");
    }

    const json = JSON.stringify(input, null, 2);
    const outPath = opts.output ?? resolve(specDir, "input.json");
    writeFileSync(outPath, json, "utf-8");
    console.error(`Wrote ${outPath}`);
  }; // end attempt

  await runWithInteractiveRetry(attempt, opts.interactive === true, spec.enrich?.project, readFile, writeFile);
}

// `import -f/--file` flow: extract a draft input.json directly from config
// files (no recipe, no build.yml), optionally enriching it against whatever
// metadata sources were configured. Unlike --spec, the only ScaffoldableBuildError
// this path can ever throw is enrich.ts's "no description" (assemble.ts's own
// "no category" check never runs here — see enrich.ts's own throw site,
// `needsCategory` is always false), so --interactive's category menu never
// shows up on this path; only description questions do.
async function runFileImport(opts: {
  file: string[];
  format?: string;
  output?: string;
  parsersDir?: string;
  providersDir?: string;
  idFields?: string[];
  annotationMarker?: string;
  project?: string;
  metadataDir?: string[];
  argumentSpecs?: string[];
  terraformVariables?: string[];
  lang: string;
  nativeLang: string;
  strictMetadata: boolean;
  interactive?: boolean;
}): Promise<void> {
  await loadCustomParsers(opts.parsersDir);
  const providersLoaded = await loadCustomProviders(opts.providersDir);

  const readFile = (path: string): string | null => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  };
  const writeFile = (path: string, content: string): void => {
    writeFileSync(path, content, "utf-8");
  };

  // --id-fields/--annotation-marker are passed explicitly to
  // buildInputWithReport() below, via ExtractOptions (see parser.ts) — the
  // only path a parser reads them through. A custom parser with a
  // two-argument `extract` (predating ExtractOptions) simply does not
  // receive these settings.
  const extractOptions: ExtractOptions = { idFields: opts.idFields, marker: opts.annotationMarker };
  // Validate against the registry (built-ins + any just-loaded custom parsers).
  if (opts.format && !getParser(opts.format)) {
    const names = listParsers().map((p) => p.name).join(", ");
    throw new Error(`Unknown format "${opts.format}". Registered: ${names}`);
  }
  const files = opts.file.map((f) => ({
    file: f,
    content: readFileSync(f, "utf-8"),
    format: opts.format as Format | undefined,
  }));

  // Wrapped so `--interactive` can retry once after writing answers back into
  // --project (see runWithInteractiveRetry) — same shape as runSpecImport's
  // own `attempt`.
  const attempt = async (): Promise<void> => {
    const built = buildInputWithReport(files, extractOptions);
    let input = built.input;

    // P10 bug 1: a file that contributed ZERO parameters must never pass
    // unremarked — before this, mixing a working file with a misdetected one
    // (e.g. a conf.d/*.conf file sysctl claimed instead of httpd) reported
    // "Extracted N parameter(s) from M file(s)" with no hint that one of
    // those M files was actually empty. Warn (not fail) per empty file: a
    // file that is legitimately all comments is not an error, but the reader
    // must be told which parser was picked so a genuine misdetection is
    // fixable with --format.
    const emptyFiles = built.report.files.filter((f) => f.count === 0);
    if (emptyFiles.length > 0) {
      const registered = listParsers().map((p) => p.name).join(", ");
      for (const f of emptyFiles) {
        const parserLabel = f.parser ? `parser: ${f.parser}` : "no parser matched";
        console.error(
          `Warning: 0 parameters extracted from ${f.file} (${parserLabel}). ` +
            `If this looks wrong, force a parser with --format <name> (registered: ${registered}).`
        );
      }
    }

    if (input.sheets.length === 0) {
      throw new Error("No parameters extracted (no recognisable key/value assignments).");
    }
    validateInput(input); // sanity-check the generated model

    // Metadata enrichment is opt-in: only run it when a source was actually
    // configured (project metadata / metadata dirs / argument specs / terraform
    // variables / a loaded custom provider plugin) — otherwise the plain
    // extracted model passes through.
    const metadataConfigured =
      Boolean(opts.project) ||
      (opts.metadataDir?.length ?? 0) > 0 ||
      (opts.argumentSpecs?.length ?? 0) > 0 ||
      (opts.terraformVariables?.length ?? 0) > 0 ||
      providersLoaded > 0;

    if (metadataConfigured) {
      const lang = opts.lang === "ja" ? "ja" : "en";
      const nativeLang = opts.nativeLang === "ja" ? "ja" : "en";
      const { input: enriched, report } = enrich(input, {
        readFile,
        lang,
        nativeLang,
        strict: opts.strictMetadata,
        project: opts.project,
        metadataDirs: opts.metadataDir ?? [],
        argumentSpecs: opts.argumentSpecs ?? [],
        terraformVariables: opts.terraformVariables ?? [],
      });
      input = enriched;
      if (!opts.strictMetadata) {
        for (const m of report.missing) {
          console.error(`Warning: metadata: no description for ${m.sheet} > ${m.category} > ${m.key}`);
        }
      }
      const perProvider = Object.entries(report.byProvider)
        .map(([name, n]) => `${name}:${n}`)
        .join(", ");
      console.error(`Metadata: enriched ${report.filled} parameter(s)${perProvider ? ` (${perProvider})` : ""}`);
    }

    const json = JSON.stringify(input, null, 2);
    if (opts.output) {
      writeFileSync(opts.output, json, "utf-8");
      console.error(`Wrote ${opts.output}`);
    } else {
      process.stdout.write(json + "\n");
    }
    const count = input.sheets.reduce((n, s) => n + countParams(s.categories), 0);
    console.error(
      `Extracted ${count} parameter(s) from ${files.length} file(s). ` +
      `Review the draft, then run 'review-sheet verify -i <file>' to confirm the source maps.`
    );
  };

  await runWithInteractiveRetry(attempt, opts.interactive === true, opts.project, readFile, writeFile);
}

program
  .command("import")
  .description(
    "Extract a draft input.json (with source maps) from configuration files, or build one from a recipe-driven build.yml (--spec). " +
      "With --spec: progress and summary lines (metadata, materialize, verify, the bindings tally) go to stderr; " +
      "\"normalized\" dictionary-binding rows (inferred matches — see bind.ts) go to stdout, one per line"
  )
  .option("-f, --file <file...>", "Source config file(s)")
  .option("--spec <file>", "Build spec YAML (build.yml) describing recipe-driven sheets; mutually exclusive with -f/--file")
  .option("--format <fmt>", "Force a parser by name (default: detect per file); see registered parsers")
  .option("-o, --output <file>", "Output file (default: stdout for -f; input.json next to the spec for --spec)")
  .option("--parsers-dir <dir>", "Directory of custom parser plugins")
  .option("--recipes-dir <dir>", "Directory of custom recipe plugins (--spec only)")
  .option("--annotation-marker <marker>", "In-source annotation marker (default: @rs)")
  .option("--id-fields <field...>", "Extra field names identifying a list-of-maps item, so its path is [field=value] not [i] (tried before name/id/key); with --spec, overrides the spec's id_fields")
  .option("--project <file>", "Project metadata YAML (description/remarks/dict_key overrides, wins over every other source)")
  .option("--metadata-dir <dir...>", "Directory to search for <product>@<version>.yml metadata dictionaries")
  .option("--argument-specs <file...>", "Ansible meta/argument_specs.yml file(s) to source descriptions from")
  .option("--terraform-variables <file...>", "Terraform variables.tf file(s) to source descriptions from")
  .option("--lang <lang>", "Metadata language: en | ja (default: en)", "en")
  .option(
    "--native-lang <lang>",
    "Language argument_specs.yml / variables.tf are actually written in: en | ja (default: en) — " +
      "both are conventionally authored in English, but override this if your team writes them in Japanese",
    "en"
  )
  .option("--no-strict-metadata", "Warn instead of failing when an in-scope parameter ends up with no description")
  .option("--providers-dir <dir>", "Directory of custom metadata provider plugins")
  .option(
    "--bind-report <file>",
    "Write a per-parameter dictionary-binding report (JSON: rows + a method summary) to this file; --spec only. " +
      "A per-method tally always goes to stderr, and any \"normalized\" rows (inferred matches — see bind.ts) always list on stdout, regardless of this flag."
  )
  .option(
    "--materialize-report <file>",
    "Write the per-sheet materialize report (JSON array, one entry per bound dictionary; includes noDefaultKeys — the " +
      "dictionary entries skipped for carrying no documented default, see assemble.ts's DictionaryMaterialize.includeNoDefault) " +
      "to this file; --spec only. A count always goes to stderr regardless of this flag."
  )
  .option(
    "--scaffold <file>",
    "Also write a paste-able sheet.yml params: snippet to this file when a strict failure (no category / no description / " +
      "unused project param) can be fixed by editing sheet.yml. The snippet is always printed to stdout on such a failure, " +
      "regardless of this flag — this only saves a copy."
  )
  .option(
    "--interactive",
    "On a strict failure fixable by editing sheet.yml (no category / no description), resolve it at the terminal " +
      "instead — pick a category from that sheet's own list (or create one), type a description — and write the " +
      "answers straight back into the project metadata file (--project, or the spec's enrich.project), preserving " +
      "comments. Default is OFF: the scaffold-and-exit behavior above is unchanged unless you pass this. Requires " +
      "an interactive terminal (stdin AND stdout must both be a TTY) — passing this flag without one is an error, " +
      "not a silent fallback to the default."
  )
  .action(async (opts: {
    file?: string[];
    spec?: string;
    format?: string;
    output?: string;
    parsersDir?: string;
    recipesDir?: string;
    annotationMarker?: string;
    idFields?: string[];
    project?: string;
    metadataDir?: string[];
    argumentSpecs?: string[];
    terraformVariables?: string[];
    lang: string;
    nativeLang: string;
    strictMetadata: boolean;
    providersDir?: string;
    bindReport?: string;
    materializeReport?: string;
    scaffold?: string;
    interactive?: boolean;
  }) => {
    try {
      // Opt-in only, and never a silent fallback: without --interactive (or
      // without an interactive TTY) nothing here changes at all — see the
      // catch block below, unchanged for every non-interactive run. With
      // --interactive but no TTY (a CI job, an agent's shell, a piped
      // invocation), fail loudly right away rather than hanging on a prompt
      // no one can answer or silently behaving as if the flag were absent.
      if (opts.interactive && !(process.stdin.isTTY && process.stdout.isTTY)) {
        throw new Error(
          "--interactive requires an interactive terminal (stdin and stdout must both be a TTY); this process's " +
            "stdin/stdout is not one. Omit --interactive to get the default, non-interactive scaffold output."
        );
      }
      if (opts.bindReport && !opts.spec) {
        throw new Error("--bind-report requires --spec: dictionary-binding decisions are only tracked by the --spec assembler.");
      }
      if (opts.materializeReport && !opts.spec) {
        throw new Error("--materialize-report requires --spec: materialize decisions are only tracked by the --spec assembler.");
      }
      if (opts.spec && opts.file) {
        throw new Error("--spec and -f/--file are mutually exclusive.");
      }
      if (opts.spec) {
        // Metadata sources are declared in build.yml's `enrich:` block under
        // --spec, so these flags have no effect here. Say so instead of
        // dropping them: a silently ignored flag reads as "I configured that
        // and it did not work", which sends the search in the wrong direction.
        // (Measured: a clean-room user lost ~30 minutes to exactly this,
        // concluding a correct sheet.yml was wrong because --project was
        // ignored.)
        const ignored = (
          [
            ["--project", opts.project],
            ["--metadata-dir", opts.metadataDir],
            ["--argument-specs", opts.argumentSpecs],
            ["--terraform-variables", opts.terraformVariables],
          ] as const
        )
          .filter(([, v]) => v !== undefined)
          .map(([flag]) => flag);
        if (ignored.length > 0) {
          throw new Error(
            `${ignored.join(", ")} ${ignored.length > 1 ? "have" : "has"} no effect with --spec. ` +
              "Declare metadata sources in the build spec instead:\n" +
              "  enrich:\n" +
              "    project: sheet.yml\n" +
              "    metadata_dirs: [dictionaries]\n" +
              "    argument_specs: [../roles/x/meta/argument_specs.yml]\n" +
              "    terraform_variables: [../terraform/variables.tf]"
          );
        }
        await runSpecImport({
          spec: opts.spec,
          output: opts.output,
          recipesDir: opts.recipesDir,
          parsersDir: opts.parsersDir,
          providersDir: opts.providersDir,
          idFields: opts.idFields,
          annotationMarker: opts.annotationMarker,
          bindReport: opts.bindReport,
          materializeReport: opts.materializeReport,
          interactive: opts.interactive,
        });
        return;
      }
      if (!opts.file || opts.file.length === 0) {
        throw new Error("Either -f/--file or --spec is required.");
      }

      await runFileImport({
        file: opts.file,
        format: opts.format,
        output: opts.output,
        parsersDir: opts.parsersDir,
        providersDir: opts.providersDir,
        idFields: opts.idFields,
        annotationMarker: opts.annotationMarker,
        project: opts.project,
        metadataDir: opts.metadataDir,
        argumentSpecs: opts.argumentSpecs,
        terraformVariables: opts.terraformVariables,
        lang: opts.lang,
        nativeLang: opts.nativeLang,
        strictMetadata: opts.strictMetadata,
        interactive: opts.interactive,
      });
    } catch (e) {
      // A ScaffoldableBuildError (assemble.ts's "no category" / "unused
      // project param", or enrich.ts's "no description") names the exact
      // offending keys — the same list a PoC clean-room user, with nothing
      // but the error text, transcribed BY HAND into sheet.yml. Print the
      // transcription for them: a paste-able params: fragment, on stdout
      // (unconditionally — this is the actionable payload of the failure, not
      // a debugging aside) alongside the usual stderr error message.
      // --scaffold additionally saves a copy to a file, same asymmetry as
      // --bind-report (always-on summary vs. opt-in file).
      if (e instanceof ScaffoldableBuildError) {
        console.error(`Error: ${e.message}`);
        const scaffold = renderScaffold(e.entries, e.shape, e.missingProjectPath);
        console.log(scaffold);
        if (opts.scaffold) {
          writeFileSync(opts.scaffold, scaffold, "utf-8");
          console.error(`Wrote ${opts.scaffold}`);
        }
      } else {
        console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
      process.exit(1);
    }
  });

program
  .command("verify")
  .description("Verify that each value's source map resolves in the real config files")
  .requiredOption("-i, --input <file>", "Input JSON file (with source mappings)")
  .option("--quiet", "Only print problems (warn/error), not every ok line", false)
  .option("--parsers-dir <dir>", "Directory of custom parser plugins")
  .option("--annotation-marker <marker>", "In-source annotation marker (default: @rs)")
  .action(async (opts: { input: string; quiet: boolean; parsersDir?: string; annotationMarker?: string }) => {
    try {
      await loadCustomParsers(opts.parsersDir);
      const input = validateInput(JSON.parse(readFileSync(opts.input, "utf-8")));

      const readFile = (path: string): string | null => {
        try {
          return readFileSync(path, "utf-8");
        } catch {
          return null;
        }
      };

      const outcome = verifySources(input, readFile, { marker: opts.annotationMarker });
      const mark: Record<string, string> = { ok: "OK  ", warn: "WARN", error: "FAIL", unmapped: "––  ", out_of_scope: "SKIP", default: "DEF " };
      for (const c of outcome.checks) {
        // `--quiet` still prints fallback hits: they are the ones worth fixing
        // while everything looks green, so hiding them defeats the point.
        if (opts.quiet && c.fallback === undefined && (c.status === "ok" || c.status === "unmapped" || c.status === "out_of_scope" || c.status === "default")) continue;
        const label = [c.target.sheet, c.target.param, c.target.instance].filter(Boolean).join(" > ");
        console.log(`${c.fallback !== undefined ? "OK~ " : mark[c.status]} ${label}${c.file ? ` [${c.file}]` : ""}: ${c.message}`);
      }
      console.error(
        `\nSummary: ${outcome.ok} ok${outcome.fallback > 0 ? ` (${outcome.fallback} via line fallback)` : ""}, ${outcome.warn} warn, ${outcome.error} error, ${outcome.unmapped} unmapped, ${outcome.out_of_scope} out-of-scope, ${outcome.default} product-default.`
      );
      if (outcome.error > 0) process.exit(1);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("apply")
  .description("Apply reviewed value changes to configuration files using the source map")
  .requiredOption("-i, --input <file>", "Input JSON file (with source mappings)")
  .requiredOption("-r, --review <file>", "Review JSON file, or the edited sheet HTML itself")
  .option("--write", "Write changes to disk (default: dry-run / preview only)", false)
  .option("--emit-prompt", "Print the AI prompt for everything not applied deterministically", false)
  .option("--parsers-dir <dir>", "Directory of custom parser plugins")
  .option("--annotation-marker <marker>", "In-source annotation marker (default: @rs)")
  .action(async (opts: { input: string; review: string; write: boolean; emitPrompt: boolean; parsersDir?: string; annotationMarker?: string }) => {
    try {
      await loadCustomParsers(opts.parsersDir);
      const input = validateInput(JSON.parse(readFileSync(opts.input, "utf-8")));
      // The edited sheet carries its own history, so the returned HTML IS the
      // review file. Accepting it directly removes an export step that only
      // exists to be forgotten — and the recipient of an edit-only document has
      // no reason to know what a review.json is.
      const reviewDoc = readReviewSource(opts.review);

      const readFile = (path: string): string | null => {
        try {
          return readFileSync(path, "utf-8");
        } catch {
          return null;
        }
      };

      // A sheet handed over as markdown comes back as ONE rewritten document.
      // Line it up against the model here, where the model still is: whatever
      // resolves to a row becomes an ordinary value edit and goes through the
      // source-mapped path below; the rest is reported as the diff it is.
      const fullEdits: ReviewItem[] = [];
      const patches: { sheet: string; report: string; unaccounted: string; count: number }[] = [];
      const ranges = documentEditRange(reviewDoc.reviews);
      for (const sheet of input.sheets) {
        const range = ranges.get(sheet.name);
        if (!range || (sheet.categories ?? []).length === 0) continue;
        const change = fullEditChanges(
          sheet as never,
          range.before,
          range.after,
          "ja",
          new Date().toISOString()
        );
        fullEdits.push(...change.edits);
        if (change.residue.length > 0 || change.unaccounted !== "") {
          patches.push({
            sheet: sheet.name,
            report: renderMarkdownChanges(change.residue),
            unaccounted: change.unaccounted,
            count: change.residue.length,
          });
        }
      }
      // The document rewrite itself is replaced by what it turned into: keeping
      // both would apply the same change twice — once as values, once as a page
      // nobody can write back.
      const reviews = [
        ...reviewDoc.reviews.filter((r) => !(r.target.param === undefined && (r.target.field ?? "") === DOCUMENT_FIELD && ranges.has(r.target.sheet) && (input.sheets.find((s) => s.name === r.target.sheet)?.categories ?? []).length > 0)),
        ...fullEdits,
      ];

      const outcome = computeApply(input, reviews, readFile, { marker: opts.annotationMarker });

      // Group applied/skipped results by file for a readable preview.
      const byFile = new Map<string, typeof outcome.results>();
      for (const res of outcome.results) {
        if (res.status === "held" || res.status === "out_of_scope") continue;
        const key = res.file ?? "(unknown)";
        const arr = byFile.get(key) ?? [];
        arr.push(res);
        byFile.set(key, arr);
      }
      for (const [file, items] of byFile) {
        console.log(`\n${file}`);
        for (const r of items) {
          if (r.status === "applied") {
            console.log(`  ~ ${r.line !== undefined ? `line ${r.line}` : r.reason ?? "edit"}`);
            console.log(`    - ${r.before}`);
            console.log(`    + ${r.after}`);
          } else {
            console.log(`  = ${r.line !== undefined ? `line ${r.line}` : "value"} (skipped: ${r.reason})`);
          }
        }
      }

      const held = outcome.results.filter((r) => r.status === "held");
      if (held.length > 0) {
        console.log(`\nHeld (deferred to AI prompt):`);
        for (const r of held) {
          const label = [r.target.sheet, r.target.category, r.target.param, r.target.instance]
            .filter(Boolean)
            .join(" > ");
          console.log(`  - ${label}: "${r.current}" -> "${r.suggested}" (${r.reason})`);
        }
      }

      if (opts.write) {
        for (const f of outcome.files) writeFileSync(f.path, f.content, "utf-8");
        console.error(`\nWrote ${outcome.files.length} file(s).`);
      } else {
        console.error(`\nDry-run: no files written. Re-run with --write to apply.`);
      }
      // A row that changed category since a finding was written is followed,
      // not dropped — and never silently: which findings moved, and to where,
      // is the difference between "the sheet was reorganised" and "apply picked
      // a different row than the reviewer meant".
      for (const m of outcome.moved) {
        console.error(`  moved: ${m.target.sheet} > ${m.target.param} — "${m.from}" is now "${m.to}"`);
      }
      // A finding whose target is simply gone cannot be followed, so it is
      // NAMED instead. Silence here reads exactly like "there was nothing to
      // do", which is the one thing it never means.
      for (const u of outcome.unresolved) {
        const where = [u.category, u.param].filter(Boolean).join(" > ");
        console.error(`  unresolved: ${u.sheet}${where ? ` > ${where}` : ""} — no longer in this document`);
      }
      // Edits made in a delivered document are not this command's to write —
      // they are the recipient's record of what the system should be, applied
      // by hand — but a review file that turns out to be mostly those must not
      // read as "nothing to do".
      if (outcome.edits.length > 0) {
        const added = outcome.edits.filter((e) => e.creates).length;
        const struck = outcome.edits.filter((e) => e.deletes === true).length;
        const changed = outcome.edits.length - added - struck;
        const parts = [
          changed > 0 ? `${changed} value(s) changed` : "",
          added > 0 ? `${added} row(s) added` : "",
          struck > 0 ? `${struck} row(s) struck out` : "",
        ].filter(Boolean);
        console.error(`Note: not applied to any file — edited in the sheet itself: ${parts.join(", ")}.`);
      }
      console.error(
        `Summary: applied ${outcome.applied}, skipped ${outcome.skipped}, held ${outcome.held}, out-of-scope ${outcome.out_of_scope}` +
          (outcome.moved.length > 0 ? `, ${outcome.moved.length} re-pointed after a category move` : "") +
          (outcome.unresolved.length > 0 ? `, ${outcome.unresolved.length} unresolved` : "") +
          "."
      );

      // What a rewritten document asked for that no row could carry — a row
      // added, a heading written, a column, a paragraph. Said as the diff it
      // is, because text is the only thing that can carry all of it, and never
      // silently: a document plainly edited whose changes all mapped to values
      // and one whose changes mapped to nothing must not print the same.
      if (patches.length > 0) {
        const total = patches.reduce((n, p) => n + p.count, 0);
        console.error(
          `Note: ${patches.length} sheet(s) came back as an edited document` +
            (total > 0 ? `; ${total} change(s) in them are not a value any source map addresses` : "") +
            `. They are in the AI prompt.`
        );
      }
      const patchText =
        patches.length === 0
          ? ""
          : `\n\n${"-".repeat(60)}\nThe sheets below were handed over as markdown and edited by hand. Every value\nthat still resolved to a row is already listed above; what follows is the rest,\nstated per change. Apply it to the project's own sources — the configuration\nfiles, and the sheet's definition where a section, a row or a column was added.\n\nEach line is: <heading> > <row>[ column]: before -> after.\n` +
            patches
              .map(
                (p) =>
                  `\n### ${p.sheet}\n\n${p.report}` +
                  (p.unaccounted === "" ? "" : `\n\nAlso changed, and not covered by the lines above:\n\`\`\`diff\n${p.unaccounted}\n\`\`\``)
              )
              .join("\n");
      const prompt = outcome.heldPrompt ? `${outcome.heldPrompt}${patchText}` : patchText.trim();

      if (opts.emitPrompt && prompt) {
        console.log(`\n${"=".repeat(60)}\nAI prompt for remaining work:\n${"=".repeat(60)}\n`);
        console.log(prompt);
      } else if (prompt) {
        console.error(`Run with --emit-prompt to print the AI prompt for the held items.`);
      }
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("parsers [name]")
  .description("List registered parsers or show details for a named parser")
  .option("--parsers-dir <dir>", "Directory of custom parser plugins")
  .action(async (name: string | undefined, opts: { parsersDir?: string }) => {
    await loadCustomParsers(opts.parsersDir);
    if (!name) {
      console.log(renderParserList(listParsers()));
    } else {
      const p = getParser(name);
      if (!p) {
        const names = listParsers().map((x) => x.name).join(", ");
        console.error(`Unknown parser "${name}". Registered: ${names}`);
        process.exit(1);
      }
      const page = renderParserPage(p);
      if (!page) {
        console.log(`Parser "${name}" has no documentation metadata.`);
      } else {
        console.log(page);
      }
    }
  });

program
  .command("annotations")
  .description("Inspect in-source @rs annotations: print resolved sheet/category/value, or --lint for tooling-friction checks")
  .requiredOption("-f, --file <file...>", "TS/TSX source file(s)")
  .option("--lint", "Run lint checks (marker in /** */, :category not on its own line) instead of printing", false)
  .option("--annotation-marker <marker>", "In-source annotation marker (default: @rs)")
  .action((opts: { file: string[]; lint: boolean; annotationMarker?: string }) => {
    try {
      let problems = 0;
      for (const f of opts.file) {
        const content = readFileSync(f, "utf-8");
        const isPy = f.toLowerCase().endsWith(".py");
        if (opts.lint) {
          for (const i of (isPy ? lintPy : lintTs)(content, opts.annotationMarker)) {
            console.log(`${f}:${i.line}  [${i.rule}] ${i.message}`);
            problems++;
          }
        } else {
          const { config, entries, warnings } = (isPy ? inspectPy : inspectTs)(content, opts.annotationMarker);
          const head = [config.sheet ? `sheet=${config.sheet}` : "", config.instance ? `instance=${config.instance}` : ""].filter(Boolean).join("  ");
          console.log(`# ${f}${head ? `  (${head})` : ""}`);
          for (const e of entries) {
            console.log(`  [${e.categoryPath.join("/")}] ${e.key} = ${e.value}  (path ${e.source.path})`);
          }
          for (const w of warnings) {
            console.log(`  ! ${w}`);
            problems++;
          }
        }
      }
      if (problems > 0) process.exit(1);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

// What changed since the sheet was last reviewed. The reviewed baseline is
// simply the input.json of that revision — history is the VCS's job — so this
// is the command that answers "which rows need looking at again?":
//   git show <reviewed>:input.json > /tmp/base.json
//   review-sheet diff -i /tmp/base.json -i input.json
//
// The same command also answers a different question: are two DIFFERENT
// sheets (e.g. two deployment platforms mid-migration) equivalently
// configured? `--equivalence` (or its two components individually) exists for
// that use — see DiffOptions in diff.ts for what each one filters and why.
program
  .command("diff")
  .description("Compare two input.json snapshots: which parameters were added, removed or changed. Differing rows go to stdout, the summary line to stderr")
  .requiredOption("-i, --input <file...>", "Two input JSON files: the baseline, then the current one")
  .option("--changed-only", "Print only the differing rows (default)", true)
  .option("--all", "Print unchanged rows too")
  .option(
    "--equivalence",
    "Equivalence-check mode for comparing two DIFFERENT sheets (e.g. two deployment platforms mid-migration): shorthand for --exclude-default-origin --sheet-presence --cross-category"
  )
  .option(
    "--cross-category",
    "Join the two sides by a row's key rather than by which category each files it under — two deployment forms of one product share their settings, not their structure"
  )
  .option(
    "--exclude-default-origin",
    "Exclude materialize-derived origin:default rows from the comparison (counted, never silently dropped — see excluded.defaultOrigin)"
  )
  .option(
    "--sheet-presence",
    "Report a sheet present on only one side as one fact instead of exploding every one of its parameters into removed/added rows (see sheetsOnlyOnOneSide)"
  )
  .option("--format <fmt>", "Output format: text | json (json prints one document, summary included, on stdout)", "text")
  .action((opts: { input: string[]; all?: boolean; format: string; equivalence?: boolean; excludeDefaultOrigin?: boolean; sheetPresence?: boolean; crossCategory?: boolean }) => {
    try {
      if (opts.format !== "text" && opts.format !== "json") {
        throw new Error(`Unknown --format "${opts.format}". Use text or json.`);
      }
      if (opts.input.length !== 2) throw new Error("diff needs exactly two -i files: the baseline and the current one.");
      const [from, to] = opts.input.map((f) => validateInput(JSON.parse(readFileSync(f, "utf-8"))));
      const excludeDefaultOrigin = Boolean(opts.equivalence || opts.excludeDefaultOrigin);
      const sheetPresence = Boolean(opts.equivalence || opts.sheetPresence);
      const crossCategory = Boolean(opts.equivalence || opts.crossCategory);
      const result: DiffResult = diffSheets(from.sheets, to.sheets, { excludeDefaultOrigin, sheetPresence, crossCategory });

      // In text mode "no differences" is an empty stdout, which a CI job cannot
      // tell apart from the command having failed. JSON emits ONE document with
      // the summary in it, so the caller branches on a number and never on
      // emptiness — and the stderr summary is dropped, leaving stdout the single
      // source. `--all` selects which rows are listed, same as text; a listed
      // row always carries all of its cells, so a consumer is never handed a
      // partial row. `excluded`/`sheetsOnlyOnOneSide` are always present (zero/
      // empty when the corresponding flag is off), so a consumer never has to
      // branch on whether the field exists.
      if (opts.format === "json") {
        const rows: object[] = [];
        const collect = (cat: CategoryDiff, sheetName: string): void => {
          for (const p of cat.params) {
            if (p.status === "unchanged" && !opts.all) continue;
            rows.push({ sheet: sheetName, category: cat.path, key: p.key, status: p.status, changed: p.changed, cells: p.cells, fields: p.fields });
          }
          for (const sub of cat.categories) collect(sub, sheetName);
        };
        for (const sheet of result.sheets) for (const cat of sheet.categories) collect(cat, sheet.name);
        process.stdout.write(
          JSON.stringify({ summary: result.summary, excluded: result.excluded, sheetsOnlyOnOneSide: result.sheetsOnlyOnOneSide, ambiguousKeys: result.ambiguousKeys, rows }, null, 2) + "\n"
        );
        return;
      }

      const mark: Record<string, string> = { added: "+", removed: "-", changed: "~", unchanged: " " };
      const printCat = (cat: CategoryDiff, sheetName: string): void => {
        for (const p of cat.params) {
          if (p.status === "unchanged" && !opts.all) continue;
          const cells = p.cells
            .filter((c) => opts.all || c.status !== "unchanged")
            .map((c) => {
              const label = c.instance ? `${c.instance}: ` : "";
              return c.status === "changed" ? `${label}${c.from} -> ${c.to}` : `${label}${c.to ?? c.from ?? ""}`;
            })
            .join(", ");
          // A row whose only difference is prose says so on its own line. Left
          // unmarked it reads exactly like a value change, which across two
          // dictionary versions is most of the output.
          const docOnlyRow = p.changed.length > 0 && p.changed.every((k) => k === "doc");
          // The one line in this output that can mean "the system behaves
          // differently and no one edited anything", so it says so rather than
          // leaving a reader to notice that a default moved on a row with no
          // value. Named even when other kinds changed too.
          const kinds = p.changed.includes("effective")
            ? " (effective: the product default moved under an unset value)"
            : docOnlyRow
              ? " (description/remarks only)"
              : "";
          console.log(`${mark[p.status]} ${sheetName} > ${cat.path} > ${p.key}${cells ? `: ${cells}` : ""}${kinds}`);
        }
        for (const sub of cat.categories) printCat(sub, sheetName);
      };
      for (const sheet of result.sheets) for (const cat of sheet.categories) printCat(cat, sheet.name);

      // A sheet-only fact is not a row (no key/cells to show), but it is still
      // information a reviewer scanning stdout needs — so it goes to stdout,
      // right alongside the rows, one line per sheet, never buried in the
      // stderr summary.
      for (const s of result.sheetsOnlyOnOneSide) {
        const side = s.onlyIn === "from" ? "baseline" : "current";
        console.log(`o ${s.name}: sheet only in the ${side} input (${s.paramCount} params, excluded from removed/added counts)`);
      }

      // A key the cross-category join could not use is a row that will read as
      // added/removed for a reason the numbers do not show. Printed beside the
      // rows, one line each: a count in the summary would say something was
      // wrong without saying what.
      for (const a of result.ambiguousKeys) {
        console.log(`o ${a.sheet} > ${a.key}: filed under ${a.categories.length} categories (${a.categories.join(", ")}) — not joined across them`);
      }

      const { changed, docOnly, added, removed, unchanged } = result.summary;
      // The doc-only share is called out rather than folded in. Comparing one
      // configuration across two product dictionaries, prose churn dominates —
      // measured at 67-74% of shared keys on a real upgrade, most of it a
      // translation the newer dictionary has and the older lacks — so a bare
      // "115 changed" reads as a system that moved when nothing did. Named, the
      // reader subtracts it and signs off on what is left.
      const changedPart = docOnly > 0 ? `${changed} changed (${docOnly} description/remarks only)` : `${changed} changed`;
      let summaryLine = `diff: ${changedPart}, ${added} added, ${removed} removed, ${unchanged} unchanged`;
      if (excludeDefaultOrigin) summaryLine += ` (excluded ${result.excluded.defaultOrigin} materialize default-origin rows)`;
      if (sheetPresence) summaryLine += ` (${result.sheetsOnlyOnOneSide.length} sheet(s) present on only one side, see stdout)`;
      if (crossCategory && result.ambiguousKeys.length > 0)
        summaryLine += ` (${result.ambiguousKeys.length} key(s) filed in several categories, not joined — see stdout)`;
      console.error(summaryLine);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program
  .command("serve")
  .description("Serve the sheet on localhost and apply reviewed changes directly to local files (no AI, no review.json round-trip)")
  .requiredOption("-i, --input <file>", "Input JSON file (single-version model, with source mappings)")
  .option("--port <port>", "Port to listen on", "5173")
  .option("--lang <lang>", "UI language: ja | en (default: ja)", "ja")
  .option("--parsers-dir <dir>", "Directory of custom parser plugins")
  .option("--annotation-marker <marker>", "In-source annotation marker (default: @rs)")
  .option("--no-open", "Do not open the browser automatically")
  .action(async (opts: { input: string; port: string; lang: string; parsersDir?: string; annotationMarker?: string; open: boolean }) => {
    try {
      await loadCustomParsers(opts.parsersDir);
      const extractOptions: ExtractOptions = { marker: opts.annotationMarker };
      const raw = JSON.parse(readFileSync(opts.input, "utf-8"));
      if (isVersionedInput(raw)) {
        throw new Error("serve requires a single-version input model (not a versions[] document).");
      }
      const input = validateInput(raw);
      const lang = opts.lang === "en" ? "en" : "ja";

      const readFile = (path: string): string | null => {
        try {
          return readFileSync(path, "utf-8");
        } catch {
          return null;
        }
      };

      // The HTML embeds the same model the apply API resolves against, so review
      // targets line up. Real config files are always read fresh from disk.
      const html = await generateHtml(input, { review: true, lang, server: true });

      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: Number(opts.port),
        async fetch(req: Request): Promise<Response> {
          const url = new URL(req.url);
          if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
            return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
          }
          if (req.method === "POST" && url.pathname === "/api/apply") {
            const body = (await req.json()) as { reviews?: ReviewItem[]; write?: boolean };
            const outcome = computeApply(input, body.reviews ?? [], readFile, extractOptions);
            if (body.write) {
              for (const f of outcome.files) writeFileSync(f.path, f.content, "utf-8");
              console.error(`Applied ${outcome.applied} change(s) across ${outcome.files.length} file(s).`);
            }
            return Response.json({
              results: outcome.results,
              applied: outcome.applied,
              skipped: outcome.skipped,
              held: outcome.held,
              out_of_scope: outcome.out_of_scope,
              heldPrompt: outcome.heldPrompt,
              files: outcome.files.map((f) => f.path),
              wrote: body.write === true,
            });
          }
          if (req.method === "POST" && url.pathname === "/api/verify") {
            return Response.json(verifySources(input, readFile, extractOptions));
          }
          return new Response("Not found", { status: 404 });
        },
      });

      const addr = `http://127.0.0.1:${server.port}`;
      console.error(`review-sheet serving ${opts.input} at ${addr}  (Ctrl+C to stop)`);
      if (opts.open !== false) openBrowser(addr);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

program.parse();
