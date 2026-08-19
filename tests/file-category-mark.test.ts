// A category named after a file says that it is one.
//
// Two routes produce such a category — a declared component, and `group_by:
// file` deriving one from where each row is written — and only the first
// marked it. So a tab called `/opt/keycloak/conf/keycloak.conf` was, to
// everything downstream, a topic that happens to contain slashes: `file_path`
// is what verify and apply fall back to for a row with no file of its own, and
// they fell back to the SHEET's file instead of this category's.
//
// It marks only where the KIND is known. `rawFileOf` answers with a deployed
// path for an artifact and with a source file for anything else — a role's
// `defaults/main.yml` is neither deployed nor a template — and a category
// marked as the wrong kind is worse than one marked as neither, since a wrong
// `file_path` sends verify and apply to a file that does not hold the value.

import { describe, it, expect } from "bun:test";
import { assembleSheets } from "../src/assemble";
import type { Category } from "../src/types";

const SHEET_YML = "sheets:\n  web:\n    group_by: file\n    params: {}\n";
const readFile = (p: string): string | null => (p === "/sheet.yml" ? SHEET_YML : null);

function sheetWith(deployed: string | undefined): Category[] {
  const si = {
    name: "web",
    instances: [],
    // Where these settings land on the host, as a project states it. That is
    // the case the mark can answer for: `fileCategory`'s own fallback answers
    // with a synthetic name instead (the template path with `.j2` stripped),
    // which is neither the deployed file nor the template, so a mark there
    // would be a claim about a path that exists nowhere.
    ...(deployed ? { deployedFiles: new Map([["", deployed]]) } : {}),
    layers: [{ kind: "base" as const, entries: new Map() }],
    embedded: [
      {
        key: "Timeout",
        value: "60",
        source: { file: "roles/web/templates/httpd.conf.j2", line: 1, path: "Timeout" },
      },
    ],
  };
  const out = assembleSheets([si] as never, { readFile, projectPath: "/sheet.yml", instances: [], strictMetadata: false } as never);
  return out.sheets[0].categories as Category[];
}

describe("a category derived from a file", () => {
  it("says which deployed file it is", () => {
    const tops = sheetWith("/etc/httpd/conf/httpd.conf");
    expect(tops.map((c) => [c.name, c.file_path])).toEqual([
      ["/etc/httpd/conf/httpd.conf", "/etc/httpd/conf/httpd.conf"],
    ]);
  });

  // The honest half, and the common one: with nothing saying what kind of file
  // this is, the category stays unmarked rather than claiming to be a deployed
  // file it is not. `fileCategory` falls back to the template path with `.j2`
  // stripped — a name for a file that exists under neither spelling.
  it("claims nothing when the kind is unknown", () => {
    const tops = sheetWith(undefined);
    expect(tops).toHaveLength(1);
    expect(tops[0].file_path).toBeUndefined();
    expect(tops[0].source_file).toBeUndefined();
  });
});
