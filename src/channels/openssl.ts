// What `openssl s_client` says about a certificate.
//
// Two things, and both are openssl's knowledge rather than one project's: the
// DATE FORMAT it prints (`notAfter=Jun  1 12:00:00 2027 GMT`, which is not any
// of the formats a config file carries), and the several different sentences it
// produces when there is no certificate to report at all — a refused
// connection, a name that does not resolve, a handshake that ended with no peer
// certificate. Telling those two apart is the whole point: a host that cannot
// REACH the public endpoint has not found an expired certificate, and answering
// "fail" there is a finding nobody can act on.
//
// WHAT IS NOT HERE is how long is long enough. That is a policy — a project
// decides how much warning it wants — and a threshold baked in here would be
// this tool deciding it for every project at once.

// The sentences openssl produces INSTEAD of a certificate. Matched as a set
// because they come from three different layers (the resolver, the socket, the
// TLS library) and a project meets whichever its network produces.
const NO_CERTIFICATE = /no peer certificate|Connection refused|unable to|Name or service not known|gethostby/i;

// Why there is no certificate to judge, in openssl's own words — the first line
// of its complaint, which is the part that names the cause.
export function handshakeFailure(text: string | null | undefined): string | undefined {
  if (typeof text !== "string" || !NO_CERTIFICATE.test(text)) return undefined;
  return text.split("\n")[0]!.slice(0, 120);
}

// The certificate's expiry, exactly as openssl printed it. Kept as the text it
// wrote rather than a date, because it is what a record quotes.
export function certNotAfter(text: string | null | undefined): string | undefined {
  return /notAfter=(.+)/.exec(text ?? "")?.[1]?.trim();
}

// …and as a moment, which is the other half openssl's format is needed for.
// `Date.parse` reads it; a project should not have to know that it does.
export function certExpiry(text: string | null | undefined): Date | undefined {
  const printed = certNotAfter(text);
  if (printed === undefined) return undefined;
  const at = Date.parse(printed);
  return Number.isNaN(at) ? undefined : new Date(at);
}
