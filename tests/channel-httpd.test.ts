// What httpd says about its own defaults.
//
// A row claiming "the product's own default applies" is answered by the file
// only when nothing ELSE decides the value, and httpd has two something-elses
// every project running it meets. Both are httpd's knowledge, not one
// project's, and copied into each project's judge they are tested in none.

import { describe, it, expect } from "bun:test";
import { compiledInDefaults, compiledInFor, injectedOptions, lineOfCompiledIn } from "../src/channels/httpd";

const V = [
  'Server version: Apache/2.4.62 (Red Hat Enterprise Linux)',
  'Server compiled: Jan  1 2026',
  'Server\'s Module Magic Number: 20120211:134',
  ' -D HTTPD_ROOT="/etc/httpd"',
  ' -D DEFAULT_PIDLOG="/run/httpd/httpd.pid"',
  ' -D SERVER_CONFIG_FILE="conf/httpd.conf"',
  "",
].join("\n");

describe("what the binary was built with", () => {
  it("reads the names it prints and nothing else", () => {
    expect([...compiledInDefaults(V)]).toEqual([
      ["HTTPD_ROOT", "/etc/httpd"],
      ["DEFAULT_PIDLOG", "/run/httpd/httpd.pid"],
      ["SERVER_CONFIG_FILE", "conf/httpd.conf"],
    ]);
  });

  // A directive is asked for by ITS name, not the binary's — the sheet's rows
  // say `PidFile`, and only httpd knows that is `DEFAULT_PIDLOG`.
  it("answers a directive by the name httpd prints it under", () => {
    expect(compiledInFor(V, "PidFile")).toBe("/run/httpd/httpd.pid");
    expect(compiledInFor(V, "ServerRoot")).toBe("/etc/httpd");
  });

  // `httpd -V` is not a dump of every default: a directive it does not report
  // is answered by the dictionary, as before.
  it("says nothing about a directive the binary does not report", () => {
    expect(compiledInFor(V, "Timeout")).toBeUndefined();
  });

  it("points at the line it was read at, not at the whole output", () => {
    expect(lineOfCompiledIn(V, "PidFile")).toBe(5);
    expect(lineOfCompiledIn(V, "Timeout")).toBeUndefined();
  });
});

describe("what reaches a configuration from beside it", () => {
  // `-C`/`-c` insert directives and `-D` defines a name an <IfDefine> tests.
  // Any of the three means the file alone can no longer say a default applies.
  it("is OPTIONS that can set configuration", () => {
    expect(injectedOptions('OPTIONS="-C \'ServerTokens Full\'"')).toContain("-C");
    expect(injectedOptions("OPTIONS=-DSTATUS")).toBeUndefined();
    expect(injectedOptions("OPTIONS=-D STATUS")).toContain("-D");
  });

  // …and not OPTIONS that merely change how it runs.
  it("is not OPTIONS that set nothing", () => {
    expect(injectedOptions('OPTIONS="-DFOREGROUND"')).toBeUndefined();
    expect(injectedOptions("OPTIONS=")).toBeUndefined();
  });

  // The file being ABSENT is the ordinary case on this distribution, and is
  // itself the answer: no OPTIONS, nothing injected.
  it("is nothing when the file is not there", () => {
    expect(injectedOptions(undefined)).toBeUndefined();
    expect(injectedOptions(null)).toBeUndefined();
  });
});
