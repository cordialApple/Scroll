import { useEffect, useReducer, type CSSProperties } from 'react'
import type * as Y from 'yjs'
import { blocks, redirects } from '../doc/model'
import type { Presence } from '../doc/awareness'

const FALLBACK = '#8a8a8a'

export function PresenceBar({ doc, presence }: { doc: Y.Doc; presence: Presence }) {
  const [, force] = useReducer((n: number) => n + 1, 0)

  useEffect(() => presence.subscribe(force), [presence])

  useEffect(() => {
    const arr = blocks(doc)
    const red = redirects(doc)
    arr.observe(force)
    red.observe(force)
    return () => {
      arr.unobserve(force)
      red.unobserve(force)
    }
  }, [doc])

  const remotes = presence.remotes()
  if (remotes.length === 0) return null

  return (
    <div className="presence-bar" role="status" aria-label="Collaborators">
      {remotes.map((r) => (
        <span
          key={r.clientId}
          className="presence-chip"
          style={{ '--peer': r.user?.color ?? FALLBACK } as CSSProperties}
          title={`at ${r.anchor.blockId || '—'}`}
        >
          <span className="presence-dot" aria-hidden />
          {r.user?.name ?? `peer ${r.clientId}`}
        </span>
      ))}
    </div>
  )
}
