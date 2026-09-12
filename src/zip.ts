// A set of files, as one archive.
//
// The directory is the primary form — a project that can receive one should get
// one — and this is the envelope for the delivery that cannot: a hand-over
// where the whole set has to arrive together and be checked as a unit.
//
// Written here rather than pulled in: the format's useful subset is a header, a
// deflate stream and a table of contents, and a dependency for it would be a
// dependency in a tool whose whole output is one self-contained file. Everything
// omitted is omitted deliberately — no encryption, no Zip64, no directory
// entries (every reader creates the directories a path names).
//
// Pure: it is given the files, it returns the bytes.

import { deflateRawSync } from "zlib";

export type ZipEntry = { path: string; text: string };

// CRC-32, which every reader checks and no reader can be told to skip.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number): Uint8Array =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

const join = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// Bit 11 of the general-purpose flags says the name is UTF-8. Without it a
// reader is entitled to read the bytes as the archive's local code page, and a
// Japanese chapter name comes out as mojibake — which is most of the names in a
// document this is for.
const UTF8_NAME = 0x0800;
// Checked against three readers: Python's `zipfile` and libarchive (`bsdtar`,
// which is macOS's `tar`) both read a Japanese path back exactly, and Info-ZIP's
// `unzip` — the one macOS still ships — does not, because that build predates
// the flag. Recorded rather than worked around: the flag is the format's answer,
// the readers a delivery actually meets (Windows Explorer, 7-Zip) honour it, and
// writing the names in a code page instead would break everything that does.

export function zipOf(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let at = 0;

  for (const e of entries) {
    const name = enc.encode(e.path);
    const raw = enc.encode(e.text);
    const body = new Uint8Array(deflateRawSync(raw));
    // Deflate can make small or already-compressed data LARGER. Storing it then
    // is what every writer does, and costs one branch.
    const stored = body.length >= raw.length;
    const data = stored ? raw : body;
    const method = stored ? 0 : 8;
    const sum = crc32(raw);

    const head = join([
      u32(0x04034b50),
      u16(20), // the version that understands deflate
      u16(UTF8_NAME),
      u16(method),
      u16(0), u16(0), // no timestamp: an archive of the same files must be the same archive
      u32(sum),
      u32(data.length),
      u32(raw.length),
      u16(name.length),
      u16(0),
      name,
    ]);
    local.push(head, data);

    central.push(
      join([
        u32(0x02014b50),
        u16(20), u16(20),
        u16(UTF8_NAME),
        u16(method),
        u16(0), u16(0),
        u32(sum),
        u32(data.length),
        u32(raw.length),
        u16(name.length),
        u16(0), u16(0), u16(0), u16(0),
        u32(0),
        u32(at),
        name,
      ])
    );
    at += head.length + data.length;
  }

  const dir = join(central);
  return join([
    ...local,
    dir,
    join([
      u32(0x06054b50),
      u16(0), u16(0),
      u16(entries.length),
      u16(entries.length),
      u32(dir.length),
      u32(at),
      u16(0),
    ]),
  ]);
}
