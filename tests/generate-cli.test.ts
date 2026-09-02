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
