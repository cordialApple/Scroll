import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { appendBlock, blockOrder, blockTextString, createDoc } from '../doc/model'
import {
  computeLayout,
  deriveAnchor,
  type Anchor,
  type HeightModel,
  type Window,
} from '../layout/layout'
import { estimateHeight } from '../layout/estimate'
import { createFakeTranscriber } from './fakeTranscriber'
import { createDictation, type DictationTarget } from './dictation'

function trueHeight(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
  return 50 + (h % 71)
}

describe('P5.1 dictation core — commit-on-final into the block model', () => {
  it('interim events never mutate the doc and clear on stop', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'hello')
    const id = blockOrder(doc)[0]
    const before = Y.encodeStateAsUpdate(doc)

    const ft = createFakeTranscriber()
    const dict = createDictation(doc, ft, () => ({ blockId: id, caret: 5 }))
    let seen = '<unset>'
    dict.observeInterim((t) => (seen = t))

    ft.start()
    ft.emitInterim('there')
    ft.emitInterim('there world')

    expect(dict.interimText).toBe('there world')
    expect(seen).toBe('there world')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect(blockTextString(doc, id)).toBe('hello')

    ft.stop()
    expect(dict.interimText).toBe('')
    expect(seen).toBe('')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  it('a sequence of finals commits exactly the concatenated text, once each', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', '')
    const id = blockOrder(doc)[0]
    const target: DictationTarget = { blockId: id, caret: 0 }

    const ft = createFakeTranscriber()
    const dict = createDictation(doc, ft, () => target)
    const commits: string[] = []
    dict.observeCommit((t, inserted) => {
      commits.push(inserted)
      target.caret = t.caret
    })

    ft.start()
    ft.emitFinal('hello')
    ft.emitFinal('world')

    expect(blockTextString(doc, id)).toBe('hello world')
    expect(commits).toEqual(['hello', ' world'])
    expect(dict.interimText).toBe('')
  })

  it('caret advances by inserted length; spacing joins words but not punctuation', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'Hello world')
    const id = blockOrder(doc)[0]
    const target: DictationTarget = { blockId: id, caret: 5 }

    const ft = createFakeTranscriber()
    const dict = createDictation(doc, ft, () => target)
    const carets: number[] = []
    dict.observeCommit((t) => {
      carets.push(t.caret)
      target.caret = t.caret
    })

    ft.start()
    ft.emitFinal('there') // word after "Hello" -> leading space
    ft.emitFinal('!') // punctuation -> no leading space

    expect(blockTextString(doc, id)).toBe('Hello there! world')
    expect(carets).toEqual([11, 12])
  })

  it('preserves every other block id, order, and text', () => {
    const doc = createDoc()
    for (let i = 0; i < 5; i++) appendBlock(doc, 'paragraph', `block ${i}`)
    const order = blockOrder(doc)
    const targetId = order[2]

    const ft = createFakeTranscriber()
    createDictation(doc, ft, () => ({
      blockId: targetId,
      caret: (blockTextString(doc, targetId) ?? '').length,
    }))
    ft.start()
    ft.emitFinal('appended')

    expect(blockOrder(doc)).toEqual(order)
    expect(blockTextString(doc, targetId)).toBe('block 2 appended')
    for (const i of [0, 1, 3, 4]) expect(blockTextString(doc, order[i])).toBe(`block ${i}`)
  })

  it('a final with no target, or a whitespace-only final, is a no-op', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'untouched')
    const id = blockOrder(doc)[0]
    const before = Y.encodeStateAsUpdate(doc)

    const noTarget = createFakeTranscriber()
    const dict = createDictation(doc, noTarget, () => null)
    noTarget.start()
    noTarget.emitFinal('dropped')
    expect(dict.interimText).toBe('')

    const ws = createFakeTranscriber()
    createDictation(doc, ws, () => ({ blockId: id, caret: 8 }))
    ws.start()
    ws.emitFinal('   ')

    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect(blockTextString(doc, id)).toBe('untouched')
  })

  // [C1] carry-forward: a real recognizer can fire a stray final around stop/error. The core must
  // only mutate while the transcriber is listening — the guarantee lives on the interface, not the fake.
  it('a final that arrives when not listening never mutates the doc', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'untouched')
    const id = blockOrder(doc)[0]
    const before = Y.encodeStateAsUpdate(doc)

    const ft = createFakeTranscriber()
    const dict = createDictation(doc, ft, () => ({ blockId: id, caret: 9 }))
    let commits = 0
    dict.observeCommit(() => commits++)

    ft.start()
    ft.stop() // back to idle
    ft.emitFinalUnchecked('stray') // recognizer fires a spurious final after stop

    expect(commits).toBe(0)
    expect(blockTextString(doc, id)).toBe('untouched')
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
  })

  // The P5 milestone seed: dictation grows a block ABOVE an anchored camera. The camera's
  // {blockId, offset} still resolves to the same content and scrollTop grows by exactly the
  // above-growth — the screen does not jump. A naive editor holding the old scrollTop lands early.
  it('dictating above an anchored camera does not move the camera', () => {
    const doc = createDoc()
    const N = 40
    for (let i = 0; i < N; i++) appendBlock(doc, 'paragraph', `line ${i}`)
    const order = blockOrder(doc)

    const CAM = 20
    const TARGET = 6 // above the camera and above the rendered window
    const cameraId = order[CAM]
    const window0: Window = { start: CAM - 5, end: CAM + 6 }
    const anchor: Anchor = { blockId: cameraId, offset: 17 }

    // Measured covers only the rendered window (camera ± neighbors); everything above — including the
    // dictation target — is estimate-only, the "variable-height above, estimates only" milestone condition.
    const measured = new Map<string, number>()
    for (let i = window0.start; i < window0.end; i++) measured.set(order[i], trueHeight(order[i]))
    const hm: HeightModel = {
      measured,
      estimate: (id) =>
        estimateHeight({ type: 'paragraph', textLength: (blockTextString(doc, id) ?? '').length }),
    }

    const estBefore = hm.estimate(order[TARGET])
    const scrollTop0 = computeLayout(order, hm, window0, anchor).scrollTop
    expect(deriveAnchor(scrollTop0, order, hm)).toEqual(anchor)

    const ft = createFakeTranscriber()
    const target: DictationTarget = {
      blockId: order[TARGET],
      caret: (blockTextString(doc, order[TARGET]) ?? '').length,
    }
    const dict = createDictation(doc, ft, () => target)
    dict.observeCommit((t) => (target.caret = t.caret))

    ft.start()
    ft.emitFinal('the candidate reasoned aloud through the time complexity')
    ft.emitFinal('and defended each tradeoff before writing the final loop')
    ft.emitFinal('while the interviewer watched the shared document update')
    ft.stop()

    // Dictation grows a block; it adds none and reorders nothing.
    expect(blockOrder(doc)).toEqual(order)
    const estAfter = hm.estimate(order[TARGET])
    expect(estAfter).toBeGreaterThan(estBefore)

    const scrollTop1 = computeLayout(order, hm, window0, anchor).scrollTop
    expect(deriveAnchor(scrollTop1, order, hm)).toEqual(anchor) // camera holds
    expect(scrollTop1 - scrollTop0).toBe(estAfter - estBefore) // grew by exactly the above-growth

    // Naive control: holding the old scrollTop against the grown layout lands off the camera — a jump.
    expect(deriveAnchor(scrollTop0, order, hm)).not.toEqual(anchor)
  })
})
