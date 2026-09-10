import { useLayoutEffect, useRef } from 'react'
import type { BlockView } from '../doc/model'
import { getCaretOffset, setCaretOffset, caretAtStart } from './caret'

interface Props {
  view: BlockView
  onEdit: (id: string, text: string) => void
  onSplit: (id: string, caret: number) => void
  onMerge: (id: string) => void
}

export function Block({ view, onEdit, onSplit, onMerge }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  // Pre-paint (useLayoutEffect), not passive: a non-focused block's programmatic grow must land in the
  // DOM before the Editor's own useLayoutEffect measures it. Child layout effects run before the parent's,
  // so the anchor is already displaced at measure time and the hold-camera correction compensates. A
  // passive effect syncs after paint — an above-camera grow is then measured stale and the camera drifts.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || el.innerText === view.text) return
    const caret = document.activeElement === el ? getCaretOffset(el) : null
    el.innerText = view.text
    if (caret !== null) setCaretOffset(el, Math.min(caret, view.text.length))
  }, [view.text])

  return (
    <div
      ref={ref}
      className={`block block-${view.type}`}
      data-block-id={view.id}
      data-author={view.author}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(e) => onEdit(view.id, (e.currentTarget as HTMLElement).innerText)}
      onBlur={(e) => {
        const el = e.currentTarget as HTMLElement
        if (el.innerText !== view.text) el.innerText = view.text
      }}
      onKeyDown={(e) => {
        const el = e.currentTarget as HTMLElement
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          onSplit(view.id, getCaretOffset(el))
        } else if (e.key === 'Backspace' && caretAtStart(el)) {
          e.preventDefault()
          onMerge(view.id)
        }
      }}
    />
  )
}
