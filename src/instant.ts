// A recorded instant, as a reader in one zone meets it.
//
// Its own module because two halves of one document need the same answer: the
// unit-test record prints when a run happened, and the evidence panel prints
// when a host was read. One saying 08:42Z while the other says 17:42+09:00 is
// one document disagreeing with itself about a single moment.
//
// Resolved at GENERATION, never in the browser, for the reason `localize.ts`
// gives for prose: a document has one reader, and deciding once means nothing
// downstream has to carry the question.

// An instant, with the offset — always.
//
// A local time with no offset is the one thing worse than UTC here: a record
// that says "17:42" and nothing else cannot be lined up with a log on the host,
// which is the whole reason a record carries a time at all.
export function inZone(iso: string, zone: string | undefined): string {
  if (zone === undefined || iso === "") return iso;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  // "GMT+09:00" -> "+09:00"; a zone that is exactly GMT formats as bare "GMT".
  const offset = get("timeZoneName").replace(/^GMT/, "") || "+00:00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${offset}`;
}

// …and just the DATE a reader in `zone` was standing in.
//
// Taking the first ten characters of the instant is the date in UTC, which is a
// different day from about 09:00 local in Tokyo onwards — a run at 23:30Z
// showed the day before the one the operator was in.
export function dateIn(iso: string, zone: string | undefined): string {
  if (iso === "") return "";
  if (zone === undefined) return iso.slice(0, 10);
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
  // en-CA formats as YYYY-MM-DD, which is what every other date here is.
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// Does this platform know the zone? A name nobody recognises must not fall back
// to UTC silently: the whole point is that the reader trusts the time.
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
