---
status: accepted
amends:
  - 0073
---

# fp Issues carry a harness-allocated number in an fp property

The harness assumes every Issue has a positive integer number. The Issue
store and Work Items require it, Pull Request bookkeeping is keyed by it,
and the GraphQL API exposes it as a required field. Forge Issues have one,
and Linear passes because its display key carries a team-local number
(`ENG-123`). An fp Issue has none: its identity is a random native id and
a display id such as `MC-miygcidm`. Making the number optional would change
the core model and the API contract, which is the upstream maintainer's
decision, not a tracker adapter's.

ADR 0073 rejected allocating a harness number to fp Issues because the
number would mean nothing to anyone. That reason no longer holds on its
own: the number now has a job, keeping the core model unchanged until the
maintainer decides otherwise.

This ADR decides that an fp Issue the harness works carries its number in
fp itself:

- **Where it lives.** An fp extension property `rfa-number` (a text
  property holding a positive integer) on the Issue. Each fp project used
  as an Issue Tracker registers the property with a small extension; a
  project without it is refused by preflight and by the first write. The
  extension's validator also accepts the empty value, because fp clears a
  property by writing it empty; an empty value counts as no number.
- **Who allocates it.** The harness, during discovery: the first time a
  Ready-labeled fp Issue without a number is seen, it gets the next free
  number in its fp project (one more than the highest `rfa-number` in the
  project, and above every issue number the Repository's Issues and Work
  Items have used in the harness, so a number freed by deleting an Issue
  in fp is not handed out again) and the write is verified by reading it
  back. An Issue keeps its number for good; Issues that never become Ready
  never get one.
- **Uniqueness.** One harness allocates for an fp project. fp syncs between
  machines, so numbering at creation (for example in the extension) could
  hand out the same number twice; a single allocator cannot. Discovery
  still checks: two Issues in one fp project with the same number stop
  discovery for that project with a message that names both, rather than
  guessing.
- **What people see.** The display id stays the Issue's name everywhere
  the harness names things, as ADR 0073 decided. The number is visible in
  fp as a property and is otherwise internal.

## Considered Options

Making the issue number optional for Issue Tracker only kinds is the model
ADR 0073 points to, and it remains the intended end state. It changes the
store, the Pull Request bookkeeping and the GraphQL contract, so it waits
for the maintainer. A number known only to the harness database was
rejected: it would be lost with the database and could not be seen or
checked from fp. Numbering in the fp extension at creation was rejected for
the duplicate risk above.

## Consequences

- The core model, the store, the lifecycle and the API are unchanged; fp
  Issues look to them like Linear Issues.
- Issue refresh writes to fp, once per Issue, when it first sees a Ready
  fp Issue without a number. For every other Issue Tracker kind refresh
  stays read-only.
- Reading every number in one call relies on `fp issue list` including
  properties (fp CLI build a381766, reported as version 0.25.0). An older
  build is refused with a request to run `fp update`, rather than read
  slowly: fp updates itself, and the same list also carries the labels
  discovery needs.
- A parent or blocker that has never been Ready has no number, but stored
  references need one; it is stored under a placeholder number. Nothing
  resolves a reference by its number: parents are matched by native id and
  blockers are only counted, as with Linear's unreadable blockers. A parent
  that matters, an open Ready-labeled one, is numbered with the Ready set,
  before author scope and relevance filter it.
- Moving the numbers between machines relies on fp sync carrying extension
  properties, which is not yet verified.
- If the maintainer later makes the number optional, the harness stops
  writing the property; existing values are harmless.
