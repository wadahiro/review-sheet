// What `openssl s_client` says about a certificate — its own date format, and
// the several sentences it prints when there is no certificate at all.

import { describe, it, expect } from "bun:test";
import { certNotAfter, certExpiry, handshakeFailure } from "../src/channels/openssl";

const GOOD = [
  "subject=CN=sso.example.com",
  "issuer=CN=Example CA",
  "notBefore=Jun  1 12:00:00 2026 GMT",
  "notAfter=Jun  1 12:00:00 2027 GMT",
  "",
].join("\n");

describe("what openssl reports about a certificate", () => {
  it("reads the expiry as printed, and as a moment", () => {
    expect(certNotAfter(GOOD)).toBe("Jun  1 12:00:00 2027 GMT");
    expect(certExpiry(GOOD)?.toISOString()).toBe("2027-06-01T12:00:00.000Z");
  });

  // The whole reason to read these apart: a host that cannot REACH the endpoint
  // has not found an expired certificate, and answering "fail" there is a
  // finding nobody can act on. Three layers produce three different sentences.
  it("tells a certificate it could not fetch from one it did", () => {
    expect(handshakeFailure(GOOD)).toBeUndefined();
    for (const said of [
      "connect: Connection refused\nconnect:errno=61",
      "sso.example.com: Name or service not known",
      "no peer certificate available",
      "unable to load certificate",
    ]) {
      expect(handshakeFailure(said)).toBe(said.split("\n")[0]);
    }
  });

  it("says nothing about output with no dates in it at all", () => {
    expect(certNotAfter("CONNECTED(00000003)")).toBeUndefined();
    expect(certExpiry("notAfter=not a date")).toBeUndefined();
  });
});
