import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import { messageYjsUpdate } from 'y-protocols/sync'
import { describe, expect, it } from 'vitest'
import { createPersistenceExtension, PROPOSE_ORIGIN, type PersistenceExtension } from './persistenceExtension'
import type { DocumentStore } from './store'

// Deterministic fake store: assigns monotonic seqs and records exactly which seqs each compact() folds,
// so the seq-ledger bookkeeping can be asserted without a database.
function fakeStore() {
  let n = 0
  const compactSeqs: string[][] = []
  const store: DocumentStore = {
    async loadDocument() {
      return { docEpoch: 0, snapshot: null, stateVector: null, updates: [] }
    },
    async acquireLease() {
      return 1
    },
    async appendUpdate() {
      return String(++n)
    },
    async compact(_docId, _docEpoch, _ownerEpoch, _snapshot, _stateVector, seqs) {
      compactSeqs.push([...seqs])
    },
  }
  return { store, compactSeqs }
}

// Hocuspocus's beforeHandleMessage receives the RAW wire frame; build a valid sync-update frame so
// extractSyncUpdate returns the payload and the persistence append fires.
function syncFrame(docName: string, payload: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarString(enc, docName)
  encoding.writeVarUint(enc, 0)
  encoding.writeVarUint(enc, messageYjsUpdate)
  encoding.writeVarUint8Array(enc, payload)
  return encoding.toUint8Array(enc)
}

function contentUpdate(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

type Ext = PersistenceExtension['extension']
const load = (e: Ext, documentName: string, document: Y.Doc) => e.onLoadDocument!({ documentName, document } as never)
const before = (e: Ext, documentName: string, update: Uint8Array) => e.beforeHandleMessage!({ documentName, update } as never)
const change = (e: Ext, documentName: string, transactionOrigin: unknown) => e.onChange!({ documentName, transactionOrigin } as never)
const store = (e: Ext, documentName: string, document: Y.Doc) => e.onStoreDocument!({ documentName, document } as never)

describe('P4.3 persistence seq-ledger under propose/commit (F-01: onChange origin-scoping)', () => {
  it('a committed proposal folds its own row — no per-commit leak in document_updates', async () => {
    const { store: fake, compactSeqs } = fakeStore()
    const { extension, commitProposal } = createPersistenceExtension(fake)
    const doc = new Y.Doc()
    const room = 'commit-folds'

    await load(extension, room, doc)
    await commitProposal(room, doc, contentUpdate('committed'))
    await store(extension, room, doc)

    // The proposal's append seq ('1') is fold-eligible, so compaction deletes it like any sync write.
    expect(compactSeqs[0]).toEqual(['1'])
  })

  it("a proposal's phantom onChange does NOT pop a concurrent sync peer's pending seq", async () => {
    const { store: fake, compactSeqs } = fakeStore()
    const { extension } = createPersistenceExtension(fake)
    const doc = new Y.Doc()
    const room = 'no-mispop'

    await load(extension, room, doc)
    // A sync-path update is appended (seq '1' pending) but its own apply/onChange has NOT landed yet.
    await before(extension, room, syncFrame(room, contentUpdate('sync-peer edit')))
    // A concurrent proposal commits: its apply fires an onChange tagged PROPOSE_ORIGIN. This must be
    // inert on the sync FIFO — crediting seq '1' now would fold it before the sync apply is confirmed.
    await change(extension, room, PROPOSE_ORIGIN)
    await store(extension, room, doc)
    expect(compactSeqs[0]).toEqual([]) // '1' NOT folded — still pending its own apply

    // The sync update's real (non-propose) onChange lands; only now is seq '1' fold-eligible.
    await change(extension, room, undefined)
    await store(extension, room, doc)
    expect(compactSeqs[1]).toEqual(['1'])
  })
})
