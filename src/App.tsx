import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { openDoc } from './doc/persistence'
import { blocks, appendBlock, blockOrder } from './doc/model'
import { insertAbove } from './dev/synthetic'
import { loadCamera } from './doc/camera'
import { MenuBar } from './chrome/MenuBar'
import { Toolbar } from './chrome/Toolbar'
import { Editor, type EditorApi } from './editor/Editor'
import type { Anchor } from './layout/layout'
import { create_ide_es, create_doc_es } from './es/factory'
import { listEndpoints } from './es/registry'
import { Launcher } from './es/Launcher'
import { EndpointRoute } from './es/EndpointRoute'
import { ResultView } from './es/ResultView'
import './es/es.css'

const DOC_ID = 'scroll-p0'

type Route =
  | { kind: 'home' }
  | { kind: 'launcher' }
  | { kind: 'endpoint'; id: string }
  | { kind: 'result'; id: string }

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  if (h === '/es' || h === '/es/') return { kind: 'launcher' }
  const result = h.match(/^\/es\/([^/]+)\/result$/)
  if (result) return { kind: 'result', id: result[1] }
  const ep = h.match(/^\/es\/([^/]+)$/)
  if (ep) return { kind: 'endpoint', id: ep[1] }
  return { kind: 'home' }
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash))
  useEffect(() => {
    const on = () => setRoute(parseRoute(window.location.hash))
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}

export function App() {
  const route = useRoute()
  if (route.kind === 'launcher') return <Launcher />
  if (route.kind === 'endpoint') return <EndpointRoute key={route.id} id={route.id} />
  if (route.kind === 'result') return <ResultView key={route.id} id={route.id} />
  return <HomeDoc />
}

function HomeDoc() {
  const handle = useMemo(() => openDoc(DOC_ID), [])
  const [synced, setSynced] = useState(false)
  const apiRef = useRef<EditorApi>(null)
  const undoRef = useRef<Y.UndoManager | null>(null)
  const initialAnchor = useRef<Anchor | null>(null)

  useEffect(() => {
    let alive = true
    handle.whenSynced.then(() => {
      if (!alive) return
      initialAnchor.current = loadCamera(DOC_ID)
      undoRef.current = new Y.UndoManager(blocks(handle.doc))
      if (import.meta.env.DEV) {
        ;(window as unknown as { __scroll: unknown }).__scroll = {
          doc: handle.doc,
          api: apiRef,
          appendBlock,
          insertAbove,
          blockOrder,
          create_ide_es,
          create_doc_es,
          listEndpoints,
        }
      }
      setSynced(true)
    })
    return () => {
      alive = false
      handle.provider.destroy()
    }
  }, [handle])

  if (!synced) {
    return (
      <div className="app">
        <div className="boot">
          <div className="boot-spinner" aria-hidden />
          <div className="boot-label">Loading document…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <MenuBar title="Untitled document" />
      <Toolbar
        api={apiRef}
        onUndo={() => undoRef.current?.undo()}
        onRedo={() => undoRef.current?.redo()}
      />
      <Editor
        ref={apiRef}
        doc={handle.doc}
        docId={DOC_ID}
        initialAnchor={initialAnchor.current}
      />
    </div>
  )
}
