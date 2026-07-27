import type * as Y from 'yjs'
import { blockTextString, insertBlockText } from '../doc/model'
import type { Transcriber, TranscriptEvent } from './transcriber'

export interface DictationTarget {
  blockId: string
  caret: number
}

export interface Dictation {
  readonly interimText: string
  observeInterim(cb: (interim: string) => void): () => void
  observeCommit(cb: (target: DictationTarget, inserted: string) => void): () => void
  destroy(): void
}

// Space between a preceding word char and a following word char; never before punctuation/closers.
function needsSpace(before: string, next: string): boolean {
  if (before.length === 0 || next.length === 0) return false
  if (/\s$/.test(before)) return false
  return !/^[\s.,!?;:)\]}]/.test(next)
}

export function createDictation(
  doc: Y.Doc,
  transcriber: Transcriber,
  getTarget: () => DictationTarget | null,
): Dictation {
  let interim = ''
  const interimCbs = new Set<(t: string) => void>()
  const commitCbs = new Set<(t: DictationTarget, inserted: string) => void>()

  const setInterim = (t: string) => {
    if (t === interim) return
    interim = t
    for (const cb of interimCbs) cb(t)
  }

  const onResult = (e: TranscriptEvent) => {
    // A real recognizer can fire a late/spurious final around end/error; only mutate while listening.
    if (transcriber.state !== 'listening') return
    if (!e.isFinal) {
      setInterim(e.text)
      return
    }
    const target = getTarget()
    if (!target || !e.text.trim()) {
      setInterim('')
      return
    }
    const full = blockTextString(doc, target.blockId)
    if (full === null) {
      setInterim('')
      return
    }
    const caret = Math.max(0, Math.min(target.caret, full.length))
    const inserted = (needsSpace(full.slice(0, caret), e.text) ? ' ' : '') + e.text
    insertBlockText(doc, target.blockId, caret, inserted)
    setInterim('')
    const next: DictationTarget = { blockId: target.blockId, caret: caret + inserted.length }
    for (const cb of commitCbs) cb(next, inserted)
  }

  // Leaving 'listening' discards any provisional tail — interim is never persisted (commit-on-final).
  const onStateChange = (s: string) => {
    if (s !== 'listening') setInterim('')
  }

  const offResult = transcriber.onResult(onResult)
  const offState = transcriber.onStateChange(onStateChange)

  return {
    get interimText() {
      return interim
    },
    observeInterim: (cb) => {
      interimCbs.add(cb)
      return () => interimCbs.delete(cb)
    },
    observeCommit: (cb) => {
      commitCbs.add(cb)
      return () => commitCbs.delete(cb)
    },
    destroy: () => {
      offResult()
      offState()
      interimCbs.clear()
      commitCbs.clear()
    },
  }
}
