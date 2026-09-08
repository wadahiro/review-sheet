// A credential the sheet holds as a literal can be in the collected bytes a
// second time — under a different name, in a file nobody chose line by line.
// The sheet's own check never looked there, because until evidence existed
// there was nothing there to look at.
import { describe, it, expect } from "bun:test";
import { findSecretsInEvidence } from "../src/secrets";

const model = {
  sheets: [
    {
      name: "kc",
      categories: [
        {
          name: "db",
          params: [
            { key: "db-password", value: "s3cr3t", secret: true },
            { key: "vault-password", value: "${KC_VAULT}", secret: true },
            { key: "db-username", value: "keycloak" },
          ],
        },
      ],
    },
  ],
};

const doc = (text: string) => [{ instance: "local", host: "n1", path: "/etc/app.conf", text }];

describe("a secret carried twice", () => {
  it("names the row and the document the credential turned up in", () => {
    const found = findSecretsInEvidence(model as never, doc("user=keycloak\npassword=s3cr3t\n"));
    expect(found.length).toBe(1);
    expect(found[0]).toMatchObject({ sheet: "kc", key: "db-password", instance: "local", where: "n1 /etc/app.conf" });
  });

  it("says nothing about a reference, which is not the credential", () => {
    expect(findSecretsInEvidence(model as never, doc("token=${KC_VAULT}\n"))).toEqual([]);
  });

  it("says nothing about a value nobody declared secret", () => {
    expect(findSecretsInEvidence(model as never, doc("user=keycloak\n"))).toEqual([]);
  });
});
