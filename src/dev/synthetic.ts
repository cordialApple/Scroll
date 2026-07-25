import * as Y from 'yjs'
import { blocks, blockId, makeBlock, resolveBlockIndex, mergeIntoPrevious } from '../doc/model'

const WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud'.split(' ')

function pseudoText(seed: number, words: number): string {
  const out: string[] = []
  let s = seed
  for (let i = 0; i < words; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out.push(WORDS[s % WORDS.length])
  }
  return out.join(' ')
}

export function insertAbove(doc: Y.Doc, beforeBlockId: string, count: number, seed = 1, hint?: number): string[] {
  const at = Math.max(0, resolveBlockIndex(doc, beforeBlockId, hint))
  const created: Y.Map<unknown>[] = []
  for (let i = 0; i < count; i++) {
    const words = 3 + ((seed + i * 7) % 40)
    created.push(makeBlock('paragraph', pseudoText(seed + i, words)))
  }
  doc.transact(() => {
    blocks(doc).insert(at, created)
  })
  return created.map(blockId)
}

export function deleteAbove(doc: Y.Doc, beforeBlockId: string, count: number, hint?: number): void {
  const at = Math.max(0, resolveBlockIndex(doc, beforeBlockId, hint))
  const n = Math.min(count, at)
  if (n <= 0) return
  doc.transact(() => {
    blocks(doc).delete(at - n, n)
  })
}

export { mergeIntoPrevious }
