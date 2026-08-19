// How a CONTAINER row is handled, built before any parser emits one.
//
// The order is deliberate. A container row is an ordinary row to everything
// that has not been told otherwise, and three of those defaults are wrong for
// it: apply would rewrite the block's own identity, binding would match it by
// an address segment, and a project's key rules could mangle its noun into some
// unrelated entry. Emitting the rows first and fixing the handling afterwards
// would mean shipping each of those live. So the handling lands first, dormant
// — nothing produces a container row yet, and these tests are what say it
// works anyway.

import { describe, it, expect } from "bun:test";
import { computeApply } from "../src/apply";
import { applyEdits, planFromEdits, promptItemsFromPlan } from "../src/edits";
import { assembleSheets } from "../src/assemble";
import { getRecipe } from "../src/recipe";
import "../src/recipes/index.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { HELD_REASON_CONTAINER_SUBJECT } from "../src/prompt";
import { bindKey, bindableKey, leafKey, makeBindSource, CONTAINER_BIND_METHODS } from "../src/bind";
import type { ParameterSheetInput, ReviewItem } from "../src/types";

const sheet = (): ParameterSheetInput => ({
  metadata: { project: "p", version: "1", generated_at: "2026-01-01" },
  sheets: [
    {
      name: "web",
      categories: [
        {
          name: "/etc/httpd/conf/httpd.conf",
          params: [
            {
              key: `Directory["/var/www"]`,
              container: { name: "Directory" },
              value: `"/var/www"`,
              description: "the directory this block governs",
              source: { file: "httpd.conf", line: 1, anchor: "/var/www", path: `Directory["/var/www"]` },
            },
            {
              key: `Directory["/var/www"].AllowOverride`,
              container_path: [{ path: `Directory["/var/www"]`, name: "Directory" }],
              value: "None",
              description: "x",
              source: { file: "httpd.conf", line: 2, anchor: "None", path: `Directory["/var/www"].AllowOverride` },
            },
          ],
        },
      ],
    },
  ],
});

const change = (param: string, current: string, suggested: string): ReviewItem => ({
  id: "r1",
  status: "pending",
  target: { sheet: "web", category: "/etc/httpd/conf/httpd.conf", param },
  changes: [{ field: "value", current, suggested }],
});

const FILE = `<Directory "/var/www">\n    AllowOverride None\n</Directory>\n`;

describe("apply and a container row", () => {
  // The block's subject is part of the ADDRESS of everything inside it, so a
  // mechanical rewrite leaves every child pointing at a block that is gone —
  // and every sibling edit in the same batch applied against stale addresses,
  // with the outcome depending on the order they happened to run in.
  it("holds the block's own identity rather than rewriting it", () => {
    const out = computeApply(sheet(), [change(`Directory["/var/www"]`, `"/var/www"`, `"/srv/www"`)], () => FILE);
    expect(out.applied).toBe(0);
    expect(out.results[0].status).toBe("held");
    expect(out.results[0].reason).toBe(HELD_REASON_CONTAINER_SUBJECT);
  });

  // The hold is about the container, not about the block's contents.
  it("still applies an ordinary setting inside the block", () => {
    const out = computeApply(sheet(), [change(`Directory["/var/www"].AllowOverride`, "None", "All")], () => FILE);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("AllowOverride All");
  });
});

describe("binding a container row", () => {
  it("matches by the block's noun, never by its key", () => {
    expect(bindableKey(`Directory["/var/www"]`, { name: "Directory" })).toBe("Directory");
    expect(bindableKey("TimeOut", undefined)).toBe("TimeOut");
  });

  // The reason the noun is used at all: the key's own leaf is nonsense for
  // exactly the formats containers were built for.
  it("the key's leaf would have bound to the argument, not the directive", () => {
    expect(leafKey(`Directory["/var/www"]`)).toBe("/var/www");
    expect(leafKey("/var/log/httpd/*.log")).toBe("log");
  });

  // Construction makes the address-reading tiers inert; it does not stop a
  // project's own key rules from mangling a bare noun, which is what the
  // build-time check is for.
  it("a noun reaches only the tiers a container may legitimately use", () => {
    const src = makeBindSource(
      { product: "httpd", version: "2.4" },
      { product: "httpd", version: "2.4", parameters: { Directory: { description: "the directory this block governs" } } }
    );
    const r = bindKey("Directory", undefined, [src]);
    expect(r && !("message" in r) && CONTAINER_BIND_METHODS.includes(r.method)).toBe(true);
  });

  it("declares which tiers those are, so the check cannot quietly widen", () => {
    expect([...CONTAINER_BIND_METHODS]).toEqual(["alias", "exact", "aka", "normalized"]);
  });
});

const CAT = "/etc/httpd/conf/httpd.conf";
const strike = (id: string, param: string, deletes: boolean, at: string): ReviewItem => ({
  id,
  status: "applied",
  target: { sheet: "web", category: CAT, param },
  changes: [],
  deletes,
  at,
});
const rowsOf = (sheets: ReturnType<typeof applyEdits>["sheets"]) =>
  Object.fromEntries((sheets[0].categories![0].params ?? []).map((p) => [p.key, p.deleted === true]));

describe("deleting a block", () => {
  // One decision, one entry. Writing an entry per descendant would make
  // restoring the block a multi-item undo and would allow half-restored states
  // nobody decided.
  it("strikes everything inside it, without an entry per row", () => {
    const r = applyEdits(sheet().sheets, [strike("e1", `Directory["/var/www"]`, true, "2026-01-01T00:00:00Z")], "en");
    expect(rowsOf(r.sheets)).toEqual({ [`Directory["/var/www"]`]: true, [`Directory["/var/www"].AllowOverride`]: true });
  });

  it("puts them all back in one action", () => {
    const r = applyEdits(
      sheet().sheets,
      [strike("e1", `Directory["/var/www"]`, true, "2026-01-01T00:00:00Z"), strike("e2", `Directory["/var/www"]`, false, "2026-01-02T00:00:00Z")],
      "en"
    );
    expect(rowsOf(r.sheets)).toEqual({ [`Directory["/var/www"]`]: false, [`Directory["/var/www"].AllowOverride`]: false });
  });

  // A child struck on its own merits keeps that state when the block comes
  // back: its entry is its own, and the block's restoration was not a statement
  // about it.
  it("leaves a row struck on its own merits struck when the block returns", () => {
    const r = applyEdits(
      sheet().sheets,
      [
        strike("e0", `Directory["/var/www"].AllowOverride`, true, "2026-01-01T00:00:00Z"),
        strike("e1", `Directory["/var/www"]`, true, "2026-01-02T00:00:00Z"),
        strike("e2", `Directory["/var/www"]`, false, "2026-01-03T00:00:00Z"),
      ],
      "en"
    );
    expect(rowsOf(r.sheets)).toEqual({ [`Directory["/var/www"]`]: false, [`Directory["/var/www"].AllowOverride`]: true });
  });
});

describe("the prompt for a struck block", () => {
  const REASONS = { added: "A", struck: "S", document: "D" };

  // "Delete these two rows" is a different statement from "remove this block":
  // an emptied grouper is not an absent one, and only the second was asked for.
  it("says the block and its contents, in one item", () => {
    const reviews = [strike("e1", `Directory["/var/www"]`, true, "2026-01-01T00:00:00Z")];
    const items = promptItemsFromPlan(planFromEdits(reviews), REASONS, sheet().sheets);
    expect(items).toHaveLength(1);
    expect(items[0].target.param).toBe(`Directory["/var/www"]`);
    expect(items[0].comment).toContain(`Directory["/var/www"].AllowOverride`);
  });

  // Derived at build time and never stored: a frozen list would go stale the
  // moment a regeneration adds a setting to the block, and "remove this block"
  // would quietly come to mean "remove what it used to contain".
  it("covers a row added to the block since the decision was made", () => {
    const later = sheet();
    later.sheets[0].categories![0].params!.push({
      key: `Directory["/var/www"].Options`,
      container_path: [{ path: `Directory["/var/www"]`, name: "Directory" }],
      value: "Indexes",
      description: "x",
    });
    const items = promptItemsFromPlan(planFromEdits([strike("e1", `Directory["/var/www"]`, true, "2026-01-01T00:00:00Z")]), REASONS, later.sheets);
    expect(items[0].comment).toContain(`Directory["/var/www"].Options`);
  });

  it("does not repeat the block's decision once per row inside it", () => {
    const reviews = [
      strike("e1", `Directory["/var/www"]`, true, "2026-01-01T00:00:00Z"),
      strike("e2", `Directory["/var/www"].AllowOverride`, true, "2026-01-02T00:00:00Z"),
    ];
    const items = promptItemsFromPlan(planFromEdits(reviews), REASONS, sheet().sheets);
    expect(items.map((i) => i.target.param)).toEqual([`Directory["/var/www"]`]);
  });
});

describe("emitting a row for a block", () => {
  // The mode this ships for: the sheet is organised by the FILE, which is what
  // supplies every row's category — the block's row and its contents alike, so
  // they sit together. Outside it the parser's own headings organise the sheet
  // and a block's row lands one level above its contents, which is where the
  // shipped expression-container rows already land.
  const SHEET_YML = "sheets:\n  web:\n    params: {}\n";
  const io = { readFile: (p: string) => (p === "/sheet.yml" ? SHEET_YML : null), instances: [], projectPath: "/sheet.yml" };
  const inputs = (containers: unknown[]) => [
    {
      name: "web",
      instances: [],
      layers: [{ kind: "base" as const, entries: new Map() }],
      embedded: [
        {
          key: `Directory["/var/www"].AllowOverride`,
          value: "None",
          source: { file: "httpd.conf", line: 5, path: `Directory["/var/www"].AllowOverride` },
          categoryPath: ["httpd.conf"],
          containers,
        },
      ],
    },
  ];
  const D = { name: "Directory", subject: `"/var/www"`, pathSeg: `Directory["/var/www"]`, headings: [`Directory "/var/www"`], line: 4 };
  const R = { name: "RequireAll", pathSeg: "RequireAll", headings: ["RequireAll"], line: 5 };

  const paramsOf = (containers: unknown[]) => {
    const out = assembleSheets(inputs(containers) as never, { ...io, strictMetadata: false } as never);
    const flat: { key: string; value?: string; container?: { name: string }; source?: { line?: number } }[] = [];
    const walk = (cats: { params?: never[]; categories?: never[] }[] | undefined): void => {
      for (const c of cats ?? []) { flat.push(...((c.params ?? []) as never[])); walk(c.categories); }
    };
    for (const sh of out.sheets) walk(sh.categories as never);
    return flat;
  };

  // The argument is the decision. `/var/www` is a path somebody chose, and
  // until now it existed only inside the keys of the settings under it — with
  // nowhere to comment on it and no way to say it should be removed.
  it("gives a block with an argument a row of its own, above its contents", () => {
    const ps = paramsOf([D]);
    expect(ps.map((p) => p.key)).toEqual([`Directory["/var/www"]`, `Directory["/var/www"].AllowOverride`]);
    expect(ps[0].container).toEqual({ name: "Directory" });
    expect(ps[0].value).toBe(`"/var/www"`);
  });

  // Its own definition site is the opening line, not the line of whichever
  // setting inside it happened to be read first.
  it("points the block's row at the line that opens it", () => {
    expect(paramsOf([D])[0].source?.line).toBe(4);
  });

  // A block that only groups says nothing else, and a row for every one of them
  // costs a third more rows plus a dictionary entry each to satisfy the
  // description gate — for rows carrying no decision.
  it("gives a block with no argument no row", () => {
    expect(paramsOf([D, R]).map((p) => p.key)).toEqual([`Directory["/var/www"]`, `Directory["/var/www"].AllowOverride`]);
  });

  it("emits the block once however many settings it holds", () => {
    const two = inputs([D]) as never as { embedded: unknown[] }[];
    two[0].embedded.push({
      key: `Directory["/var/www"].Options`,
      value: "Indexes",
      source: { file: "httpd.conf", line: 6, path: `Directory["/var/www"].Options` },
      categoryPath: ["httpd.conf"],
      containers: [D],
    });
    const out = assembleSheets(two as never, { ...io, strictMetadata: false } as never);
    const keys: string[] = [];
    const walk = (cats: { params?: { key: string }[]; categories?: never[] }[] | undefined): void => {
      for (const c of cats ?? []) { keys.push(...(c.params ?? []).map((p) => p.key)); walk(c.categories); }
    };
    for (const sh of out.sheets) walk(sh.categories as never);
    expect(keys.filter((k) => k === `Directory["/var/www"]`)).toHaveLength(1);
  });
});

// A block inside `{% if %}` renders for some environments and not others.
//
// Its contents already say so — one row per environment that has it — and the
// block's own row has to say the same. Claiming presence everywhere would be a
// false statement about the deployment with the block's SUBJECT attached, which
// is the most consequential thing on the row: "production's audit policy exists
// in every environment" is a worse error than no row at all.
describe("a block inside a conditional", () => {
  const DIR = resolve(import.meta.dir, "fixtures/artifact-rows-conditional-block");
  const SHEET_YML = "sheets:\n  os:\n    params: {}\n";
  const rf = (p: string): string | null => {
    if (p === "/sheet.yml") return SHEET_YML;
    try { return readFileSync(p, "utf-8"); } catch { return null; }
  };
  const rows = (): { key: string; container?: { name: string }; instances?: { name: string }[] }[] => {
    const io = { readFile: rf, specDir: DIR, resolve: (p: string) => resolve(DIR, p.split("/").pop()!), instances: ["staging", "production"] };
    const si = getRecipe("ansible")!.load(
      {
        name: "os",
        recipe: "ansible",
        rows: "artifact",
        defaults: "defaults.yml",
        overlays: { staging: "stg.yml", production: "prod.yml" },
        templates: [{ path: "logrotate-app.j2", component: "lr", deployed_path: "/etc/logrotate.d/app" }],
      } as never,
      io as never
    );
    const out = assembleSheets([si], { readFile: rf, projectPath: "/sheet.yml", instances: [{ name: "staging" }, { name: "production" }], strictMetadata: false } as never);
    const flat: { key: string; container?: { name: string }; instances?: { name: string }[] }[] = [];
    const walk = (cs: { params?: never[]; categories?: never[] }[] | undefined): void => {
      for (const c of cs ?? []) { flat.push(...((c.params ?? []) as never[])); walk(c.categories); }
    };
    for (const sh of out.sheets) walk(sh.categories as never);
    return flat;
  };

  it("says which environments have the block, not that all of them do", () => {
    const audit = rows().find((p) => p.container && p.key.includes("audit"))!;
    expect(audit.instances?.map((i) => i.name)).toEqual(["production"]);
  });

  it("leaves an unconditional block unconditional", () => {
    const app = rows().find((p) => p.container && p.key.includes("/app/"))!;
    expect(app.instances).toBeUndefined();
  });

  // The block and its contents must agree; a block present where its own
  // settings are not is the same false claim from the other side.
  it("agrees with what it holds", () => {
    const all = rows();
    const audit = all.find((p) => p.container && p.key.includes("audit"))!;
    const inside = all.filter((p) => !p.container && p.key.startsWith("/var/log/audit"));
    for (const child of inside) expect(child.instances?.map((i) => i.name)).toEqual(audit.instances?.map((i) => i.name));
  });
});

// A block the VENDOR ships and this project does not (`baseline:` — see
// recipes/ansible.ts). Its three settings are rows of the DEPLOYED file, saying
// "the vendor has these and we do not"; its own row used to say something else
// entirely — `origin: "embedded"`, sourced at the opening line in the vendor's
// file — and so was filed under the vendor's file while its contents sat under
// the deployed one. A block separated from its own settings, this time by
// attribution rather than by grouping.
describe("a block only the vendor's file has", () => {
  const SHEET_YML = "sheets:\n  web:\n    params: {}\n";
  const io = { readFile: (p: string) => (p === "/sheet.yml" ? SHEET_YML : null), instances: [], projectPath: "/sheet.yml" };
  const D = { name: "Directory", subject: `"/var/www/cgi-bin"`, pathSeg: `Directory["/var/www/cgi-bin"]`, headings: [`Directory "/var/www/cgi-bin"`], line: 12, file: "/vendor/httpd.conf" };

  const rows = () => {
    const out = assembleSheets(
      [
        {
          name: "web",
          instances: [],
          layers: [{ kind: "base" as const, entries: new Map() }],
          // The sheet names the file it deploys, which is what places a
          // block's own row — see the missing-category message for a sheet
          // that names none.
          deployedFiles: new Map([["", "/etc/httpd/conf/httpd.conf"]]),
          embedded: [
            {
              key: `Directory["/var/www/cgi-bin"].AllowOverride`,
              value: "None",
              origin: "baseline" as const,
              categoryPath: ["httpd.conf"],
              containers: [D],
            },
          ],
        },
      ] as never,
      { ...io, strictMetadata: false } as never
    );
    const flat: { key: string; origin?: string; source?: unknown }[] = [];
    const walk = (cats: { params?: never[]; categories?: never[] }[] | undefined): void => {
      for (const c of cats ?? []) { flat.push(...((c.params ?? []) as never[])); walk(c.categories); }
    };
    for (const sh of out.sheets) walk(sh.categories as never);
    return flat;
  };

  it("says the block is the vendor's, not something embedded in the deployed file", () => {
    expect(rows().find((p) => p.key === `Directory["/var/www/cgi-bin"]`)?.origin).toBe("baseline");
  });

  // The schema says a baseline row carries no source, because nothing in OUR
  // files holds it. The opening line it has is in the vendor's file: a place to
  // look, not a place the row lives — and its three settings carry none either.
  it("carries no source, like its contents", () => {
    expect(rows().find((p) => p.key === `Directory["/var/www/cgi-bin"]`)?.source).toBeUndefined();
  });

  it("stays with its contents", () => {
    const keys = rows().map((p) => p.key);
    expect(keys).toEqual([`Directory["/var/www/cgi-bin"]`, `Directory["/var/www/cgi-bin"].AllowOverride`]);
  });
});
