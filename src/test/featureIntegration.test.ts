import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { describe, expect, it } from 'vitest'
import { createSpatialProposalGuard } from '../../server/agent/spatialProposalGuard'
import { appendBlock, blockOrder, blockTextString, blockViews, createDoc, createTab, insertImageAfter, listTabs, renameTab, setBlockText, setBlockType, tabBlocksKey, updateImage } from '../doc/model'
import { createDictation } from '../voice/dictation'
import { createFakeTranscriber } from '../voice/fakeTranscriber'

function fork(doc: Y.Doc): Y.Doc {
  const copy = createDoc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  return copy
}

function decide(doc: Y.Doc, anchor: string, mutate: (copy: Y.Doc) => void) {
  const copy = fork(doc)
  const before = Y.encodeStateVector(copy)
  mutate(copy)
  const awareness = new Awareness(doc)
  awareness.setLocalStateField('camera', { blockId: anchor, offset: 0 })
  try {
    return createSpatialProposalGuard()(Y.encodeStateAsUpdate(copy, before), {
      document: doc, awareness, now: 0,
      peer: { sub: 'agent', room: 'test', role: 'agent', caps: ['propose'] },
    })
  } finally {
    awareness.destroy()
    copy.destroy()
    doc.destroy()
  }
}

describe('feature integration', () => {
  it('dictates into the selected tab', () => {
    const doc = createDoc()
    const main = appendBlock(doc, 'paragraph', 'main')
    const key = tabBlocksKey(createTab(doc, 'Other'))
    const blockId = blockOrder(doc, key)[0]
    const transcriber = createFakeTranscriber()
    const target = { blockId, caret: 0, blocksKey: key }
    const dictation = createDictation(doc, transcriber, () => target)
    transcriber.start()
    transcriber.emitFinal('spoken words')
    expect(blockTextString(doc, blockId, undefined, key)).toBe('spoken words')
    expect(blockTextString(doc, main)).toBe('main')
    dictation.destroy()
    doc.destroy()
  })

  it('does not turn an image into an invalid text block through formatting', () => {
    const doc = createDoc()
    const text = appendBlock(doc, 'paragraph', 'text')
    const image = insertImageAfter(doc, text, { src: 'data:image/png;base64,AA==' })
    setBlockType(doc, image, 'heading')
    expect(blockViews(doc)[1].type).toBe('image')
    doc.destroy()
  })

  it('retains tabs created concurrently on separate replicas', () => {
    const left = createDoc()
    const right = fork(left)
    const a = createTab(left, 'Left')
    const b = createTab(right, 'Right')
    const leftUpdate = Y.encodeStateAsUpdate(left)
    const rightUpdate = Y.encodeStateAsUpdate(right)
    Y.applyUpdate(left, rightUpdate)
    Y.applyUpdate(right, leftUpdate)
    expect(listTabs(left).map(t => t.id)).toEqual(expect.arrayContaining([a, b]))
    expect(listTabs(left)).toEqual(listTabs(right))
    left.destroy()
    right.destroy()
  })

  it('retains independent concurrent tab renames', () => {
    const left = createDoc()
    const a = createTab(left, 'First')
    const b = createTab(left, 'Second')
    const right = fork(left)
    renameTab(left, a, 'Renamed first')
    renameTab(right, b, 'Renamed second')
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right))
    expect(listTabs(left)).toEqual(expect.arrayContaining([
      { id: a, title: 'Renamed first' }, { id: b, title: 'Renamed second' },
    ]))
    left.destroy()
    right.destroy()
  })

  it('allows a cold text edit when document contains an image', () => {
    const doc = createDoc()
    const ids = Array.from({ length: 40 }, (_, i) => appendBlock(doc, 'paragraph', String(i)))
    insertImageAfter(doc, ids[4], { src: 'data:image/png;base64,AA==' })
    expect(decide(doc, ids[3], copy => setBlockText(copy, ids[30], 'cold edit'))).toEqual({ ok: true })
  })

  it('refuses image appearance edits beneath a reader', () => {
    const doc = createDoc()
    const text = appendBlock(doc, 'paragraph', 'text')
    const image = insertImageAfter(doc, text, { src: 'data:image/png;base64,AA==' })
    expect(decide(doc, image, copy => updateImage(copy, image, { widthPct: 20 })).ok).toBe(false)
  })

  it('protects a reader on a nondefault tab', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'default')
    const tab = createTab(doc, 'Other')
    const key = tabBlocksKey(tab)
    const id = blockOrder(doc, key)[0]
    expect(decide(doc, id, copy => setBlockText(copy, id, 'intruder', undefined, undefined, key)).ok).toBe(false)
  })
})
