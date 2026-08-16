import { describe, it, expect } from "bun:test";
import { bindKey, makeBindSource, normalizeKey, leafKey, isBindError, loadBindSources, type BindSource, type Binding, type BindError } from "../src/bind";
import type { DictionaryDoc } from "../src/providers/dictionary";

function doc(product: string, version: string, parameters: DictionaryDoc["parameters"]): DictionaryDoc {
  return { product, version, parameters };
}

function source(product: string, version: string, parameters: DictionaryDoc["parameters"], key_prefix?: string): BindSource {
  return { binding: key_prefix ? { product, version, key_prefix } : { product, version }, doc: doc(product, version, parameters) };
}

// Shared fixture mirroring the real cases a Keycloak-on-Ansible project hits
// (see CLAUDE.md / bind.ts's own doc comment): Apache's
// httpd@2.4 dictionary (TimeOut) and a Keycloak-realm-shaped dictionary
// (camelCase realm fields + a dotted smtpServer map), bound with an SSO_
// prefix so the SSO_* env var names this project actually uses can be
// exercised end to end.
const HTTPD = source(
  "httpd",
  "2.4",
  {
    TimeOut: { description: "Request/response timeout" },
    ServerTokens: { description: "Server response header verbosity" },
  },
  "httpd_"
);

const REALM = source(
  "keycloak-realm",
  "26.7.0",
  {
    ssoSessionIdleTimeout: { description: "Idle session timeout" },
    accessTokenLifespan: { description: "Access token lifespan" },
    "smtpServer.host": { description: "SMTP host" },
    "saml.client.signature": { description: "Require signed AuthnRequests" },
    redirectUris: { description: "Allowed redirect URIs" },
  },
  "SSO_"
);

describe("normalizeKey", () => {
  it("strips _, -, . and casefolds", () => {
    expect(normalizeKey("httpd_timeout")).toBe("httpdtimeout");
    expect(normalizeKey("TimeOut")).toBe("timeout");
    expect(normalizeKey("smtpServer.host")).toBe("smtpserverhost");
    expect(normalizeKey("foo-bar")).toBe("foobar");
  });

  it("leaves other characters untouched", () => {
    expect(normalizeKey("foo/bar:baz")).toBe("foo/bar:baz");
  });
});

describe("leafKey", () => {
  it("extracts a quoted bracket key even though it contains dots", () => {
    expect(leafKey('clients[clientId=x].attributes["saml.client.signature"]')).toBe("saml.client.signature");
  });

  it("drops a trailing numeric index, keeping the segment name", () => {
    expect(leafKey("redirectUris[0]")).toBe("redirectUris");
  });

  it("drops a container label and a trailing index together", () => {
    expect(leafKey("server[main].listen[1]")).toBe("listen");
  });

  it("returns the key unchanged when it has no structure", () => {
    expect(leafKey("httpd_timeout")).toBe("httpd_timeout");
  });
});

describe("bindKey: tiers", () => {
  it("alias: dict_key resolves verbatim, taking precedence over everything else", () => {
    const result = bindKey("anything_at_all", "TimeOut", [HTTPD]) as Binding;
    expect(result.method).toBe("alias");
    expect(result.dictKey).toBe("TimeOut");
    expect(result.product).toBe("httpd");
  });

  it("exact: the raw key is a dictionary key verbatim", () => {
    const result = bindKey("TimeOut", undefined, [HTTPD]) as Binding;
    expect(result.method).toBe("exact");
    expect(result.dictKey).toBe("TimeOut");
  });

  it("prefix: key_prefix stripped, then matched verbatim", () => {
    const result = bindKey("httpd_ServerTokens", undefined, [HTTPD]) as Binding;
    expect(result.method).toBe("prefix");
    expect(result.dictKey).toBe("ServerTokens");
  });

  it("leaf: attributes[\"saml.client.signature\"] resolves via bracket-aware leaf extraction", () => {
    const result = bindKey('clients[clientId=x].attributes["saml.client.signature"]', undefined, [REALM]) as Binding;
    expect(result.method).toBe("leaf");
    expect(result.dictKey).toBe("saml.client.signature");
  });

  it("leaf: redirectUris[0] resolves to the bare redirectUris entry", () => {
    const result = bindKey("clients[clientId=poc-oidc].redirectUris[0]", undefined, [REALM]) as Binding;
    expect(result.method).toBe("leaf");
    expect(result.dictKey).toBe("redirectUris");
  });

  // The three required real-world cases from the aws-ec2/realm sheet.yml.
  it("httpd_timeout + prefix httpd_ resolves to TimeOut via normalization", () => {
    const result = bindKey("httpd_timeout", undefined, [HTTPD]) as Binding;
    expect(result.method).toBe("normalized");
    expect(result.dictKey).toBe("TimeOut");
    expect(result.product).toBe("httpd");
  });

  it("SSO_SAML_CLIENT_SIGNATURE resolves to saml.client.signature via normalization", () => {
    const result = bindKey("SSO_SAML_CLIENT_SIGNATURE", undefined, [REALM]) as Binding;
    expect(result.method).toBe("normalized");
    expect(result.dictKey).toBe("saml.client.signature");
  });

  it("SSO_ACCESS_TOKEN_LIFESPAN + prefix SSO_ resolves to accessTokenLifespan", () => {
    const result = bindKey("SSO_ACCESS_TOKEN_LIFESPAN", undefined, [REALM]) as Binding;
    expect(result.dictKey).toBe("accessTokenLifespan");
  });

  it("SSO_SESSION_IDLE_TIMEOUT resolves to ssoSessionIdleTimeout via normalization", () => {
    const result = bindKey("SSO_SESSION_IDLE_TIMEOUT", undefined, [REALM]) as Binding;
    expect(result.method).toBe("normalized");
    expect(result.dictKey).toBe("ssoSessionIdleTimeout");
  });

  // The negative case that proves normalization does not erase real
  // information: the env var elides "Server", so it must NOT resolve.
  it("SSO_SMTP_HOST does NOT match smtpServer.host — a true alias, not wiring", () => {
    const result = bindKey("SSO_SMTP_HOST", undefined, [REALM]);
    expect(result).toBeUndefined();
  });

  // ... but declaring the alias explicitly closes exactly that gap.
  it("SSO_SMTP_HOST DOES resolve once dict_key: smtpServer.host is declared", () => {
    const result = bindKey("SSO_SMTP_HOST", "smtpServer.host", [REALM]) as Binding;
    expect(result.method).toBe("alias");
    expect(result.dictKey).toBe("smtpServer.host");
  });
});

describe("bindKey: tier precedence", () => {
  it("exact beats prefix even when both would resolve", () => {
    const dual = source("nginx", "1.26", { nginx_listen: { description: "raw-key entry" }, listen: { description: "prefix entry" } }, "nginx_");
    const result = bindKey("nginx_listen", undefined, [dual]) as Binding;
    expect(result.method).toBe("exact");
    expect(result.dictKey).toBe("nginx_listen");
  });

  it("prefix beats leaf even when both would resolve", () => {
    // "httpd_TimeOut[0]" -> prefix candidate "TimeOut[0]" (no match) is a
    // distractor; use a case where the prefix-stripped form itself matches
    // verbatim while the leaf (index-stripped) form would also match.
    const dual = source("nginx", "1.26", { "listen[0]": { description: "prefix-verbatim entry" }, listen: { description: "leaf entry" } }, "nginx_");
    const result = bindKey("nginx_listen[0]", undefined, [dual]) as Binding;
    expect(result.method).toBe("prefix");
    expect(result.dictKey).toBe("listen[0]");
  });

  it("leaf beats normalized even when both would resolve", () => {
    const dual = source("x", "1", { Listen: { description: "leaf-verbatim entry" }, listen: { description: "normalized entry" } });
    const result = bindKey("server[main].Listen[1]", undefined, [dual]) as Binding;
    expect(result.method).toBe("leaf");
    expect(result.dictKey).toBe("Listen");
  });
});

describe("bindKey: cross-binding resolution", () => {
  it("searches every declared binding, not just the first", () => {
    const result = bindKey("ssoSessionIdleTimeout", undefined, [HTTPD, REALM]) as Binding;
    expect(result.product).toBe("keycloak-realm");
    expect(result.dictKey).toBe("ssoSessionIdleTimeout");
  });

  it("returns undefined when no binding's dictionary has anything at any tier", () => {
    expect(bindKey("totally_unrelated_key", undefined, [HTTPD, REALM])).toBeUndefined();
  });

  it("returns undefined when there are no bindings at all", () => {
    expect(bindKey("TimeOut", undefined, [])).toBeUndefined();
  });
});

describe("bindKey: ambiguity", () => {
  it("errors when two dictionary keys normalize to the same form", () => {
    const collide = source("x", "1", {
      "foo-bar": { description: "kebab spelling" },
      FooBar: { description: "PascalCase spelling" },
    });
    const result = bindKey("foo_bar", undefined, [collide]);
    expect(isBindError(result)).toBe(true);
    const err = result as BindError;
    expect(err.method).toBe("normalized");
    expect(err.matches).toHaveLength(2);
    expect(err.matches.map((m) => m.dictKey).sort()).toEqual(["FooBar", "foo-bar"]);
    expect(err.message).toContain("ambiguous normalized match");
  });

  it("errors when two DIFFERENT bindings both hold an exact match for the same key", () => {
    const a = source("prodA", "1", { shared_key: { description: "from A" } });
    const b = source("prodB", "1", { shared_key: { description: "from B" } });
    const result = bindKey("shared_key", undefined, [a, b]);
    expect(isBindError(result)).toBe(true);
    const err = result as BindError;
    expect(err.method).toBe("exact");
    expect(err.matches.map((m) => m.product).sort()).toEqual(["prodA", "prodB"]);
  });

  it("does not report ambiguity when the same binding appears twice and resolves to the identical entry", () => {
    // Two hits at the same tier, but both are "httpd@2.4:TimeOut" — the
    // SAME answer reached twice (e.g. an accidentally duplicated
    // `dictionaries:` entry), not two DIFFERENT answers. dedupeHits collapses
    // this before judging tier-uniqueness.
    const result = bindKey("TimeOut", undefined, [HTTPD, HTTPD]) as Binding;
    expect(isBindError(result)).toBe(false);
    expect(result.dictKey).toBe("TimeOut");
  });
});

describe("bindKey: dict_key severance", () => {
  it("dict_key: null cuts the binding even though the raw key would otherwise match exactly", () => {
    const result = bindKey("TimeOut", null, [HTTPD]);
    expect(result).toBeUndefined();
  });

  it("dict_key: null cuts the binding even across multiple sources", () => {
    const result = bindKey("ssoSessionIdleTimeout", null, [HTTPD, REALM]);
    expect(result).toBeUndefined();
  });
});

describe("bindKey: kind: container entries", () => {
  it("resolves a container entry like any other — bindKey does not filter by kind", () => {
    const withContainer = source("httpd", "2.4", {
      IfModule: { description: "Conditional module block", kind: "container" },
    });
    const result = bindKey("IfModule", undefined, [withContainer]) as Binding;
    expect(result.entry.kind).toBe("container");
    expect(result.entry.description).toBe("Conditional module block");
  });
});

// loadBindSources: the one I/O loader that turns a project's declared
// `dictionaries:` bindings into the BindSources bindKey() resolves against
// (shared by assemble.ts and enrich.ts's standalone bind pass — see bind.ts).
describe("loadBindSources", () => {
  const NGINX_DICT = `
product: nginx
version: "1.26"
parameters:
  listen:
    description: Listen port
`;
  const files: Record<string, string> = { "dir1/nginx@1.26.yml": NGINX_DICT };
  const readFile = (p: string): string | null => files[p] ?? null;

  it("searches metadataDirs in order, first hit wins", () => {
    const sources = loadBindSources([{ product: "nginx", version: "1.26" }], ["dirX", "dir1"], readFile);
    expect(sources).toHaveLength(1);
    expect(sources[0].doc.parameters.listen.description).toBe("Listen port");
  });

  it("throws when a bound dictionary file is found nowhere", () => {
    expect(() => loadBindSources([{ product: "missing", version: "1.0" }], ["dirA", "dirB"], readFile)).toThrow(
      "bind: dictionary not found: missing@1.0 (searched: dirA, dirB)"
    );
  });

  it("returns one BindSource per declared dictionary, preserving order", () => {
    const files2: Record<string, string> = {
      "dir1/nginx@1.26.yml": NGINX_DICT,
      "dir1/httpd@2.4.yml": `product: httpd\nversion: "2.4"\nparameters:\n  ServerRoot:\n    default: /etc/httpd\n`,
    };
    const sources = loadBindSources(
      [
        { product: "nginx", version: "1.26" },
        { product: "httpd", version: "2.4" },
      ],
      ["dir1"],
      (p) => files2[p] ?? null
    );
    expect(sources.map((s) => s.binding.product)).toEqual(["nginx", "httpd"]);
  });
});

// bindKey() carries Binding.docProvenance through verbatim — it never
// interprets it (see bind.ts's Binding doc comment); the dictionary provider
// is the one place it gets resolved per language (providers/dictionary.ts's
// provenanceFor). This is the type-only widening from Provenance to
// LangProvenance actually exercised end to end, with a real doc-level map.
describe("bindKey: docProvenance carries a LangProvenance map through unchanged", () => {
  it("a per-language doc-level provenance map survives bindKey() verbatim", () => {
    const withMap: BindSource = {
      binding: { product: "nginx", version: "1.26" },
      doc: { product: "nginx", version: "1.26", provenance: { en: "official", ja: "community" }, parameters: { listen: { description: "Listen port" } } },
    };
    const result = bindKey("listen", undefined, [withMap]) as Binding;
    expect(result.docProvenance).toEqual({ en: "official", ja: "community" });
  });

  it("a scalar doc-level provenance still survives bindKey() verbatim (regression)", () => {
    const withScalar: BindSource = {
      binding: { product: "postgresql", version: "16" },
      doc: { product: "postgresql", version: "16", provenance: "extracted", parameters: { work_mem: { description: "Sort/hash memory" } } },
    };
    const result = bindKey("work_mem", undefined, [withScalar]) as Binding;
    expect(result.docProvenance).toBe("extracted");
  });
});

describe("isBindError", () => {
  it("distinguishes a Binding from a BindError from undefined", () => {
    const binding = bindKey("TimeOut", undefined, [HTTPD]);
    const error = bindKey("foo_bar", undefined, [
      source("x", "1", { "foo-bar": {}, FooBar: {} }),
    ]);
    const none = bindKey("nope", undefined, [HTTPD]);

    expect(isBindError(binding)).toBe(false);
    expect(isBindError(error)).toBe(true);
    expect(isBindError(none)).toBe(false);
  });
});

// The `derived` tier: a declarative rewrite from the ROW key to the dictionary
// key, for the case `key_prefix` cannot express — the row's identity is richer
// than the dictionary's and the surplus is in the MIDDLE, not the front.
//
// The motivating shape is a Terraform plan. Two ALB listeners are two rows
// (`aws_lb_listener.https.ssl_policy`, `aws_lb_listener.http_redirect.ssl_policy`)
// because they are two real resources, while the AWS provider documents one
// `aws_lb_listener.ssl_policy`. Without this tier neither binds: `exact` and
// `prefix` miss, and `leafKey` returns the bare `ssl_policy`, which is not a
// key of a dictionary keyed by resource type.
describe("bindKey: derived tier", () => {
  const AWS_PARAMS: DictionaryDoc["parameters"] = {
    "aws_lb_listener.ssl_policy": { description: "TLS policy" },
    "aws_lb.idle_timeout": { description: "Idle timeout" },
    ssl_policy: { description: "A bare leaf entry, deliberately also present" },
  };
  // Strip the resource INSTANCE out of the middle: aws_<type>.<instance>.<arg>
  // -> aws_<type>.<arg>. Anchored front-to-back, so a key that is not of this
  // shape drops out of the tier rather than getting a mangled rewrite.
  const STEPS = [{ pattern: "^(aws_[a-z0-9_]+)\\.[^.]+\\.(.+)$", replace: "$1.$2", on_no_match: "drop" as const }];

  function awsSource(): BindSource {
    return makeBindSource({ product: "aws", version: "5.100.0", key_steps: STEPS }, doc("aws", "5.100.0", AWS_PARAMS));
  }

  it("binds a row whose key carries a resource instance the dictionary does not", () => {
    const r = bindKey("aws_lb_listener.https.ssl_policy", undefined, [awsSource()]) as Binding;
    expect(r.method).toBe("derived");
    expect(r.dictKey).toBe("aws_lb_listener.ssl_policy");
  });

  it("binds two different instances of one resource type to the same entry", () => {
    const a = bindKey("aws_lb_listener.https.ssl_policy", undefined, [awsSource()]) as Binding;
    const b = bindKey("aws_lb_listener.http_redirect.ssl_policy", undefined, [awsSource()]) as Binding;
    expect(a.dictKey).toBe(b.dictKey);
    expect(b.method).toBe("derived");
  });

  it("does not outrank an exact match", () => {
    // `aws_lb.idle_timeout` IS a dictionary key verbatim, and the rewrite
    // does not apply to it (two segments, no instance in the middle). The
    // assertion that matters is the METHOD: a two-segment row must report as
    // `exact`, so the report never credits `derived` for a bind the rewrite
    // had no part in.
    const r = bindKey("aws_lb.idle_timeout", undefined, [awsSource()]) as Binding;
    expect(r.method).toBe("exact");
    expect(r.dictKey).toBe("aws_lb.idle_timeout");
  });

  it("is tried before leaf, so a bare-leaf entry cannot steal a qualified row", () => {
    // `ssl_policy` exists in this dictionary too. The row means the listener's
    // ssl_policy, and `derived` running first is what says so.
    const r = bindKey("aws_lb_listener.https.ssl_policy", undefined, [awsSource()]) as Binding;
    expect(r.dictKey).toBe("aws_lb_listener.ssl_policy");
  });

  it("drops out of the tier when the pattern does not match, instead of mangling the key", () => {
    // No instance segment: the rewrite cannot apply. `something.ssl_policy`
    // must not silently become a hit on aws_lb_listener.ssl_policy.
    const r = bindKey("something.ssl_policy", undefined, [awsSource()]);
    expect(isBindError(r)).toBe(false);
    expect((r as Binding | undefined)?.dictKey).toBe("ssl_policy"); // via the leaf tier, correctly
  });

  it("reports a rewrite that never matched any key, rather than tolerating it", () => {
    const src = makeBindSource(
      { product: "aws", version: "5.100.0", key_steps: [{ pattern: "^never_matches\\.(.+)$", replace: "$1", on_no_match: "drop" }] },
      doc("aws", "5.100.0", AWS_PARAMS)
    );
    bindKey("aws_lb.idle_timeout", undefined, [src]);
    expect(src.keyTransformer?.unmatchedDropPatterns()).toEqual(["^never_matches\\.(.+)$"]);
  });

  it("has no transformer at all when the binding declares no key_steps", () => {
    const src = makeBindSource({ product: "aws", version: "5.100.0" }, doc("aws", "5.100.0", AWS_PARAMS));
    expect(src.keyTransformer).toBeUndefined();
    expect(bindKey("aws_lb_listener.https.ssl_policy", undefined, [src])?.method).toBe("leaf");
  });
});
