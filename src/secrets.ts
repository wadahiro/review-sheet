// The one thing a `secret` declaration is for: a check, at the point where a
// sheet stops being a working file and becomes something handed around.
//
// A generated sheet is a DISTRIBUTABLE — one self-contained HTML, mailed,
// attached to a ticket, dropped on a share. Every value it shows is inside it.
// So the question worth asking of a row the product or the project has called
// a credential is not "should the viewer hide it" — hiding it on screen would
// sell a safety the file does not have, since the value is still in the source
// — but "is this a literal at all, or a reference to somewhere the secret
// actually lives".
//
// Reported, not thrown. A project may legitimately hold a placeholder it has
// decided is safe (a `CHANGEME_...` marker its pipeline replaces), and failing
// the build over one would be answered by removing the declaration, which
// leaves it less protected than before. Naming the rows every time is what
// this can honestly do.
import type { ParameterSheetInput, VersionedSheetInput, Parameter, Category, Sheet } from "./types.js";

export type BakedSecret = { sheet: string; category: string; key: string; instance?: string; version?: string };

// A value that POINTS somewhere rather than being the thing itself. Both
// spellings appear in the configuration this tool reads: `${...}` is the shell
// and Keycloak vault form, `{{ ... }}` the Jinja/Ansible one, `$(...)` the
// parenthesised environment lookup — and a row whose value survived
// substitution with any of them intact is still a reference at rest.
//
// Deliberately shape-based and nothing else. A denylist of known-bad values
// ("changeme", "password") would call a real secret safe the moment it looked
// unusual, which is the wrong way round for a check like this.
// `${...}` is the shell and Keycloak vault form, `{{ ... }}` the Jinja/Ansible
// one, and `$(...)` the parenthesised environment lookup a Keycloak provider
// config uses. Three spellings of one fact: the value at rest is a pointer, not
// the credential. Missing the third reported a reference as a baked secret,
// which sends a reader looking for something that is not in the file.
const REFERENCE = /\$\{[^}]*\}|\{\{[^}]*\}\}|\$\([^)]*\)/;

const isLiteral = (value: string | undefined): boolean => value !== undefined && value !== "" && !REFERENCE.test(value);

// Accepts a versioned document too, and reports the version: every version is
// packaged into the same file, so a credential dropped from the current one is
// still in the reader's hands if an older one carried it.
export function findBakedSecrets(input: ParameterSheetInput | VersionedSheetInput): BakedSecret[] {
  const out: BakedSecret[] = [];
  let version: string | undefined;
  const visitParam = (sheet: string, category: string, param: Parameter): void => {
    if (param.secret !== true) return;
    // A row nobody set carries the PRODUCT's default, which is published — the
    // documented default of a keystore password is not this deployment's
    // secret, and reporting it would train a reader to ignore this list.
    if (param.origin === "default" || param.origin === "baseline") return;
    const at = (instance?: string): BakedSecret => ({ sheet, category, key: param.key, ...(instance ? { instance } : {}), ...(version ? { version } : {}) });
    if (isLiteral(param.value)) out.push(at());
    for (const inst of param.instances ?? []) {
      if (isLiteral(inst.value)) out.push(at(inst.name));
    }
  };
  const walk = (sheet: string, path: string, categories: Category[] | undefined): void => {
    for (const c of categories ?? []) {
      const here = path ? `${path} > ${c.name}` : c.name;
      for (const p of c.params ?? []) visitParam(sheet, here, p);
      walk(sheet, here, c.categories);
    }
  };
  const sheets = (ss: Sheet[]): void => {
    for (const s of ss) walk(s.name, "", s.categories);
  };
  if ("versions" in input) {
    for (const v of input.versions) {
      version = v.version;
      sheets(v.sheets);
    }
  } else {
    sheets(input.sheets);
  }
  return out;
}

export function formatBakedSecrets(found: BakedSecret[]): string {
  return [
    `${found.length} value(s) declared secret are written into the sheet as literals, and a generated sheet carries every ` +
      `value it shows:`,
    ...found.map((f) => `  ${f.version ? `${f.version}: ` : ""}${f.sheet} > ${f.category} > ${f.key}${f.instance ? ` [${f.instance}]` : ""}`),
    `A reference (\${...}, {{ ... }} or \$(...)) is not reported — only a value that IS the credential.`,
  ].join("\n");
}
