import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type * as Y from 'yjs'
import { docMeta, docWordCount, getDocTitle, setDocTitle, type BlockType } from '../doc/model'
import { createDocRoom, goHome } from '../doc/roomNav'
import { MenuDropdown, type MenuDef } from './Menu'
import { ImageInsert } from '../editor/ImageInsert'
import type { EditorApi } from '../editor/Editor'
import type { Voice } from '../voice/useVoice'

interface Props {
  doc: Y.Doc
  api: React.RefObject<EditorApi>
  onUndo: () => void
  onRedo: () => void
  voice: Voice
}

type DialogKind = 'wordcount' | 'about' | 'shortcuts'

function exec(cmd: string) {
  document.execCommand(cmd)
}

function useDocTitle(doc: Y.Doc): [string, (t: string) => void] {
  const [title, setLocal] = useState(() => getDocTitle(doc))
  useEffect(() => {
    const m = docMeta(doc)
    const sync = () => setLocal(getDocTitle(doc))
    sync()
    m.observe(sync)
    return () => m.unobserve(sync)
  }, [doc])
  const set = useCallback(
    (t: string) => {
      setLocal(t)
      setDocTitle(doc, t)
    },
    [doc],
  )
  return [title, set]
}

function useListening(voice: Voice): boolean {
  const [listening, setListening] = useState(voice.transcriber.state === 'listening')
  useEffect(() => voice.transcriber.onStateChange((s) => setListening(s === 'listening')), [voice])
  return listening
}

type SaveState = 'saved' | 'saving'

// Local-first: writes land in IndexedDB effectively instantly, so "saving" is the brief window while edits
// are still arriving. Any Yjs update flips to saving; a 700ms quiet gap settles back to saved.
function useSaveState(doc: Y.Doc): SaveState {
  const [state, setState] = useState<SaveState>('saved')
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const onUpdate = () => {
      setState('saving')
      clearTimeout(t)
      t = setTimeout(() => setState('saved'), 700)
    }
    doc.on('update', onUpdate)
    return () => {
      doc.off('update', onUpdate)
      clearTimeout(t)
    }
  }, [doc])
  return state
}

export function MenuBar({ doc, api, onUndo, onRedo, voice }: Props) {
  const [title, setTitle] = useDocTitle(doc)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const [imageOpen, setImageOpen] = useState(false)
  const listening = useListening(voice)
  const saveState = useSaveState(doc)

  useEffect(() => {
    if (!openMenu) return
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu')) setOpenMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenu])

  const setType = (t: BlockType) => api.current?.setBlockType(t)
  const toggleVoice = () => (listening ? voice.transcriber.stop() : voice.transcriber.start())
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen()
  }

  const menus: MenuDef[] = [
    {
      label: 'File',
      items: [
        { label: 'New document', onClick: createDocRoom },
        { label: 'Open…', onClick: goHome },
        'separator',
        { label: 'Make a copy', disabled: true },
        { label: 'Download', disabled: true },
        { label: 'Share', disabled: true },
        'separator',
        { label: 'Print', shortcut: 'Ctrl+P', onClick: () => window.print() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: 'Ctrl+Z', onClick: onUndo },
        { label: 'Redo', shortcut: 'Ctrl+Y', onClick: onRedo },
        'separator',
        { label: 'Cut', shortcut: 'Ctrl+X', onClick: () => exec('cut') },
        { label: 'Copy', shortcut: 'Ctrl+C', onClick: () => exec('copy') },
        { label: 'Paste', shortcut: 'Ctrl+V', disabled: true },
        'separator',
        { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => exec('selectAll') },
        { label: 'Find and replace', disabled: true },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Full screen', onClick: toggleFullscreen },
        'separator',
        { label: 'Print layout', checked: true, disabled: true },
        { label: 'Show ruler', disabled: true },
        { label: 'Show outline', disabled: true },
      ],
    },
    {
      label: 'Insert',
      items: [
        { label: 'Heading', onClick: () => setType('heading') },
        { label: 'Quote', onClick: () => setType('quote') },
        'separator',
        { label: 'Image', onClick: () => setImageOpen(true) },
        { label: 'Table', disabled: true },
        { label: 'Link', shortcut: 'Ctrl+K', disabled: true },
        { label: 'Comment', disabled: true },
      ],
    },
    {
      label: 'Format',
      items: [
        { label: 'Bold', shortcut: 'Ctrl+B', onClick: () => exec('bold') },
        { label: 'Italic', shortcut: 'Ctrl+I', onClick: () => exec('italic') },
        { label: 'Underline', shortcut: 'Ctrl+U', onClick: () => exec('underline') },
        'separator',
        { label: 'Normal text', onClick: () => setType('paragraph') },
        { label: 'Heading', onClick: () => setType('heading') },
        { label: 'Quote', onClick: () => setType('quote') },
        'separator',
        { label: 'Clear formatting', onClick: () => exec('removeFormat') },
      ],
    },
    {
      label: 'Tools',
      items: [
        { label: 'Voice typing', checked: listening, onClick: toggleVoice },
        { label: 'Word count', onClick: () => setDialog('wordcount') },
        'separator',
        { label: 'Spelling and grammar', disabled: true },
        { label: 'Dictionary', disabled: true },
        { label: 'Translate document', disabled: true },
      ],
    },
    {
      label: 'Extensions',
      items: [
        { label: 'Endpoint Studio', onClick: () => (window.location.hash = '#/es') },
        'separator',
        { label: 'Add-ons', disabled: true },
        { label: 'Apps Script', disabled: true },
      ],
    },
    {
      label: 'Help',
      items: [
        { label: 'About Scroll', onClick: () => setDialog('about') },
        { label: 'Keyboard shortcuts', shortcut: 'Ctrl+/', onClick: () => setDialog('shortcuts') },
        'separator',
        { label: 'Help center', disabled: true },
      ],
    },
  ]

  return (
    <div className="menubar">
      <div className="menubar-left">
        <button
          className="doc-icon"
          title="All documents"
          aria-label="All documents"
          onClick={goHome}
        >
          <svg
            className="doc-scroll"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 21h12a2 2 0 0 0 2-2v-2H10v2a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v3h4" />
            <path d="M19 17V5a2 2 0 0 0-2-2H4" />
          </svg>
        </button>
        <div className="menubar-titlecol">
          <input
            className="doc-title"
            aria-label="Document title"
            placeholder="Untitled document"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="menu-row">
            {menus.map((m) => (
              <MenuDropdown
                key={m.label}
                def={m}
                open={openMenu === m.label}
                onToggle={() => setOpenMenu(openMenu === m.label ? null : m.label)}
                onClose={() => setOpenMenu(null)}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="menubar-right">
        <div
          className={`savestate savestate-${saveState}`}
          role="status"
          title={saveState === 'saving' ? 'Saving…' : 'Saved locally'}
          aria-label={saveState === 'saving' ? 'Saving' : 'Saved'}
        >
          {saveState === 'saving' ? (
            <span className="savestate-spin" aria-hidden />
          ) : (
            <svg
              className="savestate-check"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          )}
        </div>
        <div className="avatar" aria-hidden>
          S
        </div>
      </div>
      {dialog && <MenuDialog kind={dialog} doc={doc} onClose={() => setDialog(null)} />}
      {imageOpen && <ImageInsert api={api} onClose={() => setImageOpen(false)} />}
    </div>
  )
}

function MenuDialog({ kind, doc, onClose }: { kind: DialogKind; doc: Y.Doc; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  let title = ''
  let body: ReactNode = null
  if (kind === 'wordcount') {
    const { words, chars } = docWordCount(doc)
    title = 'Word count'
    body = (
      <dl>
        <dt>Words</dt>
        <dd>{words}</dd>
        <dt>Characters</dt>
        <dd>{chars}</dd>
      </dl>
    )
  } else if (kind === 'about') {
    title = 'About Scroll'
    body = (
      <p>
        Scroll is a collaborative document editor that holds your reading position steady while other
        people — and agents — edit around you. Nothing changes beneath you.
      </p>
    )
  } else {
    title = 'Keyboard shortcuts'
    body = (
      <dl>
        <dt>Enter</dt>
        <dd>Split block</dd>
        <dt>Backspace at start</dt>
        <dd>Merge into previous</dd>
        <dt>Ctrl+B / I / U</dt>
        <dd>Bold / Italic / Underline</dd>
        <dt>Ctrl+Z / Y</dt>
        <dd>Undo / Redo</dd>
      </dl>
    )
  }

  return (
    <div className="dlg-scrim" onClick={onClose}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dlg-head">
          <h2>{title}</h2>
          <button className="dlg-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dlg-body">{body}</div>
      </div>
    </div>
  )
}
