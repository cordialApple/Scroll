import * as Y from 'yjs'
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { encodeProposal, parseProposalResult } from '../../server/db/proposeCommit'
import { createPresence, type Presence, type PresenceOptions, type RemoteCamera } from '../doc/awareness'
import type { Anchor } from '../layout/layout'
import { blocks, blockViews, createDoc, type BlockView } from '../doc/model'

export interface ProposalOutcome {
  committed: boolean
  reason?: string
}

export interface HeadlessPeerOptions {
  room: string
  token?: string
  url?: string
  websocketProvider?: HocuspocusProviderWebsocket
  // A WebSocket constructor for environments without a global one (Node's `ws`); Hocuspocus types this
  // `any`, so a Node polyfill and the DOM global both satisfy it.
  WebSocketPolyfill?: unknown
  doc?: Y.Doc
  user?: PresenceOptions['user']
  proposalTimeoutMs?: number
  minDelayMs?: number
  maxDelayMs?: number
}

export interface HeadlessPeer {
  // The shared Y.Doc is deliberately NOT exposed as a first-class handle: a peer must never self-apply, and
  // a public `doc` field is the frictionless hook a consumer would grab to mutate it directly (the F-04
  // hazard). Reads go through snapshot()/observeText(); writes go through propose(). `provider.document`
  // still reaches the raw doc, but `provider` is exposed only for auth/lifecycle introspection and is a
  // deliberate step down from the peer API — dropping `doc` removes the ergonomic path, not every path.
  provider: HocuspocusProvider
  whenReady: Promise<void>
  propose(mutate: (fork: Y.Doc) => void): Promise<ProposalOutcome>
  proposeUpdate(update: Uint8Array): Promise<ProposalOutcome>
  snapshot(): BlockView[]
  observeText(cb: (views: BlockView[]) => void): () => void
  cameras(): RemoteCamera[]
  observeCameras(cb: () => void): () => void
  lookAt(anchor: Anchor): void
  destroy(): void
}

const DEFAULT_PROPOSAL_TIMEOUT_MS = 10_000

interface Pending {
  resolve(outcome: ProposalOutcome): void
  timer: ReturnType<typeof setTimeout>
}

// The native headless peer (roadmap P4.4): a Node/Electron-side consumer that holds the shared Y.Doc,
// observes Y.Text deltas + awareness, and writes back through propose/commit. It is the discipline made
// mechanical — a peer NEVER self-applies its own write. It forks the doc, mutates the fork, and proposes
// the diff; a refusal costs nothing (the shared doc was never touched) and a commit arrives back through
// normal sync like any remote update. This is the same peer model the native attention-anchored agent
// (P6) and STARfolio's external interviewer (P4.5) both wrap; the protocol stays Scroll-owned and
// consumer-blind, so an instance is a peer, not a first-class concept.
export function createHeadlessPeer(opts: HeadlessPeerOptions): HeadlessPeer {
  const doc = opts.doc ?? createDoc()
  const timeoutMs = opts.proposalTimeoutMs ?? DEFAULT_PROPOSAL_TIMEOUT_MS

  const ownedSocket = opts.websocketProvider
    ? null
    : new HocuspocusProviderWebsocket({
        url: requireUrl(opts),
        WebSocketPolyfill: opts.WebSocketPolyfill,
        minDelay: opts.minDelayMs,
        maxDelay: opts.maxDelayMs,
      })
  const socket = opts.websocketProvider ?? ownedSocket!

  // preserveConnection governs whether provider.destroy() also disconnects the socket. When we own the
  // socket, we want it closed (false). When the caller injected one — a socket it may share across peers
  // — destroying THIS peer must not tear down everyone else's connection, so leave the socket alone (true)
  // and let the caller own its lifecycle.
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: opts.room,
    document: doc,
    token: opts.token,
    preserveConnection: ownedSocket === null,
  })

  const presence: Presence | null = provider.awareness
    ? createPresence(doc, provider.awareness, { user: opts.user })
    : null

  // whenReady gates on `synced`, not on `authenticated`: Hocuspocus runs onAuthenticate BEFORE the sync
  // step, so a synced connection is already an authenticated one — and gating on synced alone avoids a
  // hang against a server that runs no authenticator (authenticated would never flip). destroy() also
  // settles it, so a caller awaiting whenReady against a shutdown (or a peer that never connected) is
  // released instead of hanging forever.
  let markReady!: () => void
  const whenReady = new Promise<void>((resolve) => {
    markReady = resolve
    const check = () => {
      if (provider.synced) resolve()
    }
    provider.on('synced', check)
    check()
  })

  const pending = new Map<string, Pending>()
  let seq = 0
  let destroyed = false

  const onStateless = ({ payload }: { payload: string }) => {
    const r = parseProposalResult(payload)
    if (!r) return // foreign stateless (Hocuspocus history-versioning {action} commands): not ours, ignore
    const entry = pending.get(r.id)
    if (!entry) return // foreign or already-settled result id: never throw on unknown correlation
    pending.delete(r.id)
    clearTimeout(entry.timer)
    entry.resolve({ committed: r.ok, reason: r.reason })
  }
  provider.on('stateless', onStateless)

  const proposeUpdate = (update: Uint8Array): Promise<ProposalOutcome> => {
    if (destroyed) return Promise.resolve({ committed: false, reason: 'peer destroyed' })
    const id = `${doc.clientID}:${seq++}`
    return new Promise<ProposalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ committed: false, reason: 'proposal timed out' })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
      // Send only once synced so the frame is not dropped on the floor pre-handshake; the pending entry
      // is registered first, so a fast server result can never race ahead of its correlation slot.
      void whenReady.then(() => {
        if (pending.has(id)) provider.sendStateless(encodeProposal(id, update))
      })
    })
  }

  // Fork-and-diff: clone the authoritative state into a throwaway doc, mutate THAT, and propose only the
  // resulting delta. The shared doc is never mutated, so this is a pure read-then-propose — the whole
  // point of a peer that submits proposals instead of self-applying.
  const propose = (mutate: (fork: Y.Doc) => void): Promise<ProposalOutcome> => {
    const fork = createDoc()
    Y.applyUpdate(fork, Y.encodeStateAsUpdate(doc))
    const before = Y.encodeStateVector(fork)
    mutate(fork)
    return proposeUpdate(Y.encodeStateAsUpdate(fork, before))
  }

  // Own the observeDeep unsubscribers so destroy() can release any a caller forgot — the doc may be
  // caller-supplied and outlive this peer, so a dangling handler is a real leak on a long-lived doc.
  const unobservers = new Set<() => void>()
  const observeText = (cb: (views: BlockView[]) => void): (() => void) => {
    const handler = () => cb(blockViews(doc))
    const arr = blocks(doc)
    arr.observeDeep(handler)
    const off = () => {
      if (!unobservers.delete(off)) return
      arr.unobserveDeep(handler)
    }
    unobservers.add(off)
    return off
  }

  const destroy = () => {
    if (destroyed) return
    destroyed = true
    for (const e of pending.values()) {
      clearTimeout(e.timer)
      e.resolve({ committed: false, reason: 'peer destroyed' })
    }
    pending.clear()
    for (const off of [...unobservers]) off()
    markReady()
    provider.off('stateless', onStateless)
    presence?.destroy()
    // Tearing down a socket that never finished connecting (server unreachable): ws emits a deferred
    // 'error' ("closed before the connection was established") AFTER Hocuspocus removes its own listener,
    // which as an unhandled 'error' would crash the Node process. Sink it on the raw socket first — a
    // peer being destroyed does not care why its never-open socket failed.
    sinkSocketError(ownedSocket)
    provider.destroy()
    ownedSocket?.destroy()
  }

  return {
    provider,
    whenReady,
    propose,
    proposeUpdate,
    snapshot: () => blockViews(doc),
    observeText,
    cameras: () => presence?.remotes() ?? [],
    observeCameras: (cb) => presence?.subscribe(cb) ?? (() => {}),
    lookAt: (anchor) => presence?.publishCamera(anchor),
    destroy,
  }
}

function requireUrl(opts: HeadlessPeerOptions): string {
  if (!opts.url) throw new Error('createHeadlessPeer: pass either a websocketProvider or a url')
  return opts.url
}

function sinkSocketError(socket: HocuspocusProviderWebsocket | null): void {
  const raw = (socket as unknown as { webSocket?: { addEventListener?: (e: string, cb: () => void) => void } } | null)
    ?.webSocket
  raw?.addEventListener?.('error', () => {})
}
