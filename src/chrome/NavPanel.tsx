import { useEffect, useReducer, useRef, useState } from 'react'
import type * as Y from 'yjs'
import { blocks, blockId, blockType, blockText, docMeta, listTabs, tabBlocksKey, type DocTab } from '../doc/model'

export interface NavPanelProps {
  doc: Y.Doc
  open: boolean
  onToggle: () => void
  activeTabId: string
  onSelectTab: (id: string) => void
  onCreateTab: () => void
  onRenameTab: (id: string, title: string) => void
  onRemoveTab: (id: string) => void
  onOpenTabInNewTab: (id: string) => void
  onJumpToBlock: (blockId: string) => void
}

interface Heading {
  id: string
  text: string
}

function useLiveNav(doc: Y.Doc, activeTabId: string): { tabs: DocTab[]; headings: Heading[] } {
  const [, bump] = useReducer((x) => x + 1, 0)

  useEffect(() => {
    const meta = docMeta(doc)
    meta.observe(bump)
    return () => meta.unobserve(bump)
  }, [doc])

  useEffect(() => {
    const arr = blocks(doc, tabBlocksKey(activeTabId))
    arr.observeDeep(bump)
    return () => arr.unobserveDeep(bump)
  }, [doc, activeTabId])

  const tabs = listTabs(doc)
  const arr = blocks(doc, tabBlocksKey(activeTabId))
  const headings: Heading[] = []
  for (let i = 0; i < arr.length; i++) {
    const m = arr.get(i)
    if (blockType(m) === 'heading') headings.push({ id: blockId(m), text: blockText(m).toString() })
  }
  return { tabs, headings }
}

export function NavPanel(props: NavPanelProps) {
  const { doc, open, onToggle, activeTabId } = props
  const { tabs, headings } = useLiveNav(doc, activeTabId)

  if (!open) {
    return (
      <button
        className="nav-toggle"
        title="Show tabs & outlines"
        aria-label="Show tabs & outlines"
        onClick={onToggle}
      >
        ≡
      </button>
    )
  }

  const canRemove = tabs.length > 1

  return (
    <aside className="navpanel" aria-label="Tabs and outline">
      <div className="navpanel-head">
        <button
          className="nav-back"
          title="Hide tabs & outlines"
          aria-label="Hide tabs & outlines"
          onClick={onToggle}
        >
          ‹
        </button>
      </div>

      <section className="nav-section">
        <div className="nav-section-head">
          <span className="nav-section-title">Document tabs</span>
          <button className="nav-add" title="Add tab" aria-label="Add tab" onClick={props.onCreateTab}>
            +
          </button>
        </div>
        <ul className="nav-tablist">
          {tabs.map((t) => (
            <TabRow
              key={t.id}
              tab={t}
              active={t.id === activeTabId}
              canRemove={canRemove}
              onSelect={() => props.onSelectTab(t.id)}
              onRename={(title) => props.onRenameTab(t.id, title)}
              onRemove={() => props.onRemoveTab(t.id)}
              onOpenNew={() => props.onOpenTabInNewTab(t.id)}
            />
          ))}
        </ul>
        {headings.length === 0 && (
          <p className="nav-hint">Headings you add to the document will appear here.</p>
        )}
      </section>

      {headings.length > 0 && (
        <section className="nav-section">
          <div className="nav-section-head">
            <span className="nav-section-title">Outline</span>
          </div>
          <ul className="nav-outline">
            {headings.map((h) => (
              <li key={h.id}>
                <button
                  className="nav-outline-item"
                  title={h.text || 'Untitled heading'}
                  onClick={() => props.onJumpToBlock(h.id)}
                >
                  {h.text || 'Untitled heading'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}

interface TabRowProps {
  tab: DocTab
  active: boolean
  canRemove: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onRemove: () => void
  onOpenNew: () => void
}

function TabRow({ tab, active, canRemove, onSelect, onRename, onRemove, onOpenNew }: TabRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(tab.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setDraft(tab.title), [tab.title])

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.nav-rowmenu-wrap')) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  const commit = () => {
    const t = draft.trim()
    if (t && t !== tab.title) onRename(t)
    setRenaming(false)
  }

  if (renaming) {
    return (
      <li className="nav-tab nav-tab-editing">
        <input
          ref={inputRef}
          className="nav-tab-input"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') {
              setDraft(tab.title)
              setRenaming(false)
            }
          }}
        />
      </li>
    )
  }

  return (
    <li className={`nav-tab${active ? ' nav-tab-active' : ''}`}>
      <button className="nav-tab-label" title={tab.title} onClick={onSelect}>
        <span className="nav-tab-dot" aria-hidden />
        <span className="nav-tab-text">{tab.title || 'Untitled tab'}</span>
      </button>
      <div className="nav-rowmenu-wrap">
        <button
          className="nav-tab-more"
          title="Tab options"
          aria-label="Tab options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          ⋮
        </button>
        {menuOpen && (
          <div className="nav-rowmenu" role="menu">
            <button
              role="menuitem"
              className="nav-rowmenu-item"
              onClick={() => {
                setDraft(tab.title)
                setRenaming(true)
                setMenuOpen(false)
              }}
            >
              Rename
            </button>
            <button
              role="menuitem"
              className="nav-rowmenu-item"
              onClick={() => {
                onOpenNew()
                setMenuOpen(false)
              }}
            >
              Open in new tab
            </button>
            <button
              role="menuitem"
              className="nav-rowmenu-item nav-rowmenu-danger"
              disabled={!canRemove}
              onClick={() => {
                onRemove()
                setMenuOpen(false)
              }}
            >
              Remove
            </button>
          </div>
        )}
      </div>
    </li>
  )
}
