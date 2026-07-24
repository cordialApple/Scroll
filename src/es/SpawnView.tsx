import { useEffect, useRef, useState } from 'react'
import { decodeSchema } from './programmatic'
import { create_endpoint, isSpawnError } from './factory'

export function SpawnView({ param }: { param: string }) {
  const [errors, setErrors] = useState<string[] | null>(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true
    try {
      const input = decodeSchema(param)
      if (input === null) {
        setErrors(['spawn URL carries no valid schema payload'])
        return
      }
      const handle = create_endpoint(input)
      if (isSpawnError(handle)) {
        setErrors(handle.errors)
        return
      }
      window.location.replace(handle.url)
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)])
    }
  }, [param])

  if (!errors) {
    return (
      <div className="app">
        <div className="boot">
          <div className="boot-spinner" aria-hidden />
          <div className="boot-label">Spawning endpoint…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className="es-missing">
        <p>Could not spawn endpoint:</p>
        <ul className="es-tests">
          {errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <a className="es-back" href="#/es">
          ← Endpoints
        </a>
      </div>
    </div>
  )
}
