import * as Y from 'yjs'
import type { Extension } from '@hocuspocus/server'
import type { DocumentStore } from './store'
import { extractSyncUpdate } from './extractSyncUpdate'

// P3.5 owns real epoch fencing; P3.4 just threads a constant so the column shape is already load-bearing.
const DOC_EPOCH_V1 = 0

export function createPersistenceExtension(store: DocumentStore): Extension {
  // appendUpdate assigns a seq durably BEFORE that update's apply() runs (see store.ts); onChange
  // fires exactly when the corresponding apply() lands, in the same order beforeHandleMessage calls
  // resolved in (each hook's own `.then()` chains straight to its own apply — see Connection.ts in
  // @hocuspocus/server). So: push a pending seq on append, pop it on the matching onChange, and only
  // ever fold seqs we've individually confirmed applied. A naive "delete everything <= MAX(seq)" read
  // instead can race a concurrent append whose row committed but hasn't been applied yet — that's the
  // bug this queue exists to close.
  const pendingSeqs = new Map<string, string[]>()
  const foldableSeqs = new Map<string, string[]>()

  return {
    async onLoadDocument({ documentName, document }) {
      const loaded = await store.loadDocument(documentName)
      if (loaded.snapshot) Y.applyUpdate(document, loaded.snapshot)
      for (const update of loaded.updates) Y.applyUpdate(document, update)
    },

    // Fires strictly before MessageReceiver.apply (Connection.handleMessage awaits this hook, then
    // applies/broadcasts in its .then()) — the append below completing is what makes "persist before
    // broadcast" true, not any ordering inside this function.
    async beforeHandleMessage({ documentName, update }) {
      const syncUpdate = extractSyncUpdate(update)
      if (!syncUpdate) return
      const seq = await store.appendUpdate(documentName, DOC_EPOCH_V1, syncUpdate)
      const pending = pendingSeqs.get(documentName) ?? []
      pending.push(seq)
      pendingSeqs.set(documentName, pending)
    },

    // Fires once apply() has actually mutated `document` for one applied update — pop the oldest
    // pending seq (FIFO matches apply order) into the fold-eligible set. Fires during onLoadDocument's
    // own replay too; pendingSeqs is empty then, so it's a harmless no-op.
    async onChange({ documentName }) {
      const pending = pendingSeqs.get(documentName)
      const seq = pending?.shift()
      if (seq === undefined) return
      const foldable = foldableSeqs.get(documentName) ?? []
      foldable.push(seq)
      foldableSeqs.set(documentName, foldable)
    },

    // Hocuspocus's own debounced hook — safe place to fold the log. Swap out the fold-eligible list
    // before encoding the snapshot: any seq newly confirmed WHILE compact() is in flight lands in a
    // fresh array instead, deferred to the next round rather than raced into this DELETE.
    async onStoreDocument({ documentName, document }) {
      const seqs = foldableSeqs.get(documentName) ?? []
      foldableSeqs.set(documentName, [])
      const snapshot = Y.encodeStateAsUpdate(document)
      const stateVector = Y.encodeStateVector(document)
      await store.compact(documentName, DOC_EPOCH_V1, snapshot, stateVector, seqs)
    },

    async beforeUnloadDocument({ documentName }) {
      pendingSeqs.delete(documentName)
      foldableSeqs.delete(documentName)
    },
  }
}
