// Several recipes, one sheet. A page of an incumbent parameter sheet is a HOST
// — sysctl, then chrony, then the logrotate policy — and which of those this
// tool reads as Ansible variables and which as lines of a rendered artifact is
// an accident of the build. It used to decide the tab layout.

import { describe, it, expect } from "bun:test";
import { composeSheet, type ComposePart } from "../src/compose";
import type { SheetInputs } from "../src/assemble";

const part = (
  label: string,
  o: Partial<SheetInputs> & { name?: string }
): ComposePart => ({
  label,
  input: { name: o.name ?? "OS", instances: [], layers: [{ kind: "base", entries: new Map() }], embedded: [], ...o },
});

const entry = (value: string, component?: string) => ({ value, component, source: { line: 1 } });

describe("composeSheet", () => {
  it("puts every part's rows in one sheet", () => {
    const r = composeSheet("OS", [
      part("part 1 (layered)", {
        layers: [{ kind: "base", entries: new Map([["net.core.somaxconn", entry("4096")]]) }],
        componentOf: new Map([["net.core.somaxconn", "/etc/sysctl.d/override.conf"]]),
      }),
      part("part 2 (ansible)", {
        layers: [{ kind: "base", entries: new Map([["rotate", entry("7", "/etc/logrotate.d/app")]]) }],
      }),
    ]);
    expect(r.conflicts).toEqual([]);
    const base = r.input.layers.find((l) => l.kind === "base")!;
    expect([...base.entries.keys()]).toEqual(["net.core.somaxconn", "rotate"]);
  });

  it("keeps exactly one base layer and one overlay per environment", () => {
    const r = composeSheet("OS", [
      part("p1", {
        layers: [
          { kind: "base", entries: new Map([["a", entry("1")]]) },
          { kind: "overlay", instance: "production", entries: new Map([["a", entry("2")]]) },
        ],
        componentOf: new Map([["a", "c1"]]),
      }),
      part("p2", {
        layers: [
          { kind: "base", entries: new Map([["b", entry("3")]]) },
          { kind: "overlay", instance: "production", entries: new Map([["b", entry("4")]]) },
        ],
        componentOf: new Map([["b", "c2"]]),
      }),
    ]);
    expect(r.input.layers.filter((l) => l.kind === "base")).toHaveLength(1);
    const overlays = r.input.layers.filter((l) => l.kind === "overlay");
    expect(overlays).toHaveLength(1);
    expect([...overlays[0].entries.keys()]).toEqual(["a", "b"]);
  });

  // The rule that makes the whole thing safe. Two recipes quietly overwriting
  // each other's rows is the failure this project exists around, so a clash is
  // reported and neither side wins by accident.
  it("reports a row two parts both claim, naming which parts", () => {
    const r = composeSheet("OS", [
      part("part 1 (layered)", { layers: [{ kind: "base", entries: new Map([["rotate", entry("7", "c")]]) }] }),
      part("part 2 (ansible)", { layers: [{ kind: "base", entries: new Map([["rotate", entry("9", "c")]]) }] }),
    ]);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toContain("part 1 (layered)");
    expect(r.conflicts[0]).toContain("part 2 (ansible)");
    expect(r.conflicts[0]).toContain("rotate");
    // The first claim stands; the second is not silently written over it.
    expect(r.input.layers[0].entries.get("rotate")?.value).toBe("7");
  });

  // Every part carries the SHEET's name, so the name cannot tell two apart —
  // a report naming both sides identically is no report at all.
  it("does not name both sides the same when the parts share a sheet name", () => {
    const r = composeSheet("OS", [
      part("part 1 (layered)", { layers: [{ kind: "base", entries: new Map([["x", entry("1")]]) }] }),
      part("part 2 (ansible)", { layers: [{ kind: "base", entries: new Map([["x", entry("2")]]) }] }),
    ]);
    expect(r.conflicts[0]).not.toContain("(OS and OS)");
  });

  it("lets the same key live in two different components", () => {
    const r = composeSheet("OS", [
      part("p1", { layers: [{ kind: "base", entries: new Map([["rotate", entry("7", "/etc/logrotate.d/a")]]) }] }),
      part("p2", { layers: [{ kind: "base", entries: new Map([["rotate", entry("9", "/etc/logrotate.d/b")]]) }] }),
    ]);
    // Two components, one key each: not a clash, and the model already keys
    // rows within a component.
    expect(r.conflicts).toEqual([]);
  });

  it("merges the per-component maps every part contributes", () => {
    const r = composeSheet("OS", [
      part("p1", {
        componentFiles: new Map([["c1", { filePath: "/etc/sysctl.d/override.conf" }]]),
        componentOrder: ["c1"],
      }),
      part("p2", {
        componentFiles: new Map([["c2", { filePath: "/etc/logrotate.d/app" }]]),
        componentOrder: ["c2"],
      }),
    ]);
    expect([...r.input.componentFiles!.keys()]).toEqual(["c1", "c2"]);
    // Declaration order: the sheet is read top to bottom, and the parts are
    // written in the order they should be read.
    expect(r.input.componentOrder).toEqual(["c1", "c2"]);
  });

  it("carries each part's artifacts and key map through", () => {
    const r = composeSheet("OS", [
      part("p1", { keyMap: [{ variable: "v1", boundKey: "k1" }] }),
      part("p2", { keyMap: [{ variable: "v2", boundKey: "k2" }] }),
    ]);
    expect(r.input.keyMap?.map((k) => k.variable)).toEqual(["v1", "v2"]);
  });

  // One sheet has one of each of these, so parts that disagree cannot both be
  // honoured — said out loud, with the way out named.
  it("refuses parts that imply different dictionary key rewrites", () => {
    const r = composeSheet("OS", [
      part("p1", { dictKeySteps: [{ drop: "^a" }] }),
      part("p2", { dictKeySteps: [{ drop: "^b" }] }),
    ]);
    expect(r.conflicts.join("\n")).toContain("key_steps");
  });

  it("refuses more than one document", () => {
    const doc = { html: "<p>x</p>", headings: [] };
    const r = composeSheet("OS", [part("p1", { document: doc }), part("p2", { document: doc })]);
    expect(r.conflicts.join("\n")).toContain("document");
  });

  it("is a no-op shape for a single part", () => {
    const r = composeSheet("OS", [part("p1", { layers: [{ kind: "base", entries: new Map([["a", entry("1")]]) }] })]);
    expect(r.conflicts).toEqual([]);
    expect(r.input.name).toBe("OS");
    expect([...r.input.layers[0].entries.keys()]).toEqual(["a"]);
  });
});
