// The raw material a test result points at, carried into the document.
//
// A verdict names an address — `web01 /etc/httpd/conf/httpd.conf:12` — and
// until now the thing that address names existed only on a machine nobody
// reading the record can reach. This is the same answer the artifact panel gave
// the sheet's rows ("the row has an address, so give it a file to open"), one
// journey over: the reader of a verdict gets the file the verdict was read from.
//
// Two rules are not negotiable and are asserted here rather than described. The
// document says the evidence was COLLECTED, never that it was rendered — those
// are opposite claims about who produced the bytes. And `--instances` narrows
// evidence exactly as it narrows values: an environment a delivery does not
// cover is NOT IN THE FILE, not hidden in it.

import { describe, it, expect } from "bun:test";
import { evidencePreviews, evidenceCell, withoutEvidence } from "../src/evidence";
import { parseEvidenceRef } from "../src/html/app";
import type { TestResults } from "../src/testresults";

const results = (): TestResults =>
  ({
    results: [],
    evidence: [
      {
        instance: "local",
        host: "web01",
        at: "2026-09-08T00:11:22Z",
        sheet: "web",
        component: "httpd.conf",
        path: "/etc/httpd/conf/httpd.conf",
        text: "Listen 80\nServerName x\n",
      },
      {
        instance: "prod",
        host: "web09",
        at: "2026-09-08T00:11:22Z",
        sheet: "web",
        component: "httpd.conf",
        path: "/etc/httpd/conf/httpd.conf",
        text: "Listen 443\n",
      },
      {
        instance: "local",
        host: "web01",
        at: "2026-09-08T00:11:22Z",
        sheet: "kc",
        command: "kc.sh show-config",
        text: "kc.db =  postgres (keycloak.conf)\n",
      },
    ],
  }) as TestResults;

// Every evidence of the fixture, cited by one record — which is what these
// tests were written against and what a real record does. Citation is no longer
// optional: an observed document is reachable only through a record's link, so
// "who cites this" decides whether it can be carried at all.
const allCited = (r: TestResults = results()): ReadonlyMap<string, string> =>
  new Map((r.evidence ?? []).map((e) => [
    `observed ${e.instance} ${e.host} ${e.path ?? e.command}`,
    "record",
  ]));

// …and the same map minus one, for the tests about `--instances`: citation and
// the environment filter are two gates and the second only shows when the first
// is open. Written as an exclusion so those tests keep saying what they say
// about environments rather than about citation.
const citedExcept = (drop: (id: string) => boolean): ReadonlyMap<string, string> =>
  new Map([...allCited()].filter(([k]) => !drop(k)));

describe("evidence, as documents", () => {
  it("is observed, and says which host it came from and when", () => {
    const out = evidencePreviews(results(), undefined, allCited());
    const one = out.find((a) => a.observed?.host === "web01" && a.source_file.startsWith("/etc"))!;
    expect(one.nature).toBe("observed");
    expect(one.observed).toEqual({ host: "web01", at: "2026-09-08T00:11:22Z" });
    // The file it was read from IS its source — literally true of a collected
    // file, and what the panel's header shows.
    expect(one.source_file).toBe("/etc/httpd/conf/httpd.conf");
    // …and it is filed under the record that CITES it, never under the sheet
    // whose values it answers for — see the describe() on that below.
    expect(one.sheet).toBe("record");
    expect(one.component).toBe("httpd.conf");
  });

  it("keeps every line of what was collected, verbatim", () => {
    const one = evidencePreviews(results(), undefined, allCited()).find((a) => a.source_file.startsWith("/etc"))!;
    expect(one.lines.map((l) => l.text)).toEqual(["Listen 80", "ServerName x"]);
    expect(new Set(one.lines.map((l) => l.kind))).toEqual(new Set(["verbatim"]));
    // No keys: an observed document is not in the row->preview index, and a key
    // on its lines is the only thing that could put it there.
    expect(one.lines.some((l) => l.key !== undefined || l.keys !== undefined)).toBe(false);
  });

  it("gives a command's output a document too", () => {
    const cmd = evidencePreviews(results(), undefined, allCited()).find((a) => a.source_file === "kc.sh show-config")!;
    expect(cmd.nature).toBe("observed");
    expect(cmd.deployed_path).toBeUndefined();
  });

  // Two hosts hold the same file and are two documents: the bytes may agree and
  // the moment they were taken does not, and a record that merges them can no
  // longer say which host a verdict was read from.
  it("never merges two hosts into one document", () => {
    const out = evidencePreviews(results(), undefined, allCited());
    expect(new Set(out.map((a) => a.id)).size).toBe(out.length);
    expect(out.length).toBe(3);
  });

  it("leaves out the environments a delivery does not cover", () => {
    const out = evidencePreviews(results(), ["prod"], citedExcept((id) => id.startsWith("observed local ")));
    expect(out.map((a) => a.observed?.host)).toEqual(["web09"]);
  });
});


// The record's evidence cell, and the document it cites.
//
// The rule this follows is the panel's own: an affordance that opens nothing is
// worse than none. So the cell is a LINK only when the document it names is
// actually being carried — a delivery built without `--evidence` keeps the
// address as plain text, which is exactly what it was before any of this.
describe("the evidence cell", () => {
  // The INSTANCE is what the cell needs, not a whole answer: an item with no row
  // behind it names one and has no `target` to dig it out of.
  const answer = {
    instance: "local",
    evidence: { host: "web01", file: "/etc/httpd/conf/httpd.conf", line: 12 },
  };

  it("links to the document that was collected, at the line it was read from", () => {
    const cell = evidenceCell(answer, [
      { instance: "local", host: "web01", at: "x", sheet: "web", path: "/etc/httpd/conf/httpd.conf", text: "" },
    ]);
    // A markdown link, because the record is markdown a project owns and its
    // renderer escapes raw HTML — an `<a>` here shows up as visible markup.
    expect(cell).toContain("[web01 /etc/httpd/conf/httpd.conf:12](rs-evidence:");
    expect(parseEvidenceRef(cell.slice(cell.indexOf("(") + 1, -1))).toEqual({
      id: "observed local web01 /etc/httpd/conf/httpd.conf",
      line: 12,
    });
  });

  it("stays plain text when no document is carried", () => {
    const cell = evidenceCell(answer, []);
    expect(cell).toBe("web01 /etc/httpd/conf/httpd.conf:12");
    expect(cell).not.toContain("rs-evidence:");
  });

  // The HOST is part of the match, not decoration: two hosts hold the same file
  // and a verdict was read from one of them.
  // …and a command's output is reached the same way, which is what an item with
  // no row behind it always points at.
  it("links a verdict that names a command rather than a file", () => {
    const cell = evidenceCell({ instance: "local", evidence: { host: "web01", command: "systemctl restart keycloak" } }, [
      { instance: "local", host: "web01", at: "x", sheet: "web", command: "systemctl restart keycloak", text: "" },
    ]);
    expect(cell).toContain("[web01 systemctl restart keycloak](rs-evidence:");
  });

  it("does not link a verdict to another host's document", () => {
    const cell = evidenceCell(answer, [
      { instance: "local", host: "web02", at: "x", sheet: "web", path: "/etc/httpd/conf/httpd.conf", text: "" },
    ]);
    expect(cell).not.toContain("rs-evidence:");
  });
});


// Two documents at one address is a judge bug this tool must not paper over:
// the link resolves to whichever came first, and a reader is then shown bytes
// no verdict was read from.
describe("a document carried twice", () => {
  it("is said out loud rather than quietly deduped", () => {
    const said: string[] = [];
    const said_to = console.error;
    console.error = (m: string) => said.push(m);
    const twice = {
      results: [],
      evidence: [
        { instance: "local", host: "web01", at: "x", sheet: "web", command: "GET /login", text: "a" },
        { instance: "local", host: "web01", at: "x", sheet: "web", command: "GET /login", text: "b" },
      ],
    };
    const out = evidencePreviews(twice, undefined, new Map([["observed local web01 GET /login", "record"]]));
    console.error = said_to;
    expect(said.join("\n")).toContain("carried more than once");
    expect(said.join("\n")).toContain("observed local web01 GET /login");
    // …and both are still emitted: which of the two is right is not this tool's
    // to decide, and picking one silently is the failure it would be hiding.
    expect(out.length).toBe(2);
  });
});

// The reference an evidence cell carries, read back. The id holds spaces and
// slashes — it names a host and a path — so only the line suffix has a shape
// worth parsing, and splitting the whole thing blind would cut ids in half.
describe("an evidence reference", () => {
  it("keeps the id whole and takes the line off the end", () => {
    expect(parseEvidenceRef("observed local web01 /etc/httpd/conf/httpd.conf#L12")).toEqual({
      id: "observed local web01 /etc/httpd/conf/httpd.conf",
      line: 12,
    });
  });

  it("reads a command's document, which has no line to point at", () => {
    expect(parseEvidenceRef("observed local n1 kc.sh show-config")).toEqual({
      id: "observed local n1 kc.sh show-config",
    });
  });
});

// A record that travels and evidence that does not is one document
// contradicting itself.
describe("evidence a carried record already cites", () => {
  // A unit-test record is a DOCUMENT sheet: its verdicts and their links are
  // baked in at import, and `--instances` never narrowed them. So a delivery
  // for prod hands over every verdict read on `local` — and dropping the bytes
  // those verdicts name leaves links that open nothing, which is the one thing
  // this tool refuses to ship.
  const localId = "observed local web01 /etc/httpd/conf/httpd.conf";

  it("drops an environment's evidence when nothing carried cites it", () => {
    const docs = evidencePreviews(results(), ["prod"], citedExcept((id) => id === localId));
    expect(docs.map((d) => d.id)).not.toContain(localId);
  });

  it("keeps it when a carried document links to it", () => {
    const docs = evidencePreviews(results(), ["prod"], allCited());
    expect(docs.map((d) => d.id)).toContain(localId);
    // …and the one it does cover is there either way.
    expect(docs.some((d) => (d.instances ?? []).includes("prod"))).toBe(true);
  });

  it("keeps only what is cited, not the whole environment", () => {
    // Citing one document is not a reason to widen the delivery to every file
    // that environment holds.
    const wide = { ...results(), evidence: [...(results().evidence ?? []), { instance: "local", host: "web01", at: "2026-09-08T00:11:22Z", sheet: "web", path: "/etc/other.conf", text: "x\n" }] } as TestResults;
    const docs = evidencePreviews(wide, ["prod"], new Map([[localId, "record"]]));
    expect(docs.map((d) => d.id).filter((id) => id.startsWith("observed local"))).toEqual([localId]);
  });
});

// Where a carried document LANDS, which for evidence is not where its rows are.
//
// A set writes a carried file under its sheet's own chapter. An evidence
// document's rows are a parameter sheet's, so it used to land in the design
// chapter — while the unit-test record holding every link to it sits in
// another. The set's own rule is "evidence beside the record that cites it",
// and only the citing record can answer which one that is.
describe("which sheet an evidence document is filed under", () => {
  const id = "observed local web01 /etc/httpd/conf/httpd.conf";
  const docs = (cited: Map<string, string>) => evidencePreviews(results(), undefined, cited);

  it("is the record that cites it, not the rows it is about", () => {
    expect(docs(new Map([[id, "unit tests"]])).find((d) => d.id === id)?.sheet).toBe("unit tests");
  });

  // …and one nothing cites is not filed anywhere, because it cannot be
  // reached from anywhere: an observed document carries no line keys at all
  // (types.ts), precisely so a row can never open one, so a record's link is
  // the only way in. It used to be carried under the sheet whose values it
  // answers for — a chapter with no column to link it from.
  it("is not carried at all when no record cites it", () => {
    expect(docs(new Map([["observed local web01 /etc/other.conf", "unit tests"]])).map((d) => d.id)).not.toContain(id);
  });

  it("says which ones went, so a delivery holding less is not a discovery", () => {
    const gone: string[] = [];
    evidencePreviews(results(), undefined, new Map(), (ids) => gone.push(...ids));
    expect(gone).toContain(id);
    expect(gone).toHaveLength(3);
  });

  it("reports nothing when every document is cited", () => {
    const gone: string[] = [];
    evidencePreviews(results(), undefined, allCited(), (ids) => gone.push(...ids));
    expect(gone).toEqual([]);
  });
});

// A stamp identifies the MODEL. Evidence is carried beside one and is never
// part of it, so the stamp must not move when a delivery carries some — the
// check that reads it re-takes it over the model FILE, which never held any.
describe("the model a stamp is taken over", () => {
  const observed = { id: "o", sheet: "s", source_file: "/etc/x", nature: "observed" as const, lines: [] };
  const rendered = { id: "a", sheet: "s", source_file: "x.j2", lines: [] };

  it("is the same before and after evidence is carried", () => {
    const model = { sheets: [], artifacts: [rendered] };
    expect(withoutEvidence({ ...model, artifacts: [rendered, observed] })).toEqual(model);
  });

  it("has no artifacts key when evidence created it", () => {
    // `--evidence` appends to a model that may carry no artifacts at all, which
    // CREATES the key. Taking the evidence out has to take the key with it, or
    // the inverse is not an inverse.
    expect(Object.keys(withoutEvidence({ sheets: [], artifacts: [observed] }))).toEqual(["sheets"]);
  });

  it("does the same inside every version of a history", () => {
    const one = { version: "1", artifacts: [rendered] };
    expect(withoutEvidence({ versions: [{ ...one, artifacts: [rendered, observed] }] })).toEqual({ versions: [one] });
  });
});

// A markdown destination ends at the first `)`, and an id is free to contain
// one. Two things went wrong at once when it did, which is what makes this a
// dropped document rather than an ugly link.
describe("an evidence id with a bracket in it", () => {
  const carried = [
    { instance: "local", host: "web01", at: "2026-09-08T00:11:22Z", sheet: "web", command: "GET / (Host: x)", text: "200\n" },
  ];
  const cell = evidenceCell({ instance: "local", evidence: { host: "web01", command: "GET / (Host: x)" } }, carried);

  it("is escaped, so the link holds the whole id", () => {
    const [, dest = ""] = /\]\(([^)]*)\)/.exec(cell) ?? [];
    expect(parseEvidenceRef(dest).id).toBe("observed local web01 GET / (Host: x)");
  });

  it("…which is also what keeps its document in the delivery", () => {
    // The scan that decides what evidence has to travel reads these links back.
    // A destination cut at the bracket names no document, so the bytes were
    // dropped as uncited — a record citing a file the delivery does not carry.
    const [, dest = ""] = /\]\(([^)]*)\)/.exec(cell) ?? [];
    const cited = new Map([[parseEvidenceRef(dest).id, "record"]]);
    const docs = evidencePreviews({ results: [], evidence: carried } as TestResults, ["prod"], cited);
    expect(docs.map((d) => d.id)).toEqual(["observed local web01 GET / (Host: x)"]);
  });
});
