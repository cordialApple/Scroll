import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  AUTHOR_AGENT,
  AUTHOR_HUMAN,
  appendBlock,
  blockAuthor,
  blockViewOf,
  blocks,
  createDoc,
  mergeIntoPrevious,
  setBlockAuthor,
  setBlockText,
  splitBlock,
} from './model'

const first = (doc: Y.Doc) => blocks(doc).get(0)

describe('block provenance (P6.7)', () => {
  it('unstamped: no author, and blockViewOf omits the key (a plain view stays {id,type,text})', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'hello')
    expect(blockAuthor(first(doc))).toBeUndefined()
    expect(blockViewOf(first(doc))).toEqual({ id, type: 'paragraph', text: 'hello' })
    expect('author' in blockViewOf(first(doc))).toBe(false)
  })

  it('setBlockAuthor stamps and surfaces through blockViewOf', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'hi')
    setBlockAuthor(doc, id, AUTHOR_AGENT)
    expect(blockAuthor(first(doc))).toBe(AUTHOR_AGENT)
    expect(blockViewOf(first(doc)).author).toBe(AUTHOR_AGENT)
  })

  it('setBlockAuthor is idempotent — a redundant stamp creates no op', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'hi')
    setBlockAuthor(doc, id, AUTHOR_AGENT)
    const sv = Y.encodeStateVector(doc)
    setBlockAuthor(doc, id, AUTHOR_AGENT)
    expect(Y.encodeStateVector(doc)).toEqual(sv) // no clock advance ⇒ no op written
  })

  it('setBlockAuthor no-ops a missing block', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'hi')
    expect(() => setBlockAuthor(doc, 'nope', AUTHOR_AGENT)).not.toThrow()
    expect(blockAuthor(first(doc))).toBeUndefined()
  })

  it('setBlockText stamps the author in the SAME transaction as the text (one render, not two)', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'orig')
    let txns = 0
    doc.on('afterTransaction', () => void txns++)
    setBlockText(doc, id, 'edited', undefined, AUTHOR_HUMAN)
    expect(txns).toBe(1)
    expect(blockViewOf(first(doc))).toMatchObject({ text: 'edited', author: AUTHOR_HUMAN })
  })

  it('a human edit clears an agent marker (last writer wins)', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'agent wrote this')
    setBlockAuthor(doc, id, AUTHOR_AGENT)
    setBlockText(doc, id, 'human rewrote', undefined, AUTHOR_HUMAN)
    expect(blockAuthor(first(doc))).toBe(AUTHOR_HUMAN)
  })

  it('setBlockText without an author argument leaves an existing marker intact', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'x')
    setBlockAuthor(doc, id, AUTHOR_AGENT)
    setBlockText(doc, id, 'changed', undefined)
    expect(blockAuthor(first(doc))).toBe(AUTHOR_AGENT)
  })

  it('provenance lives in the CRDT — it survives an encode/apply round-trip to another peer', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'x')
    setBlockAuthor(doc, id, AUTHOR_AGENT)
    const clone = createDoc()
    Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc))
    expect(blockAuthor(blocks(clone).get(0))).toBe(AUTHOR_AGENT)
    expect(blockViewOf(blocks(clone).get(0))).toMatchObject({ id, author: AUTHOR_AGENT })
  })

  it('blockAuthor rejects a garbage lastAuthor value off the wire (not agent|human ⇒ undefined)', () => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'x')
    blocks(doc).get(0).set('lastAuthor', 'martian')
    expect(blockAuthor(blocks(doc).get(0))).toBeUndefined()
  })

  // Structural edits (#72 PF2): authorship follows CONTENT, so split/merge must NOT invent a 'human' stamp on
  // unchanged text. The tail inherits the source author; merging two agent blocks stays agent.
  it('splitBlock: the tail inherits the source author, in one transaction', () => {
    const doc = createDoc()
    const id = appendBlock(doc, 'paragraph', 'agent wrote all of this')
    setBlockAuthor(doc, id, AUTHOR_AGENT)
    let txns = 0
    doc.on('afterTransaction', () => void txns++)
    const tail = splitBlock(doc, id, 5)
    expect(tail).not.toBeNull()
    expect(txns).toBe(1) // tail-inherit rides splitBlock's single transact, not a separate stamp
    expect(blockAuthor(blocks(doc).get(0))).toBe(AUTHOR_AGENT) // head keeps agent (content unchanged)
    expect(blockAuthor(blocks(doc).get(1))).toBe(AUTHOR_AGENT) // tail inherits agent
  })

  it('mergeIntoPrevious: merging two agent blocks keeps the survivor agent (no false human overwrite)', () => {
    const doc = createDoc()
    const a = appendBlock(doc, 'paragraph', 'first')
    const b = appendBlock(doc, 'paragraph', 'second')
    setBlockAuthor(doc, a, AUTHOR_AGENT)
    setBlockAuthor(doc, b, AUTHOR_AGENT)
    expect(mergeIntoPrevious(doc, b, 1)).toBe(a)
    expect(blockAuthor(blocks(doc).get(0))).toBe(AUTHOR_AGENT)
  })
})
