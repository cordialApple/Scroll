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

function invalidState(): Error {
  const e = new Error('recognition already started')
  e.name = 'InvalidStateError'
  return e
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
  startError: unknown = invalidState()
  aborted = 0

  start() {
    if (this.throwOnStart) throw this.startError
    if (this.running) throw invalidState()
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
    this.aborted++
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

  it('swallows an already-running InvalidStateError from start() [C3]', () => {
    const m = mockCtor((r) => (r.throwOnStart = true)) // startError defaults to InvalidStateError
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))
    expect(() => t.start()).not.toThrow()
    expect(t.state).not.toBe('error')
    expect(errs).toEqual([])
  })

  it('surfaces a non-InvalidStateError start() throw as an error ([B1])', () => {
    const boom = new Error('boom')
    boom.name = 'NotSupportedError'
    const m = mockCtor((r) => {
      r.throwOnStart = true
      r.startError = boom
    })
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))
    t.start()
    expect(t.state).toBe('error')
    expect(errs).toEqual([{ kind: 'unknown', message: 'boom' }])
  })

  it('classifies audio-capture as a hard error and does not restart ([B4])', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))

    t.start()
    m.last().fireError('audio-capture', 'no mic')
    expect(t.state).toBe('error')
    expect(errs).toEqual([{ kind: 'audio-capture', message: 'no mic' }])

    m.last().fireEnd()
    expect(t.state).toBe('error')
    expect(m.instances.length).toBe(1)
  })

  it('classifies service-not-allowed as a hard permission-denied error ([B4])', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))

    t.start()
    m.last().fireError('service-not-allowed')
    expect(t.state).toBe('error')
    expect(errs.map((e) => e.kind)).toEqual(['permission-denied'])
    m.last().fireEnd()
    expect(m.instances.length).toBe(1)
  })

  it('does not surface an aborted error after an intentional stop() ([B5])', () => {
    // stop() flips intendedRunning false, then the native teardown fires 'aborted' + onend.
    const m = mockCtor((r) => {
      r.stop = function () {
        this.stopped++
        this.running = false
        this.onerror?.({ error: 'aborted' })
        this.onend?.()
      }
    })
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))

    t.start()
    t.stop()
    expect(errs).toEqual([])
    expect(t.state).toBe('idle')
  })

  it('neutralizes a superseded recognizer instance ([B2] instance-identity guard)', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const finals: string[] = []
    t.onResult((e) => e.isFinal && finals.push(e.text))

    t.start()
    const first = m.last()
    first.fireEnd() // silence-timeout restart -> instance 2, first detached
    expect(m.instances.length).toBe(2)

    first.fireResult(0, [{ transcript: 'stale', isFinal: true }]) // late callback from old instance
    first.fireEnd() // late end from old instance
    expect(finals).toEqual([]) // ignored, no stray final
    expect(m.instances.length).toBe(2) // no duplicate restart

    t.stop()
  })

  it('backs off and gives up after repeated transient failures ([B3])', () => {
    const delays: number[] = []
    const m = mockCtor()
    const t = createWebSpeechTranscriber({
      recognitionCtor: m.ctor,
      restartBaseMs: 100,
      restartMaxMs: 1000,
      maxTransientRestarts: 4,
      scheduleRestart: (fn, ms) => {
        delays.push(ms)
        fn() // run synchronously to drive the streak deterministically
      },
    })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))

    t.start()
    for (let i = 0; i < 6; i++) {
      m.last().fireError('network')
      m.last().fireEnd()
      if (t.state === 'error') break
    }

    expect(t.state).toBe('error')
    expect(errs.at(-1)).toEqual({ kind: 'network', message: 'restart limit exceeded' })
    // First transient restart is immediate (unscheduled); later ones back off, increasing and capped.
    expect(delays.length).toBeGreaterThan(0)
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
    expect(Math.max(...delays)).toBeLessThanOrEqual(1000)
  })

  it('swallows a DOMException-shaped InvalidStateError, not just Error instances ([F-04])', () => {
    // Real browsers throw a DOMException (NOT instanceof Error) — the swallow must duck-type on name.
    const domLike = { name: 'InvalidStateError', message: 'recognition has already started' }
    const m = mockCtor((r) => {
      r.throwOnStart = true
      r.startError = domLike
    })
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const errs: TranscriberError[] = []
    t.onError((e) => errs.push(e))
    t.start()
    expect(t.state).not.toBe('error')
    expect(errs).toEqual([])
  })

  it('a stale scheduled restart cannot orphan a live session across stop()+start() ([F-02])', () => {
    let pending: (() => void) | null = null
    const m = mockCtor()
    const t = createWebSpeechTranscriber({
      recognitionCtor: m.ctor,
      restartBaseMs: 50,
      scheduleRestart: (fn) => {
        pending = fn // capture, do NOT run — models a real timer still in flight
      },
    })

    t.start()
    // Two transient errors push the streak past the immediate-restart threshold, scheduling a backoff.
    m.last().fireError('network')
    m.last().fireEnd()
    m.last().fireError('network')
    m.last().fireEnd()
    expect(pending, 'a backoff restart is now pending').not.toBeNull()

    // Caller intentionally cycles the session while the stale timer is still in flight.
    t.stop()
    t.start()
    const live = m.last()
    const instancesAfterRestart = m.instances.length

    // The stale timer fires — it must no-op (wrong epoch), not spawn a session over the live one.
    pending!()
    expect(m.instances.length, 'no orphaned session from the stale restart').toBe(instancesAfterRestart)
    expect(live.running, 'the caller-established session stays live').toBe(true)
  })

  it('detaching a superseded recognizer aborts it so no live mic is orphaned ([F-02] belt)', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    t.start()
    const first = m.last()
    first.fireEnd() // silence-timeout restart supersedes `first`
    expect(m.instances.length).toBe(2)
    expect(first.aborted, 'superseded instance was aborted').toBeGreaterThan(0)
    t.stop()
  })

  it('never double-inserts when the native results list shrinks/rebases ([A1] fail-safe)', () => {
    const m = mockCtor()
    const t = createWebSpeechTranscriber({ recognitionCtor: m.ctor })
    const finals: string[] = []
    t.onResult((e) => e.isFinal && finals.push(e.text))

    t.start()
    const r = m.last()
    r.fireResult(0, [
      { transcript: 'one', isFinal: true },
      { transcript: 'two', isFinal: true },
    ])
    // A hypothetical shrink/rebase to a shorter list must never replay a finalized index.
    r.fireResult(0, [{ transcript: 'one', isFinal: true }])
    expect(finals).toEqual(['one', 'two'])
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
