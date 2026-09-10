import { useCallback, useEffect, useState } from 'react'
import { listDocuments, renameDocument, type DocSummary } from '../doc/docsApi'
import { createDocRoom, openDocRoom, rememberWs } from '../doc/roomNav'
import './DocPicker.css'

interface Props {
  wsUrl?: string
}

function editedLabel(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Preserve every existing query param (notably ?ws) and just swap room; drop the one-shot ?new seed flag.
function newTabUrl(docId: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('room', docId)
  url.searchParams.delete('new')
  url.hash = ''
  return url.toString()
}

export function DocPicker({ wsUrl }: Props) {
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const currentRoom = new URLSearchParams(window.location.search).get('room')

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!wsUrl) return
      try {
        const list = await listDocuments(wsUrl, signal)
        setDocs(list)
        setError(null)
      } catch (e: unknown) {
        if (!signal?.aborted) setError(e instanceof Error ? e.message : String(e))
      }
    },
    [wsUrl],
  )

  useEffect(() => {
    if (!wsUrl) return
    rememberWs(wsUrl)
    const ac = new AbortController()
    setDocs(null)
    setError(null)
    void reload(ac.signal)
    return () => ac.abort()
  }, [wsUrl, reload])

  useEffect(() => {
    if (menuFor == null) return
    const onDown = () => setMenuFor(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuFor(null)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuFor])

  async function onRename(d: DocSummary) {
    setMenuFor(null)
    if (!wsUrl) return
    const next = window.prompt('Rename document', d.title)?.trim()
    if (!next || next === d.title) return
    try {
      await renameDocument(wsUrl, d.docId, next)
      await reload()
    } catch (e: unknown) {
      window.alert(`Rename failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function onOpenNewTab(docId: string) {
    setMenuFor(null)
    window.open(newTabUrl(docId), '_blank', 'noopener')
  }

  return (
    <div className="docpicker">
      <header className="docpicker-top">
        <h1 className="docpicker-h1">Recent documents</h1>
      </header>

      {!wsUrl ? (
        <p className="docpicker-note">
          Not connected to a relay, so there are no shared documents to list. Start one with{' '}
          <code>npm run dev:all</code> and open with <code>?ws=ws://127.0.0.1:1234</code>, or open the local
          document with the New tile once connected.
        </p>
      ) : error ? (
        <p className="docpicker-note">
          Couldn’t reach the relay at <code>{wsUrl}</code> — {error}. Start it with{' '}
          <code>npm run dev:all</code>.
        </p>
      ) : (
        <div className="docpicker-grid">
          <button className="doccard doccard-new" onClick={createDocRoom}>
            <span className="doccard-plus" aria-hidden>
              +
            </span>
            <span className="doccard-newlabel">New document</span>
          </button>

          {docs === null
            ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="doccard doccard-skeleton" aria-hidden />)
            : docs.map((d) => (
                <div key={d.docId} className="doccard-wrap">
                  <button className="doccard" onClick={() => openDocRoom(d.docId)} title={d.docId}>
                    <div className="doccard-thumb">
                      <div className="doccard-page">{d.preview || '(empty document)'}</div>
                    </div>
                    <div className="doccard-foot">
                      <span className="doccard-glyph" aria-hidden>
                        ≡
                      </span>
                      <div className="doccard-meta">
                        <div className="doccard-title">{d.title}</div>
                        <div className="doccard-sub">
                          {d.docId === currentRoom && <span className="doccard-current">current · </span>}
                          Edited {editedLabel(d.updatedAt)}
                        </div>
                      </div>
                    </div>
                  </button>

                  <button
                    className="doccard-more"
                    aria-label="Document actions"
                    aria-haspopup="menu"
                    aria-expanded={menuFor === d.docId}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={() => setMenuFor((m) => (m === d.docId ? null : d.docId))}
                  >
                    ⋮
                  </button>

                  {menuFor === d.docId && (
                    <div className="doccard-menu" role="menu" onMouseDown={(e) => e.stopPropagation()}>
                      <button className="doccard-menu-item" role="menuitem" onClick={() => onRename(d)}>
                        Rename
                      </button>
                      <button className="doccard-menu-item" role="menuitem" onClick={() => onOpenNewTab(d.docId)}>
                        Open in new tab
                      </button>
                    </div>
                  )}
                </div>
              ))}
        </div>
      )}
    </div>
  )
}
