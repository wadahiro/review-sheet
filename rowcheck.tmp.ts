// What the viewer actually PUTS on screen for that section.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
if (typeof (globalThis as { document?: unknown }).document === "undefined") GlobalRegistrator.register();
import { h, render } from "preact";
import { readFileSync } from "node:fs";
import { Root } from "./src/html/app";

const P = "/Users/wadahiro/dev/src/github.com/wadahiro/iam-platform-poc/.review-sheet/out";
const model = JSON.parse(readFileSync(`${P}/iam-platform-delivery.json`, "utf-8"));
const idx = (model.sheets as { name: string; document?: { html?: string } }[]).findIndex((s) => (s.document?.html ?? "").includes("OS基本情報"));
console.log(`sheet: ${model.sheets[idx]?.name}`);
location.hash = `#${idx + 1}`;
const host = document.createElement("div");
document.body.appendChild(host);
render(h(Root, { payload: { metadata: model.metadata, versions: [{ version: "current", sheets: model.sheets, columns: model.columns }] }, reviewEnabled: true, editEnabled: false, initialLang: "ja", server: false } as never), host);
const heads = [...host.querySelectorAll(".rs-doc h4")].filter((x) => (x.textContent ?? "").includes("OS基本情報"));
console.log(`OS基本情報 の見出し: ${heads.length}`);
const first = heads[0];
let n = first?.nextElementSibling ?? null;
let step = 0;
while (n && step < 4) {
  console.log(`  次の要素[${step}] <${n.tagName.toLowerCase()}> "${(n.textContent ?? "").trim().slice(0, 70)}"`);
  const tb = n.tagName.toLowerCase() === "table" ? n : n.querySelector("table");
  if (tb) {
    const rows = [...tb.querySelectorAll("tr")];
    console.log(`     wrapper: <${n.tagName.toLowerCase()} class="${(n as HTMLElement).className}">`);
    console.log((tb as HTMLElement).outerHTML.slice(0, 420).replace(/></g, '>\n<'));
    break;
  }
  n = n.nextElementSibling;
  step++;
}
