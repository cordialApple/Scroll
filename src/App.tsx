import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { openDoc } from './doc/persistence'
import {
  blocks,
  appendBlock,
  blockOrder,
  blockTextString,
  insertBlockText,
  tabBlocksKey,
  getActiveTabId,
  listTabs,
  setActiveTabId,
  createTab,
  renameTab,
  removeTab,
  DEFAULT_TAB_ID,
} from './doc/model'
import { NavPanel } from './chrome/NavPanel'
import { rememberWs } from './doc/roomNav'
import { insertAbove } from './dev/synthetic'
import { loadCamera } from './doc/camera'
import { MenuBar } from './chrome/MenuBar'
import { Toolbar } from './chrome/Toolbar'
import { VoiceIndicator } from './chrome/VoiceIndicator'
import { DocPicker } from './chrome/DocPicker'
import { useVoice } from './voice/useVoice'
import { PresenceBar } from './chrome/PresenceBar'
import { createPresence, type Presence } from './doc/awareness'
import { makePresenceUser } from './doc/presenceUser'
import { Editor, type EditorApi } from './editor/Editor'
import type { Anchor } from './layout/layout'
import { create_ide_es, create_doc_es } from './es/factory'
import { listEndpoints } from './es/registry'
import { Launcher } from './es/Launcher'
import { EndpointRoute } from './es/EndpointRoute'
import { ResultView } from './es/ResultView'
import { SpawnView } from './es/SpawnView'
import './es/es.css'

const DOC_ID = 'scroll-p0'

// Effective relay URL: a dev-only ?ws= override, else the build-time env, else none (pure-local).
function resolveWs(): string | undefined {
  const q = new URLSearchParams(window.location.search)
  return (import.meta.env.DEV ? q.get('ws') : null) ?? (import.meta.env.VITE_SCROLL_WS_URL as string | undefined) ?? undefined
}

type Route =
  | { kind: 'home' }
  | { kind: 'docs' }
  | { kind: 'launcher' }
  | { kind: 'spawn'; param: string }
  | { kind: 'endpoint'; id: string }
  | { kind: 'result'; id: string }

function parseRoute(hash: string): Route {
  const h = hash.replace(/^#/, '')
  if (h === '/docs' || h === '/docs/') return { kind: 'docs' }
  if (h === '/es' || h === '/es/') return { kind: 'launcher' }
  const spawn = h.match(/^\/es\/new(?:\?(.*))?$/)
  if (spawn) return { kind: 'spawn', param: new URLSearchParams(spawn[1] ?? '').get('s') ?? '' }
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
  if (route.kind === 'spawn') return <SpawnView key={route.param} param={route.param} />
  if (route.kind === 'endpoint') return <EndpointRoute key={route.id} id={route.id} />
  if (route.kind === 'result') return <ResultView key={route.id} id={route.id} />
  const wsUrl = resolveWs()
  if (route.kind === 'docs') return <DocPicker wsUrl={wsUrl} />
  // Server-connected with no explicit doc: land on the picker rather than auto-opening one room.
  if (wsUrl && !new URLSearchParams(window.location.search).has('room')) return <DocPicker wsUrl={wsUrl} />
  return <HomeDoc />
}

function HomeDoc() {
  const { room, wsUrl, seed } = useMemo(() => {
    const q = new URLSearchParams(window.location.search)
    const wsUrl = resolveWs()
    // Seed only when this client authors the doc: pure-local single-user, or an explicit New (?new=1).
    // Opening an existing shared doc must not seed — a stale local-empty would inject a phantom block
    // into content the server is about to sync down.
    return { room: q.get('room') ?? DOC_ID, wsUrl, seed: !wsUrl || q.has('new') }
  }, [])
  const handle = useMemo(() => openDoc(room, { room, wsUrl, seed }), [room, wsUrl, seed])
  useEffect(() => rememberWs(wsUrl), [wsUrl])

  // Normalize the URL after boot so a shared/reloaded link doesn't carry the one-shot seed intent.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    if (!q.has('new')) return
    q.delete('new')
    const s = q.toString()
    window.history.replaceState(null, '', `${window.location.pathname}${s ? `?${s}` : ''}${window.location.hash}`)
  }, [])
  const presence = useMemo<Presence | null>(() => {
    const aw = handle.network?.awareness
    return aw ? createPresence(handle.doc, aw, { user: makePresenceUser() }) : null
  }, [handle])
  useEffect(() => () => presence?.destroy(), [presence])
  const [synced, setSynced] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [activeTabId, setActiveTab] = useState<string>(
    () => new URLSearchParams(window.location.search).get('tab') || DEFAULT_TAB_ID,
  )
  const apiRef = useRef<EditorApi>(null)
  const undoRef = useRef<Y.UndoManager | null>(null)
  const undoByTabRef = useRef(new Map<string, Y.UndoManager>())
  const initialAnchor = useRef<Anchor | null>(null)

  const voiceFake = useMemo(
    () => import.meta.env.DEV && new URLSearchParams(window.location.search).get('voice') === 'fake',
    [],
  )
  const voice = useVoice(handle.doc, apiRef, { fake: voiceFake, blocksKey: tabBlocksKey(activeTabId) })

  useEffect(() => {
    let alive = true
    handle.whenSynced.then(() => {
      if (!alive) return
      initialAnchor.current = loadCamera(room)
      const requestedTab = new URLSearchParams(window.location.search).get('tab')
      setActiveTab(requestedTab && listTabs(handle.doc).some(tab => tab.id === requestedTab)
        ? requestedTab
        : getActiveTabId(handle.doc))
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
          presence,
          voice,
          blockTextString,
          insertBlockText,
        }
      }
      setSynced(true)
    })
    return () => {
      alive = false
      handle.destroy()
    }
  }, [handle])

  useEffect(() => {
    if (!synced) return
    const reconcileTab = () => {
      const tabIds = new Set(listTabs(handle.doc).map(tab => tab.id))
      setActiveTab(current => tabIds.has(current) ? current : getActiveTabId(handle.doc))
      for (const [id, undo] of undoByTabRef.current) {
        if (!tabIds.has(id)) {
          undo.destroy()
          undoByTabRef.current.delete(id)
        }
      }
    }
    reconcileTab()
    handle.doc.on('afterTransaction', reconcileTab)
    return () => handle.doc.off('afterTransaction', reconcileTab)
  }, [handle.doc, synced])

  useEffect(() => {
    const managers = undoByTabRef.current
    return () => {
      for (const undo of managers.values()) undo.destroy()
      managers.clear()
      undoRef.current = null
    }
  }, [handle.doc])

  useEffect(() => {
    if (!synced) return
    let undo = undoByTabRef.current.get(activeTabId)
    if (!undo) {
      undo = new Y.UndoManager(blocks(handle.doc, tabBlocksKey(activeTabId)))
      undoByTabRef.current.set(activeTabId, undo)
    }
    undoRef.current = undo
    return () => {
      undo.stopCapturing()
      undoRef.current = null
    }
  }, [handle.doc, activeTabId, synced])

  const selectTab = useCallback(
    (id: string) => {
      setActiveTab(id)
      setActiveTabId(handle.doc, id)
    },
    [handle.doc],
  )
  const onCreateTab = useCallback(() => {
    const id = createTab(handle.doc, '')
    setActiveTab(id)
    setActiveTabId(handle.doc, id)
  }, [handle.doc])
  const onRenameTab = useCallback((id: string, title: string) => renameTab(handle.doc, id, title), [handle.doc])
  const onRemoveTab = useCallback(
    (id: string) => {
      removeTab(handle.doc, id)
      setActiveTab(getActiveTabId(handle.doc))
    },
    [handle.doc],
  )
  const onOpenTabInNewTab = useCallback((id: string) => {
    const url = new URL(window.location.href)
    url.searchParams.set('tab', id)
    window.open(url.toString(), '_blank', 'noopener')
  }, [])

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
      <MenuBar
        doc={handle.doc}
        api={apiRef}
        onUndo={() => undoRef.current?.undo()}
        onRedo={() => undoRef.current?.redo()}
        voice={voice}
      />
      <Toolbar
        api={apiRef}
        onUndo={() => undoRef.current?.undo()}
        onRedo={() => undoRef.current?.redo()}
      />
      <div className="workspace">
        <NavPanel
          doc={handle.doc}
          open={navOpen}
          onToggle={() => setNavOpen((v) => !v)}
          activeTabId={activeTabId}
          onSelectTab={selectTab}
          onCreateTab={onCreateTab}
          onRenameTab={onRenameTab}
          onRemoveTab={onRemoveTab}
          onOpenTabInNewTab={onOpenTabInNewTab}
          onJumpToBlock={(id) => apiRef.current?.scrollToBlock(id)}
        />
        <Editor
          ref={apiRef}
          doc={handle.doc}
          docId={room}
          blocksKey={tabBlocksKey(activeTabId)}
          initialAnchor={initialAnchor.current}
          onAnchorChange={presence?.publishCamera}
        />
      </div>
      <VoiceIndicator voice={voice} />
      {presence && <PresenceBar doc={handle.doc} presence={presence} />}
    </div>
  )
}
