import { describe, it, expect, vi } from 'vitest'
import {
  createDoc,
  appendBlock,
  blocks,
  blockOrder,
  setBlockText,
  splitBlock,
  mergeIntoPrevious,
} from '../doc/model'

const N = 60

function bigDoc() {
  const doc = createDoc()
  for (let i = 0; i < N; i++) appendBlock(doc, 'paragraph', `block ${i}`)
  return doc
}

type Mutate = (doc: ReturnType<typeof bigDoc>, id: string, at: number | undefined) => void

// Count Y.Array element reads during one mutation targeting the LAST block (worst case for a scan). A
// valid at-hint => resolveBlockIndex verifies one slot and returns; no hint => indexOfBlock walks all N.
// Spying the array instance's get is the empirical teeth for the O(1)-vs-O(n) locate claim.
function reads(mutate: Mutate, hinted: boolean): number {
  const doc = bigDoc()
  const lastId = blockOrder(doc)[N - 1]
  const spy = vi.spyOn(blocks(doc), 'get')
  mutate(doc, lastId, hinted ? N - 1 : undefined)
  const n = spy.mock.calls.length
  spy.mockRestore()
  return n
}

function expectShortCircuit(name: string, mutate: Mutate) {
  const hinted = reads(mutate, true)
  const scanned = reads(mutate, false)
  expect(hinted, `${name}: hinted is O(1)`).toBeLessThanOrEqual(5)
  expect(scanned, `${name}: unhinted scans O(n)`).toBeGreaterThanOrEqual(N)
  expect(scanned, `${name}: clear O(1) vs O(n) separation`).toBeGreaterThan(hinted * 5)
}

describe('perf: a valid at-hint short-circuits the O(n) locate scan (write path, S7)', () => {
  it('setBlockText — hinted keystroke reads O(1) slots, unhinted scans O(n)', () => {
    expectShortCircuit('setBlockText', (doc, id, at) => setBlockText(doc, id, 't', at))
  })
  it('splitBlock — hinted split reads O(1) slots, unhinted scans O(n)', () => {
    expectShortCircuit('splitBlock', (doc, id, at) => void splitBlock(doc, id, 2, at))
  })
  it('mergeIntoPrevious — hinted merge reads O(1) slots, unhinted scans O(n)', () => {
    expectShortCircuit('mergeIntoPrevious', (doc, id, at) => void mergeIntoPrevious(doc, id, at))
  })
})
