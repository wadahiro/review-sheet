// The shared engine behind an "artifact preview" — a whole file shown beside
// the sheet so a reviewer can judge a value IN ITS PLACE (see
// `ArtifactPreview`/`ArtifactLine` in types.ts for what a preview line IS and
// how much trust each kind deserves).
//
// Three producers call it, and the split between them is the whole design: the
// ansible recipe renders a Jinja template once per instance, the layered
// recipe reads a committed static file verbatim, and terraform-plan reads a
// module's `.tf` source. Each owns only what is ITS OWN — which variables
// resolve, which files are safe to show, how a row relates to a line — while
// the size gate, the line vocabulary and the identity rules live here once.
// A pure core: no `fs`, everything a caller already read handed in as a string.
//
// Deliberately not a plugin registry, unlike parser.ts/recipe.ts/metadata.ts.
// Those three each have a genuine dispatch problem — many parsers/recipes/
// providers exist and the caller does not know in advance which one a
// file/spec/query needs, so something has to pick one by name or by content.
// A preview has no such moment: a recipe produces one during its own
// `load()`, for a file it ALREADY holds and whose nature it already knows (a
// committed static file, or a template it is about to render) — there is
// nothing to look up, so a registry here would only be a detour back to the
// one caller that already had the answer.

import { jinjaConditions, jinjaLoopBlocks, substituteJinja, truthyJinja, type LineCondition } from "./jinja2.js";
import type { ArtifactLine, ArtifactPreview } from "./types.js";

// Above this a file is not previewed. The limit is a RULE rather than a list of
// file kinds so nothing has to be special-cased: what it excludes in practice
// is machine-generated documents (a rendered terraform plan), which are also
// exactly the documents whose adjacent lines say nothing.
export const MAX_PREVIEW_BYTES = 128 * 1024;

// keys: the SOURCE file's own 1-based line number (the template `previewRendered`
// walks, or the committed file `previewFile` reads) -> the row's FINAL sheet
// key. Built by the caller, who alone knows which line became which row —
// this module never invents a key, only attaches the ones it is handed.
// One template line can become SEVERAL lines of the deployed file — a
// `{% for %}` writes its body once per element — and each of those is its own
// row. So the value is a list, indexed by the element's position: entry 0 is
// the ordinary case and the only one a template line outside a loop has.
//
// Without the axis, a loop's copies all pointed at one key: the map kept the
// last member's (last-wins, below) and hung it on the FIRST copy, so one row
// linked to another row's line and every other member had no line at all —
// no "see this line in the file" button on any of them.
export type LineKeys = Map<number, string[]>;

// No-ops when `line` is undefined (a row with no source line has nowhere to
// attach). A collision is last-wins, matching both existing producers: neither
// has ever needed to distinguish "the second entry on this line wins" from an
// error, since a later entry on the same line is closer to what a reader sees
// there.
export function addLineKey(keys: LineKeys, line: number | undefined, key: string, member = 0): void {
  if (line === undefined) return;
  const at = keys.get(line) ?? [];
  at[member] = key;
  keys.set(line, at);
}

// Identity plus placement, common to both producers. A caller builds this once
// (with `previewId` below) and passes it to `previewFile`/`previewRendered`,
// which never have to re-derive an id or guess where a file lands.
export type PreviewSource = {
  id: string;
  sheet: string;
  component?: string;
  deployed_path?: string;
  source_file: string;
  // Passed straight through to `ArtifactPreview.nature` — see its own doc
  // comment in types.ts. Omitted = the default "artifact" (a whole deployed
  // file); every producer before terraform-plan.ts's `.tf` bridge leaves this
  // unset, so their output is unaffected.
  nature?: ArtifactPreview["nature"];
};

// `sheet` alone when the sheet has no components, `sheet::component` when it
// does — the same convention `ArtifactPreview.id` has always used, and every
// id the repository produces today must come out byte-identical, so `file` is
// genuinely optional and unused by every current caller. It exists for a
// producer whose sheet/component covers MORE THAN ONE FILE (several static
// files under one component; a Terraform module's `main.tf` and
// `variables.tf` on one sheet/component) — id identifies one previewed FILE
// (see `ArtifactPreview.id`), so those need a further discriminator to keep
// their ids apart, on pain of the viewer rendering unrelated files as bogus
// instance tabs of each other; a file's basename is what a reader would call
// it, so that is what gets appended.
export function previewId(sheet: string, component?: string, file?: string): string {
  const base = component === undefined ? sheet : `${sheet}::${component}`;
  if (file === undefined) return base;
  return `${base}::${file.split("/").pop() ?? file}`;
}

// Shared wording for the one gate both producers must apply, kept as one
// string so a wording fix can't drift between them. Named by the file the
// caller is trying to preview and its size against the limit; refusal is
// always loud (`warn`) — losing a preview quietly is exactly the failure mode
// this project exists to prevent, so the caller is told what happened and why
// its rows will not get the "show me this line in the file" affordance.
function sizeGateWarning(file: string, bytes: number): string {
  return (
    `file ${file}: ${Math.round(bytes / 1024)} KB, over the ${Math.round(MAX_PREVIEW_BYTES / 1024)} KB ` +
    `preview limit — its rows will not offer "show me this line in the file"`
  );
}

// A committed file: verbatim by identity. There is nothing for an engine to
// get wrong here — the file's own text IS the deployed text — so every line
// is `verbatim`, and a row's key (from `keys`) is attached where it landed.
// Returns `undefined` when the size gate refuses it, having warned.
export function previewFile(
  src: PreviewSource,
  content: string,
  keys: LineKeys,
  warn: (m: string) => void
): ArtifactPreview | undefined {
  if (content.length > MAX_PREVIEW_BYTES) {
    warn(sizeGateWarning(src.source_file, content.length));
    return undefined;
  }
  return {
    id: src.id,
    sheet: src.sheet,
    ...(src.component !== undefined ? { component: src.component } : {}),
    ...(src.deployed_path !== undefined ? { deployed_path: src.deployed_path } : {}),
    source_file: src.source_file,
    ...(src.nature !== undefined ? { nature: src.nature } : {}),
    lines: content.split("\n").map((text, i) => {
      // A committed file has no loop to repeat a line, so only entry 0 is ever
      // set here.
      const key = keys.get(i + 1)?.[0];
      return { text, kind: "verbatim" as const, ...(key === undefined ? {} : { key }) };
    }),
  };
}

// Whether a `{% if %}` around a line holds for this instance, evaluated
// through the caller's own `resolve` — the equivalent of the ansible recipe's
// `holds`/`valueIn`, generalized to whatever variable source the caller has
// (defaults+overlays for Ansible; nothing else uses this yet). An unsupported
// condition never holds: the caller already reported it as `unrendered`
// before this is even consulted for the `absent` case.
function holds(
  cond: LineCondition | undefined,
  instance: string | undefined,
  resolve: (instance: string | undefined, name: string) => string | undefined
): boolean {
  return cond === undefined
    ? true
    : cond.supported
      ? cond.tests.every((t) => truthyJinja(resolve(instance, t.variable)) !== t.negated)
      : false;
}

// One instance's rendering of the whole template, line by line — moved
// unchanged from the ansible recipe's `renderPreview`. A line with no Jinja on
// it IS the deployed line, by identity, which is what makes this cheap and
// what makes it honest: every comment and every blank line comes through
// untouched.
// One element of a `{% for %}`'s list, as the CALLER already understands it.
// A scalar member is its value; a map member is its fields, plus the field the
// format folded into the element's address to identify it (which renders and
// has no site of its own).
//
// Passed in rather than walked here: the recipe that renders a template already
// resolves these to build the ROWS, and two walks that must agree are two walks
// that drift. Without it this file could only count `list[0]`, `list[1]`, … up
// from zero, so a list of maps read as an empty list and the preview declared
// the whole loop uncomputable while the rows for it sat on the sheet.
export type LoopMemberView = {
  value?: string;
  fields?: ReadonlyMap<string, string>;
  identifier?: { field: string; value: string };
};

function renderLines(
  templateText: string,
  instance: string | undefined,
  keys: LineKeys,
  resolve: (instance: string | undefined, name: string) => string | undefined,
  deployTimeVars: ReadonlySet<string>,
  listMembers: ((list: string, instance: string | undefined) => LoopMemberView[]) | undefined
): ArtifactLine[] {
  const conditions = jinjaConditions(templateText);
  const blocks = new Map(jinjaLoopBlocks(templateText).map((b) => [b.start, b]));
  const keyOf = (line: number, member = 0): { key?: string } => {
    const k = keys.get(line)?.[member];
    return k === undefined ? {} : { key: k };
  };
  const out: ArtifactLine[] = [];
  // A `{% for %}` renders its body once per element, and the preview is the
  // deployed FILE — three NTP sources are three `server` lines there. Rendering
  // it once left `server {{ s }} iburst` on screen: the loop variable resolves
  // from no vars file, so the preview showed the template where it promises the
  // file. The members come from the same walk the recipe's expansion uses.
  const membersOf = (list: string): LoopMemberView[] => {
    if (listMembers !== undefined) return listMembers(list, instance);
    const out: LoopMemberView[] = [];
    for (let i = 0; ; i++) {
      const v = resolve(instance, `${list}[${i}]`);
      if (v === undefined) break;
      out.push({ value: v });
    }
    return out;
  };
  // The loop variable resolves to THIS member: the whole of it for a scalar,
  // one field for a map, and the identifier where the address holds it.
  const inMember = (m: LoopMemberView, nm: string, variable: string): string | undefined => {
    if (nm === variable) return m.value;
    if (!nm.startsWith(`${variable}.`)) return resolve(instance, nm);
    const field = nm.slice(variable.length + 1);
    return m.fields?.get(field) ?? (m.identifier?.field === field ? m.identifier.value : undefined);
  };
  // Does the `{% if %}` around a line hold — or is the answer not knowable
  // here? THREE states, not two.
  //
  // "Not knowable" used to be spelled false, and `absent` is a positive claim
  // that the deployed file does NOT contain the line. For a name this sheet
  // cannot read, the tool holds no evidence for that claim: the deployment
  // leaving a variable unset and the SHEET never being pointed at the file that
  // sets it are indistinguishable here, and only the first of them makes the
  // line absent. Measured, on a real template: `{% if secret_list %}` around a
  // block whose `{% for secret_list %}` body the sheet was rendering perfectly
  // — the list has no scalar value, so six lines the deployed file has, one of
  // them the directory's permissions, were struck through as absent while the
  // loop inside them rendered. The preview asserted the block was both taken
  // and not taken.
  //
  // What this costs in noise, measured rather than argued: on a real project
  // it turned 0 lines from `absent` into `unrendered`, because the ROW side
  // already reported a condition variable a sheet does not read ("add it to
  // include:") — the preview was the one surface still silent about it. A sheet
  // that legitimately tests a variable defined nowhere would now be told so on
  // every build; if that ever becomes noise, the answer is a declaration in the
  // spec that the build can check, not a guess here.
  //
  // A name with readable ELEMENTS is a non-empty list and therefore true —
  // Jinja agrees, and refusing the enumeration here while printing rendered
  // lines from it two lines down is that same contradiction. Zero elements
  // stays unknown: "genuinely empty" and "this sheet reads no elements of it"
  // are the same two cases again.
  const condState = (cond: Extract<LineCondition, { supported: true }>): "holds" | "fails" | "unknown" => {
    for (const t of cond.tests) {
      const scalar = resolve(instance, t.variable);
      const truth = scalar !== undefined ? truthyJinja(scalar) : membersOf(t.variable).length > 0 ? true : undefined;
      if (truth === undefined) return "unknown";
      if (truth === t.negated) return "fails";
    }
    return "holds";
  };
  const unreadable = (cond: Extract<LineCondition, { supported: true }>): string =>
    cond.tests
      .filter((t) => resolve(instance, t.variable) === undefined && membersOf(t.variable).length === 0)
      .map((t) => t.variable)
      .join(", ");

  const lines = templateText.split("\n");
  // One template line, outside any loop body — or inside one, with the loop
  // variable already bound by the caller.
  const renderOne = (i: number, bind: ((nm: string) => string | undefined) | undefined, member: number): void => {
    const line = lines[i];
    const key = keyOf(i + 1, member);
    const cond = bind === undefined ? conditions.get(i + 1) : undefined;
    if (cond !== undefined && !cond.supported) {
      out.push({ text: line, kind: "unrendered", reason: cond.expr, ...key });
      return;
    }
    if (cond !== undefined) {
      const state = condState(cond);
      if (state === "unknown") {
        out.push({
          text: line,
          kind: "unrendered",
          cause: "engine",
          reason: `${unreadable(cond)} — this sheet reads no value for it, so whether this line is in the file is not known here`,
          ...key,
        });
        return;
      }
      if (state === "fails") {
        out.push({
          text: line,
          kind: "absent",
          reason: cond.tests.map((t) => (t.negated ? `not ${t.variable}` : t.variable)).join(" and "),
          ...key,
        });
        return;
      }
    }
    if (!line.includes("{{")) {
      out.push({ text: line, kind: "verbatim", ...key });
      return;
    }
    const { text: rendered, unresolved } = substituteJinja(line, bind ?? ((n) => resolve(instance, n)));
    if (unresolved.length === 0) {
      out.push({ text: rendered, kind: "substituted", ...key });
      return;
    }
    // `{{ name }}` -> name, for deciding which of the two causes this is.
    const names = unresolved.map((u) => /^\{\{-?\s*([A-Za-z_][\w.]*)\s*-?\}\}$/.exec(u)?.[1]);
    const deployTime = names.every((n) => n !== undefined && deployTimeVars.has(n));
    out.push({
      text: line,
      kind: "unrendered",
      cause: deployTime ? "deploy-time" : "engine",
      reason: unresolved.join(", "),
      ...key,
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const block = blocks.get(i + 1);
    if (block !== undefined) {
      const body: number[] = [];
      for (let j = i + 1; j < block.end - 1; j++) body.push(j);
      const members = membersOf(block.list);
      if (members.length === 0) {
        // Not "the list is empty": this sheet reads no elements of it, and an
        // empty list would render nothing at all rather than these lines.
        for (const j of body) {
          out.push({
            text: lines[j],
            kind: "unrendered",
            cause: "engine",
            reason: `${block.list} has no elements this sheet reads`,
            ...keyOf(j + 1),
          });
        }
      } else {
        // Element one's whole body, then element two's — the order Jinja
        // writes and therefore the order the deployed file has. Each copy takes
        // ITS element's row key: a template line inside a loop is one row per
        // element, and each of those rows wants to point at its own line.
        members.forEach((m, n) => {
          for (const j of body) renderOne(j, (nm) => inMember(m, nm, block.variable), n);
        });
      }
      i = block.end - 1;
      continue;
    }
    // The `{% ... %}` tag line itself produces no output line.
    if (/\{%/.test(lines[i])) continue;
    renderOne(i, undefined, 0);
  }
  return out;
}

// A template, rendered once per instance and deduped — moved unchanged from
// the ansible recipe's per-template loop (`byText`/`JSON.stringify(lines)`).
// Most files do not differ between environments at all, and three identical
// copies of one file is three times the reading for no information, so
// instances that render the same text are listed together on one preview
// instead of emitted as separate ones.
export function previewRendered(
  src: PreviewSource,
  templateText: string,
  instances: string[],
  resolve: (instance: string | undefined, name: string) => string | undefined,
  keys: LineKeys,
  deployTimeVars: ReadonlySet<string>,
  warn: (m: string) => void,
  // How to enumerate a `{% for %}`'s elements — see LoopMemberView. Omitted
  // means "count list[0], list[1], … up from zero", which covers a list of
  // scalars and nothing else.
  listMembers?: (list: string, instance: string | undefined) => LoopMemberView[]
): ArtifactPreview[] {
  if (templateText.length > MAX_PREVIEW_BYTES) {
    warn(sizeGateWarning(src.source_file, templateText.length));
    return [];
  }
  const names = instances.length > 0 ? instances : [undefined];
  const byText = new Map<string, { lines: ArtifactLine[]; instances: string[] }>();
  for (const instance of names) {
    const lines = renderLines(templateText, instance, keys, resolve, deployTimeVars, listMembers);
    const sig = JSON.stringify(lines);
    const hit = byText.get(sig);
    if (hit) {
      if (instance !== undefined) hit.instances.push(instance);
    } else {
      byText.set(sig, { lines, instances: instance === undefined ? [] : [instance] });
    }
  }
  return [...byText.values()].map(({ lines, instances: sharedInstances }) => ({
    id: src.id,
    sheet: src.sheet,
    ...(src.component !== undefined ? { component: src.component } : {}),
    ...(src.deployed_path !== undefined ? { deployed_path: src.deployed_path } : {}),
    source_file: src.source_file,
    ...(src.nature !== undefined ? { nature: src.nature } : {}),
    ...(sharedInstances.length > 0 ? { instances: sharedInstances } : {}),
    lines,
  }));
}
