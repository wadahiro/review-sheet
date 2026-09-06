// `--allow` states the whole permission set of a delivered document. It has to
// coexist with `--readonly`, and the precedence between them is the
// part that can silently ship the wrong thing: a sheet that quietly accepts
// edits, or one that quietly refuses them.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { tmpdir } from "os";
import { join } from "path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const input = join(import.meta.dir, "fixtures", "simple.json");
const work = mkdtempSync(join(tmpdir(), "review-sheet-generate-cli-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function caps(...args: string[]): { review: boolean; edit: boolean; prompt: boolean; code: number | null; stderr: string } {
  const out = join(work, `out-${args.join("_").replace(/[^A-Za-z0-9]+/g, "") || "default"}.html`);
  const proc = Bun.spawnSync(["bun", "run", cli, "generate", "-i", input, ...args, "-o", out]);
  if (proc.exitCode !== 0) return { review: false, edit: false, prompt: false, code: proc.exitCode, stderr: proc.stderr.toString() };
  const html = readFileSync(out, "utf-8");
  const m = /"review":(true|false),"edit":(true|false),"prompt":(true|false)/.exec(html);
  if (m === null) throw new Error("no capability config in the generated HTML");
  return { review: m[1] === "true", edit: m[2] === "true", prompt: m[3] === "true", code: proc.exitCode, stderr: proc.stderr.toString() };
}

describe("generate capability flags", () => {
  it("delivers review on and editing off when nothing is said", () => {
    expect(caps()).toMatchObject({ review: true, edit: false });
  });

  it("hands over a document that can only be read", () => {
    expect(caps("--readonly")).toMatchObject({ review: false, edit: false, prompt: false });
  });

  // The flag named only the review UI, but by the time editing and the prompt
  // existed it meant none of them. Renamed, not removed.
  it("still honours the old spelling", () => {
    const { stderr: _a, ...old } = caps("--no-review");
    const { stderr: _b, ...renamed } = caps("--readonly");
    expect(old).toEqual(renamed);
  });

  // Reviewing a sheet and maintaining one are different jobs done by different
  // people at different times. A document offering both puts two primary
  // actions on every cell and mixes proposals with facts in one file.
  it("refuses to be both at once", () => {
    const r = caps("--allow", "edit,review");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("not both");
  });

  // --allow is authoritative: naming only `edit` turns review OFF, even though
  // review is the default. Anything else would make the flag a set of additions
  // and leave no way to say "edit only".
  it("treats --allow as the whole set, not an addition", () => {
    expect(caps("--allow", "edit")).toMatchObject({ review: false, edit: true });
    expect(caps("--allow", "review")).toMatchObject({ review: true, edit: false });
    expect(caps("--allow", "")).toMatchObject({ review: false, edit: false });
  });

  // The prompt is a judgement about the AUDIENCE. In the usual flow the edited
  // document goes back to whoever built it and `apply` produces the prompt
  // there, against the real files — so the handed-over copy often has no use
  // for one, and shipping an affordance nobody asked to include is the thing
  // --allow exists to prevent.
  it("leaves the AI prompt out of any document whose permissions were stated", () => {
    expect(caps("--allow", "edit")).toMatchObject({ edit: true, prompt: false });
    expect(caps("--allow", "review")).toMatchObject({ review: true, prompt: false });
  });

  it("includes it when asked", () => {
    expect(caps("--allow", "edit,prompt")).toMatchObject({ edit: true, prompt: true });
    expect(caps("--allow", "review,prompt")).toMatchObject({ review: true, prompt: true });
  });

  // A document built before the switch existed still offers it, and so does one
  // built without --allow at all.
  it("keeps it when nothing was stated", () => {
    expect(caps()).toMatchObject({ prompt: true });
  });

  // The prompt is built FROM findings or edits. A read-only document produces
  // neither, so claiming the capability would describe a button that cannot
  // exist — and a config nobody can trust is worse than one feature fewer.
  it("never claims it in a document that can produce nothing", () => {
    expect(caps("--readonly")).toMatchObject({ review: false, edit: false, prompt: false });
  });

  it("refuses to be asked for it alone", () => {
    const r = caps("--allow", "prompt");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("needs review or edit");
  });

  it("refuses an unknown capability instead of ignoring it", () => {
    const r = caps("--allow", "edit,reviw");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("reviw");
  });
});

// A document handed over for hand maintenance has no cell to comment on: there
// is no model behind it, so nothing carries a review target, and a finding
// written against one would have nowhere to live. What its reader wants to say,
// they write in the text.
describe("a document handed over as markdown", () => {
  it("is editable and offers no review affordance", () => {
    expect(caps("--full-edit")).toMatchObject({ review: false, edit: true });
  });

  // …even when the permission set says otherwise: `--allow review` names a
  // capability this document cannot have, and editing is what it IS.
  it("stays that way even when review is asked for by name", () => {
    expect(caps("--full-edit", "--allow", "review")).toMatchObject({ review: false, edit: true });
  });

  // The prompt is what carries the edited document to whoever applies it, so it
  // survives review being off — unlike an ordinary sheet, where a prompt with
  // neither review nor editing behind it would describe a button that cannot
  // produce anything.
  it("keeps the prompt", () => {
    expect(caps("--full-edit")).toMatchObject({ prompt: true });
  });
});

// The previewed files are a LENS on the deployed file as it was AT GENERATION.
// A document maintained by hand keeps its values current and the preview does
// not, so a delivery that will be edited for a long time may prefer to carry no
// picture rather than one that quietly ages. It is a flag, not a rule: the
// preview is at its most useful on the first read, before anything is edited.
describe("leaving the previewed files out", () => {
  // Built here rather than committed as a fixture: a file under fixtures/ is
  // one every parser golden then answers for, and this one is a payload, not
  // an extraction subject.
  const withPreviews = join(work, "with-preview.json");
  const model = JSON.parse(readFileSync(input, "utf-8")) as {
    sheets: { name: string }[];
    artifacts?: unknown[];
  };
  model.artifacts = [
    {
      id: "s::c",
      sheet: model.sheets[0].name,
      source_file: "conf/app.conf",
      lines: [
        { text: "listen 8080", kind: "verbatim" },
        { text: "workers 4", kind: "verbatim" },
      ],
    },
  ];
  writeFileSync(withPreviews, JSON.stringify(model));

  const previews = (...args: string[]): number => {
    const out = join(work, `pv-${args.join("_").replace(/[^A-Za-z0-9]+/g, "") || "default"}.html`);
    const proc = Bun.spawnSync(["bun", "run", cli, "generate", "-i", withPreviews, ...args, "-o", out]);
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
    // The payload is gzipped into the document, so it is read back the way the
    // page reads it rather than searched as text.
    const html = readFileSync(out, "utf-8");
    const block = /id="sheet-data-gz"[^>]*>([^<]*)</.exec(html);
    const json = block
      ? gunzipSync(Buffer.from(block[1].trim(), "base64")).toString("utf-8")
      : /id="sheet-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
    const data = JSON.parse(json) as { versions: { artifacts?: unknown[] }[] };
    return data.versions.reduce((n, v) => n + (v.artifacts?.length ?? 0), 0);
  };

  it("carries them by default, and not when they are declined", () => {
    expect(previews()).toBeGreaterThan(0);
    expect(previews("--no-previews")).toBe(0);
  });
});

// A delivery names the environments it covers: not every environment a build
// knows belongs to the same handover, and the one an engineer keeps in order to
// build the others is nobody's acceptance evidence. What must be true of the
// delivered FILE is that the environment is not in it — not that a column is
// hidden — so these read the payload, not the page.
describe("generate --instances", () => {
  const model = {
    metadata: { title: "t" },
    sheets: [
      {
        name: "os",
        instances: ["local", "staging"],
        categories: [
          {
            name: "keycloak.conf",
            params: [
              {
                key: "hostname",
                description: "d",
                origin: "overlay",
                instances: [
                  { name: "local", value: "https://dev.internal.example" },
                  { name: "staging", value: "https://staging.example" },
                ],
              },
              { key: "debug-only", description: "d", origin: "overlay", instances: [{ name: "local", value: "on" }] },
            ],
          },
        ],
      },
    ],
  };
  const src = join(work, "instances.json");
  writeFileSync(src, JSON.stringify(model));

  const deliver = (...args: string[]): { payload: string; stderr: string; code: number | null } => {
    const out = join(work, `inst-${args.join("_").replace(/[^A-Za-z0-9]+/g, "") || "all"}.html`);
    const proc = Bun.spawnSync(["bun", "run", cli, "generate", "-i", src, ...args, "-o", out]);
    if (proc.exitCode !== 0) return { payload: "", stderr: proc.stderr.toString(), code: proc.exitCode };
    const html = readFileSync(out, "utf-8");
    const block = /id="sheet-data-gz"[^>]*>([^<]*)</.exec(html);
    const payload = block
      ? gunzipSync(Buffer.from(block[1].trim(), "base64")).toString("utf-8")
      : /id="sheet-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
    return { payload, stderr: proc.stderr.toString(), code: proc.exitCode };
  };

  it("leaves the undelivered environment's values out of the file itself", () => {
    const all = deliver();
    expect(all.payload).toContain("dev.internal.example");

    const some = deliver("--instances", "staging");
    expect(some.payload).not.toContain("dev.internal.example");
    expect(some.payload).toContain("staging.example");
    expect(some.payload).not.toContain('"local"');
  });

  // Kept, with nothing in its cells: the parameter is still part of the system,
  // and a document that removed the row would say it does not exist.
  it("keeps a row it emptied, and says which ones those were", () => {
    const some = deliver("--instances", "staging");
    expect(some.payload).toContain("debug-only");
    expect(some.stderr).toContain("os > keycloak.conf > debug-only");
    expect(some.stderr).toContain("left out: local");
  });

  it("refuses an environment the document does not have, instead of shipping a shorter one", () => {
    const bad = deliver("--instances", "stagng");
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("this document has local, staging");
  });

  // The hand-maintained projection is written from the model at generate time,
  // so it follows — pinned because that markdown IS the deliverable in that
  // mode, and a column nobody delivered would be a column somebody fills in.
  it("carries into the markdown a hand-maintained delivery is made of", () => {
    const some = deliver("--full-edit", "--instances", "staging");
    expect(some.payload).toContain("staging");
    expect(some.payload).not.toContain("dev.internal.example");
    const heads = /\| 設定項目 \|[^\\]*/.exec(some.payload)?.[0] ?? "";
    expect(heads).not.toContain("local");
  });
});

// One build, several documents: a parameter sheet and a test record are
// approved separately and revised on their own cycles, so a delivery says which
// sheets it is made of. Read from the payload, not the page: what must be true
// is that the other sheet is not IN the file.
describe("generate --sheets", () => {
  const model = {
    metadata: { title: "t" },
    groups: [{ name: "platform", label: { ja: "基盤" } }, { name: "tests", label: { ja: "試験" } }],
    sheets: [
      { name: "os", group: "platform", instances: [], categories: [{ name: "c", params: [{ key: "one", description: "d", value: "1" }] }] },
      { name: "os tests", group: "tests", instances: [], categories: [{ name: "c", params: [{ key: "t1", description: "d", value: "OK-EVIDENCE" }] }] },
    ],
  };
  const src = join(work, "sheets.json");
  writeFileSync(src, JSON.stringify(model));

  const deliver = (...args: string[]): { payload: string; stderr: string; code: number | null } => {
    const out = join(work, `sheets-${args.join("_").replace(/[^A-Za-z0-9]+/g, "") || "all"}.html`);
    const proc = Bun.spawnSync(["bun", "run", cli, "generate", "-i", src, ...args, "-o", out]);
    if (proc.exitCode !== 0) return { payload: "", stderr: proc.stderr.toString(), code: proc.exitCode };
    const html = readFileSync(out, "utf-8");
    const block = /id="sheet-data-gz"[^>]*>([^<]*)</.exec(html);
    const payload = block
      ? gunzipSync(Buffer.from(block[1].trim(), "base64")).toString("utf-8")
      : /id="sheet-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
    return { payload, stderr: proc.stderr.toString(), code: proc.exitCode };
  };

  it("makes the document out of the named sheets only, and says what it left out", () => {
    expect(deliver().payload).toContain("OK-EVIDENCE");
    const one = deliver("--sheets", "os");
    expect(one.payload).not.toContain("OK-EVIDENCE");
    expect(one.payload).toContain('"one"');
    expect(one.stderr).toContain("left out (1 row(s)): os tests");
    // …and the group nothing is left under goes with it, or the header carries
    // a heading over nothing.
    expect(one.payload).not.toContain('"tests"');
  });

  // One delivery script names the environments once, for documents that have
  // them and documents that do not — a prose page has no environment columns,
  // and refusing the flag there would make the script branch per document.
  it("takes --instances quietly when what is left has no environments at all", () => {
    const both = deliver("--sheets", "os", "--instances", "staging");
    expect(both.code).toBe(0);
    expect(both.payload).toContain('"one"');
  });

  it("refuses a sheet the document does not have", () => {
    const bad = deliver("--sheets", "os tets");
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("this document has os, os tests");
  });
});
