import { describe, it, expect } from "bun:test";
import { baseFileName, jinjaVariable, conditionalLineSet, substituteJinja } from "../src/jinja2";
import { extractFile } from "../src/extract";
import type { Entry } from "../src/parser";

describe("jinja2 primitives", () => {
  it("strips a trailing .j2", () => {
    expect(baseFileName("roles/keycloak/templates/keycloak.conf.j2")).toBe("roles/keycloak/templates/keycloak.conf");
    expect(baseFileName("plain.conf")).toBe("plain.conf");
  });

  it("extracts the variable behind a {{ … }} value (with or without filters)", () => {
    expect(jinjaVariable("{{ keycloak_hostname }}")).toBe("keycloak_hostname");
    expect(jinjaVariable("{{ keycloak_db_url | default('') }}")).toBe("keycloak_db_url");
    expect(jinjaVariable("{{- a.b.c -}}")).toBe("a.b.c");
    expect(jinjaVariable("plain-literal")).toBeUndefined();
  });

  it("flags lines strictly inside if/for blocks", () => {
    const content = ["a=1", "{% if x %}", "b=2", "{% endif %}", "c=3"].join("\n");
    const set = conditionalLineSet(content);
    expect(set.has(3)).toBe(true); // b=2
    expect(set.has(1)).toBe(false);
    expect(set.has(5)).toBe(false);
  });
});

describe("jinja2 parser extraction", () => {
  const content = [
    "hostname={{ keycloak_hostname }}",
    "db.url={{ keycloak_db_url | default('') }}",
    "{% if keycloak_cache_stack | length > 0 %}",
    "cache.stack={{ keycloak_cache_stack }}",
    "{% endif %}",
    "literal=fixedvalue",
  ].join("\n");

  const entries: Entry[] = extractFile(content, "roles/keycloak/templates/keycloak.properties.j2");
  const by = (key: string) => entries.find((e) => e.key === key);

  it("detects .j2, delegates to the base format, and keeps line numbers", () => {
    expect(by("hostname")?.value).toBe("{{ keycloak_hostname }}");
    expect(by("hostname")?.source.line).toBe(1);
    expect(by("literal")?.value).toBe("fixedvalue");
  });

  it("records the template variable behind each {{ … }} value", () => {
    expect(by("hostname")?.source.templateVar).toBe("keycloak_hostname");
    expect(by("db.url")?.source.templateVar).toBe("keycloak_db_url");
    expect(by("literal")?.source.templateVar).toBeUndefined();
  });

  it("flags values inside a conditional block", () => {
    expect(by("cache.stack")?.source.templateVar).toBe("keycloak_cache_stack");
    expect(by("cache.stack")?.source.conditional).toBe(true);
    expect(by("hostname")?.source.conditional).toBeUndefined();
  });
});

describe("jinja2 over a brace-structured base format (nginx)", () => {
  // Jinja `{{ }}` / `{% %}` tokens collide with nginx's `{}` block scanner unless
  // they are masked before delegation — without it the `{{ … }}`-valued directives
  // were dropped and the `{% %}` lines leaked as bogus parameters.
  const tmpl = [
    "worker_processes {{ nginx_worker_processes }};",
    "events {",
    "    worker_connections {{ nginx_worker_connections }};",
    "}",
    "http {",
    "    sendfile on;",
    "    {% if nginx_gzip %}",
    "    gzip on;",
    "    {% endif %}",
    "    server {",
    "        listen {{ nginx_listen_port }} default_server;",
    "        server_name {{ nginx_server_name }};",
    "    }",
    "}",
  ].join("\n");
  const entries: Entry[] = extractFile(tmpl, "roles/nginx/templates/nginx.conf.j2");
  const by = (key: string) => entries.find((e) => e.key === key);

  it("captures directives whose value is a {{ … }} expression", () => {
    expect(by("worker_processes")?.value).toBe("{{ nginx_worker_processes }}");
    expect(by("worker_processes")?.source.templateVar).toBe("nginx_worker_processes");
    expect(by("worker_connections")?.source.templateVar).toBe("nginx_worker_connections");
    expect(by("server_name")?.source.templateVar).toBe("nginx_server_name");
    // a value with a literal tail keeps its full text; templateVar is the variable.
    expect(by("listen")?.value).toBe("{{ nginx_listen_port }} default_server");
    expect(by("listen")?.source.templateVar).toBe("nginx_listen_port");
  });

  it("keeps literal directives mapped to the template", () => {
    expect(by("sendfile")?.value).toBe("on");
    expect(by("sendfile")?.source.templateVar).toBeUndefined();
  });

  it("does not leak {% … %} control lines, and flags conditional blocks", () => {
    expect(entries.map((e) => e.key).sort()).toEqual([
      "gzip", "listen", "sendfile", "server_name", "worker_connections", "worker_processes",
    ]);
    expect(by("gzip")?.value).toBe("on");
    expect(by("gzip")?.source.conditional).toBe(true);
  });
});

// The masking lives in the shared jinja2 wrapper, so every base format benefits —
// not just nginx. Spot-check the other structured formats (httpd tags, haproxy
// sections) to lock that in.
describe("jinja2 over other structured base formats", () => {
  const byPath = (entries: Entry[], path: string) => entries.find((e) => e.source.path === path);
  const noLeak = (entries: Entry[]) =>
    entries.every((e) => !e.key.includes("%") && !e.value.includes("%}") && !e.value.includes("{%"));

  it("httpd (<Tag> containers) captures {{ }} directives and drops {% %} lines", () => {
    const httpd = [
      'ServerRoot "/etc/httpd"',
      "Listen {{ httpd_listen_port }}",
      "{% if httpd_ssl %}",
      "Listen 443",
      "{% endif %}",
      "<VirtualHost *:80>",
      "    ServerName {{ httpd_server_name }}",
      "    DocumentRoot {{ httpd_docroot }}",
      "</VirtualHost>",
    ].join("\n");
    const e = extractFile(httpd, "httpd.conf.j2");
    expect(byPath(e, "Listen[0]")?.source.templateVar).toBe("httpd_listen_port");
    expect(byPath(e, "Listen[1]")?.source.conditional).toBe(true);
    expect(byPath(e, "VirtualHost[*:80].ServerName")?.source.templateVar).toBe("httpd_server_name");
    expect(byPath(e, "VirtualHost[*:80].DocumentRoot")?.value).toBe("{{ httpd_docroot }}");
    expect(noLeak(e)).toBe(true);
  });

  it("haproxy (sections) captures {{ }} directives (incl. a literal tail) and drops {% %} lines", () => {
    const haproxy = [
      "global",
      "    maxconn {{ haproxy_maxconn }}",
      "backend app",
      "    {% if haproxy_check %}",
      "    option httpchk",
      "    {% endif %}",
      "    server web1 {{ haproxy_web1_addr }} check",
    ].join("\n");
    const e = extractFile(haproxy, "haproxy.cfg.j2");
    expect(byPath(e, "global.maxconn")?.source.templateVar).toBe("haproxy_maxconn");
    expect(byPath(e, "backend[app].option")?.source.conditional).toBe(true);
    expect(byPath(e, "backend[app].server")?.value).toBe("web1 {{ haproxy_web1_addr }} check");
    expect(byPath(e, "backend[app].server")?.source.templateVar).toBe("haproxy_web1_addr");
    expect(noLeak(e)).toBe(true);
  });
});

// A quoted string literal as the whole expression. Jinja emits the string, so
// this is exact rather than a guess — the standard the pure filters meet and
// the reason an expression like `{{ a + b }}` is still refused.
describe("substituteJinja: a string literal", () => {
  it("renders it, and does not report a line that rendered perfectly", () => {
    // The literal a template most often writes is a doubled brace it wants
    // shown LITERALLY — a comment explaining the templating. Its OUTPUT
    // therefore contains braces, and the sweep for leftover `{{ }}` used to
    // report the very braces the substitution had just produced.
    const r = substituteJinja("# {{ '{{ var }}' }} values are the reviewable ones", () => undefined);
    expect(r.text).toBe("# {{ var }} values are the reviewable ones");
    expect(r.unresolved).toEqual([]);
  });

  it("takes either quote, and leaves a real expression alone", () => {
    expect(substituteJinja('{{ "plain" }}', () => undefined).text).toBe("plain");
    const expr = substituteJinja("{{ a + b }}", () => undefined);
    expect(expr.text).toBe("{{ a + b }}");
    expect(expr.unresolved).toEqual(["{{ a + b }}"]);
  });

  it("still reports an unresolved variable beside a literal", () => {
    const r = substituteJinja("{{ 'lit' }} {{ missing }}", () => undefined);
    expect(r.text).toBe("lit {{ missing }}");
    expect(r.unresolved).toEqual(["{{ missing }}"]);
  });
});
