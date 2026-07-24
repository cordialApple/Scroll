# Pinned wire contracts

These are the **versioned wire schemas** for Scroll's endpoint spawn seam (contract 2 in
[../architecture/boundaries.md](../architecture/boundaries.md)). They are the entire contract a
consumer (PersonalServer, STARfolio) reaches through — no consumer touches Scroll past a schema here.

## Rules

- **Bilateral change only.** Neither Scroll nor a consumer changes a schema alone. A change is a new
  version file (`*.v2.json`), never an edit that silently reshapes `v1`.
- **Versioned.** Every schema carries `schemaVersion`; the code mirror in
  [../../src/es/schema.ts](../../src/es/schema.ts) pins the same integer in
  `DOC_ES_SCHEMA_VERSION` / `IDE_ES_SCHEMA_VERSION`. `src/test/schema.test.ts` fails if the JSON and
  the code drift.
- **Scroll depends on nothing.** These schemas name no consumer concept (grep-clean for
  "PersonalServer", "STARfolio", "interviewer", "coaching"). `programmatic` is a generic Scroll-owned
  capability preset, not a consumer role.

## Files

| File | Spawner | Owner | Consumers |
|---|---|---|---|
| [doc-es.v1.json](doc-es.v1.json) | `doc-es` (prose surface) | Scroll | any document consumer |
| [ide-es.v1.json](ide-es.v1.json) | `ide-es` (code surface) | Scroll | PersonalServer, STARfolio |

The code mirror in `src/es/schema.ts` is the single source of truth consumed by `create_doc_es` /
`create_ide_es`; these JSON files are the human-readable, review-pinned form of the same shape.
