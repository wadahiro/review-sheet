// What `docker inspect` says an image or a container is.
//
// The counterpart of a Dockerfile: the file says what THIS build decided, and
// the inspection says what the thing actually carries — including everything
// the base image already had. Judging one against the other is how a container
// project answers "is the image what the design says", and it needs three
// pieces of the format's own shape, none of which a project should be
// re-deriving:
//
//   the reply is an ARRAY, of one element per name asked about;
//   `Config.Env` is an ARRAY OF `K=V` STRINGS, not an object — so `KC_DB` is
//   not at an address any structural path reaches until it is turned into one;
//   `ExposedPorts` is an object whose KEYS carry the value (`8080/tcp`), and
//   Entrypoint/Cmd are arrays.
//
// The same shape answers for a running container, which is why this is not
// called "image": `docker inspect <container>` returns the same `Config`, with
// what the run added on top.

export type Inspected = {
  Config?: {
    Env?: string[];
    ExposedPorts?: Record<string, unknown>;
    Labels?: Record<string, string>;
    Entrypoint?: string[];
    Cmd?: string[];
    User?: string;
    WorkingDir?: string;
    Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number };
  };
};

// The one element, where a reply carries exactly one. More than one means the
// caller asked about more than one thing and has to say which — answering from
// the first would be a verdict about whichever it happened to list first.
export function inspected(text: string | null | undefined): Inspected | undefined {
  if (typeof text !== "string" || text.trim() === "") return undefined;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(body) || body.length !== 1) return undefined;
  return body[0] as Inspected;
}

// `Config.Env` as the map a sheet's rows are named by. An entry with no `=` is
// left out rather than read as an empty value: the runtime writes `K=V`, and
// anything else is not a variable this can name.
export function env(one: Inspected | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of one?.Config?.Env ?? []) {
    const at = line.indexOf("=");
    if (at > 0) out.set(line.slice(0, at), line.slice(at + 1));
  }
  return out;
}

// The ports, as the numbers a design states — the keys carry `8080/tcp`, and a
// sheet says 8080.
export function exposedPorts(one: Inspected | undefined): Set<string> {
  return new Set(Object.keys(one?.Config?.ExposedPorts ?? {}).map((k) => k.split("/")[0]!));
}

// …and the rest of what a Dockerfile can decide, under the names that file
// uses, so a row keyed by the instruction reaches its own value.
export function settings(one: Inspected | undefined): Map<string, string> {
  const c = one?.Config;
  const out = new Map<string, string>();
  if (c === undefined) return out;
  if (typeof c.User === "string" && c.User !== "") out.set("user", c.User);
  if (typeof c.WorkingDir === "string" && c.WorkingDir !== "") out.set("workdir", c.WorkingDir);
  if (Array.isArray(c.Entrypoint)) out.set("entrypoint", JSON.stringify(c.Entrypoint));
  if (Array.isArray(c.Cmd)) out.set("cmd", JSON.stringify(c.Cmd));
  for (const [k, v] of Object.entries(c.Labels ?? {})) out.set(k, v);
  return out;
}
