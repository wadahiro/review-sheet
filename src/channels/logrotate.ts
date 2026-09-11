// What `logrotate -d` says about a configuration it was asked to read.
//
// A debug run prints what it WOULD do and, among it, its complaints about the
// file — `error:`, `unknown option`, `bad …`. Which lines are a complaint is
// logrotate's grammar; whether the file should have been there at all is the
// project's.

export function configErrors(text: string | null | undefined): string[] {
  return (text ?? "").split("\n").filter((l) => /error:|unknown option|bad /i.test(l));
}
