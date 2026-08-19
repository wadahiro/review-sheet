// The container chain, checked rather than described.
//
// A parser now records the blocks enclosing each value as a list of NODES, and
// both serialized forms — `source.path` and `categoryPath` — are computed from
// it. That is only worth anything if the three cannot drift, and the project's
// own stance is that prose about code rots while a check does not. So the
// agreement is asserted here, per parser, over every file the repository has.
//
// The invariant is a PREFIX, deliberately, and not the join-plus-key equality
// that looks more natural. A value's key is not always its address's last
// segment: an XML element with text is keyed by its own SUBJECT (`realms`)
// while its address ends with the promoted element (`local-cache[name=realms]`),
// so `join(chain) + "." + key === path` is false for a shape that is not a bug.
// What every consumer actually needs — filtering that keeps ancestors,
// container rows derived from the chain, the leaf display stripped off a
// path-spelled key — is that the chain IS the address's enclosing prefix, at a
// segment boundary. That is what is checked.

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolveParser } from "../src/parser";
import "../src/parsers/index.js";
import { stubNonBuiltInParsers } from "./only-builtin-parsers";
import { goldenFiles } from "../scripts/gen-goldens";
import type { Entry } from "../src/parser";

// Which parsers have been moved onto the node record. Written down so the set
// changes only when somebody means it to: a parser silently ceasing to emit a
// chain would otherwise just make this suite quieter, which is the failure mode
// the whole design exists to avoid.
// `jinja2` is here without a line of its own having changed: it masks the
// template and hands the text to the declared base format, so it inherits
// whatever that parser reports — which is the point of wrapping rather than
// reimplementing, and worth asserting so the delegation cannot quietly stop.
const EMITTING = ["xml", "httpd", "jinja2"];

type Emitted = { file: string; parser: string; entries: Entry[] };

// Extraction over every file in the repository is not cheap, and each check
// below wants the same result — so it is taken once.
let cached: Emitted[] | undefined;
const emitted = (): Emitted[] => (cached ??= collect());

function collect(): Emitted[] {
  stubNonBuiltInParsers();
  const out: Emitted[] = [];
  for (const file of goldenFiles()) {
    let text: string;
    try { text = readFileSync(file, "utf-8"); } catch { continue; }
    const parser = resolveParser(file, text);
    if (!parser) continue;
    let entries: Entry[];
    try { entries = parser.extract(text, file, {}); } catch { continue; }
    if (!entries.some((e) => e.containers)) continue;
    out.push({ file, parser: parser.name, entries });
  }
  return out;
}

const join = (e: Entry): string => (e.containers ?? []).map((n) => n.pathSeg).join(".");

describe("container chain conformance", () => {
  it("only the parsers declared to emit a chain do", () => {
    const seen = [...new Set(emitted().map((e) => e.parser))].sort();
    expect(seen).toEqual([...EMITTING].sort());
  });

  it("each declared parser actually produced some", () => {
    const seen = new Set(emitted().map((e) => e.parser));
    expect(EMITTING.filter((p) => !seen.has(p))).toEqual([]);
  });

  it("the chain is the address's enclosing prefix, at a segment boundary", () => {
    const bad: string[] = [];
    for (const { file, entries } of emitted()) {
      for (const e of entries) {
        if (!e.containers) continue;
        const path = e.source?.path;
        if (path === undefined) { bad.push(`${file}: ${e.key} has a chain but no path`); continue; }
        const j = join(e);
        if (j === "") continue; // a value at the root encloses nothing
        if (path !== j && !path.startsWith(`${j}.`)) bad.push(`${file}: ${e.key} — chain "${j}" is not a prefix of "${path}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  // A parser may not describe one address two ways. If `local-cache[name=realms]`
  // is a promoted element in one entry it must be the same element in every
  // other — otherwise a container row built from the chain would inherit
  // whichever entry happened to be read first.
  it("one address is always the same node", () => {
    const bad: string[] = [];
    for (const { file, entries } of emitted()) {
      const seen = new Map<string, string>();
      for (const e of entries) {
        let addr = "";
        for (const n of e.containers ?? []) {
          addr = addr ? `${addr}.${n.pathSeg}` : n.pathSeg;
          const spelling = JSON.stringify([n.name, n.subject, n.subjectField, n.index]);
          const prev = seen.get(addr);
          if (prev === undefined) seen.set(addr, spelling);
          else if (prev !== spelling) bad.push(`${file}: ${addr} is ${prev} and also ${spelling}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // A chain is a path down one tree, so every prefix of it must be a chain
  // somebody else could also have. A gap would mean a node whose parent the
  // parser never reported, and a derived container row for it would hang under
  // nothing.
  it("chains form a tree", () => {
    const bad: string[] = [];
    for (const { file, entries } of emitted()) {
      const known = new Set<string>([""]);
      for (const e of entries) {
        let addr = "";
        for (const n of e.containers ?? []) {
          const parent = addr;
          addr = addr ? `${addr}.${n.pathSeg}` : n.pathSeg;
          if (!known.has(parent)) bad.push(`${file}: ${addr} has no reported parent "${parent}"`);
          known.add(addr);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // The subject is promoted INTO the address, so the attribute it came from
  // must not also be a row: two statements of one fact, free to disagree.
  it("a promoted subject leaves no row of its own", () => {
    const bad: string[] = [];
    for (const { file, entries } of emitted()) {
      const promoted = new Map<string, string>();
      for (const e of entries) {
        for (let i = 0; i < (e.containers?.length ?? 0); i++) {
          const n = e.containers![i];
          if (n.subjectField === undefined) continue;
          promoted.set(e.containers!.slice(0, i + 1).map((x) => x.pathSeg).join("."), n.subjectField);
        }
      }
      for (const e of entries) {
        const path = e.source?.path;
        if (!path) continue;
        for (const [addr, field] of promoted) {
          if (path === `${addr}.@${field}`) bad.push(`${file}: ${path} restates the subject already in its own address`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
