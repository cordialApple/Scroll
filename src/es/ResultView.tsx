import { pollResult } from './registry'

export function ResultView({ id }: { id: string }) {
  const result = pollResult(id)
  const payload = result ?? { endpointId: id, status: 'pending' }
  return (
    <div className="es-result">
      <header className="es-topbar">
        <a className="es-back" href={`#/es/${id}`}>
          ← Endpoint
        </a>
        <span className="es-title">Result</span>
      </header>
      <pre className="es-json">{JSON.stringify(payload, null, 2)}</pre>
    </div>
  )
}
