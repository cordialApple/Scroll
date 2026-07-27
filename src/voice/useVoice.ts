import { useEffect, useMemo, type RefObject } from 'react'
import type * as Y from 'yjs'
import { blockTextString } from '../doc/model'
import type { EditorApi } from '../editor/Editor'
import { createDictation, type Dictation, type DictationTarget } from './dictation'
import { createFakeTranscriber } from './fakeTranscriber'
import { createWebSpeechTranscriber } from './webSpeechTranscriber'
import type { Transcriber } from './transcriber'

export interface Voice {
  transcriber: Transcriber
  dictation: Dictation
}

export function useVoice(
  doc: Y.Doc,
  editorApiRef: RefObject<EditorApi | null>,
  opts: { fake?: boolean } = {},
): Voice {
  const fake = opts.fake ?? false
  const voice = useMemo(() => {
    const transcriber = fake ? createFakeTranscriber() : createWebSpeechTranscriber()
    // getTarget reads the advancing session caret; it falls back to the live editor caret before the
    // first commit AND whenever the advancing target's block no longer exists (deleted/merged mid-
    // session), so a dropped target self-heals instead of silently stalling every later final.
    const activeTarget: { current: DictationTarget | null } = { current: null }
    const dictation = createDictation(doc, transcriber, () => {
      const active = activeTarget.current
      if (active && blockTextString(doc, active.blockId) !== null) return active
      return editorApiRef.current?.dictationTarget() ?? null
    })
    return { transcriber, dictation, activeTarget }
  }, [doc, fake, editorApiRef])

  useEffect(() => {
    const { transcriber, dictation, activeTarget } = voice
    const offState = transcriber.onStateChange((s) => {
      activeTarget.current = s === 'listening' ? (editorApiRef.current?.dictationTarget() ?? null) : null
    })
    const offCommit = dictation.observeCommit((next) => {
      activeTarget.current = next
    })
    return () => {
      offState()
      offCommit()
      // Release the mic on unmount / doc change — otherwise a session left listening keeps recording.
      transcriber.stop()
      dictation.destroy()
    }
  }, [voice, editorApiRef])

  return voice
}
