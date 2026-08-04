#!/usr/bin/env bun
// Normalize a pg_settings dump into a review-sheet product dictionary
// (postgresql@<major>.yml, provenance "extracted" — machine-derived from the
// running server, not hand-transcribed). This reads the dump on STDIN, so the
// dictionary always reflects the real product build, not embedded sample data.
//
// Generate the full dictionary from the version you deploy:
//
//   docker run -d --name pgdump -e POSTGRES_PASSWORD=pw postgres:16
//   until docker exec pgdump pg_isready -qU postgres; do sleep 1; done
//   docker exec pgdump psql -U postgres -At -F '|' \
//     -c "SELECT name, boot_val, unit, short_desc, category, vartype FROM pg_settings ORDER BY name" \
//     | bun run review-sheet/metadata/normalize-pg.ts > review-sheet/metadata/postgresql@16.yml
//   docker rm -f pgdump
//
// pg_settings.boot_val is a raw number in `unit` (e.g. 16384 * 8kB); we format it
// to a human value (128MB) so the sheet's stock-default column is comparable to
// the human values written in the Ansible vars.

import { readFileSync } from "node:fs";
// The dictionary SHAPE belongs to review-sheet; only the pg_settings reshaping
// below is PostgreSQL-specific.
import { renderDictionary, type DictionaryDoc, type DictionaryParam } from "../../../../src/index.js";

const MEM: Record<string, number> = { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
const TIME_MS: Record<string, number> = { us: 1e-3, ms: 1, s: 1000, min: 60000, h: 3_600_000, d: 86_400_000 };

// Format a numeric pg_settings default that has a unit into a human string.
function formatDefault(bootVal: string, unit: string): string {
  const n = Number(bootVal);
  if (!unit || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return bootVal; // -1/off/no-unit: keep raw
  const mem = unit.match(/^(\d*)(B|kB|MB|GB|TB)$/);
  if (mem) {
    const bytes = n * (mem[1] ? Number(mem[1]) : 1) * MEM[mem[2]];
    for (const u of ["TB", "GB", "MB", "kB", "B"]) {
      if (bytes % MEM[u] === 0) return `${bytes / MEM[u]}${u}`;
    }
  }
  const time = unit.match(/^(\d*)(us|ms|s|min|h|d)$/);
  if (time) {
    const ms = n * (time[1] ? Number(time[1]) : 1) * TIME_MS[time[2]];
    for (const u of ["d", "h", "min", "s", "ms"]) {
      if (ms % TIME_MS[u] === 0) return `${ms / TIME_MS[u]}${u}`;
    }
  }
  return bootVal;
}

const input = readFileSync(process.argv[2] ?? "/dev/stdin", "utf8");
const parameters: Record<string, DictionaryParam> = {};
for (const line of input.split("\n")) {
  if (!line.trim()) continue;
  const [name, bootVal, unit, shortDesc, category, vartype] = line.split("|");
  parameters[name] = {
    description: { en: shortDesc ?? "" },
    default: formatDefault(bootVal ?? "", unit ?? ""),
    type: vartype ?? "string",
    // pg_settings' `category` is PostgreSQL's own grouping of its parameters,
    // not a "scope" (where/when a setting applies) — it goes in `group`, which
    // the assembler uses as the category fallback for materialized rows.
    group: category ?? "",
  };
}

const doc: DictionaryDoc = {
  product: "postgresql",
  version: "16",
  provenance: "extracted",
  // pg_settings enumerates every GUC the running server knows about — the
  // product's whole option space, not a hand-picked subset — genuinely
  // materializable (see build.yml's "materialize").
  coverage: "full",
  generated_by: "pg_settings dump from postgres:16 (see normalize-pg.ts header)",
  parameters,
};

process.stdout.write(renderDictionary(doc, { generator: "normalize-pg.ts" }));
