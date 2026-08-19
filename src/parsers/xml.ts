// XML parser: wraps xmlIndex/xmlLocate/xmlEdit.

import { xmlIndex, xmlLocate, xmlEdit } from "../xml.js";
import { registerParser, type ConfigParser, type EditResult, type LocateResult } from "../parser.js";
import type { SourceLocation } from "../types.js";

const xmlParser: ConfigParser = {
  name: "xml",
  priority: 20,
  meta: {
    title: "XML",
    summary: "Element text and attributes; reorder-robust paths via identity attributes.",
    files: "*.xml",
    detection: "extension (.xml)",
    pathStyle: "server.connector.@port — attribute; services.service[name=web].port — element by identity",
    containers:
      "Every element is a block. One carrying `name`/`id`/`key` promotes it into the address (`local-cache[name=realms]`) and becomes a row valued by that attribute, whose own attribute row is then suppressed — the fact is stated once. Promotion does not depend on how many siblings the element has.",
    notes: [
      "Attribute values addressed with .@attr suffix.",
      "Repeated elements addressed by identity attribute (name/id/key) → reorder-robust.",
      "Positional [i] fallback when no identity attribute exists.",
      "Mixed content and CDATA sections are skipped.",
    ],
    examples: ["server.connector.@port", "services.service[name=web].port", "beans.bean[id=myBean].property.@value"],
  },
  detect: (file) => file.toLowerCase().endsWith(".xml"),
  extract: (content) =>
    xmlIndex(content).map((e) => ({
      categoryPath: e.categoryPath,
      key: e.key,
      value: e.value,
      source: { line: e.line, path: e.path },
      containers: e.containers,
    })),
  locate: (content, source: SourceLocation, _expected: string): LocateResult => {
    if (!source.path) return { error: "no path", status: "unmapped" };
    const loc = xmlLocate(content, source.path);
    if ("value" in loc) return { value: loc.value };
    return { error: loc.error };
  },
  edit: (content, source: SourceLocation, current: string, suggested: string): EditResult => {
    if (!source.path) return { status: "error", reason: "no path" };
    return xmlEdit(content, source.path, current, suggested);
  },
};
registerParser(xmlParser);
