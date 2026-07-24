import type { EndpointSchema } from './schema'

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodeSchema(schema: EndpointSchema): string {
  return toBase64Url(JSON.stringify(schema))
}

const MAX_PARAM_LEN = 65536

export function decodeSchema(param: string): unknown | null {
  if (!param || param.length > MAX_PARAM_LEN) return null
  try {
    return JSON.parse(fromBase64Url(param))
  } catch {
    return null
  }
}

export function programmaticSpawnUrl(schema: EndpointSchema): string {
  return `#/es/new?s=${encodeSchema(schema)}`
}
