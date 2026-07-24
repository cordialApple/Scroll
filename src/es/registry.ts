import type { EndpointSchema } from './schema'
import type { ResultPayload } from './grader'

const KEY = 'scroll.endpoints.v1'

export type EndpointRecord = {
  id: string
  kind: 'doc-es' | 'ide-es'
  title: string
  schema: EndpointSchema
  url: string
  resultUrl: string
  createdAt: number
  result?: ResultPayload
}

function store(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

function readAll(): Record<string, EndpointRecord> {
  const s = store()
  if (!s) return {}
  const raw = s.getItem(KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, EndpointRecord>
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, EndpointRecord>): void {
  const s = store()
  if (!s) return
  s.setItem(KEY, JSON.stringify(map))
}

export function registerEndpoint(record: EndpointRecord): void {
  const map = readAll()
  map[record.id] = record
  writeAll(map)
}

export function getEndpoint(id: string): EndpointRecord | null {
  return readAll()[id] ?? null
}

export function listEndpoints(): EndpointRecord[] {
  return Object.values(readAll()).sort((a, b) => b.createdAt - a.createdAt)
}

export function setResult(id: string, result: ResultPayload): void {
  const map = readAll()
  const rec = map[id]
  if (!rec) return
  rec.result = result
  writeAll(map)
}

export function pollResult(id: string): ResultPayload | null {
  return getEndpoint(id)?.result ?? null
}
