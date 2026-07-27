import type {
  Transcriber,
  TranscriberError,
  TranscriberErrorKind,
  TranscriberState,
  TranscriptEvent,
} from './transcriber'

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean
  readonly length: number
  readonly [i: number]: SpeechRecognitionAlternativeLike
}

interface SpeechRecognitionResultListLike {
  readonly length: number
  readonly [i: number]: SpeechRecognitionResultLike
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultListLike
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string
  readonly message?: string
}

export interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike

export interface WebSpeechOptions {
  lang?: string
  recognitionCtor?: SpeechRecognitionCtor
}

type GlobalWithSpeech = {
  SpeechRecognition?: SpeechRecognitionCtor
  webkitSpeechRecognition?: SpeechRecognitionCtor
  navigator?: { language?: string }
}

function globalCtor(): SpeechRecognitionCtor | null {
  const g = globalThis as unknown as GlobalWithSpeech
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null
}

function resolveCtor(opts: WebSpeechOptions): SpeechRecognitionCtor | null {
  return opts.recognitionCtor ?? globalCtor()
}

export function isSpeechRecognitionSupported(): boolean {
  return globalCtor() !== null
}

// A native error string aborts recognition permanently — restarting can't recover it.
const HARD_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture'])

function classify(error: string): TranscriberErrorKind {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'permission-denied'
    case 'no-speech':
      return 'no-speech'
    case 'network':
      return 'network'
    case 'aborted':
      return 'aborted'
    default:
      return 'unknown'
  }
}

// Web Speech adapter for the Transcriber interface. Maps native onresult (a cumulative results list)
// to per-segment deltas on finals and a full provisional tail on interim, per transcriber.ts's
// TranscriptEvent contract. Transient no-speech/network end the session; onend auto-restarts while
// still intended-running (mirrors the reconnect-code discipline). not-allowed/audio-capture are hard.
export function createWebSpeechTranscriber(opts: WebSpeechOptions = {}): Transcriber {
  let state: TranscriberState = 'idle'
  let recognition: SpeechRecognitionLike | null = null
  let ctor: SpeechRecognitionCtor | null = null
  let intendedRunning = false
  // Count of results already emitted as finals this session — guards the delta path against
  // re-emitting a finalized segment if the native results list replays it.
  let finalizedCount = 0

  const results = new Set<(e: TranscriptEvent) => void>()
  const states = new Set<(s: TranscriberState) => void>()
  const errors = new Set<(e: TranscriberError) => void>()

  const setState = (s: TranscriberState) => {
    if (s === state) return
    state = s
    for (const cb of states) cb(s)
  }
  const emitResult = (e: TranscriptEvent) => {
    for (const cb of results) cb(e)
  }
  const emitError = (err: TranscriberError) => {
    for (const cb of errors) cb(err)
  }

  const handleResult = (e: SpeechRecognitionEventLike) => {
    let interim = ''
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i]
      const transcript = r[0]?.transcript ?? ''
      if (r.isFinal) {
        if (i >= finalizedCount) {
          finalizedCount = i + 1
          const text = transcript.trim()
          if (text) emitResult({ text, isFinal: true })
        }
      } else {
        interim += transcript
      }
    }
    emitResult({ text: interim.trim(), isFinal: false })
  }

  const handleError = (e: SpeechRecognitionErrorEventLike) => {
    const kind = classify(e.error)
    if (HARD_ERRORS.has(e.error)) {
      intendedRunning = false
      setState('error')
    }
    emitError({ kind, message: e.message })
  }

  // onend fires after every session — a natural silence timeout, a stop(), or a transient error.
  // Restart iff the user still wants to listen and no hard error tore us down.
  const handleEnd = () => {
    if (intendedRunning && state !== 'error' && ctor) {
      beginSession(ctor)
      return
    }
    recognition = null
    if (state !== 'error') setState('idle')
  }

  function beginSession(c: SpeechRecognitionCtor) {
    const rec = new c()
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    const g = globalThis as unknown as GlobalWithSpeech
    rec.lang = opts.lang ?? g.navigator?.language ?? 'en-US'
    rec.onresult = handleResult
    rec.onerror = handleError
    rec.onend = handleEnd
    rec.onstart = () => setState('listening')
    recognition = rec
    finalizedCount = 0
    // start() throws InvalidStateError if the recognizer is already running [C3]; our intendedRunning
    // guard makes a double-start from callers a no-op, but swallow the native throw defensively.
    try {
      rec.start()
    } catch {
      /* already running */
    }
  }

  return {
    get state() {
      return state
    },
    start: () => {
      if (intendedRunning) return
      ctor = resolveCtor(opts)
      if (!ctor) {
        setState('error')
        emitError({ kind: 'unsupported', message: 'SpeechRecognition unavailable' })
        return
      }
      intendedRunning = true
      beginSession(ctor)
    },
    stop: () => {
      intendedRunning = false
      recognition?.stop()
    },
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
  }
}
