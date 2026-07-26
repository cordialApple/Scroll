import type { Awareness } from 'y-protocols/awareness'
import type * as Y from 'yjs'
import type { Anchor } from '../layout/layout'
import { resolveEffectiveAnchor } from './anchor'
import { blockOrder, redirectSource } from './model'

export interface PresenceUser {
  id: string
  name?: string
  color?: string
}

export interface RemoteCamera {
  clientId: number
  raw: Anchor
  anchor: Anchor
  user?: PresenceUser
}

// Same pipeline the local editor uses: after a concurrent merge the peer's block leaves
// `order`, so we follow the redirect to the surviving successor — never a stored index.
export function resolveRemoteCamera(doc: Y.Doc, raw: Anchor): Anchor {
  return resolveEffectiveAnchor(blockOrder(doc), redirectSource(doc), raw)
}

export interface Clock {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
}

const realClock: Clock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
}

export interface PresenceOptions {
  user?: PresenceUser
  minPublishMs?: number
  clock?: Clock
}

export interface Presence {
  publishCamera(anchor: Anchor): void
  remotes(): RemoteCamera[]
  subscribe(cb: () => void): () => void
  destroy(): void
}

const DEFAULT_MIN_PUBLISH_MS = 60

function isAnchor(v: unknown): v is Anchor {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Anchor).blockId === 'string' &&
    typeof (v as Anchor).offset === 'number'
  )
}

function isUser(v: unknown): v is PresenceUser {
  return typeof v === 'object' && v !== null && typeof (v as PresenceUser).id === 'string'
}

export function createPresence(
  doc: Y.Doc,
  awareness: Awareness,
  opts: PresenceOptions = {},
): Presence {
  const clock = opts.clock ?? realClock
  const minMs = opts.minPublishMs ?? DEFAULT_MIN_PUBLISH_MS
  const self = awareness.clientID
  if (opts.user) awareness.setLocalStateField('user', opts.user)

  let last = -Infinity
  let pending: Anchor | null = null
  let timer: unknown = null

  const write = (a: Anchor) => {
    last = clock.now()
    awareness.setLocalStateField('camera', { blockId: a.blockId, offset: a.offset })
  }

  const flush = () => {
    timer = null
    if (pending) {
      const p = pending
      pending = null
      write(p)
    }
  }

  // Leading + trailing throttle: a fast scroll coalesces to one write per window, but the
  // final resting camera always lands (trailing flush) so peers don't see a stale position.
  const publishCamera = (anchor: Anchor) => {
    if (clock.now() - last >= minMs) {
      pending = null
      if (timer) {
        clock.clearTimer(timer)
        timer = null
      }
      write(anchor)
    } else {
      pending = anchor
      if (!timer) timer = clock.setTimer(flush, last + minMs - clock.now())
    }
  }

  const listeners = new Set<() => void>()
  const onChange = () => listeners.forEach((l) => l())
  awareness.on('change', onChange)

  const remotes = (): RemoteCamera[] => {
    const out: RemoteCamera[] = []
    awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return
      const s = state as { camera?: unknown; user?: PresenceUser }
      if (!isAnchor(s.camera)) return
      out.push({
        clientId,
        raw: s.camera,
        anchor: resolveRemoteCamera(doc, s.camera),
        user: isUser(s.user) ? s.user : undefined,
      })
    })
    return out
  }

  const subscribe = (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  const destroy = () => {
    if (timer) {
      clock.clearTimer(timer)
      timer = null
    }
    awareness.off('change', onChange)
    listeners.clear()
    awareness.setLocalState(null)
  }

  return { publishCamera, remotes, subscribe, destroy }
}
