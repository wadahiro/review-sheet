import { describe, it, expect } from "bun:test";
import { httpdIndex, httpdEdit, isHttpd } from "../src/httpd";
import { extractFile } from "../src/extract";
import { computeApply } from "../src/apply";
import { verifySources } from "../src/verify";
import type { SheetData, ReviewItem } from "../src/prompt";

const conf = `Listen 80
<VirtualHost *:80>
    ServerName a.example.com
    DocumentRoot /var/www/a
</VirtualHost>
<VirtualHost *:443>
    ServerName b.example.com
    DocumentRoot /var/www/b
    <Directory /var/www/b>
        Require all granted
    </Directory>
</VirtualHost>`;

describe("httpd (Apache)", () => {
  it("detects httpd configs", () => {
    expect(isHttpd("/etc/httpd/httpd.conf", "")).toBe(true);
    expect(isHttpd("/sites/x.conf", "<VirtualHost *:80>\n</VirtualHost>")).toBe(true);
    expect(isHttpd("/etc/sysctl.conf", "a = 1")).toBe(false);
  });

  // P10 bug 3: conf.d/*.conf (the RHEL httpd layout) is a directive-only
  // fragment with no <Tag> block at all — the ORIGINAL isHttpd, requiring
  // either a known filename or a <Tag> block, never matched this, so it fell
  // through to the generic sysctl parser (which found nothing, since none of
  // these lines use `=`) and silently contributed zero rows.
  describe("conf.d/*.conf detection (content, no <Tag> block)", () => {
    const proxyConf = "ProxyRequests Off\nProxyPreserveHost On\nProxyPass /app http://localhost:8080/app\nProxyPassReverse /app http://localhost:8080/app\nProxyTimeout 300\n";

    it("detects a directive-only .conf fragment as httpd", () => {
      expect(isHttpd("/etc/httpd/conf.d/proxy.conf", proxyConf)).toBe(true);
    });

    it("still requires .conf (or a known filename/<Tag>) — an extensionless directive-only file is unaffected", () => {
      expect(isHttpd("/etc/httpd/conf.d/proxy", proxyConf)).toBe(false);
    });

    it("does not misfire on a sysctl-style .conf (key = value, no CamelCase directives)", () => {
      expect(isHttpd("/etc/sysctl.d/99-net.conf", "net.core.somaxconn = 128\nnet.ipv4.ip_forward = 1\n")).toBe(false);
    });

    it("does not misfire on an ini-style .conf ([section] + key = value)", () => {
      expect(isHttpd("/etc/app/app.conf", "[Database]\nHost = localhost\nPort = 5432\n")).toBe(false);
    });

    it("does not misfire on one incidental CamelCase-looking value inside an otherwise sysctl-style file", () => {
      // A value line ("DefaultBackend = someHost") could coincidentally start
      // with a capital letter; a single such line must not be enough to flip
      // the whole file to httpd — directive-shaped lines must OUTNUMBER
      // assignment-shaped ones.
      const mostlyAssignments = "net.core.somaxconn = 128\nnet.ipv4.ip_forward = 1\nDefaultBackend = someHost\n";
      expect(isHttpd("/etc/sysctl.d/mixed.conf", mostlyAssignments)).toBe(false);
    });

    it("extract auto-detects the fragment and produces real rows", () => {
      const e = extractFile(proxyConf, "/etc/httpd/conf.d/proxy.conf");
      expect(e.map((x) => `${x.key}=${x.value}`)).toEqual([
        "ProxyRequests=Off",
        "ProxyPreserveHost=On",
        "ProxyPass=/app http://localhost:8080/app",
        "ProxyPassReverse=/app http://localhost:8080/app",
        "ProxyTimeout=300",
      ]);
    });
  });

  it("indexes directives and containers by label", () => {
    const out = httpdIndex(conf).map((e) => `${e.path}=${e.value}`);
    expect(out).toEqual([
      "Listen=80",
      "VirtualHost[*:80].ServerName=a.example.com",
      "VirtualHost[*:80].DocumentRoot=/var/www/a",
      "VirtualHost[*:443].ServerName=b.example.com",
      "VirtualHost[*:443].DocumentRoot=/var/www/b",
      "VirtualHost[*:443].Directory[/var/www/b].Require=all granted",
    ]);
  });

  it("extract auto-detects + apply/verify hit the right vhost after a reorder", () => {
    const e = extractFile(conf, "/sites/x.conf");
    expect(e.find((x) => x.source.path === "VirtualHost[*:443].DocumentRoot")).toBeTruthy();

    const reordered = `<VirtualHost *:443>\n  DocumentRoot /var/www/b\n</VirtualHost>\n<VirtualHost *:80>\n  DocumentRoot /var/www/a\n</VirtualHost>`;
    const data: SheetData = { sheets: [{ name: "S", file_path: "/sites/x.conf", categories: [{ name: "C", params: [{ key: "p", value: "/var/www/a", source: { path: "VirtualHost[*:80].DocumentRoot" } }] }] }] };
    const reviews: ReviewItem[] = [{ id: "r", status: "pending", target: { sheet: "S", category: "C", param: "p", field: "value" }, changes: [{ field: "value", current: "/var/www/a", suggested: "/srv/a" }] }];
    const out = computeApply(data, reviews, () => reordered);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("<VirtualHost *:80>\n  DocumentRoot /srv/a");
    expect(verifySources(data, () => reordered).ok).toBe(1);
  });

  it("edits a directive value and is stale-safe", () => {
    const r = httpdEdit(conf, "Listen", "80", "8080");
    expect(r.status).toBe("applied");
    expect(httpdEdit(conf, "Listen", "x", "9").status).toBe("error");
  });

  describe("conditional containers (If/ElseIf/Else, IfModule, Limit, ...)", () => {
    const cond = `<VirtualHost *:443>
    DocumentRoot /var/www/secure
    <If "%{HTTP_HOST} == 'admin.example.com'">
        Require ip 10.0.0.0/8
        Header set X-Admin "yes"
    </If>
    <ElseIf "%{HTTP_HOST} == 'staging.example.com'">
        Header set X-Staging "yes"
    </ElseIf>
    <Else>
        Header set X-Default "yes"
    </Else>
    <IfModule mod_ssl.c>
        SSLEngine on
    </IfModule>
    <Limit GET POST>
        Require all granted
    </Limit>
</VirtualHost>`;

    it("extracts the expression as its own row, positionally addressed, and does not disturb no-argument containers", () => {
      const out = httpdIndex(cond).map((e) => `${e.path}=${e.value}`);
      expect(out).toEqual([
        "VirtualHost[*:443].DocumentRoot=/var/www/secure",
        "VirtualHost[*:443].If=\"%{HTTP_HOST} == 'admin.example.com'\"",
        "VirtualHost[*:443].If.Require=ip 10.0.0.0/8",
        "VirtualHost[*:443].If.Header=set X-Admin \"yes\"",
        "VirtualHost[*:443].ElseIf=\"%{HTTP_HOST} == 'staging.example.com'\"",
        "VirtualHost[*:443].ElseIf.Header=set X-Staging \"yes\"",
        // <Else> takes no expression, so no synthetic row for it — only its
        // (unindexed, since it's the only Else) children.
        "VirtualHost[*:443].Else.Header=set X-Default \"yes\"",
        "VirtualHost[*:443].IfModule=mod_ssl.c",
        "VirtualHost[*:443].IfModule.SSLEngine=on",
        "VirtualHost[*:443].Limit=GET POST",
        "VirtualHost[*:443].Limit.Require=all granted",
      ]);
    });

    it("verify resolves the condition row's source", () => {
      const data: SheetData = {
        sheets: [{
          name: "S", file_path: "/sites/x.conf",
          categories: [{ name: "C", params: [{ key: "If", value: "\"%{HTTP_HOST} == 'admin.example.com'\"", source: { path: "VirtualHost[*:443].If" } }] }],
        }],
      };
      expect(verifySources(data, () => cond).ok).toBe(1);
    });

    it("apply rewrites the condition expression in place", () => {
      const data: SheetData = {
        sheets: [{
          name: "S", file_path: "/sites/x.conf",
          categories: [{ name: "C", params: [{ key: "If", value: "\"%{HTTP_HOST} == 'admin.example.com'\"", source: { path: "VirtualHost[*:443].If" } }] }],
        }],
      };
      const reviews: ReviewItem[] = [{
        id: "r", status: "pending",
        target: { sheet: "S", category: "C", param: "If", field: "value" },
        changes: [{ field: "value", current: "\"%{HTTP_HOST} == 'admin.example.com'\"", suggested: "\"%{HTTP_HOST} == 'admin2.example.com'\"" }],
      }];
      const out = computeApply(data, reviews, () => cond);
      expect(out.applied).toBe(1);
      expect(out.files[0].content).toContain("<If \"%{HTTP_HOST} == 'admin2.example.com'\">");
      // The rewritten file verifies clean against the post-review value.
      const updated: SheetData = {
        sheets: [{ ...data.sheets[0], categories: [{ name: "C", params: [{ key: "If", value: "\"%{HTTP_HOST} == 'admin2.example.com'\"", source: { path: "VirtualHost[*:443].If" } }] }] }],
      };
      expect(verifySources(updated, () => out.files[0].content).error).toBe(0);
      expect(verifySources(updated, () => out.files[0].content).ok).toBe(1);
    });

    it("editing the condition leaves the nested directives' paths unchanged", () => {
      const before = httpdIndex(cond).find((e) => e.path === "VirtualHost[*:443].If.Require");
      expect(before?.value).toBe("ip 10.0.0.0/8");

      const r = httpdEdit(cond, "VirtualHost[*:443].If", "\"%{HTTP_HOST} == 'admin.example.com'\"", "\"%{HTTP_HOST} == 'totally-different.example.com'\"");
      expect(r.status).toBe("applied");
      if (r.status !== "applied") return;

      const after = httpdIndex(r.content).find((e) => e.path === "VirtualHost[*:443].If.Require");
      expect(after?.value).toBe("ip 10.0.0.0/8");
      expect(after?.path).toBe("VirtualHost[*:443].If.Require"); // unchanged despite the condition text changing
    });
  });
});
