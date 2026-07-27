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
  setBlockAuthor,
  setBlockText,
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
    expect(id).toBe(blockViewOf(blocks(clone).get(0)).id)
  })
})
