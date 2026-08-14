// Jinja2 parser: a `.j2` template is recognised first (high priority), its base
// format is detected from the name minus `.j2`, and each extracted value is
// annotated with the variable behind a `{{ … }}` substitution and whether it
// sits in a conditional/loop block. It is an extraction aid: the intended flow
// resolves `source.templateVar` against the variable file, not the template.

import { baseFileName, jinjaVariable, conditionalLineSet, maskJinja } from "../jinja2.js";
import {
  registerParser,
  resolveParser,
  getParser,
  type ConfigParser,
  type Entry,
  type EditResult,
  type LocateResult,
} from "../parser.js";
import type { SourceLocation } from "../types.js";

const jinja2Parser: ConfigParser = {
  name: "jinja2",
  // Win over the content-detectors (nginx/httpd/haproxy, 60) so a templated
  // config is recognised as a template first, then delegated to its base format.
  priority: 70,
  meta: {
    title: "Jinja2",
    summary: "Templates (.j2): base-format structure + the {{ variable }} behind each value (extraction aid).",
    files: "*.j2",
    detection: "extension (.j2)",
    delimiter: "(base format, detected from the name minus .j2)",
    comments: "(base format)",
    pathStyle: "delegates to the base format; adds source.templateVar / source.conditional hints",
    notes: [
      "Strips .j2 and detects the base format from the remaining name (keycloak.conf.j2 -> .conf).",
      "Each value keeps the base format's line/anchor/path; a `{{ var }}` value also records source.templateVar.",
      "Lines inside {% if %}/{% for %} blocks are flagged source.conditional (their rendered line numbers are unstable).",
      "Brace-structured base formats (nginx/httpd) are supported: {{ }}/{% %} are masked before delegation, so a {{ var }} directive value is captured (not mis-read as a block brace) and {% %} lines do not leak as parameters.",
      "Intended as an extraction aid: a conversion script resolves templateVar against the variable file (defaults/group_vars), not the template.",
      "verify/apply on a .j2 itself fall back to line+anchor; the primary flow points source at the variable file.",
    ],
    examples: [
      "{{ keycloak_hostname }} -> source.templateVar: keycloak_hostname",
      "a line inside {% if … %} -> source.conditional: true",
    ],
  },
  detect: (file) => file.toLowerCase().endsWith(".j2"),
  extract: (content, file, opts): Entry[] => {
    const baseName = baseFileName(file);
    // Mask Jinja2 tokens before handing the template to the base parser, so a
    // brace-structured format (nginx/httpd) does not mis-scan `{{ }}` / `{% %}`.
    // Restore the original `{{ … }}` text on each extracted value afterwards.
    const { masked, restore } = maskJinja(content);
    // A caller-supplied base format WINS over the stripped name. It is only
    // ever supplied when that name yields no structured format of its own (see
    // ExtractOptions.baseFormat), and in that case it is the better witness: a
    // bare `.conf` resolves to the generic key=value parser, which is a guess
    // from an extension thousands of unrelated files share, while the path the
    // artifact is DEPLOYED to says what it actually is.
    const base = (opts?.baseFormat ? getParser(opts.baseFormat) : undefined) ?? resolveParser(baseName, masked);
    if (!base) return [];
    const cond = conditionalLineSet(content);
    // Pass opts through unchanged: the base format is whatever the delegate
    // is (yaml's identity fields, an annotation parser's marker, …), and this
    // parser has no opinion of its own about them.
    return base.extract(masked, baseName, opts).map((e): Entry => {
      const key = restore(e.key);
      const value = restore(e.value);
      // The PATH too. A structural address is normally built from real keys,
      // which cannot contain `{{ }}` — but a format whose containers are
      // themselves templated has one that can (a logrotate block is addressed
      // by its log path, and that path is `{{ keycloak_home }}/data/log/…`).
      // Left masked, the placeholder token leaks into the row's identity.
      const path = e.source.path === undefined ? undefined : restore(e.source.path);
      // And the CATEGORY path, for the same reason and from the same source:
      // it is the container's own name, so a templated container names its
      // rows' heading too.
      const categoryPath = e.categoryPath.map(restore);
      const templateVar = jinjaVariable(value);
      const conditional = e.source.line !== undefined && cond.has(e.source.line);
      if (
        key === e.key &&
        value === e.value &&
        path === e.source.path &&
        categoryPath.every((c, i) => c === e.categoryPath[i]) &&
        !templateVar &&
        !conditional
      )
        return e;
      return {
        ...e,
        key,
        value,
        categoryPath,
        source: {
          ...e.source,
          ...(path === undefined ? {} : { path }),
          ...(templateVar ? { templateVar } : {}),
          ...(conditional ? { conditional: true } : {}),
        },
      };
    });
  },
  // A .j2 is rarely the apply target (the variable file is), but a literal value
  // left mapped to the template is still verifiable there.
  //
  // Delegated to the BASE format, the same way extraction is, whenever the row
  // carries a structural path: a template line that holds no variable at all is
  // an ordinary line of its format, and only that format can answer where it
  // is. This is what makes a value the format SYNTHESISED verifiable — a
  // logrotate flag's value is `true` because the directive is present, and no
  // amount of searching the text for "true" will confirm it, while asking
  // logrotate's own locate for the block's `missingok` confirms it exactly.
  // Falls back to line+anchor for a row with no path, which is every row that
  // predates this and every unstructured format.
  locate: (content, source: SourceLocation, expected: string, opts): LocateResult => {
    if (source.path !== undefined) {
      const { masked, restore, mask } = maskJinja(content);
      const base = resolveParser(baseFileName(source.file ?? ""), masked);
      // `resolveParser` never returns this parser for the stripped name (it no
      // longer ends in `.j2`), so there is no recursion to guard against —
      // except when the base IS unresolvable and the generic fallback answers,
      // which is the same answer the line+anchor path below gives anyway.
      if (base && base.name !== "jinja2") {
        // The path goes back through the mask: it was recorded restored (a row
        // is identified by what the template says, not by an internal token),
        // and the index the base parser builds here is over `masked`.
        const hit = base.locate(masked, { ...source, path: mask(source.path) }, expected, opts);
        // Restore before comparing: the caller matches this against the row's
        // value, which carries the original `{{ … }}` text.
        if ("value" in hit) return { ...hit, value: restore(hit.value) };
        return hit;
      }
    }
    const generic = getParser("generic");
    return generic ? generic.locate(content, source, expected) : { error: "no base parser", status: "unmapped" };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    const generic = getParser("generic");
    return generic ? generic.edit(content, source, current, suggested) : { status: "error", reason: "no base parser" };
  },
};
registerParser(jinja2Parser);
