import * as Y from 'yjs'
import { blockOrder, blockViews, redirectSource, setBlockText } from '../doc/model'
import type { HeadlessPeer } from '../peer/headlessPeer'
import { markWorked } from './coldScheduler'
import { resolveCameras } from './cameraResolve'
import { emptyObserverState, observe, type ObserverState } from './observer'
import type { GuardConfig } from './spatialGuard'

// A reorganization the agent proposes for one cold target block. Receives the fork (a throwaway clone of the
// authoritative doc that headlessPeer.propose diffs) and the target id; mutates the fork in place. Injectable
// so P6.6+ can supply richer restructurings; the default is a safe, idempotent whitespace tidy.
export type ReorganizeActor = (fork: Y.Doc, targetId: string) => void

export function normalizeWhitespaceActor(fork: Y.Doc, targetId: string): void {
  const view = blockViews(fork).find((v) => v.id === targetId)
  if (!view) return
  const tidied = view.text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '')
  if (tidied !== view.text) setBlockText(fork, targetId, tidied)
}

export interface AttentionAgentOptions {
  actor?: ReorganizeActor
  config?: Partial<GuardConfig>
  // Monotonic clock (ms). Default performance.now — the LRU recency + grace math require monotonicity
  // (coldScheduler precondition), which a wall clock can't guarantee.
  now?: () => number
}

export interface TickResult {
  targetId: string | null
  proposed: boolean
  committed?: boolean
  reason?: string
}

export interface AttentionAgent {
  tick(): Promise<TickResult>
  state(): ObserverState
}

// The native attention-anchored agent, headless: it holds a HeadlessPeer, and each tick observes the cold
// set (outside every live reader's residency band) and proposes a reorganization of the least-recently-worked
// cold block through propose/commit. It NEVER self-applies — the fork-and-diff peer discipline — and the room
// authority re-checks the same band at commit, so a proposal into a region a reader just entered is refused
// op-grain (belt/suspenders). Fail closed: if the peer set is unknown (provider has no awareness), the whole
// doc is guarded and the agent idles.
export function createAttentionAgent(peer: HeadlessPeer, opts: AttentionAgentOptions = {}): AttentionAgent {
  const actor = opts.actor ?? normalizeWhitespaceActor
  const clock = opts.now ?? (() => performance.now())
  let state = emptyObserverState

  async function tick(): Promise<TickResult> {
    const doc = peer.provider.document
    const order = blockOrder(doc)
    const cameras = resolveCameras(peer.cameras(), order, redirectSource(doc))
    const obs = observe({
      order,
      cameras,
      state,
      now: clock(),
      awarenessKnown: peer.provider.awareness != null,
      config: opts.config,
    })
    state = obs.state
    if (obs.targetId == null) return { targetId: null, proposed: false }

    const target = obs.targetId
    const outcome = await peer.propose((fork) => actor(fork, target))
    // Advance the LRU on any attempt (commit OR refuse) so a target refused because a reader just moved in
    // isn't re-picked every tick — it rotates to the back and comes around after the rest of the cold set.
    state = { tracked: state.tracked, lru: markWorked(state.lru, target, clock(), order) }
    return { targetId: target, proposed: true, committed: outcome.committed, reason: outcome.reason }
  }

  return { tick, state: () => state }
}
