// What `docker inspect` says a thing is — the format's own shape, which a
// Dockerfile's rows have to be judged against.

import { describe, it, expect } from "bun:test";
import { inspected, env, exposedPorts, settings } from "../src/channels/docker";

// The shape a real reply has, trimmed to what is read here.
const REPLY = JSON.stringify([
  {
    Id: "sha256:abc",
    Config: {
      Env: ["PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", "APP_DB=postgres", "NOT_A_PAIR"],
      ExposedPorts: { "8080/tcp": {}, "9000/tcp": {} },
      Labels: { "org.opencontainers.image.title": "Example" },
      Entrypoint: ["/opt/app/bin/run"],
      User: "1000",
      WorkingDir: "/opt/app",
    },
  },
]);

describe("what docker inspect says", () => {
  // The reply is an ARRAY. One element is one thing asked about; more than one
  // means the caller asked about several and has to say which — answering from
  // the first would be a verdict about whichever it happened to list first.
  it("reads the one element, and refuses a reply that is not one", () => {
    expect(inspected(REPLY)).toBeDefined();
    expect(inspected("[]")).toBeUndefined();
    expect(inspected(JSON.stringify([{ Id: "a" }, { Id: "b" }]))).toBeUndefined();
    expect(inspected("not json")).toBeUndefined();
    expect(inspected("")).toBeUndefined();
  });

  // `Env` is an ARRAY OF `K=V` STRINGS, so a row named `APP_DB` is at no
  // address any structural path reaches until it is turned into one.
  it("turns the environment array into the names a sheet's rows carry", () => {
    const e = env(inspected(REPLY));
    expect(e.get("APP_DB")).toBe("postgres");
    expect(e.get("PATH")).toBe("/usr/bin:/bin");
    // An entry with no `=` is not a variable this can name, and an empty value
    // would be a claim about something that is not there.
    expect(e.has("NOT_A_PAIR")).toBe(false);
  });

  // The KEYS carry the value (`8080/tcp`), and a design says 8080.
  it("reads the ports as the numbers a design states", () => {
    expect([...exposedPorts(inspected(REPLY))].sort()).toEqual(["8080", "9000"]);
    expect(exposedPorts(inspected(JSON.stringify([{ Config: {} }]))).size).toBe(0);
  });

  // …and the rest under the names the Dockerfile uses, so a row keyed by the
  // instruction reaches its own value.
  it("answers the other instructions under their own names", () => {
    const s = settings(inspected(REPLY));
    expect(s.get("user")).toBe("1000");
    expect(s.get("workdir")).toBe("/opt/app");
    expect(s.get("entrypoint")).toBe('["/opt/app/bin/run"]');
    expect(s.get("org.opencontainers.image.title")).toBe("Example");
    // A `CMD` the image does not carry is absent, not an empty string.
    expect(s.has("cmd")).toBe(false);
  });
});
