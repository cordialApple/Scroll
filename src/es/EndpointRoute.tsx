import { useEndpointDoc } from './useEndpointDoc'
import { IdeEndpointView } from './IdeEndpointView'
import { DocEndpointView } from './DocEndpointView'
import type { IdeEsSchema } from './schema'

export function EndpointRoute({ id }: { id: string }) {
  const state = useEndpointDoc(id)

  if (state.status === 'loading') {
    return (
      <div className="app">
        <div className="boot">
          <div className="boot-spinner" aria-hidden />
          <div className="boot-label">Opening endpoint…</div>
        </div>
      </div>
    )
  }
  if (state.status === 'missing') {
    return (
      <div className="app">
        <div className="es-missing">
          <p>Endpoint <code>{id}</code> not found on this device.</p>
          <a className="es-back" href="#/es">
            ← Endpoints
          </a>
        </div>
      </div>
    )
  }

  const { doc, record } = state
  return record.kind === 'ide-es' ? (
    <IdeEndpointView doc={doc} id={id} schema={record.schema as IdeEsSchema} />
  ) : (
    <DocEndpointView doc={doc} id={id} title={record.title} />
  )
}
