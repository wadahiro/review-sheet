// The wiring a project no longer has to write.
//
// Two kinds so far, both the same move: a declaration that carried a project
// fact AND a product fact, with the product half lifted out and the project
// half left where it belongs. `channels:` (how a row with no file behind it is
// read) and `documents:` (where a row sits in what the product's own API
// returned).
//
// A declared entry carries WHICH rows and HOW to read them. The second half is
// the product's (see `ProductRead` in channel.ts); the first half the build
// already knows, because a sheet's `dictionaries:` binding selects exactly
// those rows. So the entry derives from the two facts already in hand.
//
// It emits a FULL ChannelSpec with the keys spelled out, rather than teaching
// the judge to re-derive them: the model is what travels to whoever runs the
// test, and a model that says which rows `getenforce` answers can be read and
// argued with, while one that says "ask the bindings" cannot. Everything
// downstream is unchanged — these are ordinary entries.
//
// Pure: no registry lookup of its own, no I/O. The recipe is passed in.

import type { ChannelSpec } from "./types.js";
import type { BindReportRow } from "./assemble.js";
import type { ProductRead } from "./channel.js";

export type DerivedChannels = {
  channels: ChannelSpec[];
  // What was derived, and what was deliberately not. Both are reported: a
  // channel appearing from nowhere is as surprising as a row vanishing, and a
  // recipe that could not be scoped must never be a silent no-op.
  derived: { sheet: string; product: string; command: string; keys: string[] }[];
  // `kind` is what a caller branches on; `reason` is for a human to read.
  // Matching on the sentence would make a reworded message silently change
  // behaviour — the same reason nothing else here is decided by prose.
  skipped: { sheet: string; product: string; kind: "claimed" | "no-prefix"; reason: string }[];
};

// Does a declared entry already claim this row? The project's own declaration
// always wins — it is the more specific statement, and a second channel
// claiming the same row would make the answer depend on registration order.
const claimed = (declared: readonly ChannelSpec[], sheet: string, key: string): boolean =>
  declared.some(
    (d) =>
      d.sheet === sheet &&
      ((d.key_prefix !== undefined && key.startsWith(d.key_prefix)) || (d.keys ?? []).includes(key))
  );

// The sheet namespaces a row (`firewalld.ssh`) and the host has never heard of
// the prefix; the dictionary key is the name the product knows (`ssh`). So the
// prefix is exactly their difference — read off the rows rather than declared,
// which is what keeps the recipe free of any one project's naming.
//
// It is emitted ALONGSIDE the explicit keys, not instead of them, because
// `commandChannel` reads it for two different jobs: `bare()` needs it to ask
// the host the right name, and `covers()` happens to also accept any row under
// it. That second reading makes the entry's scope wider than the keys listed —
// harmless here, since every row it would additionally claim is one bound to
// the same product, which the next build lists explicitly anyway.
//
// Returns undefined when there is no single prefix covering every row. That is
// only fatal for a reading that USES the key; `whole: true` never looks at it.
const prefixOf = (rows: { key: string; dictKey: string }[]): string | undefined => {
  const prefixes = new Set<string>();
  for (const r of rows) {
    if (!r.key.endsWith(r.dictKey)) return undefined;
    prefixes.add(r.key.slice(0, r.key.length - r.dictKey.length));
  }
  return prefixes.size === 1 ? [...prefixes][0] : undefined;
};

const usesKey = (read: ProductRead["read"]): boolean =>
  "member" in read || ("pattern" in read && read.pattern.includes("{key}"));

export function deriveChannels(
  rows: readonly BindReportRow[],
  declared: readonly ChannelSpec[] | undefined,
  recipeFor: (product: string) => ProductRead | undefined
): DerivedChannels {
  const already = declared ?? [];
  const groups = new Map<string, { sheet: string; product: string; rows: { key: string; dictKey: string }[] }>();
  for (const r of rows) {
    if (r.method === "none") continue;
    // JSON, not a joined string: a separator that cannot appear in a sheet
    // or product name is one more thing to be right about, and this needs none.
    const id = JSON.stringify([r.sheet, r.product]);
    const g = groups.get(id) ?? { sheet: r.sheet, product: r.product, rows: [] };
    g.rows.push({ key: r.key, dictKey: r.dictKey });
    groups.set(id, g);
  }

  const out: DerivedChannels = { channels: [], derived: [], skipped: [] };
  // Sorted, so a model built twice from one spec is the same model.
  for (const g of [...groups.values()].sort((a, b) => a.sheet.localeCompare(b.sheet) || a.product.localeCompare(b.product))) {
    const recipe = recipeFor(g.product);
    if (recipe === undefined) continue;

    const mine = g.rows.filter((r) => !claimed(already, g.sheet, r.key));
    if (mine.length === 0) {
      out.skipped.push({ sheet: g.sheet, product: g.product, kind: "claimed", reason: "every row is already claimed by a declared channel" });
      continue;
    }

    const prefix = prefixOf(mine);
    if (prefix === undefined && usesKey(recipe.read)) {
      // The reading needs the product's own name for the row and the rows do
      // not agree on how the sheet arrived at theirs. Guessing would ask the
      // host about a name it has never heard, which answers "not set" — a
      // wrong answer that looks exactly like a right one.
      out.skipped.push({
        sheet: g.sheet,
        product: g.product,
        kind: "no-prefix",
        reason: `rows do not share one key prefix over their dictionary keys, and \`${recipe.command}\` reads by name`,
      });
      continue;
    }

    const keys = [...new Set(mine.map((r) => r.key))].sort();
    out.channels.push({
      channel: "command",
      sheet: g.sheet,
      keys,
      ...(prefix !== undefined && prefix !== "" ? { key_prefix: prefix } : {}),
      command: recipe.command,
      read: recipe.read,
    });
    out.derived.push({ sheet: g.sheet, product: g.product, command: recipe.command, keys });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The `address:` a project no longer writes.
//
// Same move as above, one declaration over: a `documents:` entry says WHICH
// document (`poc`, `master` — the project's own realms) and WHERE in it a row
// sits (`clients[clientId={component}].{key}` — the shape of the product's own
// export). Only the second is derivable, and getting it slightly wrong is not
// a build error: `resolveDocument` skips an entry whose address is missing, so
// a wrong one resolves rows to nothing and the sheet simply goes unanswered.
//
// Per SHEET, not per row, because that is what a `documents:` entry is.

export type DerivedDocuments = {
  // The entries to write back, keyed the way `documents:` is.
  addresses: { sheet: string; address: string }[];
  skipped: { sheet: string; kind: "declared" | "ambiguous"; reason: string }[];
  // An entry left with no address at all — neither stated nor derivable.
  // `resolveDocument` SKIPS such an entry, so its sheet goes unanswered with
  // nothing said; the build fails on this rather than shipping that silence.
  unresolved: { sheet: string; reason: string }[];
};

export function deriveDocuments(
  rows: readonly BindReportRow[],
  // The spec's own entries. `document`/`substitute` are not read here — they
  // stay the project's — but the type carries `document` so a caller can hand
  // over its real entries rather than a stripped-down copy.
  declared: readonly { sheet: string; document?: string; address?: string; router?: string }[] | undefined,
  addressFor: (product: string) => { address: string } | undefined
): DerivedDocuments {
  const out: DerivedDocuments = { addresses: [], skipped: [], unresolved: [] };
  const bySheet = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.method === "none") continue;
    const set = bySheet.get(r.sheet) ?? new Set<string>();
    set.add(r.product);
    bySheet.set(r.sheet, set);
  }

  for (const entry of declared ?? []) {
    // A router answers where a row sits by itself; an address would be a second,
    // competing answer.
    if (entry.router !== undefined) continue;
    if (entry.address !== undefined) {
      out.skipped.push({ sheet: entry.sheet, kind: "declared", reason: "the spec states an address of its own" });
      continue;
    }
    const withRecipe = [...(bySheet.get(entry.sheet) ?? [])].filter((p) => addressFor(p) !== undefined).sort();
    if (withRecipe.length === 0) {
      out.unresolved.push({
        sheet: entry.sheet,
        reason: "no address stated, and none of the dictionaries it binds says where a row sits in the product's own export",
      });
      continue;
    }
    if (withRecipe.length > 1) {
      // Two products both claiming to say where a row sits is a question about
      // this sheet that only its author can answer.
      out.unresolved.push({
        sheet: entry.sheet,
        reason: `bound to ${withRecipe.join(" and ")}, which address rows differently — state \`address:\` for this sheet`,
      });
      out.skipped.push({
        sheet: entry.sheet,
        kind: "ambiguous",
        reason: `bound to ${withRecipe.join(" and ")}, which address rows differently — state \`address:\` for this sheet`,
      });
      continue;
    }
    out.addresses.push({ sheet: entry.sheet, address: addressFor(withRecipe[0]!)!.address });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The `command` of a `defaults_checked_by:` entry.
//
// Narrower than the two above, deliberately. An entry says a product, the
// deployed file whose "we set nothing, so the default applies" rows it governs,
// and the command that makes the product answer for itself. Only the last
// derives, and the entry itself is NEVER invented.
//
// That limit was found by the test suite rather than reasoned out: a first
// version paired every sheet carrying a deployed `file_path` with its one bound
// product and emitted the entry whole, which grew one on two shipped examples
// that had never declared it. The two cases are not alike. A derived CHANNEL
// answers a row that had no answer at all; this is an EXTRA cross-check on rows
// the file already answers, and switching it on unasked adds a command to every
// collection and can turn a passing row into a failing one — a project's test
// changing character because it upgraded the tool.
//
// So a project states which files it wants cross-checked, and never has to know
// how. `aside:` — the second file the DISTRIBUTION makes the product read — was
// never derivable anyway: a dictionary pinned to an upstream version
// (`httpd@2.4.62`, unlike an NVR like `systemd@252-67.el9_8.4`) cannot say
// which distribution this is.

export type DefaultsEntry = { product: "httpd" | "keycloak"; file: string; command?: string; aside?: string };

export type DerivedDefaults = {
  entries: DefaultsEntry[];
  derived: { file: string; product: string; command: string }[];
};

export function deriveDefaultsCheckedBy(
  declared: readonly DefaultsEntry[] | undefined,
  recipeFor: (product: string) => { product: "httpd" | "keycloak"; command: (f: string) => string } | undefined
): DerivedDefaults {
  const out: DerivedDefaults = { entries: [], derived: [] };
  for (const d of declared ?? []) {
    const recipe = d.command === undefined ? recipeFor(d.product) : undefined;
    if (recipe === undefined) {
      out.entries.push(d);
      continue;
    }
    const command = recipe.command(d.file);
    out.entries.push({ ...d, command });
    out.derived.push({ file: d.file, product: d.product, command });
  }
  return out;
}
