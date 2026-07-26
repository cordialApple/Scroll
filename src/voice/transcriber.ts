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
