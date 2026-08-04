import { describe, it, expect } from "bun:test";
import { systemdIndex, systemdEdit, systemdLocate } from "../src/systemd";
import { extractFile, inferFormat } from "../src/extract";
import { computeApply } from "../src/apply";
import type { SheetData, ReviewItem } from "../src/prompt";

const unit = `[Unit]
Description=My App
After=network.target

[Service]
ExecStartPre=/usr/bin/setup
ExecStartPre=/usr/bin/check
ExecStart=/usr/bin/app --port 8080
Restart=always
`;

describe("systemd", () => {
  it("infers the format from unit extensions", () => {
    expect(inferFormat("/etc/systemd/system/app.service")).toBe("systemd");
    expect(inferFormat("/x/foo.timer")).toBe("systemd");
  });

  it("indexes sections and indexes repeated keys uniquely", () => {
    const out = systemdIndex(unit).map((e) => `${e.path}=${e.value}`);
    expect(out).toEqual([
      "Unit.Description=My App",
      "Unit.After=network.target",
      "Service.ExecStartPre[0]=/usr/bin/setup",
      "Service.ExecStartPre[1]=/usr/bin/check",
      "Service.ExecStart=/usr/bin/app --port 8080",
      "Service.Restart=always",
    ]);
  });

  it("gives repeated keys a unique param key", () => {
    const e = extractFile(unit, "/x/app.service");
    const keys = e.filter((x) => x.source.path?.startsWith("Service.ExecStartPre")).map((x) => x.key);
    expect(keys).toEqual(["ExecStartPre[0]", "ExecStartPre[1]"]);
  });

  it("edits the targeted occurrence of a repeated key", () => {
    const r = systemdEdit(unit, "Service.ExecStartPre[1]", "/usr/bin/check", "/usr/bin/verify");
    expect(r.status).toBe("applied");
    if (r.status !== "applied") return;
    expect(r.content).toContain("ExecStartPre=/usr/bin/setup"); // first untouched
    expect(r.content).toContain("ExecStartPre=/usr/bin/verify");
  });

  it("locates and detects a stale value", () => {
    expect(systemdLocate(unit, "Service.Restart")).toEqual({ value: "always" });
    expect(systemdEdit(unit, "Service.Restart", "wrong", "x").status).toBe("error");
  });

  it("apply routes systemd through the structured path", () => {
    const data: SheetData = {
      sheets: [{ name: "S", file_path: "/app.service", categories: [{ name: "C", params: [{ key: "p", value: "always", source: { path: "Service.Restart" } }] }] }],
    };
    const reviews: ReviewItem[] = [
      { id: "r", status: "pending", target: { sheet: "S", category: "C", param: "p", field: "value" }, changes: [{ field: "value", current: "always", suggested: "on-failure" }] },
    ];
    const out = computeApply(data, reviews, () => unit);
    expect(out.applied).toBe(1);
    expect(out.files[0].content).toContain("Restart=on-failure");
  });
});
