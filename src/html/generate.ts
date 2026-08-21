import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { ParameterSheetInput, VersionedSheetInput, SheetVersion, GenerateOptions } from "../types.js";
import { customStyles } from "./styles.js";
import { toBase64Gzip, BOOTSTRAP } from "./compress.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Three entries, one app. `app-md.ts` is `app.ts` plus a markdown renderer, and
// it is the only module that imports marked — see html/markdown-runtime.ts for
// why that costs 43 KB and why most documents should not pay it.
// `app-mermaid.ts` is that plus a diagram renderer, which costs 3.3 MB and is
// carried only by a document that draws one. Cached per entry: a build with
// several sheets should not rebuild any of them.
const bundles = new Map<string, Promise<string>>();

async function getAppBundle(entry: "app.ts" | "app-md.ts" | "app-mermaid.ts"): Promise<string> {
  const cached = bundles.get(entry);
  if (cached) return cached;
  const built = buildBundle(entry);
  bundles.set(entry, built);
  return built;
}

async function buildBundle(entry: string): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(__dirname, entry)],
    minify: true,
    target: "browser",
    format: "esm",
  });
  if (!result.success) {
    throw new Error(
      `Browser JS build failed:\n${result.logs.map((l) => l.message).join("\n")}`
    );
  }
  return await result.outputs[0].text();
}

// Normalize either shape into the embedded `{ metadata, versions }` payload the
// viewer reads. A plain ParameterSheetInput becomes a single version.
function normalize(input: ParameterSheetInput | VersionedSheetInput): {
  metadata?: ParameterSheetInput["metadata"];
  versions: SheetVersion[];
  capabilities?: ParameterSheetInput["capabilities"];
} {
  if ("versions" in input) {
    return { metadata: input.metadata, versions: input.versions, capabilities: input.capabilities };
  }
  return {
    metadata: input.metadata,
    versions: [
      {
        version: input.metadata?.version ?? "current",
        date: input.metadata?.generated_at,
        sheets: input.sheets,
        columns: input.columns,
        groups: input.groups,
        artifacts: input.artifacts,
      },
    ],
    capabilities: input.capabilities,
  };
}

// Assemble several single-version inputs (one file per snapshot) into a
// versioned document. Order is derived from each snapshot's `generated_at`
// date — NOT the order files were passed — so the timeline is correct
// regardless of CLI argument order. When any snapshot lacks a date, the given
// order is kept (the CLI warns in that case).
export function assembleVersions(inputs: { file: string; input: ParameterSheetInput }[]): VersionedSheetInput {
  const baseName = (f: string): string => (f.split("/").pop() ?? f).replace(/\.[^.]+$/, "");
  let versions: SheetVersion[] = inputs.map(({ file, input }) => ({
    version: input.metadata?.version ?? baseName(file),
    date: input.metadata?.generated_at,
    sheets: input.sheets,
    columns: input.columns,
    groups: input.groups,
    artifacts: input.artifacts,
  }));
  if (versions.every((v) => v.date)) {
    versions = versions.slice().sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
  }
  // Disambiguate duplicate version labels so ids stay unique.
  const labelCount = new Map<string, number>();
  for (const v of versions) labelCount.set(v.version, (labelCount.get(v.version) ?? 0) + 1);
  versions.forEach((v, i) => {
    if ((labelCount.get(v.version) ?? 0) > 1) v.id = `${v.version}#${i + 1}`;
  });
  const metadata = inputs.map((x) => x.input.metadata).find((m) => m?.title) ?? inputs[0]?.input.metadata;
  // Same pick-first-defined rule as metadata: any one snapshot opting out of a
  // capability (e.g. `apply: false`) applies to the whole assembled document.
  const capabilities = inputs.map((x) => x.input.capabilities).find((c) => c !== undefined);
  return { metadata, versions, capabilities };
}

// Returns true if all snapshots carry a date (so ordering is unambiguous).
export function allDated(inputs: { input: ParameterSheetInput }[]): boolean {
  return inputs.every((x) => !!x.input.metadata?.generated_at);
}

// A closing script tag inside embedded text ends the element, whatever that
// text means to JS or JSON. It is not hypothetical: the app's own source
// mentions "</script>" (it reads its embedded history back out), and any config
// value could contain one. Both JavaScript and JSON read \/ as a plain forward
// slash, so one substitution covers the bundle and the payloads alike.
//
// This belongs to whoever writes the <script> element, not to whoever produced
// the text — every caller getting it right separately is how it went wrong.
const escapeScriptClose = (text: string): string => text.replace(/<\/script/gi, "<\\/script");

export async function generateHtml(
  input: ParameterSheetInput | VersionedSheetInput,
  options?: GenerateOptions
): Promise<string> {
  const reviewEnabled = options?.review !== false;
  const editEnabled = options?.edit === true;
  const promptEnabled = options?.prompt !== false;
  const lang = options?.lang ?? "ja";
  const data = normalize(input);
  // The renderer travels only where it can be used: a document sheet that
  // somebody may edit. A read-only document is already rendered.
  const editableDocument =
    editEnabled && data.versions.some((v) => v.sheets.some((s) => s.document !== undefined));
  // A diagram, unlike a heading or a paragraph, is NOT already rendered in a
  // read-only copy: the build leaves the diagram's source in the page because
  // it has no browser to draw it with, so the page draws it. That makes this
  // independent of `editEnabled` — a read-only document needs the renderer just
  // as much as an editable one.
  const drawsDiagram = data.versions.some((v) => v.sheets.some((s) => s.document?.mermaid === true));
  const entry = drawsDiagram ? "app-mermaid.ts" : editableDocument ? "app-md.ts" : "app.ts";
  const appJS = await getAppBundle(entry);
  const dataJson = JSON.stringify(data);
  const showSources = options?.sources !== false;
  const configJson = escapeScriptClose(JSON.stringify({ review: reviewEnabled, edit: editEnabled, prompt: promptEnabled, sources: showSources, lang, server: options?.server === true }));
  const title = options?.title ?? data.metadata?.title ?? (lang === "en" ? "Parameter Sheet" : "パラメータシート");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<script>(function(){try{var t=localStorage.getItem('rs-theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="sheet-config">
${configJson}
</script>
${editEnabled ? `<script type="application/json" id="sheet-reviews">
[]
</script>` : ""}
<script type="application/gzip-base64" id="sheet-style-gz">
${toBase64Gzip(customStyles)}
</script>
<script type="application/gzip-base64" id="sheet-data-gz">
${toBase64Gzip(dataJson)}
</script>
<script type="application/gzip-base64" id="sheet-app-gz">
${toBase64Gzip(appJS)}
</script>
<script>${BOOTSTRAP}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
