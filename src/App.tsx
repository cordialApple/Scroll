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

const DOC_ID = 'scroll-p0'

export function App() {
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
