import { describe, it } from 'vitest'
import fc from 'fast-check'
import * as Y from 'yjs'
import {
  createDoc,
  appendBlock,
  blockOrder,
  blockViews,
  indexOfBlock,
  resolveBlockIndex,
  redirects,
  setBlockText,
  insertBlockAfter,
  splitBlock,
  mergeIntoPrevious,
} from '../../doc/model'
import { pbtAssert } from './harness'

const view = (d: Y.Doc) => blockViews(d).map((v) => ({ type: v.type, text: v.text }))

type MOp =
  | { k: 'text'; sel: number; text: string; corrupt: boolean }
  | { k: 'insert'; sel: number; text: string; corrupt: boolean }
  | { k: 'split'; sel: number; off: number; corrupt: boolean }
  | { k: 'merge'; sel: number; corrupt: boolean }

const mopArb: fc.Arbitrary<MOp> = fc.oneof(
  fc.record({ k: fc.constant('text' as const), sel: fc.nat(), text: fc.string({ maxLength: 10 }), corrupt: fc.boolean() }),
  fc.record({ k: fc.constant('insert' as const), sel: fc.nat(), text: fc.string({ maxLength: 10 }), corrupt: fc.boolean() }),
  fc.record({ k: fc.constant('split' as const), sel: fc.nat(), off: fc.nat(), corrupt: fc.boolean() }),
  fc.record({ k: fc.constant('merge' as const), sel: fc.nat(), corrupt: fc.boolean() }),
)

describe('PBT: fast block locate is hint-independent (perf S3)', () => {
  it('resolveBlockIndex equals indexOfBlock for correct / stale / out-of-range / undefined hints', () => {
    pbtAssert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.nat(),
        fc.boolean(),
        fc.option(fc.integer({ min: -3, max: 33 }), { nil: undefined }),
        (n, sel, absent, hint) => {
          const doc = createDoc()
          for (let i = 0; i < n; i++) appendBlock(doc, 'paragraph', `b${i}`)
          const id = absent ? '__nope__' : blockOrder(doc)[sel % n]
          return resolveBlockIndex(doc, id, hint) === indexOfBlock(doc, id)
        },
      ),
    )
  })

  // two docs, same ops: A resolves via at-hint (correct or corrupted), B via plain scan — if hint ever changed which
  // block got touched, structure/redirect count would diverge
  it('mutators with a hint (even a corrupted one) match mutators without, structurally', () => {
    pbtAssert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.array(mopArb, { maxLength: 40 }), (base, ops) => {
        const a = createDoc()
        const b = createDoc()
        for (let i = 0; i < base; i++) {
          appendBlock(a, 'paragraph', `s${i}`)
          appendBlock(b, 'paragraph', `s${i}`)
        }

        for (const op of ops) {
          const len = blockViews(a).length
          const i = op.sel % len
          const idA = blockOrder(a)[i]
          const idB = blockOrder(b)[i]
          const hint = op.corrupt ? i + 1 : i

          if (op.k === 'text') {
            setBlockText(a, idA, op.text, hint)
            setBlockText(b, idB, op.text)
          } else if (op.k === 'insert') {
            insertBlockAfter(a, idA, 'paragraph', op.text, hint)
            insertBlockAfter(b, idB, 'paragraph', op.text)
          } else if (op.k === 'split') {
            splitBlock(a, idA, op.off, hint)
            splitBlock(b, idB, op.off)
          } else {
            mergeIntoPrevious(a, idA, hint)
            mergeIntoPrevious(b, idB)
          }

          if (JSON.stringify(view(a)) !== JSON.stringify(view(b))) return false
          if (redirects(a).size !== redirects(b).size) return false
        }
        return true
      }),
    )
  })
})
