// A Dockerfile's reviewable values.
//
// The instructions that DECIDE something a reviewer signs — the base image,
// the environment the process gets, the ports it declares, who it runs as,
// what it runs, how it is probed — and nothing else. `RUN` is a build step,
// not a setting: what it changes is inside the layer it produces, and reading
// its shell as configuration would put a package manager's arguments on a
// parameter sheet.
//
// Keyed the way a reviewer names it: `ENV KC_DB=postgres` is the row `KC_DB`,
// not the row `ENV`. An instruction that carries no name of its own (`FROM`,
// `USER`, `ENTRYPOINT`) is the row its instruction names, lowercased, because
// there is exactly one of each that matters and the sheet reads as prose.
//
// A multi-stage build names its stages (`FROM x AS build`); the stage is part
// of the address, so two stages' `ENV PATH` are two rows rather than one row
// written twice.

import { registerParser, type ConfigParser, type Entry, type ExtractOptions } from "../parser.js";
import { lineLocate, lineEdit } from "../line-config.js";

// name=value, name value, and a quoted value with spaces.
const PAIRS = /([A-Za-z_][A-Za-z0-9_.-]*)=("[^"]*"|'[^']*'|\S*)/g;

const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/s, "$2");

// THE EXEC FORM IS STORED AS THE FILE WROTE IT, spacing and all — a row's
// value is a substring of its own line, which is what `verify` checks and what
// `apply` writes back. Canonicalising it here made the sheet show
// `["start","--optimized"]` for a file that says `["start", "--optimized"]`,
// and verify said so immediately: the value is not in the file.
//
// That two spellings of one JSON array are one VALUE is a judging question,
// answered where the comparison happens (`channels/docker.ts`'s `sameExec`),
// not by rewriting what the file says.

// Which instructions carry a setting, and whether they name it themselves.
const NAMED = new Set(["ENV", "ARG", "LABEL"]);
const PLAIN = new Set(["FROM", "USER", "WORKDIR", "ENTRYPOINT", "CMD", "EXPOSE", "STOPSIGNAL", "HEALTHCHECK", "SHELL", "VOLUME", "COPY", "ADD"]);

// …and the one shape inside a RUN that IS a setting. `RUN` is a build step, but
// a build step that takes LONG OPTIONS is where a product's build-time options
// live — an optimized image's `--db=postgres` is exactly as reviewable as the
// runtime option it replaces, and it appears in no other file. Read with the
// same rule `src/shell.ts` already applies to a wrapper script: a long option
// with a value, and nothing else. A bare flag is not read (it is
// indistinguishable from a bundle), nor is a positional argument.
//
// KEYED WITH ITS DASHES, as shell.ts keys one, because a row space shared with
// ENV names must not let `--db` and `db` be the same row.
const LONG_OPTION = /(?:^|\s)(--[a-zA-Z][a-zA-Z0-9-]*)(?:=(\S+)|\s+([^-\s]\S*))/g;

export function dockerfileEntries(content: string, file: string): Entry[] {
  const out: Entry[] = [];
  const lines = content.split("\n");
  let stage = "";
  const seen = new Map<string, number>();
  // A continued instruction is one instruction: `ENV A=1 \` + `    B=2` is two
  // values of one ENV, and reading the second line on its own would make a row
  // out of a fragment.
  for (let i = 0; i < lines.length; i++) {
    const at = i + 1;
    let text = lines[i]!;
    if (/^\s*(#|$)/.test(text)) continue;
    while (/\\\s*$/.test(text) && i + 1 < lines.length) {
      i++;
      text = text.replace(/\\\s*$/, " ") + lines[i]!;
    }
    const m = /^\s*([A-Za-z]+)\s+(.*)$/.exec(text);
    if (m === null) continue;
    const kw = m[1]!.toUpperCase();
    const rest = m[2]!.trim();
    if (kw === "FROM") {
      // `FROM image AS name` — the stage is an address, not a value.
      const as = /\s+AS\s+(\S+)\s*$/i.exec(rest);
      stage = as === null ? "" : as[1]!;
    }
    if (kw === "RUN") {
      for (const o of rest.matchAll(LONG_OPTION)) {
        const value = (o[2] ?? o[3] ?? "").replace(/\\$/, "");
        if (value === "") continue;
        const n = (seen.get((stage === "" ? "" : `${stage}.`) + o[1]!) ?? 0) + 1;
        seen.set((stage === "" ? "" : `${stage}.`) + o[1]!, n);
        const k = `${stage === "" ? "" : `${stage}.`}${o[1]!}${n === 1 ? "" : `[${n - 1}]`}`;
        out.push({
          key: k,
          categoryPath: stage === "" ? [] : [stage],
          value,
          source: { file, line: at, anchor: `${o[1]!}=`, path: k },
        });
      }
      continue;
    }
    if (!NAMED.has(kw) && !PLAIN.has(kw)) continue;
    const prefix = stage === "" ? "" : `${stage}.`;
    const add = (key: string, value: string): void => {
      const n = (seen.get(prefix + key) ?? 0) + 1;
      seen.set(prefix + key, n);
      const k = n === 1 ? `${prefix}${key}` : `${prefix}${key}[${n - 1}]`;
      out.push({ key: k, categoryPath: stage === "" ? [] : [stage], value, source: { file, line: at, anchor: value.slice(0, 60) || key, path: k } });
    };
    if (NAMED.has(kw)) {
      const pairs = [...rest.matchAll(PAIRS)];
      if (pairs.length > 0) {
        for (const p of pairs) add(p[1]!, unquote(p[2]!));
        continue;
      }
      // The older `ENV NAME value` form, whose value runs to end of line.
      const one = /^(\S+)\s+(.*)$/.exec(rest);
      if (one !== null) add(one[1]!, unquote(one[2]!.trim()));
      continue;
    }
    add(kw.toLowerCase(), kw === "FROM" ? rest.replace(/\s+AS\s+\S+\s*$/i, "") : rest);
  }
  return out;
}

export const dockerfileParser: ConfigParser = {
  name: "dockerfile",
  priority: 60,
  detect: (file) => /(^|\/)(Dockerfile|Containerfile)(\.[\w.-]+)?$/.test(file) || /\.(dockerfile|containerfile)$/i.test(file),
  extract: (content, file, _opts?: ExtractOptions) => dockerfileEntries(content, file),
  locate: lineLocate,
  edit: lineEdit,
  meta: {
    title: "Dockerfile",
    summary:
      "The instructions that decide something a reviewer signs — the base image, the environment, the ports, the user, what it runs.",
    files: "Dockerfile, Containerfile (any suffix), *.dockerfile",
    detection: "filename",
    pathStyle: "The name the instruction carries (`KC_DB` for `ENV KC_DB=…`), or the instruction's own name lowercased (`from`, `user`, `entrypoint`). A multi-stage build prefixes the stage (`build.PATH`); a repeat is indexed.",
    notes: [
      "`FROM` is a row of the file and has no counterpart in `docker inspect`: the built image does not carry what it was built FROM (buildkit records no parent), so that row is judged against the build, not against the image.",
      "`RUN` is a build step, not a setting: what it changes is inside the layer it produces, and reading its shell as configuration would put a package manager's arguments on a parameter sheet.",
      "A continued instruction (`\\` at end of line) is ONE instruction — `ENV A=1 \\` + `B=2` is two values of one ENV, and reading the second line alone would make a row out of a fragment.",
      "`ENV NAME value` (the older, unequalled form) is read too, with the value running to end of line.",
    ],
    examples: ["KC_DB", "from", "entrypoint", "build.PATH", "EXPOSE"],
  },
};

registerParser(dockerfileParser);
