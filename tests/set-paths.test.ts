// EVERY PATH OF A SET IS INSIDE THE SET.
//
// A set is written under the directory `-o` names and carried in an archive
// somebody else opens, so a path of it is not a path on this machine. The two
// spaces used to be joined by string concatenation — `sources/` + whatever the
// model recorded — and every way a filesystem path is not already a suffix came
// through with it.
//
// Measured on the real CLI before this existed, and each one is a case below:
//   a `..`-carrying path wrote OUTSIDE the directory -o named, with no warning
//   at all (the stale-file scan only looks inside it); the same model as a .zip
//   produced an entry named `docs/sources/../../../../x.txt`; and two documents
//   whose paths differed as strings but normalised to one collapsed to a single
//   file on disk — the first silently gone, while the run reported both.

import { describe, it, expect } from "bun:test";
import { containedPath, carriedDocuments } from "../src/md-documents";
import { join } from "node:path";

const preview = (over: Record<string, unknown> = {}) => ({
  id: "s::a",
  sheet: "s",
  source_file: "x.conf",
  nature: "source",
  lines: [{ text: "a line", kind: "verbatim" }],
  ...over,
});

describe("a path that has to stay inside the set", () => {
  it("leaves a path that is already one alone", () => {
    for (const p of ["sources/a/b.conf", "docs/index.md", "x"]) expect(containedPath(p)).toBe(p);
  });

  // The same spelling every working directory agrees on: a run from the
  // repository root already records `platforms/x.tf`, and a run from the spec's
  // own directory records `../../platforms/x.tf`. They become one path here
  // rather than two — and rather than a third.
  it("resolves a .. against what precedes it, and drops one with nothing to pop", () => {
    expect(containedPath("a/../x.conf")).toBe("x.conf");
    expect(containedPath("../../platforms/x.tf")).toBe("platforms/x.tf");
    expect(containedPath("../../../../ESCAPED.txt")).toBe("ESCAPED.txt");
  });

  // An absolute path is how a collected file is named — the path its host held
  // it at — so the root is dropped and the rest kept.
  it("drops a leading separator rather than the path", () => {
    expect(containedPath("/etc/httpd/conf/httpd.conf")).toBe("etc/httpd/conf/httpd.conf");
  });

  // A backslash is a separator wherever the path was written down, and a drive
  // prefix is not a segment. An archive entry carrying either is the same
  // escape as `..`, for whoever opens it on Windows.
  it("reads a path recorded on Windows as a path", () => {
    expect(containedPath("C:\\conf\\app.ini")).toBe("conf/app.ini");
    expect(containedPath("..\\..\\x.tf")).toBe("x.tf");
  });

  it("keeps a . and an empty segment out of the result", () => {
    expect(containedPath("./a//b.conf")).toBe("a/b.conf");
  });

  // The invariant, stated the way the writers rely on it.
  it("always joins to somewhere under the root", () => {
    for (const raw of ["../../x", "/etc/x", "C:\\x", "a/../../../../x", ".", "..", "///"]) {
      const p = containedPath(raw);
      expect(p.startsWith("/")).toBe(false);
      expect(p.split("/")).not.toContain("..");
      expect(join("/root", p).startsWith("/root")).toBe(true);
    }
  });
});

describe("the documents a set carries", () => {
  it("puts a path that pointed outside the set inside it, and says so", () => {
    const notes: string[] = [];
    const docs = carriedDocuments([preview({ source_file: "../../../../ESCAPED.txt" })] as never, [], notes);
    expect(docs[0]!.path).toBe("sources/ESCAPED.txt");
    expect(notes.join("\n")).toContain("../../../../ESCAPED.txt is carried as ESCAPED.txt");
  });

  // Dropping the root of an absolute path is what `evidence/` is FOR, so it is
  // not a rewrite worth a line of its own.
  it("says nothing about an absolute path, which is how a collected file is named", () => {
    const notes: string[] = [];
    carriedDocuments(
      [preview({ nature: "observed", source_file: "/etc/chrony.conf", observed: { host: "h1", at: "X" } })] as never,
      [],
      notes
    );
    expect(notes).toEqual([]);
  });

  // THE ONE THAT LOSES A DOCUMENT. Two paths that differ as strings and
  // normalise to one: distinct here, one file on disk, the first overwritten —
  // with the run still reporting that it carried two. Normalising before the
  // paths are made distinct turns it into the text-differs case the renamer
  // already handles.
  it("keeps both documents when two paths normalise to one", () => {
    const docs = carriedDocuments(
      [
        preview({ id: "s::one", source_file: "x.conf", lines: [{ text: "FIRST", kind: "verbatim" }] }),
        preview({ id: "s::two", source_file: "a/../x.conf", lines: [{ text: "SECOND", kind: "verbatim" }] }),
      ] as never,
      []
    );
    expect(new Set(docs.map((d) => d.path)).size).toBe(2);
    expect(docs[0]!.path).toBe("sources/x.conf");
    expect(docs[1]!.path).not.toBe(docs[0]!.path);
  });

  // A host name is one SEGMENT of the set's own tree, not a path read out of a
  // file: a separator in it would silently become a directory level.
  it("keeps a host and an environment to one segment each", () => {
    const docs = carriedDocuments(
      [preview({ nature: "observed", source_file: "/etc/x", instances: ["../evil"], observed: { host: "a/b", at: "X" } })] as never,
      ["../evil"]
    );
    // A separator becomes an ordinary character; what matters is that neither
    // turned into a level of its own, and that the whole path still stays in.
    expect(docs[0]!.path).toBe("evidence/..-evil/a-b/etc/x");
    expect(containedPath(docs[0]!.path)).toBe(docs[0]!.path);
  });

  // Nothing left at all is still a document. Named by its own digest rather
  // than dropped, the move `commandFile` already makes for a command no
  // filename can hold.
  it("still carries a document whose path normalises to nothing", () => {
    const docs = carriedDocuments([preview({ source_file: "../.." })] as never, []);
    expect(docs[0]!.path).toMatch(/^sources\/unnamed-[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// …and the gate the two writers stand behind.
//
// `carriedDocuments` mints contained paths, so a set reaching the writer with
// one that escapes is a bug in the producer. Checked there anyway, and not
// assumed: the directory writer and the archive writer both trust this path
// space, and a generator that writes outside the directory it was given — or
// puts `..` in an archive somebody else opens — is not a thing to warn about
// and carry on past.

import { mkdtempSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = realpathSync(resolve(import.meta.dir, ".."));
const CLI = join(ROOT, "src", "cli.ts");

const model = (sourceFile: string): string =>
  JSON.stringify({
    metadata: { title: "t" },
    sheets: [{ name: "s", categories: [{ name: "c", params: [{ key: "k", value: "v" }] }] }],
    artifacts: [
      { id: "s::a", sheet: "s", source_file: sourceFile, nature: "source", lines: [{ text: "carried", kind: "verbatim" }] },
    ],
  });

async function generated(sourceFile: string): Promise<{ at: string; code: number; err: string }> {
  const at = mkdtempSync(join(realpathSync(tmpdir()), "rs-set-"));
  writeFileSync(join(at, "input.json"), model(sourceFile));
  const p = Bun.spawn(["bun", "run", CLI, "generate", "-i", "input.json", "--format", "md", "-o", "out/set"], {
    cwd: at,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { at, code: await p.exited, err };
}

describe("a set written out", () => {
  // Walked from contained to escaped, because the two depths used to fail
  // differently: the shallow one produced a spurious "not written by this run"
  // warning, and the deep one wrote outside and said nothing at all.
  it("keeps every carried file under the directory -o named, at every depth", async () => {
    for (const depth of [0, 1, 2, 3, 4, 6]) {
      const { at, code, err } = await generated(`${"../".repeat(depth)}CARRIED.txt`);
      expect(code, err).toBe(0);
      expect(existsSync(join(at, "out", "set", "docs", "sources", "CARRIED.txt")), `depth ${depth}`).toBe(true);
      // Nothing anywhere else: the directory the command ran in holds exactly
      // what it started with plus `out`.
      expect(readdirSync(at).sort()).toEqual(["input.json", "out"]);
    }
  });

  // …and no spurious complaint about files this run did write.
  it("does not report its own files as left over from an earlier run", async () => {
    const { err } = await generated("../../platforms/foo/bar.tf");
    expect(err).not.toContain("were not written by this run");
    // The rewrite itself IS said, which is the other half of not being silent.
    expect(err).toContain("is carried as platforms/foo/bar.tf");
  });
});

// ---------------------------------------------------------------------------
// …and, one stage earlier, the recording itself.
//
// `import --spec` records paths relative to the directory it ran in, and
// verify/apply/serve read them back the same way — a contract, not a defect.
// But a path that comes out pointing ABOVE that directory ties the model to the
// place it was built, and the fix is one sentence rather than a debugging
// session in a later command.
describe("a model recorded from a directory the spec's paths point above", () => {
  const spec = (): string => {
    const at = mkdtempSync(join(realpathSync(tmpdir()), "rs-spec-"));
    mkdirSync(join(at, "deep", "dir"), { recursive: true });
    writeFileSync(join(at, "values.yml"), "k: v\n");
    writeFileSync(
      join(at, "deep", "dir", "build.yml"),
      [
        "version: 1",
        "instances: [prod]",
        "enrich:",
        "  strict: false",
        "sheets:",
        "  - name: s",
        "    recipe: layered",
        "    defaults: ../../values.yml",
        "",
      ].join("\n")
    );
    return at;
  };

  const imported = async (cwd: string, specArg: string): Promise<string> => {
    const p = Bun.spawn(["bun", "run", CLI, "import", "--spec", specArg, "-o", join(cwd, "input.json")], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect(await p.exited, err).toBe(0);
    return err;
  };

  it("says so, and names the paths", async () => {
    const at = spec();
    const err = await imported(join(at, "deep", "dir"), "build.yml");
    expect(err).toContain("pointing above this directory");
    expect(err).toContain("../../values.yml");
  });

  it("says nothing when the paths come out plain", async () => {
    const at = spec();
    const err = await imported(at, join("deep", "dir", "build.yml"));
    expect(err).not.toContain("pointing above this directory");
  });
});
