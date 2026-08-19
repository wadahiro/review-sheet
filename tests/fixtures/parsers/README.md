# Parser fixtures

One representative file per format, existing so `tests/goldens/extraction.json`
covers every parser rather than only the ones an example project happens to use.

Before these, eight parsers — including `xml`, `nginx`, `haproxy` and `systemd`,
all of them tree-bearing and all of them due to be rebuilt around a per-node
container record — had no file in the repository at all, so a refactor could
change what they extract with nothing to notice.

Each file is written to exercise the shapes that decide row identity, not to be
a realistic config: nested blocks, a labelled block, repeated siblings (which is
what makes an address positional or identity-keyed), and a singleton carrying an
identity attribute (the arity case).
