import { describe, it, expect, vi } from 'vitest'
import {
  Awareness,
  encodeAwarenessUpdate,
  applyAwarenessUpdate,
} from 'y-protocols/awareness'
import { createDoc, appendBlock, mergeIntoPrevious } from './model'
import { createPresence, resolveRemoteCamera, type Clock } from './awareness'

function seedDoc() {
  const doc = createDoc()
  const h = appendBlock(doc, 'heading', 'Title')
  const p0 = appendBlock(doc, 'paragraph', 'zero')
  const x = appendBlock(doc, 'paragraph', 'ex')
  const p2 = appendBlock(doc, 'paragraph', 'two')
  return { doc, h, p0, x, p2 }
}

describe('resolveRemoteCamera', () => {
  it('follows the merge redirect to the surviving successor, never the vanished block', () => {
    const { doc, p0, x } = seedDoc()

    expect(resolveRemoteCamera(doc, { blockId: x, offset: 12 })).toEqual({ blockId: x, offset: 12 })

    // A concurrent merge folds X into its predecessor: X leaves `order`, redirect X->p0 is written.
    mergeIntoPrevious(doc, x)

    const resolved = resolveRemoteCamera(doc, { blockId: x, offset: 12 })
    expect(resolved).toEqual({ blockId: p0, offset: 0 })
  })
})

describe('createPresence — remote cameras', () => {
  it('resolves a peer camera through THIS doc redirects after a local merge', () => {
    const { doc, p0, x } = seedDoc()

    const awB = new Awareness(doc)
    const awA = new Awareness(createDoc())
    awA.setLocalStateField('camera', { blockId: x, offset: 7 })
    applyAwarenessUpdate(awB, encodeAwarenessUpdate(awA, [awA.clientID]), 'remote')

    const presence = createPresence(doc, awB)

    const before = presence.remotes()
    expect(before).toHaveLength(1)
    expect(before[0].anchor).toEqual({ blockId: x, offset: 7 })

    mergeIntoPrevious(doc, x)

    const after = presence.remotes()
    expect(after[0].raw).toEqual({ blockId: x, offset: 7 })
    expect(after[0].anchor).toEqual({ blockId: p0, offset: 0 })

    presence.destroy()
  })

  it('excludes the local client from remotes', () => {
    const { doc, x } = seedDoc()
    const aw = new Awareness(doc)
    const presence = createPresence(doc, aw)
    presence.publishCamera({ blockId: x, offset: 0 })
    expect(presence.remotes()).toHaveLength(0)
    presence.destroy()
  })
})

describe('createPresence — publish rate cap', () => {
  it('coalesces a burst to one leading + one trailing write, last camera wins', () => {
    const { doc, h, p0, x } = seedDoc()

    let t = 1000
    const timers: { fn: () => void; at: number }[] = []
    const clock: Clock = {
      now: () => t,
      setTimer: (fn, ms) => {
        const handle = { fn, at: t + ms }
        timers.push(handle)
        return handle
      },
      clearTimer: (handle) => {
        const i = timers.indexOf(handle as (typeof timers)[number])
        if (i >= 0) timers.splice(i, 1)
      },
    }
    const advance = (ms: number) => {
      t += ms
      for (const handle of [...timers]) {
        if (handle.at <= t) {
          timers.splice(timers.indexOf(handle), 1)
          handle.fn()
        }
      }
    }

    const aw = new Awareness(doc)
    const spy = vi.spyOn(aw, 'setLocalStateField')
    const presence = createPresence(doc, aw, { minPublishMs: 60, clock })

    presence.publishCamera({ blockId: h, offset: 0 })
    presence.publishCamera({ blockId: p0, offset: 0 })
    presence.publishCamera({ blockId: x, offset: 3 })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenLastCalledWith('camera', { blockId: h, offset: 0 })

    advance(60)

    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy).toHaveBeenLastCalledWith('camera', { blockId: x, offset: 3 })

    presence.destroy()
  })
})
