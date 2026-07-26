export type TranscriberState = 'idle' | 'listening' | 'error'

export type TranscriberErrorKind =
  | 'permission-denied'
  | 'no-speech'
  | 'network'
  | 'unsupported'
  | 'aborted'
  | 'unknown'

export interface TranscriberError {
  kind: TranscriberErrorKind
  message?: string
}

// isFinal:false — text is the full provisional tail, replacing the current interim (preview only).
// isFinal:true — text is the incremental delta to insert at the caret, NOT the cumulative transcript.
// A Web Speech adapter must emit per-result segment text on finals, not SpeechRecognitionEvent's
// accumulated results, or the delta path double-inserts.
export interface TranscriptEvent {
  text: string
  isFinal: boolean
}

export interface Transcriber {
  readonly state: TranscriberState
  start(): void
  stop(): void
  onResult(cb: (e: TranscriptEvent) => void): () => void
  onStateChange(cb: (s: TranscriberState) => void): () => void
  onError(cb: (err: TranscriberError) => void): () => void
}
