import { describe, expect, it } from 'vitest'
import {
  createWebSpeechTranscriber,
  isSpeechRecognitionSupported,
  type SpeechRecognitionCtor,
  type SpeechRecognitionLike,
} from './webSpeechTranscriber'
import type { TranscriberError, TranscriberState, TranscriptEvent } from './transcriber'

interface Seg {
  transcript: string
  isFinal: boolean
}

function resultsEvent(resultIndex: number, segs: Seg[]) {
  const results = segs.map((s) => ({ isFinal: s.isFinal, length: 1, 0: { transcript: s.transcript } }))
  return { resultIndex, results }
}

class MockRecognition implements SpeechRecognitionLike {
  continuous = false
  interimResults = false
  lang = ''
  maxAlternatives = 1
  onresult: SpeechRecognitionLike['onresult'] = null
  onerror: SpeechRecognitionLike['onerror'] = null
  onend: SpeechRecognitionLike['onend'] = null
  onstart: SpeechRecognitionLike['onstart'] = null
  started = 0
  stopped = 0
  running = false
  throwOnStart = false

  start() {
    if (this.throwOnStart) throw new Error('InvalidStateError')
    if (this.running) throw new Error('InvalidStateError')
    this.running = true
    this.started++
    this.onstart?.()
  }
  stop() {
    this.stopped++
    this.running = false
    this.onend?.()
  }
  abort() {
    this.running = false
    this.onend?.()
  }

  fireResult(resultIndex: number, segs: Seg[]) {
    this.onresult?.(resultsEvent(resultIndex, segs))
  }
  fireError(error: string, message?: string) {
    this.onerror?.({ error, message })
  }
  fireEnd() {
    this.running = false
    this.onend?.()
  }
}

function mockCtor(mutate?: (r: MockRecognition) => void) {
  const instances: MockRecognition[] = []
  const ctor = class extends MockRecognition {
    constructor() {
      super()
      mutate?.(this)
      instances.push(this)
    }
  } as unknown as SpeechRecognitionCtor
  return { ctor, instances, last: () => instances[instances.length - 1] }
}

describe('P5.2 web speech transcriber — native SpeechRecognition behind the interface', () => {
  it('maps a cumulative results list to per-segment finals and a provisional interim tail', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const finals: string[] = []
    const interims: string[] = []
    t.onResult((e: TranscriptEvent) => (e.isFinal ? finals.push(e.text) : interims.push(e.text)))

    t.start()
    const r = m.last()
    r.fireResult(0, [{ transcript: 'hello', isFinal: false }])
    r.fireResult(0, [{ transcript: 'hello world', isFinal: false }])
    r.fireResult(0, [{ transcript: 'hello world', isFinal: true }])
    r.fireResult(1, [
      { transcript: 'hello world', isFinal: true },
      { transcript: 'and', isFinal: false },
    ])
    r.fireResult(1, [
      { transcript: 'hello world', isFinal: true },
      { transcript: 'and again', isFinal: true },
    ])

    expect(finals).toEqual(['hello world', 'and again'])
    expect(interims).toContain('hello')
    expect(interims).toContain('hello world')
    expect(interims).toContain('and')
  })

  it('never re-emits a finalized segment if the native list replays it', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const finals: string[] = []
    t.onResult((e) => e.isFinal && finals.push(e.text))

    t.start()
    const r = m.last()
    r.fireResult(0, [{ transcript: 'hi', isFinal: true }])
    r.fireResult(0, [{ transcript: 'hi', isFinal: true }])

    expect(finals).toEqual(['hi'])
  })

  it('drops whitespace-only segments and trims transcripts', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const finals: string[] = []
    t.onResult((e) => e.isFinal && finals.push(e.text))

    t.start()
    m.last().fireResult(0, [{ transcript: '  spaced  ', isFinal: true }])
    m.last().fireResult(1, [
      { transcript: '  spaced  ', isFinal: true },
      { transcript: '   ', isFinal: true },
    ])

    expect(finals).toEqual(['spaced'])
  })

  it('transitions idle -> listening on start, back to idle on stop', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const seen: TranscriberState[] = []
    t.onStateChange((s) => seen.push(s))

    expect(t.state).toBe('idle')
    t.start()
    expect(t.state).toBe('listening')
    t.stop()
    expect(t.state).toBe('idle')
    expect(seen).toEqual(['listening', 'idle'])
  })

  it('classifies not-allowed as a hard permission-denied error and stays in error', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))

    t.start()
    const r = m.last()
    r.fireError('not-allowed', 'denied')
    expect(t.state).toBe('error')
    expect(errs).toEqual([{ kind: 'permission-denied', message: 'denied' }])

    r.fireEnd() // native end after error must not flip back to idle or restart
    expect(t.state).toBe('error')
    expect(m.instances.length).toBe(1)
  })

  it('auto-restarts after a silence-timeout end while still intended-running', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    t.start()
    expect(m.instances.length).toBe(1)

    m.last().fireEnd() // Chrome ends on silence even with continuous=true
    expect(m.instances.length).toBe(2)
    expect(t.state).toBe('listening')

    t.stop()
    expect(t.state).toBe('idle')
  })

  it('treats no-speech/network as transient — surfaces the error but keeps listening and restarts', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))

    t.start()
    m.last().fireError('no-speech')
    expect(t.state).toBe('listening')
    m.last().fireError('network')
    expect(errs.map((e) => e.kind)).toEqual(['no-speech', 'network'])

    m.last().fireEnd()
    expect(m.instances.length).toBe(2)
    expect(t.state).toBe('listening')
  })

  it('double start is a no-op and never throws (InvalidStateError guard [C3])', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    t.start()
    expect(() => t.start()).not.toThrow()
    expect(m.instances.length).toBe(1)
  })

  it('swallows a native start() throw defensively', () => {
    const m = mockCtor((r) => (r.throwOnStart = true))
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    expect(() => t.start()).not.toThrow()
  })

  it('cuts off a trailing final that arrives in the stop -> onend window', () => {
    // Real SpeechRecognition emits onend asynchronously, so a final can fire after stop() while
    // state still lags at 'listening'. A deferred-onend mock models that window.
    const m = mockCtor((r) => {
      r.stop = function () {
        this.stopped++
        this.running = false
        // native onend intentionally NOT fired inline — the window stays open
      }
    })
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const finals: string[] = []
    t.onResult((e) => e.isFinal && finals.push(e.text))

    t.start()
    t.stop()
    expect(t.state).toBe('listening') // state still lags — onend hasn't fired
    m.last().fireResult(0, [{ transcript: 'stray', isFinal: true }])

    expect(finals).toEqual([]) // cut off at the adapter by the intendedRunning gate
  })

  it('degrades cleanly when SpeechRecognition is unavailable', () => {
    const t = createWebSpeechTranscriber({}) // no ctor, none on globalThis in node env
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))

    t.start()
    expect(t.state).toBe('error')
    expect(errs).toEqual([{ kind: 'unsupported', message: 'SpeechRecognition unavailable' }])
    expect(isSpeechRecognitionSupported()).toBe(false)
  })
})
