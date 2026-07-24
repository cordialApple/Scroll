# Endpoint spawners: doc-es and ide-es

Scroll exposes **endpoint spawning** as a feature in the app. An endpoint is a single-person editing
surface that Scroll creates on demand. There are two spawners.

## doc-es (document endpoint spawner)

Spawns a single-person prose editor surface. Used by Scroll's own AI-editor value prop and by any
document-oriented consumer.

### The doc-es schema

Nearly config-free by design, but it exists so the spawn seam is uniform (one Factory, two schemas):

- **title** — display name for the surface.
- **initial content** (optional) — seed blocks; empty buffer if absent.
- **lifecycle owner** — `human` (durable, user-owned doc) or `consumer` (ephemeral endpoint).
- **programmatic preset** — the contract-3 selection.
- **result / callback target** (optional) — per contract 6, for lifecycle events.

Like the ide-es schema, it is the entire contract: a consumer never reaches past it, and neither side
changes it alone (contract 2 in [boundaries.md](boundaries.md)).

## ide-es (IDE endpoint spawner)

Spawns a single-person code editor surface. Two properties distinguish it from doc-es:

- **Schema attachability.** An ide-es endpoint is spawned from an attached schema, not from an empty
  buffer. The schema describes what the endpoint is for.
- **A spawn function**, `create_ide_es`, or similar spawn logic ("sl"), that takes the schema and
  produces the running endpoint.

### The ide-es schema

The schema a consumer seeds carries, at minimum:

- **goal condition** — what "done" means for this endpoint.
- **problem** — the statement the user works against.
- **test-case + TLE budget** — the hidden tests and the time-limit / complexity budget that gate a
  submission. The TLE budget is how the "use the efficient strategy" constraint is enforced: an
  adversarially large input that a brute-force solution blows but the intended structure clears.
- **hints** — staged strategy hints.

This schema is the boundary between Scroll and a programmatic consumer. Scroll owns spawning,
hosting, and grading; the consumer owns seeding the schema. Neither side changes it alone. It is
formalized as contract 2 (Factory + OCP) in [boundaries.md](boundaries.md). See
[integrations/personalserver.md](../integrations/personalserver.md).

## Who spawns what

- **Single-user** mode and **multi-user with a second-user AI** need both `ide_es` and `doc-es`.
- The **attention-anchored AI-editor** value prop needs only `doc-es`.

## The OCP thesis (unproven)

`doc-es` does not strictly have to be an endpoint for parts that only Scroll controls (the native AI
editor, for instance). It is modeled as an endpoint for **Open/Closed-principle adherence**: the
expectation is that PersonalServer and STARfolio best control **endpoints**, not Scroll's native app
processes. Making both surfaces spawnable-endpoints keeps external consumers extending Scroll from
the outside (seed a schema, drive an endpoint) rather than modifying the app internals.

This is a design bet. It has not been proven that the endpoint seam is the right abstraction for
Scroll-only features, and it may add indirection where a native call would do. Recorded as an open
question in [open-questions.md](../open-questions.md).
