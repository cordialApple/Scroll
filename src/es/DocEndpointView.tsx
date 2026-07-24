import type * as Y from 'yjs'
import { Editor } from '../editor/Editor'

export function DocEndpointView({ doc, id, title }: { doc: Y.Doc; id: string; title: string }) {
  return (
    <div className="app">
      <header className="es-topbar">
        <a className="es-back" href="#/es">
          ← Endpoints
        </a>
        <span className="es-title">{title}</span>
        <span className="es-badge">doc-es</span>
      </header>
      <Editor doc={doc} docId={`es-${id}`} initialAnchor={null} />
    </div>
  )
}
