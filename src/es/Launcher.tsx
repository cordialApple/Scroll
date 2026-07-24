import { useState } from 'react'
import { create_ide_es, create_doc_es, isSpawnError, type EndpointHandle, type SpawnError } from './factory'
import { listEndpoints } from './registry'
import { sampleIdeSchema, sampleDocSchema } from './samples'
import { programmaticSpawnUrl } from './programmatic'

export function Launcher() {
  const [items, setItems] = useState(() => listEndpoints())

  const go = (url: string) => {
    window.location.hash = url.startsWith('#') ? url.slice(1) : url
  }

  const spawn = (h: EndpointHandle | SpawnError) => {
    if (!isSpawnError(h)) {
      setItems(listEndpoints())
      go(h.url)
    }
  }
  const spawnIde = () => spawn(create_ide_es(sampleIdeSchema()))
  const spawnDoc = () => spawn(create_doc_es(sampleDocSchema()))

  return (
    <div className="es-launcher">
      <header className="es-topbar">
        <a className="es-back" href="#/">
          ← Document
        </a>
        <span className="es-title">Endpoints</span>
      </header>
      <div className="es-launcher-body">
        <div className="es-actions">
          <button className="es-btn es-btn-primary" onClick={spawnIde}>
            Spawn IDE endpoint (sample)
          </button>
          <button className="es-btn" onClick={spawnDoc}>
            Spawn doc endpoint (sample)
          </button>
          <button className="es-btn" onClick={() => go(programmaticSpawnUrl(sampleIdeSchema()))}>
            Spawn via URL (sample)
          </button>
        </div>
        {items.length === 0 ? (
          <p className="es-muted">No endpoints spawned yet.</p>
        ) : (
          <ul className="es-list">
            {items.map((e) => (
              <li key={e.id}>
                <a href={e.url}>
                  <span className="es-badge">{e.kind}</span> {e.title}
                </a>
                {e.result && <span className={`es-pill es-verdict-${e.result.status}`}>{e.result.status}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
