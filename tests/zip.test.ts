// The set as one archive.
//
// Checked by UNZIPPING it — with the system's own reader, not with this file's
// idea of the format. A zip writer that only its author can read is the failure
// mode here, and it is silent: the bytes look like an archive, the size is
// plausible, and nothing says otherwise until somebody on the receiving end
// double-clicks it.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve as resolvePath } from "path";
import { zipOf, crc32 } from "../src/zip";
import { SET_DIR } from "../src/set-block";

const work = mkdtempSync(join(tmpdir(), "review-sheet-zip-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// libarchive, which is what macOS's `tar` is and what a great many readers are.
// Deliberately not Info-ZIP's `unzip`: the build macOS ships predates the UTF-8
// filename flag and mangles a Japanese path, which is a fact about that reader
// rather than about the archive (see src/zip.ts).
const extract = (bytes: Uint8Array, into: string): number => {
  const at = join(work, "a.zip");
  writeFileSync(at, bytes);
  const r = Bun.spawnSync(["tar", "-xf", at, "-C", into]);
  return r.exitCode ?? 1;
};

describe("writing a set as one archive", () => {
  const files = [
    { path: "README.md", text: "# 索引\n" },
    { path: "詳細設計/OS基本情報.md", text: `# OS基本情報\n\n${"| a | b |\n".repeat(200)}` },
    { path: "viewer.html", text: "<html></html>" },
  ];

  it("is read by a reader that did not write it", () => {
    const into = mkdtempSync(join(work, "out-"));
    expect(extract(zipOf(files), into)).toBe(0);
    for (const f of files) {
      expect(existsSync(join(into, f.path)), f.path).toBe(true);
      expect(readFileSync(join(into, f.path), "utf-8")).toBe(f.text);
    }
  });

  // Most of a set is markdown, which deflates to a fraction — and the viewer is
  // most of the bytes.
  it("compresses what compresses", () => {
    const raw = files.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
    expect(zipOf(files).length).toBeLessThan(raw);
  });

  // Deflate makes small or already-compressed data larger, and an archive that
  // grew a file would be paying for the privilege.
  it("stores what does not", () => {
    const tiny = [{ path: "a", text: "x" }];
    const entry = zipOf(tiny);
    // method is the 9th and 10th byte of the local header: 0 = stored.
    expect(entry[8]).toBe(0);
  });

  // An archive of the same files must BE the same archive: it is committed,
  // attached, and checked against a hash by whoever receives it.
  it("is the same bytes for the same files", () => {
    expect(Buffer.from(zipOf(files)).equals(Buffer.from(zipOf(files)))).toBe(true);
  });

  // libarchive reads a Japanese name back whether or not the flag is set — it
  // guesses — so extracting proves nothing about it. What a reader is ENTITLED
  // to do without the flag is read the bytes as a local code page, which is
  // what Windows Explorer does, so the flag is asserted where it lives: bit 11
  // of the general-purpose field, the 7th and 8th bytes of the local header and
  // of every central-directory entry.
  it("declares the names UTF-8, in both headers", () => {
    const z = zipOf(files);
    expect([z[6], z[7]]).toEqual([0x00, 0x08]);
    // The central directory's own copy, found by its signature.
    let at = -1;
    for (let i = 0; i + 3 < z.length; i++) {
      if (z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 0x01 && z[i + 3] === 0x02) { at = i; break; }
    }
    expect(at).toBeGreaterThan(0);
    expect([z[at + 8], z[at + 9]]).toEqual([0x00, 0x08]);
  });

  it("computes the checksum every reader verifies", () => {
    // The value in every zip specification's own example.
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("the output's name chooses the envelope", () => {
  const project = resolvePath(import.meta.dir, "fixtures", "projects", "ansible-keycloak");
  const cli = resolvePath(import.meta.dir, "..", "src", "cli.ts");

  it("writes an archive for a .zip, and a tree for anything else", () => {
    const zipAt = join(work, "set.zip");
    const dirAt = join(work, "set-dir");
    for (const out of [zipAt, dirAt]) {
      const r = Bun.spawnSync(["bun", "run", cli, "generate", "-i", "input.json", "--format", "md", "-o", out], {
        cwd: project,
      });
      expect(r.exitCode, r.stderr.toString().slice(0, 400)).toBe(0);
    }
    // Two things at the top, with one role each: the page you open and the
    // folder you drag.
    expect(existsSync(join(dirAt, "viewer.html"))).toBe(true);
    expect(existsSync(join(dirAt, SET_DIR, "README.md"))).toBe(true);

    const into = mkdtempSync(join(work, "cli-"));
    expect(Bun.spawnSync(["tar", "-xf", zipAt, "-C", into]).exitCode).toBe(0);
    expect(readFileSync(join(into, SET_DIR, "README.md"), "utf-8")).toBe(readFileSync(join(dirAt, SET_DIR, "README.md"), "utf-8"));
    expect(existsSync(join(into, "viewer.html"))).toBe(true);
  });
});
