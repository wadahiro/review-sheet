import { describe, it, expect } from "bun:test";
import { nginxIndex, nginxEdit, nginxLocate, isNginx } from "../src/nginx";
import { extractFile } from "../src/extract";
import { computeApply } from "../src/apply";
import { verifySources } from "../src/verify";
import type { SheetData, ReviewItem } from "../src/prompt";

const conf = `worker_processes 4;
http {
    upstream backend {
        server 10.0.0.1:8080;
        server 10.0.0.2:8080;
    }
    server {
        listen 80;
        listen 443 ssl;
        location /api {
            proxy_pass http://backend;
        }
        location /static {
            root /var/www;
        }
    }
}`;

describe("nginx", () => {
  it("detects nginx by name or block syntax", () => {
    expect(isNginx("/etc/nginx/nginx.conf", "")).toBe(true);
    expect(isNginx("/sites/app.conf", "server {\n  listen 80;\n}")).toBe(true);
    expect(isNginx("/etc/sysctl.conf", "net.core.somaxconn = 128")).toBe(false);
  });

  it("indexes directives, labeled blocks, and repeats", () => {
    const out = nginxIndex(conf).map((e) => `${e.path}=${e.value}`);
    expect(out).toEqual([
      "worker_processes=4",
      "http.upstream[backend].server[0]=10.0.0.1:8080",
      "http.upstream[backend].server[1]=10.0.0.2:8080",
      "http.server.listen[0]=80",
      "http.server.listen[1]=443 ssl",
      "http.server.location[/api].proxy_pass=http://backend",
      "http.server.location[/static].root=/var/www",
    ]);
  });

  it("extractFile auto-detects an nginx .conf by content", () => {
    const e = extractFile(conf, "/sites/app.conf");
    expect(e.find((x) => x.source.path === "http.server.location[/api].proxy_pass")).toMatchObject({ key: "proxy_pass", value: "http://backend" });
  });

  it("edits a labeled location's directive and a repeated directive occurrence", () => {
    const r = nginxEdit(conf, "http.server.location[/api].proxy_pass", "http://backend", "http://new");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("proxy_pass http://new;");

    const r2 = nginxEdit(conf, "http.server.listen[1]", "443 ssl", "8443 ssl");
    expect(r2.status).toBe("applied");
    if (r2.status !== "applied") return;
    expect(r2.content).toContain("listen 80;"); // first untouched
    expect(r2.content).toContain("listen 8443 ssl;");
  });

  it("locates by path", () => {
    expect(nginxLocate(conf, "http.server.location[/static].root")).toEqual({ value: "/var/www" });
  });

  it("apply/verify hit the right location by label after a reorder", () => {
    const reordered = `http {\n  server {\n    location /static { root /var/www; }\n    location /api { proxy_pass http://backend; }\n  }\n}`;
    const data: SheetData = {
      sheets: [{ name: "S", file_path: "/sites/app.conf", categories: [{ name: "C", params: [{ key: "p", value: "http://backend", source: { path: "http.server.location[/api].proxy_pass" } }] }] }],
    };
    const reviews: ReviewItem[] = [
      { id: "r", status: "pending", target: { sheet: "S", category: "C", param: "p", field: "value" }, changes: [{ field: "value", current: "http://backend", suggested: "http://new" }] },
    ];
    const out = computeApply(data, reviews, () => reordered);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("location /api { proxy_pass http://new; }");
    expect(verifySources(data, () => reordered).ok).toBe(1);
  });

  describe("if (...) conditional blocks", () => {
    const cond = `server {
    location /api {
        if ($http_user_agent ~ MSIE) {
            rewrite ^ /msie.html break;
        }
        if ($request_method = POST) {
            return 405;
        }
        proxy_pass http://backend;
    }
}`;

    it("extracts the condition as its own row, positionally addressed", () => {
      const out = nginxIndex(cond).map((e) => `${e.path}=${e.value}`);
      expect(out).toEqual([
        "server.location[/api].proxy_pass=http://backend",
        "server.location[/api].if[0]=($http_user_agent ~ MSIE)",
        "server.location[/api].if[0].rewrite=^ /msie.html break",
        "server.location[/api].if[1]=($request_method = POST)",
        "server.location[/api].if[1].return=405",
      ]);
    });

    it("verify resolves the condition row's source", () => {
      const data: SheetData = {
        sheets: [{
          name: "S", file_path: "/sites/app.conf",
          categories: [{ name: "C", params: [{ key: "if", value: "($http_user_agent ~ MSIE)", source: { path: "server.location[/api].if[0]" } }] }],
        }],
      };
      expect(verifySources(data, () => cond).ok).toBe(1);
    });

    it("apply rewrites the condition expression in place", () => {
      const data: SheetData = {
        sheets: [{
          name: "S", file_path: "/sites/app.conf",
          categories: [{ name: "C", params: [{ key: "if", value: "($http_user_agent ~ MSIE)", source: { path: "server.location[/api].if[0]" } }] }],
        }],
      };
      const reviews: ReviewItem[] = [{
        id: "r", status: "pending",
        target: { sheet: "S", category: "C", param: "if", field: "value" },
        changes: [{ field: "value", current: "($http_user_agent ~ MSIE)", suggested: "($http_user_agent ~ Trident)" }],
      }];
      const out = computeApply(data, reviews, () => cond);
      expect(out.applied).toBe(1);
      expect(out.files[0].content).toContain("if ($http_user_agent ~ Trident) {");
    });

    it("editing the condition leaves the nested directive's path unchanged", () => {
      const r = nginxEdit(cond, "server.location[/api].if[0]", "($http_user_agent ~ MSIE)", "($http_user_agent ~ totally-different)");
      expect(r.status).toBe("applied");
      if (r.status !== "applied") return;

      const after = nginxIndex(r.content).find((e) => e.path === "server.location[/api].if[0].rewrite");
      expect(after?.value).toBe("^ /msie.html break");
      expect(after?.path).toBe("server.location[/api].if[0].rewrite"); // unchanged
    });
  });
});
