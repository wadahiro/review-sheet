---
paths:
  - "src/**"
  - "tests/**"
  - "scripts/**"
---

# Verifying

Loaded alongside `architecture.md`. That file records why each piece is shaped
the way it is; this one records how a claim about this codebase earns the right
to be believed.

It exists because of a measured failure record, not a principle. During one
piece of work, thirteen claims turned out to be wrong, and they had a single
shape: **a claim that outran its witness** — asserted without observing the
exact thing asserted. They differ only in what stood in for the missing witness.

- **A proxy stood in for the fact.** A category's kind guessed from how its name
  looked (dictionary group paths, which contain `/`, read as file paths). Rows
  without a component counted from visible tabs (a single component collapses
  its level, so its rows have one and cannot be seen to). "Is this row backed by
  a variable" read from any `extra` value (`provenance` lives there, so every
  row answered yes). Containers counted by splitting a path on `.` (a quoted map
  key contains dots).
- **A classification stood in for the instances.** Buckets and booleans are
  compression, applied at the source, before anyone could see what was
  compressed. `isArtifactLine` as a yes/no hid a whole population; a report
  whose buckets were judgments hid three defects at once.
- **An intention stood in for an effect.** "I reverted it" (the directory was
  gitignored, so nothing had happened). "An empty value cell claims nothing" (it
  renders "uses the default"). Each backed by having done or believed something
  rather than by looking afterwards.
- **An artifact stood in for a behavior.** A CSS selector that matched nothing —
  twice, two different wrong ancestries. A registration placed in a branch that
  path never takes. A test that passed against broken code because it seeded a
  key nobody read. None of these is distinguishable from working code by any
  check that was run.

And the part that makes it more than carelessness: **every one of those errors
leaned toward the hypothesis being tested.** Random error scatters. These
flattered — a clean 100%, a clean zero, exactly the predicted shape.

## The rules

**R1. A check may only consume what the build itself emits.** If the number a
check needs does not exist in any report, the work is to make the build say it —
never to reconstruct it from the model. `BindingReport` and `MaterializeReport`
exist for this reason: "what did the build decide" is observed, not re-derived.

**R2. A report states facts; judgments live in its consumers.** `BindingReport`
says "this key bound by `leaf`" and never "this key is well-bound". A bucket
name is a judgment, and a judgment inside a report cannot be held to anything —
the build has no way to be wrong about it.

**R3. No green without having seen red.** A test, a selector, a branch, a report
or a gate is not written until the thing it guards has been broken on purpose
and it has been watched failing. Keep the evidence. A rule nobody has seen fire
is indistinguishable from one that cannot.

**R4. Every aggregate ships its exemplars.** A count carries its first few
members, verbatim, in the same output. "102 rows" is unreviewable; "102 rows,
including keycloak_dist_checksum, providerId, server_tokens" refutes itself at a
glance — which is how a bucket that mixed three unrelated populations was
caught, by reading four of them.

**R5. An effect claim carries the observed post-state.** "Reverted", "fixed",
"regenerated" is admissible with the `git status`, the re-run, the re-rendered
cell attached. Running a command is not evidence that the world changed.

**The too-clean trigger.** A measurement returning 0%, 100%, or precisely the
predicted shape is not a result yet. Perturb something deliberately and watch
the number move before using it.

## What none of this covers

A malformed question passes every check, because checks verify answers. The one
error in that record no rule would have caught was a question built on a wrong
premise — two rows read for what they were, by someone who knew the domain,
dissolved it. So: the rules are for answers. Questions are settled with a human,
and work handed to an agent must be work whose question is already settled.
