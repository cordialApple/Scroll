import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapSchema, createPostgresStore } from '../../server/db/store'
import { appendBlock, blockViews } from './model'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/scroll'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

const pool = new Pool({ connectionString: DATABASE_URL })
beforeAll(async () => {
  await bootstrapSchema(pool)
})
afterAll(async () => {
  await pool.end()
})

function texts(loaded: { snapshot: Uint8Array | null; updates: Uint8Array[] }): string[] {
  const doc = new Y.Doc()
  if (loaded.snapshot) Y.applyUpdate(doc, loaded.snapshot)
  for (const u of loaded.updates) Y.applyUpdate(doc, u)
  return blockViews(doc).map((v) => v.text)
}

describe('P3.5 store-enforced epoch fence', () => {
  // The exact two-owner trace from distributed-systems.md: old owner (epoch e) folds log rows 1–100;
  // new owner (epoch e+1) folds 1–150 and deletes them; old owner commits LAST. Without the WHERE
  // owner_epoch clause the old owner's snapshot (ops 1–100) clobbers the new owner's (1–150) and
  // 101–150 vanish — dropping that clause turns this test RED (the sabotage). With the fence the stale
  // compaction updates 0 rows, throws, and rolls back before its DELETE.
  it('a stale-epoch compaction fails loudly and preserves ops the new owner already folded', async () => {
    const store = createPostgresStore(pool)
    const docId = `fence-${await freePort()}`

    const doc = new Y.Doc()
    const updates: Uint8Array[] = []
    doc.on('update', (u) => updates.push(u))
    for (let i = 1; i <= 150; i++) appendBlock(doc, 'paragraph', `op ${i}`)

    const seqs: string[] = []
    for (const u of updates) seqs.push(await store.appendUpdate(docId, 0, u))

    const oldLease = await store.acquireLease(docId)
    const newLease = await store.acquireLease(docId)
    expect(newLease).toBeGreaterThan(oldLease)

    const newDoc = new Y.Doc()
    for (const u of updates) Y.applyUpdate(newDoc, u)
    await store.compact(docId, 0, newLease, Y.encodeStateAsUpdate(newDoc), Y.encodeStateVector(newDoc), seqs)

    const oldDoc = new Y.Doc()
    for (const u of updates.slice(0, 100)) Y.applyUpdate(oldDoc, u)
    await expect(
      store.compact(docId, 0, oldLease, Y.encodeStateAsUpdate(oldDoc), Y.encodeStateVector(oldDoc), seqs.slice(0, 100)),
    ).rejects.toThrow(/epoch/i)

    const recovered = texts(await store.loadDocument(docId))
    expect(recovered).toContain('op 150')
    expect(recovered).toContain('op 101')
    expect(recovered.length).toBe(150)
  })

  // Positive control: the fence rejects a STALE epoch, not every write. The current lease holder's
  // compaction must land — otherwise the sabotage tooth above could pass for the wrong reason (a fence
  // that always throws).
  it('the current lease holder compacts successfully and folds its log', async () => {
    const store = createPostgresStore(pool)
    const docId = `fence-ok-${await freePort()}`

    const doc = new Y.Doc()
    const updates: Uint8Array[] = []
    doc.on('update', (u) => updates.push(u))
    appendBlock(doc, 'paragraph', 'folded content')

    const seqs: string[] = []
    for (const u of updates) seqs.push(await store.appendUpdate(docId, 0, u))

    const lease = await store.acquireLease(docId)
    await store.compact(docId, 0, lease, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), seqs)

    const loaded = await store.loadDocument(docId)
    expect(loaded.snapshot).not.toBeNull()
    expect(loaded.updates.length).toBe(0)
    expect(texts(loaded)).toContain('folded content')
  })
})
