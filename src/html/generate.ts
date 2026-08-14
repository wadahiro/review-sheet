import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { ParameterSheetInput, VersionedSheetInput, SheetVersion, GenerateOptions } from "../types.js";
import { customStyles } from "./styles.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function getAppBundle(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [resolve(__dirname, "app.ts")],
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

export async function generateHtml(
  input: ParameterSheetInput | VersionedSheetInput,
  options?: GenerateOptions
): Promise<string> {
  const reviewEnabled = options?.review !== false;
  const lang = options?.lang ?? "ja";
  const appJS = await getAppBundle();
  const data = normalize(input);
  const dataJson = JSON.stringify(data);
  const configJson = JSON.stringify({ review: reviewEnabled, lang, server: options?.server === true });
  const title = options?.title ?? data.metadata?.title ?? (lang === "en" ? "Parameter Sheet" : "パラメータシート");

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
${customStyles}
</style>
<script>(function(){try{var t=localStorage.getItem('rs-theme');if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="sheet-data">
${dataJson}
</script>
<script type="application/json" id="sheet-config">
${configJson}
</script>
<script type="module">
${appJS}
</script>
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
