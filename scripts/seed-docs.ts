import * as Y from 'yjs'
import { Pool } from 'pg'
import { appendBlock, createDoc } from '../src/doc/model'
import type { BlockType } from '../src/doc/model'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'

const SEEDS: Array<{ id: string; blocks: Array<[BlockType, string]> }> = [
  {
    id: 'welcome',
    blocks: [
      ['heading', 'Welcome to Scroll'],
      ['paragraph', 'Scroll is a relative-anchored collaborative editor. Nothing changes beneath your cursor, even when an agent is reorganizing the document above you.'],
      ['paragraph', 'Open any document from this screen, or start a new one. Every doc is a live room; presence, persistence, and the native agent all attach when you are connected to a relay.'],
      ['paragraph', 'Try it: open two tabs on the same room and watch edits sync in real time.'],
    ],
  },
  {
    id: 'release-notes',
    blocks: [
      ['heading', 'Release notes: P6 closed'],
      ['paragraph', 'The attention-anchored agent editor shipped. A headless agent now reorganizes cold regions of a document while your viewport holds.'],
      ['paragraph', 'A belt-and-suspenders spatial guard refuses any write inside a live reader band, proven live over a real server and Postgres.'],
      ['paragraph', 'Per-block provenance renders a change bar in the gutter for agent-authored blocks, with zero layout shift.'],
    ],
  },
  {
    id: 'meeting-notes',
    blocks: [
      ['heading', 'Meeting notes'],
      ['paragraph', 'Agenda: the document picker, one-command dev startup, and dogfooding the native agent.'],
      ['paragraph', 'Decision: land on a Recent-documents overlay whenever the app is connected to a relay.'],
      ['paragraph', 'Next: ship dev:all, then wire the agent to run against the live room so the change bars appear on their own.'],
    ],
  },
  {
    id: 'scratchpad',
    blocks: [
      ['heading', 'Scratchpad'],
      ['paragraph', 'ideas, todos, half-thoughts'],
      ['paragraph', '- try the change bar with a real agent tick'],
      ['paragraph', '- prune the dev database before demos'],
      ['quote', 'nothing changes beneath you'],
    ],
  },
]

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL })
  await pool.query('TRUNCATE documents, document_updates')
  for (const seed of SEEDS) {
    const doc = createDoc()
    for (const [type, text] of seed.blocks) appendBlock(doc, type, text)
    const update = Y.encodeStateAsUpdate(doc)
    await pool.query(
      `INSERT INTO documents (doc_id, doc_epoch, owner_epoch) VALUES ($1, 0, 1)
       ON CONFLICT (doc_id) DO UPDATE SET updated_at = now()`,
      [seed.id],
    )
    await pool.query('INSERT INTO document_updates (doc_id, doc_epoch, update) VALUES ($1, 0, $2)', [
      seed.id,
      Buffer.from(update),
    ])
  }
  await pool.end()
  console.log(`[seed] wiped + seeded ${SEEDS.length} documents: ${SEEDS.map((s) => s.id).join(', ')}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
