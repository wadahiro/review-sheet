// A generated sheet is one self-contained file that carries every value it
// shows, so a credential written into it as a literal has left the systems
// that were keeping it. These tests pin what counts as "written into it".
import { describe, it, expect } from "bun:test";
import { findBakedSecrets } from "../src/secrets.js";
import type { ParameterSheetInput } from "../src/types.js";

const sheet = (params: ParameterSheetInput["sheets"][number]["categories"][number]["params"]): ParameterSheetInput => ({
  metadata: { title: "t" },
  sheets: [{ name: "app", instances: ["staging"], categories: [{ name: "Auth", params }] }],
});

describe("findBakedSecrets", () => {
  it("reports a declared secret written as a literal", () => {
    const found = findBakedSecrets(sheet([{ key: "bindCredential", value: "hunter2", secret: true }]));
    expect(found).toEqual([{ sheet: "app", category: "Auth", key: "bindCredential" }]);
  });

  it("says nothing about a reference — that is the shape it wants", () => {
    const found = findBakedSecrets(
      sheet([
        { key: "a", value: "${vault.corp-ldap}", secret: true },
        { key: "b", value: "{{ kc_db_password }}", secret: true },
        { key: "c", value: "jdbc:postgresql://h/db?password=${PW}", secret: true },
      ])
    );
    expect(found).toEqual([]);
  });

  it("says nothing about a row nobody declared secret", () => {
    expect(findBakedSecrets(sheet([{ key: "http-port", value: "8080" }]))).toEqual([]);
  });

  it("says nothing about a product default", () => {
    // `https-key-store-password` documents `password` as its default. That is
    // published, not this deployment's credential, and reporting it would
    // train a reader to ignore the list.
    const found = findBakedSecrets(
      sheet([{ key: "https-key-store-password", value: "password", default: "password", origin: "default", secret: true }])
    );
    expect(found).toEqual([]);
  });

  it("reports the environment a per-instance literal is in", () => {
    const found = findBakedSecrets(
      sheet([
        {
          key: "smtpServer.password",
          secret: true,
          instances: [
            { name: "staging", value: "${SMTP_PW}" },
            { name: "production", value: "s3cret" },
          ],
        },
      ])
    );
    expect(found).toEqual([{ sheet: "app", category: "Auth", key: "smtpServer.password", instance: "production" }]);
  });

  it("says nothing about an empty value", () => {
    expect(findBakedSecrets(sheet([{ key: "a", value: "", secret: true }]))).toEqual([]);
  });
});

// The interaction that made this feature dead on arrival: a project marks its
// credentials `out_of_scope` — every one of the real project's was — and
// enrich skips an excluded row entirely, so the declaration never reached the
// row and the check found nothing.
describe("out_of_scope rows still resolve `secret`", () => {
  it("reports an excluded row whose value is a literal", () => {
    // out_of_scope says the row is not being REVIEWED here. It says nothing
    // about whether its value is in the file that gets handed around.
    const found = findBakedSecrets(
      sheet([{ key: "smtpServer.password", value: "hunter2", secret: true, out_of_scope: { reason: "pipeline" } }])
    );
    expect(found).toHaveLength(1);
  });
});
