import { useEffect, useRef } from 'react'
import type { BlockView } from '../doc/model'
import { getCaretOffset, caretAtStart } from './caret'

interface Props {
  view: BlockView
  onEdit: (id: string, text: string) => void
  onSplit: (id: string, caret: number) => void
  onMerge: (id: string) => void
}

export function Block({ view, onEdit, onSplit, onMerge }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (document.activeElement === el) return
    if (el.innerText !== view.text) el.innerText = view.text
  }, [view.text])

  return (
    <div
      ref={ref}
      className={`block block-${view.type}`}
      data-block-id={view.id}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={(e) => onEdit(view.id, (e.currentTarget as HTMLElement).innerText)}
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
