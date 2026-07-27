import { useEffect, useState } from 'react'
import type { Dictation } from '../voice/dictation'
import type { Transcriber, TranscriberError, TranscriberState } from '../voice/transcriber'

interface Props {
  transcriber: Transcriber
  dictation: Dictation
}

function errorMessage(e: TranscriberError): string {
  switch (e.kind) {
    case 'permission-denied':
      return 'Microphone access was blocked. Allow it in your browser to dictate.'
    case 'unsupported':
      return "Voice typing isn't supported in this browser."
    case 'audio-capture':
      return 'No microphone was found. Check your input device.'
    case 'network':
      return 'Voice typing lost the connection to the speech service. Try again.'
    default:
      return e.message ?? 'Voice typing hit an error.'
  }
}

export function MicButton({ transcriber, dictation }: Props) {
  const [state, setState] = useState<TranscriberState>(transcriber.state)
  const [interim, setInterim] = useState(dictation.interimText)
  const [error, setError] = useState<TranscriberError | null>(null)

  useEffect(() => {
    const offState = transcriber.onStateChange(setState)
    const offInterim = dictation.observeInterim(setInterim)
    // Surface any error that lands the engine in a terminal state — hard permission/device errors,
    // restart-exhaustion (network), and start throws (unknown). Transient blips keep state 'listening'.
    const offError = transcriber.onError((e) => {
      if (transcriber.state === 'error') setError(e)
    })
    return () => {
      offState()
      offInterim()
      offError()
    }
  }, [transcriber, dictation])

  const listening = state === 'listening'
  const toggle = () => {
    setError(null)
    if (listening) transcriber.stop()
    else transcriber.start()
  }

  return (
    <>
      <button
        className={`mic-btn${listening ? ' mic-on' : ''}${state === 'error' ? ' mic-err' : ''}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle}
        aria-pressed={listening}
        aria-label={listening ? 'Stop voice typing' : 'Start voice typing'}
        title={listening ? 'Stop voice typing' : 'Voice typing'}
        data-mic-state={state}
      >
        <span className="mic-glyph" aria-hidden>
          {state === 'error' ? '🎙' : '🎤'}
        </span>
        <span className="mic-label">{listening ? 'Listening' : 'Dictate'}</span>
      </button>

      {listening && (
        <div className="mic-interim" role="status" aria-live="polite" data-mic-interim>
          {interim ? (
            <span className="mic-interim-text">{interim}</span>
          ) : (
            <span className="mic-interim-hint">Listening… start speaking</span>
          )}
        </div>
      )}

      {error && (
        <div className="mic-toast" role="alert">
          <span>{errorMessage(error)}</span>
          <button className="mic-toast-x" aria-label="Dismiss" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
    </>
  )
}
