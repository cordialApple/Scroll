import * as decoding from 'lib0/decoding'
import { messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync'
import { MessageType } from '@hocuspocus/server'

// `beforeHandleMessage`'s `update` field is the RAW wire message (doc-name prefix + type + payload),
// not the decoded Yjs update — only a sync-step-2 or update sync message actually carries doc bytes
// worth persisting; syncStep1/awareness/query/stateless carry none. Mirrors MessageReceiver's own
// decode path so we durably log exactly what apply() is about to apply.
export function extractSyncUpdate(raw: Uint8Array): Uint8Array | null {
  const decoder = decoding.createDecoder(raw)
  decoding.readVarString(decoder)
  const messageType = decoding.readVarUint(decoder)
  if (messageType !== MessageType.Sync && messageType !== MessageType.SyncReply) return null

  const subtype = decoding.readVarUint(decoder)
  if (subtype !== messageYjsSyncStep2 && subtype !== messageYjsUpdate) return null

  return decoding.readVarUint8Array(decoder)
}
