import net from 'node:net'
import * as Y from 'yjs'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapSchema, createPostgresStore } from '../../server/db/store'
import { createPersistenceExtension } from '../../server/db/persistenceExtension'
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
    ).rejects.toThrow(/compaction fenced/i)

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

  // compact() is self-fencing, not caller-fenced: a pure UPDATE matches 0 rows when the doc row is
  // absent, so it throws instead of silently seeding a row and dropping log rows (the upsert-WHERE hole
  // an INSERT ... ON CONFLICT would leave on the fresh-row path).
  it('compaction of a doc with no row throws instead of seeding an unfenced row', async () => {
    const store = createPostgresStore(pool)
    const docId = `fence-norow-${await freePort()}`
    const doc = new Y.Doc()
    appendBlock(doc, 'paragraph', 'x')
    await expect(
      store.compact(docId, 0, 1, Y.encodeStateAsUpdate(doc), Y.encodeStateVector(doc), []),
    ).rejects.toThrow(/compaction fenced/i)
    const res = await pool.query('SELECT 1 FROM documents WHERE doc_id = $1', [docId])
    expect(res.rowCount).toBe(0)
  })
})

// Drives the fence through createPersistenceExtension (not store.compact directly), so a wiring
// regression — lease not acquired on load, wrong epoch threaded, or the contained-throw handling
// removed — is caught. The hook payloads are the minimal subset each hook reads.
describe('P3.5 epoch fence — extension wiring', () => {
  type Hooks = ReturnType<typeof createPersistenceExtension>['extension']
  const call = (ext: Hooks, hook: keyof Hooks, documentName: string, document: Y.Doc) =>
    (ext[hook] as (p: { documentName: string; document: Y.Doc }) => Promise<unknown>)({ documentName, document })

  it('onLoadDocument takes a lease and onStoreDocument folds under it', async () => {
    const store = createPostgresStore(pool)
    const ext = createPersistenceExtension(store).extension
    const docId = `ext-ok-${await freePort()}`
    const doc = new Y.Doc()

    await call(ext, 'onLoadDocument', docId, doc)
    appendBlock(doc, 'paragraph', 'via extension')
    await call(ext, 'onStoreDocument', docId, doc)

    const loaded = await store.loadDocument(docId)
    expect(loaded.snapshot).not.toBeNull()
    expect(texts(loaded)).toContain('via extension')
  })

  it("a superseded owner's debounced compaction is contained, not thrown, and does not clobber", async () => {
    const store = createPostgresStore(pool)
    const ext = createPersistenceExtension(store).extension
    const docId = `ext-stale-${await freePort()}`
    const doc = new Y.Doc()

    // Extension takes lease 1 on load. A new owner then supersedes it out-of-band (lease 2) and folds.
    await call(ext, 'onLoadDocument', docId, doc)
    const newLease = await store.acquireLease(docId)
    const winner = new Y.Doc()
    appendBlock(winner, 'paragraph', 'new owner content')
    await store.compact(docId, 0, newLease, Y.encodeStateAsUpdate(winner), Y.encodeStateVector(winner), [])

    // The stale extension's onStoreDocument must NOT reject (an escaped throw on Hocuspocus's
    // un-awaited debounce timer crashes every room), and must not overwrite the new owner's snapshot.
    appendBlock(doc, 'paragraph', 'stale owner content')
    await expect(call(ext, 'onStoreDocument', docId, doc)).resolves.toBeUndefined()

    const loaded = await store.loadDocument(docId)
    expect(texts(loaded)).toContain('new owner content')
    expect(texts(loaded)).not.toContain('stale owner content')
  })
})
