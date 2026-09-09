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
import { evidencePreviews, evidenceCell } from "../src/evidence";
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

describe("evidence, as documents", () => {
  it("is observed, and says which host it came from and when", () => {
    const out = evidencePreviews(results(), undefined);
    const one = out.find((a) => a.observed?.host === "web01" && a.source_file.startsWith("/etc"))!;
    expect(one.nature).toBe("observed");
    expect(one.observed).toEqual({ host: "web01", at: "2026-09-08T00:11:22Z" });
    // The file it was read from IS its source — literally true of a collected
    // file, and what the panel's header shows.
    expect(one.source_file).toBe("/etc/httpd/conf/httpd.conf");
    expect(one.sheet).toBe("web");
    expect(one.component).toBe("httpd.conf");
  });

  it("keeps every line of what was collected, verbatim", () => {
    const one = evidencePreviews(results(), undefined).find((a) => a.source_file.startsWith("/etc"))!;
    expect(one.lines.map((l) => l.text)).toEqual(["Listen 80", "ServerName x"]);
    expect(new Set(one.lines.map((l) => l.kind))).toEqual(new Set(["verbatim"]));
    // No keys: an observed document is not in the row->preview index, and a key
    // on its lines is the only thing that could put it there.
    expect(one.lines.some((l) => l.key !== undefined || l.keys !== undefined)).toBe(false);
  });

  it("gives a command's output a document too", () => {
    const cmd = evidencePreviews(results(), undefined).find((a) => a.source_file === "kc.sh show-config")!;
    expect(cmd.nature).toBe("observed");
    expect(cmd.deployed_path).toBeUndefined();
  });

  // Two hosts hold the same file and are two documents: the bytes may agree and
  // the moment they were taken does not, and a record that merges them can no
  // longer say which host a verdict was read from.
  it("never merges two hosts into one document", () => {
    const out = evidencePreviews(results(), undefined);
    expect(new Set(out.map((a) => a.id)).size).toBe(out.length);
    expect(out.length).toBe(3);
  });

  it("leaves out the environments a delivery does not cover", () => {
    const out = evidencePreviews(results(), ["prod"]);
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
    const out = evidencePreviews(twice, undefined);
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
