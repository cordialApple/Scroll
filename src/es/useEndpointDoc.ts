import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { openDoc } from '../doc/persistence'
import { initEndpoint } from './endpoint'
import { getEndpoint, type EndpointRecord } from './registry'

export type OpenEndpoint =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'ready'; doc: Y.Doc; record: EndpointRecord }

export function useEndpointDoc(id: string): OpenEndpoint {
  const [state, setState] = useState<OpenEndpoint>({ status: 'loading' })
  useEffect(() => {
    setState({ status: 'loading' })
    const record = getEndpoint(id)
    if (!record) {
      setState({ status: 'missing' })
      return
    }
    const handle = openDoc(`es-${id}`, { seed: false })
    let alive = true
    handle.whenSynced.then(() => {
      if (!alive) return
      initEndpoint(handle.doc, record.schema)
      setState({ status: 'ready', doc: handle.doc, record })
    })
    return () => {
      alive = false
      handle.destroy()
    }
  }, [id])
  return state
}
