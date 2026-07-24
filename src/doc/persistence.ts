import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { createDoc, seedIfEmpty } from './model'

export interface DocHandle {
  doc: Y.Doc
  docId: string
  provider: IndexeddbPersistence
  whenSynced: Promise<void>
}

export function openDoc(docId: string): DocHandle {
  const doc = createDoc()
  const provider = new IndexeddbPersistence(docId, doc)
  const whenSynced = new Promise<void>((resolve) => {
    provider.once('synced', () => {
      seedIfEmpty(doc)
      resolve()
    })
  })
  return { doc, docId, provider, whenSynced }
}
