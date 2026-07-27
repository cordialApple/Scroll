import * as Y from 'yjs'
import { newBlockId } from './ids'
import type { RedirectSource } from './redirects'

export type BlockType = 'paragraph' | 'heading' | 'quote'
export type BlockAuthor = 'agent' | 'human'
export const AUTHOR_AGENT: BlockAuthor = 'agent'
export const AUTHOR_HUMAN: BlockAuthor = 'human'

export interface BlockView {
  id: string
  type: BlockType
  text: string
  author?: BlockAuthor
}

const BLOCKS = 'blocks'
const REDIRECTS = 'redirects'

export function createDoc(): Y.Doc {
  return new Y.Doc({ gc: false })
}

export function blocks(doc: Y.Doc): Y.Array<Y.Map<unknown>> {
  return doc.getArray<Y.Map<unknown>>(BLOCKS)
}

export function redirects(doc: Y.Doc): Y.Map<string> {
  return doc.getMap<string>(REDIRECTS)
}

export function redirectSource(doc: Y.Doc): RedirectSource {
  const map = redirects(doc)
  return { get: (id) => map.get(id) }
}

export function makeBlock(type: BlockType, text: string): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('id', newBlockId())
  m.set('type', type)
  const t = new Y.Text()
  if (text) t.insert(0, text)
  m.set('text', t)
  return m
}

export function blockId(m: Y.Map<unknown>): string {
  return m.get('id') as string
}

export function blockType(m: Y.Map<unknown>): BlockType {
  return (m.get('type') as BlockType) ?? 'paragraph'
}

export function blockText(m: Y.Map<unknown>): Y.Text {
  return m.get('text') as Y.Text
}

export function blockAuthor(m: Y.Map<unknown>): BlockAuthor | undefined {
  const v = m.get('lastAuthor')
  return v === AUTHOR_AGENT ? AUTHOR_AGENT : v === AUTHOR_HUMAN ? AUTHOR_HUMAN : undefined
}

export function blockOrder(doc: Y.Doc): string[] {
  return blocks(doc).map(blockId)
}

export function indexOfBlock(doc: Y.Doc, id: string): number {
  const arr = blocks(doc)
  for (let i = 0; i < arr.length; i++) {
    if (blockId(arr.get(i)) === id) return i
  }
  return -1
}

// at-hint from caller's OrderIndex trusted only if still points at id (O(1) check), else falls back to O(n) scan —
// result always == indexOfBlock regardless of staleness, hint is pure speed shortcut
export function resolveBlockIndex(doc: Y.Doc, id: string, at?: number): number {
  if (at !== undefined) {
    const arr = blocks(doc)
    if (at >= 0 && at < arr.length && blockId(arr.get(at)) === id) return at
  }
  return indexOfBlock(doc, id)
}

export function blockViewOf(m: Y.Map<unknown>): BlockView {
  const view: BlockView = { id: blockId(m), type: blockType(m), text: blockText(m).toString() }
  const author = blockAuthor(m)
  if (author) view.author = author
  return view
}

export function blockViews(doc: Y.Doc): BlockView[] {
  return blocks(doc).map(blockViewOf)
}

export function setBlockText(doc: Y.Doc, id: string, text: string, at?: number, author?: BlockAuthor): void {
  const idx = resolveBlockIndex(doc, id, at)
  if (idx < 0) return
  const m = blocks(doc).get(idx)
  const t = blockText(m)
  doc.transact(() => {
    t.delete(0, t.length)
    if (text) t.insert(0, text)
    if (author && blockAuthor(m) !== author) m.set('lastAuthor', author)
  })
}

export function setBlockAuthor(doc: Y.Doc, id: string, author: BlockAuthor, at?: number): void {
  const idx = resolveBlockIndex(doc, id, at)
  if (idx < 0) return
  const m = blocks(doc).get(idx)
  if (blockAuthor(m) === author) return
  doc.transact(() => m.set('lastAuthor', author))
}

export function blockTextString(doc: Y.Doc, id: string, at?: number): string | null {
  const idx = resolveBlockIndex(doc, id, at)
  return idx < 0 ? null : blockText(blocks(doc).get(idx)).toString()
}

export function insertBlockText(
  doc: Y.Doc,
  id: string,
  offset: number,
  text: string,
  at?: number,
): void {
  if (!text) return
  const idx = resolveBlockIndex(doc, id, at)
  if (idx < 0) return
  const t = blockText(blocks(doc).get(idx))
  const pos = Math.max(0, Math.min(offset, t.length))
  doc.transact(() => t.insert(pos, text))
}

export function insertBlockAfter(
  doc: Y.Doc,
  id: string,
  type: BlockType,
  text: string,
  at?: number,
): string {
  const idx = resolveBlockIndex(doc, id, at)
  const block = makeBlock(type, text)
  doc.transact(() => {
    blocks(doc).insert(idx < 0 ? blocks(doc).length : idx + 1, [block])
  })
  return blockId(block)
}

export function appendBlock(doc: Y.Doc, type: BlockType, text: string): string {
  const block = makeBlock(type, text)
  doc.transact(() => {
    blocks(doc).push([block])
  })
  return blockId(block)
}

export function splitBlock(doc: Y.Doc, id: string, charOffset: number, at?: number): string | null {
  const idx = resolveBlockIndex(doc, id, at)
  if (idx < 0) return null
  const arr = blocks(doc)
  const src = arr.get(idx)
  const t = blockText(src)
  const tail = t.toString().slice(charOffset)
  const next = makeBlock(blockType(src), tail)
  const author = blockAuthor(src)
  if (author) next.set('lastAuthor', author) // structural split moves content; the tail keeps its origin
  doc.transact(() => {
    if (t.length > charOffset) t.delete(charOffset, t.length - charOffset)
    arr.insert(idx + 1, [next])
  })
  return blockId(next)
}

export function mergeIntoPrevious(doc: Y.Doc, id: string, at?: number): string | null {
  const idx = resolveBlockIndex(doc, id, at)
  if (idx <= 0) return null
  const arr = blocks(doc)
  const src = arr.get(idx)
  const prev = arr.get(idx - 1)
  const prevId = blockId(prev)
  const prevText = blockText(prev)
  const moved = blockText(src).toString()
  doc.transact(() => {
    if (moved) prevText.insert(prevText.length, moved)
    arr.delete(idx, 1)
    redirects(doc).set(id, prevId)
  })
  return prevId
}

export function seedIfEmpty(doc: Y.Doc): void {
  if (blocks(doc).length > 0) return
  doc.transact(() => {
    const arr = blocks(doc)
    arr.push([
      makeBlock('heading', 'Untitled document'),
      makeBlock('paragraph', ''),
    ])
  })
}
