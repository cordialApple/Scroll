import { describe, it, expect } from 'vitest'
import { resolveRedirect, mapAsRedirectSource } from '../doc/redirects'

describe('redirect resolution', () => {
  it('resolves a multi-hop chain transitively', () => {
    const m = new Map([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ])
    const r = resolveRedirect(mapAsRedirectSource(m), 'a', 99)
    expect(r.blockId).toBe('d')
    expect(r.hops).toBe(3)
    expect(r.offset).toBe(0)
  })

  it('returns the original id and offset when there is no redirect', () => {
    const r = resolveRedirect(mapAsRedirectSource(new Map()), 'x', 17)
    expect(r).toEqual({ blockId: 'x', offset: 17, hops: 0 })
  })

  it('terminates on a cycle instead of looping forever', () => {
    const m = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ])
    const r = resolveRedirect(mapAsRedirectSource(m), 'a', 5)
    expect(r.blockId).toBe('b')
    expect(r.hops).toBe(1)
  })

  it('terminates on a self-loop', () => {
    const m = new Map([['a', 'a']])
    const r = resolveRedirect(mapAsRedirectSource(m), 'a', 5)
    expect(r.blockId).toBe('a')
    expect(r.hops).toBe(0)
  })
})
