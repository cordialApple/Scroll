import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { createDoc, seedIfEmpty } from './model'

export interface DocHandle {
  doc: Y.Doc
  docId: string
  room: string
  local: IndexeddbPersistence
  network: HocuspocusProvider | null
  whenSynced: Promise<void>
  destroy(): void
}

export interface OpenDocOptions {
  seed?: boolean
  room?: string
  wsUrl?: string
  websocketProvider?: HocuspocusProviderWebsocket
}

export function openDoc(docId: string, opts: OpenDocOptions = {}): DocHandle {
  const doc = createDoc()
  const local = new IndexeddbPersistence(docId, doc)
  const room = opts.room ?? docId

  // preserveConnection:false so destroy() actually closes the socket. It defaults true (meant for
  // sharing one socket across docs); we run one provider per doc, so a kept-alive socket is a leaked
  // reconnect loop on every unmount.
  let network: HocuspocusProvider | null = null
  if (opts.websocketProvider) {
    network = new HocuspocusProvider({ websocketProvider: opts.websocketProvider, name: room, document: doc, preserveConnection: false })
  } else if (opts.wsUrl) {
    network = new HocuspocusProvider({ url: opts.wsUrl, name: room, document: doc, preserveConnection: false })
  }

  // Boot gates on LOCAL persistence only. The network provider is background self-heal, never a boot
  // gate — the editor opens instantly and offline, exactly as single-user P0. Gating whenSynced on the
  // network would hang the app whenever the server is unreachable (a P3.1 sabotage the teeth catch).
  // Seeding is caller intent (seed:true = this client authors a new doc), applied at local sync so an
  // offline creator still gets a usable doc. Opening an existing shared doc passes seed:false — a stale
  // local-empty must never inject a phantom block into content the server is about to sync down.
  const whenSynced = new Promise<void>((resolve) => {
    local.once('synced', () => {
      if (opts.seed !== false) seedIfEmpty(doc)
      resolve()
    })
  })

  const destroy = () => {
    network?.destroy()
    void local.destroy()
  }

  return { doc, docId, room, local, network, whenSynced, destroy }
}
