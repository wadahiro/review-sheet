import { describe, it, expect } from "bun:test";
import { haproxyIndex, isHaproxy } from "../src/haproxy";
import { extractFile } from "../src/extract";
import { computeApply } from "../src/apply";
import { verifySources } from "../src/verify";
import type { SheetData, ReviewItem } from "../src/prompt";

const cfg = `global
    maxconn 4096

frontend http-in
    bind *:80
    bind *:443 ssl
    default_backend app

backend app
    balance roundrobin
    server web1 10.0.0.1:8080 check
    server web2 10.0.0.2:8080 check
`;

describe("haproxy", () => {
  it("detects haproxy configs", () => {
    expect(isHaproxy("/etc/haproxy/haproxy.cfg", "")).toBe(true);
    expect(isHaproxy("/x.cfg", "frontend http-in\n  bind *:80")).toBe(true);
    expect(isHaproxy("/x.ini", "[section]\nkey=1")).toBe(false);
  });

  it("indexes named sections and identifies repeated directives by first arg", () => {
    const out = haproxyIndex(cfg).map((e) => `${e.path}=${e.value}`);
    expect(out).toEqual([
      "global.maxconn=4096",
      "frontend[http-in].bind[*:80]=*:80",
      "frontend[http-in].bind[*:443]=*:443 ssl",
      "frontend[http-in].default_backend=app",
      "backend[app].balance=roundrobin",
      "backend[app].server[web1]=web1 10.0.0.1:8080 check",
      "backend[app].server[web2]=web2 10.0.0.2:8080 check",
    ]);
  });

  it("extract auto-detects + apply/verify hit the right server after a reorder", () => {
    expect(extractFile(cfg, "/x.cfg").find((x) => x.source.path === "backend[app].server[web2]")).toBeTruthy();

    const reordered = `backend app\n  server web2 10.0.0.2:8080 check\n  server web1 10.0.0.1:8080 check\n`;
    const data: SheetData = { sheets: [{ name: "S", file_path: "/x.cfg", categories: [{ name: "C", params: [{ key: "p", value: "web1 10.0.0.1:8080 check", source: { path: "backend[app].server[web1]" } }] }] }] };
    const reviews: ReviewItem[] = [{ id: "r", status: "pending", target: { sheet: "S", category: "C", param: "p", field: "value" }, changes: [{ field: "value", current: "web1 10.0.0.1:8080 check", suggested: "web1 10.0.0.9:8080 check" }] }];
    const out = computeApply(data, reviews, () => reordered);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("server web1 10.0.0.9:8080 check");
    expect(out.files[0].content).toContain("server web2 10.0.0.2:8080 check"); // untouched
    expect(verifySources(data, () => reordered).ok).toBe(1);
  });
});
