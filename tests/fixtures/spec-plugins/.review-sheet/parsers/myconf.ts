// Custom ConfigParser for a fake ".myconf" format ("key -> value"), used by
// tests/spec-plugins.test.ts to prove `import --spec` auto-discovers
// .review-sheet/parsers/. The shipped `generic` fallback splits on the first
// `=`/`:` and finds neither here, so a `timeout` parameter in the output can
// only have come from this parser.
import { registerParser, type ConfigParser } from "../../../../../src/index.js";

function parse(line: string): { key: string; value: string } | undefined {
  const i = line.indexOf("->");
  if (i < 0) return undefined;
  return { key: line.slice(0, i).trim(), value: line.slice(i + 2).trim() };
}

const myconf: ConfigParser = {
  name: "myconf",
  priority: 50,
  detect: (file) => file.endsWith(".myconf"),
  extract: (content) =>
    content.split("\n").flatMap((line, i) => {
      const kv = parse(line);
      return kv ? [{ categoryPath: [], key: kv.key, value: kv.value, source: { line: i + 1, anchor: kv.key } }] : [];
    }),
  locate: (content, source) => {
    const line = content.split("\n")[(source.line ?? 0) - 1];
    const kv = line === undefined ? undefined : parse(line);
    return kv ? { value: kv.value } : { error: "no myconf assignment on that line" };
  },
  edit: (content, source, current, suggested) => {
    const lines = content.split("\n");
    const i = (source.line ?? 0) - 1;
    const kv = lines[i] === undefined ? undefined : parse(lines[i]);
    if (!kv || kv.value !== current) return { status: "skipped" };
    const before = lines[i];
    lines[i] = `${kv.key} -> ${suggested}`;
    return { status: "applied", content: lines.join("\n"), before, after: lines[i] };
  },
};

registerParser(myconf);
