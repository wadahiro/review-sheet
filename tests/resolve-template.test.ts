import { describe, it, expect } from "bun:test";
import { resolveTemplateVars } from "../src/extract";

function reader(map: Record<string, string>) {
  return (p: string): string | null => (p in map ? map[p] : null);
}

const template = [
  "hostname={{ keycloak_hostname }}",
  "db-url={{ keycloak_db_url | default('') }}",
  "log-level=INFO",
].join("\n");

describe("resolveTemplateVars", () => {
  it("resolves {{ var }} values to their definition in the variable file", () => {
    const out = resolveTemplateVars(
      "roles/keycloak/templates/keycloak.properties.j2",
      ["roles/keycloak/defaults/main.yml"],
      reader({
        "roles/keycloak/templates/keycloak.properties.j2": template,
        "roles/keycloak/defaults/main.yml": "keycloak_hostname: sso.example.co.jp\nkeycloak_db_url: jdbc:postgresql://db/kc\n",
      })
    );
    const host = out.find((e) => e.key === "hostname");
    expect(host?.source.templateVar).toBe("keycloak_hostname");
    expect(host?.resolvedSource?.file).toBe("roles/keycloak/defaults/main.yml");
    expect(host?.resolvedSource?.path).toBe("keycloak_hostname");
    expect(host?.resolvedSource?.anchor).toBe("keycloak_hostname:");
    // jinja-only hints must not leak into the resolved source.
    expect(host?.resolvedSource?.templateVar).toBeUndefined();
  });

  it("keeps a literal value mapped to the template itself", () => {
    const out = resolveTemplateVars(
      "app.properties.j2",
      ["vars.yml"],
      reader({ "app.properties.j2": template, "vars.yml": "keycloak_hostname: x\n" })
    );
    const lit = out.find((e) => e.key === "log-level");
    expect(lit?.source.templateVar).toBeUndefined();
    expect(lit?.resolvedSource?.file).toBe("app.properties.j2");
    expect(lit?.resolvedSource?.line).toBe(3);
    expect(lit?.resolvedSource?.anchor).toBe("log-level=");
  });

  it("tries variable files in order — the first definition wins", () => {
    const out = resolveTemplateVars(
      "t.properties.j2",
      ["group_vars.yml", "defaults.yml"],
      reader({
        "t.properties.j2": "hostname={{ keycloak_hostname }}",
        "group_vars.yml": "keycloak_hostname: prod-host\n",
        "defaults.yml": "keycloak_hostname: default-host\n",
      })
    );
    expect(out.find((e) => e.key === "hostname")?.resolvedSource?.file).toBe("group_vars.yml");
  });

  it("leaves resolvedSource undefined when no variable file defines the variable", () => {
    const out = resolveTemplateVars(
      "t.properties.j2",
      ["vars.yml"],
      reader({ "t.properties.j2": "hostname={{ missing_var }}", "vars.yml": "other: 1\n" })
    );
    expect(out.find((e) => e.key === "hostname")?.resolvedSource).toBeUndefined();
  });

  it("returns nothing when the template file is unreadable", () => {
    expect(resolveTemplateVars("nope.j2", [], reader({}))).toEqual([]);
  });
});
