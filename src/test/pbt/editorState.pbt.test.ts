import { describe, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import {
  createDoc,
  appendBlock,
  blocks,
  blockOrder,
  setBlockText,
  insertBlockAfter,
  splitBlock,
  mergeIntoPrevious,
  type BlockType,
} from '../../doc/model'
import { buildDocModel, applyEvents, setMeasured, type DocModel, type HeightSource } from '../../editor/docModel'
import { pbtAssert } from './harness'

type EOp =
  | { k: 'text'; sel: number; text: string }
  | { k: 'insertAfter'; sel: number; type: BlockType; text: string }
  | { k: 'split'; sel: number; off: number }
  | { k: 'merge'; sel: number }
  | { k: 'append'; type: BlockType; text: string }

// Height variance is load-bearing: types + line-crossing lengths make estimateHeight non-uniform, so
// a prefix-sum mismatch actually discriminates. (Uniform heights made ixEst drift undetectable.)
const typeArb = fc.constantFrom<BlockType>('paragraph', 'heading', 'quote')
const textArb = fc.string({ maxLength: 300 })

const eopArb: fc.Arbitrary<EOp> = fc.oneof(
  fc.record({ k: fc.constant('text' as const), sel: fc.nat(), text: textArb }),
  fc.record({ k: fc.constant('insertAfter' as const), sel: fc.nat(), type: typeArb, text: textArb }),
  fc.record({ k: fc.constant('split' as const), sel: fc.nat(), off: fc.nat() }),
  fc.record({ k: fc.constant('merge' as const), sel: fc.nat() }),
  fc.record({ k: fc.constant('append' as const), type: typeArb, text: textArb }),
)

// The exact drift oracle: the incrementally-maintained model must equal a from-scratch rebuild of
// the same doc — order, per-block estimate, and both indices' prefix-heights — after EVERY op.
function tracksFresh(model: DocModel, doc: Y.Doc, src: HeightSource): boolean {
  const fresh = buildDocModel(doc, src)
  if (JSON.stringify(model.order) !== JSON.stringify(fresh.order)) return false
  if (JSON.stringify(model.order) !== JSON.stringify(blockOrder(doc))) return false
  // Direct structural equality on both indices — catches ghost/misplaced entries regardless of
  // height, so ixEst drift is detected even where prefix-sums happen to coincide.
  if (JSON.stringify(model.ix.order()) !== JSON.stringify(fresh.ix.order())) return false
  if (JSON.stringify(model.ixEst.order()) !== JSON.stringify(fresh.ixEst.order())) return false
  for (const id of model.order) if (model.estimates.get(id) !== fresh.estimates.get(id)) return false
  if (model.estimates.size !== fresh.estimates.size) return false
  const n = model.order.length
  for (let k = 0; k <= n; k++) {
    if (model.ix.prefixHeight(k) !== fresh.ix.prefixHeight(k)) return false
    if (model.ixEst.prefixHeight(k) !== fresh.ixEst.prefixHeight(k)) return false
  }
  return true
}

function run(base: number, ops: EOp[], src: HeightSource): boolean {
  const doc = createDoc()
  const seedTypes: BlockType[] = ['paragraph', 'heading', 'quote']
  for (let i = 0; i < base; i++) appendBlock(doc, seedTypes[i % 3], `seed ${i} `.repeat(1 + (i % 9)))
  const model = buildDocModel(doc, src)
  const cb = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => applyEvents(model, doc, events, src)
  blocks(doc).observeDeep(cb)

  for (const op of ops) {
    const len = blockOrder(doc).length
    if (op.k === 'append') appendBlock(doc, op.type, op.text)
    else {
      const id = blockOrder(doc)[op.sel % len]
      if (op.k === 'text') setBlockText(doc, id, op.text)
      else if (op.k === 'insertAfter') insertBlockAfter(doc, id, op.type, op.text)
      else if (op.k === 'split') splitBlock(doc, id, op.off)
      else mergeIntoPrevious(doc, id)
    }
    if (!tracksFresh(model, doc, src)) return false
  }
  blocks(doc).unobserveDeep(cb)
  return true
}

describe('PBT: incremental Editor state tracks a full rebuild (perf S4 drift oracle)', () => {
  const NONE: HeightSource = { measuredOf: () => undefined }

  it('order + estimates + indices stay drift-free vs full rebuild (pure estimates)', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.array(eopArb, { maxLength: 40 }), (base, ops) =>
        run(base, ops, NONE),
      ),
    )
  })

  // A fixed measured-height map exercises the effective index (ix ≠ ixEst): applyEvents must feed
  // measured?estimate into ix on insert/edit, and it must still equal a fresh rebuild under the same
  // source. (Static source ⇒ a fresh rebuild reproduces exactly what the incremental path produced.)
  it('effective index tracks a full rebuild under a fixed measured-height map', () => {
    const measured: HeightSource = {
      measuredOf: (id) => {
        let h = 0
        for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff
        return h % 3 === 0 ? 60 + (h % 40) : undefined
      },
    }
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.array(eopArb, { maxLength: 40 }), (base, ops) =>
        run(base, ops, measured),
      ),
    )
  })

  it('setMeasured re-syncs only the effective index to the current source', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.nat(), (base, sel) => {
        const doc = createDoc()
        for (let i = 0; i < base; i++) appendBlock(doc, 'paragraph', `seed ${i}`)
        const store = new Map<string, number>()
        const src: HeightSource = { measuredOf: (id) => store.get(id) }
        const model = buildDocModel(doc, src)
        const id = blockOrder(doc)[sel % base]

        const estBefore = model.estimates.get(id)!
        store.set(id, 999)
        setMeasured(model, id, src)

        const i = model.ix.indexOf(id)
        const measuredH = model.ix.prefixHeight(i + 1) - model.ix.prefixHeight(i)
        const estH = model.ixEst.prefixHeight(i + 1) - model.ixEst.prefixHeight(i)
        return measuredH === 999 && estH === estBefore
      }),
    )
  })
})
