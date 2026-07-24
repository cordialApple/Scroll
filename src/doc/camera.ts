import type { Anchor } from '../layout/layout'

const KEY = (docId: string) => `scroll.camera.${docId}`

export function loadCamera(docId: string): Anchor | null {
  try {
    const raw = localStorage.getItem(KEY(docId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.blockId === 'string' && typeof parsed?.offset === 'number') {
      return { blockId: parsed.blockId, offset: parsed.offset }
    }
  } catch {
    /* ignore corrupt camera */
  }
  return null
}

export function saveCamera(docId: string, anchor: Anchor): void {
  try {
    localStorage.setItem(KEY(docId), JSON.stringify(anchor))
  } catch {
    /* storage full or unavailable — camera is best-effort */
  }
}
