// What `bind.ts` makes of a CONTAINER's key.
//
// A container row's key is an address segment, and `leafKey` — the tier that
// takes "the last identity-bearing segment of a structural path" — reads those
// segments with `parseSteps`. That works for a row key, which is what it was
// written for. It does not work for a container's, and the two shapes it gets
// wrong are the two formats that motivated container rows at all:
//
//   Directory["/var/www"]  ->  "/var/www"   (a QUOTED bracket parses as a map
//                                            key, so the leaf is the argument)
//   /var/log/httpd/*.log   ->  "log"        (the pattern contains the step
//                                            separator, so it splits mid-path)
//
// Neither is a crash. Both silently bind a container to whatever dictionary
// entry happens to carry that name — none, in every dictionary shipped here
// today, which is exactly why this is pinned rather than left to be noticed:
// whether it fires depends on a dictionary the project supplies, so the day it
// does there is nothing to catch it.
//
// The design's answer is that a container row is bound by its NOUN
// (`ContainerNode.name`), never by its key, so these tiers never see it. This
// records what they WOULD do, so that promise cannot quietly stop being kept.

import { describe, it, expect } from "bun:test";
import { leafKey } from "../src/bind";

// Spellings the parsers actually emit — taken from their own output rather than
// typed here, so the table cannot drift away from what a container's key is.
const SHAPES: { key: string; leaf: string; safe: boolean; note: string }[] = [
  { key: `Directory["/var/www"]`, leaf: "/var/www", safe: false, note: "httpd, quoted label" },
  { key: "/var/log/httpd/*.log", leaf: "log", safe: false, note: "logrotate pattern" },
  { key: "/var/log/a.log", leaf: "log", safe: false, note: "logrotate, dot in the pattern" },
  { key: "Directory[/var/www]", leaf: "Directory", safe: true, note: "httpd, unquoted label" },
  { key: "local-cache[name=realms]", leaf: "local-cache", safe: true, note: "xml, promoted identity" },
  { key: "location[/api]", leaf: "location", safe: true, note: "nginx" },
  { key: "backend[app]", leaf: "backend", safe: true, note: "haproxy" },
  {
    key: `components["org.keycloak.storage.UserStorageProvider"][name=corp-ldap]`,
    leaf: "org.keycloak.storage.UserStorageProvider",
    safe: true,
    note: "a quoted map key holding dots, plus a filter — one container, two steps",
  },
];

describe("a container key through bind's leaf tier", () => {
  it("resolves exactly as recorded", () => {
    expect(SHAPES.map((s) => [s.key, leafKey(s.key)])).toEqual(SHAPES.map((s) => [s.key, s.leaf]));
  });

  // The point of the table: three of eight are wrong, and they are not exotic.
  it("still gets the two motivating formats wrong", () => {
    const wrong = SHAPES.filter((s) => !s.safe).map((s) => s.note);
    expect(wrong).toEqual(["httpd, quoted label", "logrotate pattern", "logrotate, dot in the pattern"]);
  });

  // Which is why a container is bound by its noun. `name` is a plain word with
  // no address syntax in it at all, so `leaf` cannot apply to it — the tier
  // returns undefined when its candidate is the key itself.
  it("a container's noun has nothing for the leaf tier to strip", () => {
    for (const noun of ["Directory", "local-cache", "location", "backend", "RequireAll", "cache-container"]) {
      expect(leafKey(noun)).toBe(noun);
    }
  });
});
