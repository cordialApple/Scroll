import {
  validateDocEsSchema,
  validateIdeEsSchema,
  type DocEsSchema,
  type IdeEsSchema,
} from './schema'
import { newEndpointId } from '../doc/ids'
import { registerEndpoint, type EndpointRecord } from './registry'

export type EndpointHandle = {
  endpointId: string
  url: string
  resultUrl: string
}

export type SpawnError = { ok: false; errors: string[] }

export function endpointUrl(id: string): string {
  return `#/es/${id}`
}

export function resultUrl(id: string): string {
  return `#/es/${id}/result`
}

function spawn(schema: DocEsSchema | IdeEsSchema, now: number): EndpointHandle {
  const id = newEndpointId()
  const record: EndpointRecord = {
    id,
    kind: schema.kind,
    title: schema.title,
    schema,
    url: endpointUrl(id),
    resultUrl: resultUrl(id),
    createdAt: now,
  }
  registerEndpoint(record)
  return { endpointId: id, url: record.url, resultUrl: record.resultUrl }
}

export function create_doc_es(
  input: unknown,
  now: number = Date.now(),
): EndpointHandle | SpawnError {
  const r = validateDocEsSchema(input)
  if (!r.ok) return { ok: false, errors: r.errors }
  return spawn(r.value, now)
}

export function create_ide_es(
  input: unknown,
  now: number = Date.now(),
): EndpointHandle | SpawnError {
  const r = validateIdeEsSchema(input)
  if (!r.ok) return { ok: false, errors: r.errors }
  return spawn(r.value, now)
}

export function isSpawnError(v: EndpointHandle | SpawnError): v is SpawnError {
  return (v as SpawnError).ok === false
}
