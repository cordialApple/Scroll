import { describe, it, expect } from 'vitest'
import { emptyLru, markWorked, selectNext, type LruState } from './coldScheduler'

const lru = (entries: [string, number][]): LruState => ({ lastWorked: new Map(entries) })

describe('coldScheduler — cold-region LRU (P6.4)', () => {
  it('returns null when nothing is cold', () => {
    expect(selectNext(emptyLru, [])).toBeNull()
  })

  it('prefers a never-worked block, earliest in document order', () => {
    expect(selectNext(lru([['b0', 100], ['b2', 50]]), ['b0', 'b1', 'b2'])).toBe('b1')
  })

  it('when all are worked, picks the least-recently-worked', () => {
    expect(selectNext(lru([['b0', 300], ['b1', 100], ['b2', 200]]), ['b0', 'b1', 'b2'])).toBe('b1')
  })

  it('breaks ties by the given (document) order', () => {
    expect(selectNext(lru([['b0', 100], ['b1', 100]]), ['b1', 'b0'])).toBe('b1')
  })

  it('markWorked records the timestamp and prunes absent blocks', () => {
    const s = markWorked(lru([['gone', 5], ['b0', 1]]), 'b1', 42, ['b0', 'b1'])
    expect(s.lastWorked.get('b1')).toBe(42)
    expect(s.lastWorked.get('b0')).toBe(1)
    expect(s.lastWorked.has('gone')).toBe(false)
  })

  it('markWorked updates an existing block in place', () => {
    expect(markWorked(lru([['b0', 1]]), 'b0', 99, ['b0']).lastWorked.get('b0')).toBe(99)
  })

  it('among multiple never-worked blocks, picks the earliest in the given order', () => {
    expect(selectNext(emptyLru, ['b2', 'b0', 'b1'])).toBe('b2')
  })

  it('returns a member (never null) for non-empty cold even when timestamps are non-finite', () => {
    expect(selectNext(lru([['b0', Infinity], ['b1', Infinity]]), ['b0', 'b1'])).toBe('b0')
    expect(selectNext(lru([['b0', NaN]]), ['b0'])).toBe('b0')
  })

  it('markWorked records the just-worked id even when absent from present, then prunes it next call', () => {
    const s1 = markWorked(emptyLru, 'ghost', 100, [])
    expect(s1.lastWorked.get('ghost')).toBe(100)
    const s2 = markWorked(s1, 'real', 200, ['real'])
    expect(s2.lastWorked.has('ghost')).toBe(false)
    expect(s2.lastWorked.get('real')).toBe(200)
  })
})
