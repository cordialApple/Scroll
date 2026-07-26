import type {
  Transcriber,
  TranscriberError,
  TranscriberState,
  TranscriptEvent,
} from './transcriber'

export interface FakeTranscriber extends Transcriber {
  emitInterim(text: string): void
  emitFinal(text: string): void
  emitError(err: TranscriberError): void
}

export function createFakeTranscriber(): FakeTranscriber {
  let state: TranscriberState = 'idle'
  const results = new Set<(e: TranscriptEvent) => void>()
  const states = new Set<(s: TranscriberState) => void>()
  const errors = new Set<(e: TranscriberError) => void>()

  const setState = (s: TranscriberState) => {
    if (s === state) return
    state = s
    for (const cb of states) cb(s)
  }
  const result = (e: TranscriptEvent) => {
    if (state !== 'listening') return
    for (const cb of results) cb(e)
  }

  return {
    get state() {
      return state
    },
    start: () => setState('listening'),
    stop: () => setState('idle'),
    onResult: (cb) => {
      results.add(cb)
      return () => results.delete(cb)
    },
    onStateChange: (cb) => {
      states.add(cb)
      return () => states.delete(cb)
    },
    onError: (cb) => {
      errors.add(cb)
      return () => errors.delete(cb)
    },
    emitInterim: (text) => result({ text, isFinal: false }),
    emitFinal: (text) => result({ text, isFinal: true }),
    emitError: (err) => {
      setState('error')
      for (const cb of errors) cb(err)
    },
  }
}
