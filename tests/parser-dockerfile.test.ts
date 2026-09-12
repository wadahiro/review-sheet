// A Dockerfile's reviewable values — the instructions that decide something a
// reader signs, and nothing else.

import { describe, it, expect } from "bun:test";
import "../src/parsers/index";
import { extractFile } from "../src/extract";

const DF = `FROM base:1 AS build
ARG VERSION=1.2
ENV PATH=/usr/bin LANG=en_US.UTF-8
RUN make install && rm -rf /var/cache

FROM quay.io/x/y:26.7.0
ENV APP_DB=postgres \\
    APP_HEALTH=true
ENV OLD_STYLE some value with spaces
LABEL org.opencontainers.image.title="Example"
EXPOSE 8080
EXPOSE 9000
USER 1000
ENTRYPOINT ["/opt/x/bin/run.sh"]
`;

const rows = (text = DF) => new Map(extractFile(text, "Dockerfile").map((e) => [e.key, String(e.value)]));

describe("what a Dockerfile decides", () => {
  it("names a row the way a reviewer does, not by the instruction", () => {
    const r = rows();
    expect(r.get("APP_DB")).toBe("postgres");
    expect(r.get("org.opencontainers.image.title")).toBe("Example");
    // …and an instruction that carries no name of its own is its own name.
    expect(r.get("from")).toBe("quay.io/x/y:26.7.0");
    expect(r.get("user")).toBe("1000");
  });

  // `RUN` is a build step, not a setting: reading its shell as configuration
  // would put a package manager's arguments on a parameter sheet.
  it("leaves build steps out", () => {
    expect([...rows().keys()].some((k) => /make|gradlew|run/i.test(k))).toBe(false);
  });

  // A continued instruction is ONE instruction, and reading its second line
  // alone would make a row out of a fragment.
  it("reads a continued instruction as one, at one line", () => {
    const entries = extractFile(DF, "Dockerfile").filter((e) => e.key.startsWith("APP_"));
    expect(entries.map((e) => e.key)).toEqual(["APP_DB", "APP_HEALTH"]);
    expect(entries[0]!.source!.line).toBe(entries[1]!.source!.line);
  });

  it("reads the older unequalled form, value to end of line", () => {
    expect(rows().get("OLD_STYLE")).toBe("some value with spaces");
  });

  // A multi-stage build's stages are separate address spaces: two stages'
  // `PATH` are two rows, not one row written twice.
  it("keeps a stage's values under the stage", () => {
    const r = rows();
    expect(r.get("build.PATH")).toBe("/usr/bin");
    expect(r.get("build.from")).toBe("base:1");
    expect(r.has("PATH")).toBe(false);
  });

  it("indexes a repeated instruction rather than losing one", () => {
    const r = rows();
    expect(r.get("expose")).toBe("8080");
    expect(r.get("expose[1]")).toBe("9000");
  });
});
