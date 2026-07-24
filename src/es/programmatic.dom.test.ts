import { describe, it, expect, beforeEach } from 'vitest'
import { encodeSchema, decodeSchema, programmaticSpawnUrl } from './programmatic'
import { create_endpoint, isSpawnError } from './factory'
import { getEndpoint } from './registry'
import { sampleIdeSchema } from './samples'

beforeEach(() => localStorage.clear())

describe('schema url codec', () => {
  it('round-trips a schema through encode/decode', () => {
    const schema = sampleIdeSchema()
    expect(decodeSchema(encodeSchema(schema))).toEqual(schema)
  })
  it('round-trips unicode/newline content', () => {
    const schema = { ...sampleIdeSchema(), problem: 'sum π\nмного строк 数字' }
    expect(decodeSchema(encodeSchema(schema))).toEqual(schema)
  })
  it('returns null on garbage or empty payload', () => {
    expect(decodeSchema('')).toBeNull()
    expect(decodeSchema('!!!not-base64!!!')).toBeNull()
    expect(decodeSchema(btoa('{not json'))).toBeNull()
  })
  it('returns null on an oversized payload (DoS guard)', () => {
    expect(decodeSchema('A'.repeat(70000))).toBeNull()
  })
  it('programmaticSpawnUrl embeds a decodable schema', () => {
    const url = programmaticSpawnUrl(sampleIdeSchema())
    expect(url.startsWith('#/es/new?s=')).toBe(true)
    const param = url.slice('#/es/new?s='.length)
    expect((decodeSchema(param) as { kind: string }).kind).toBe('ide-es')
  })
})

describe('create_endpoint dispatch', () => {
  it('spawns an ide-es from a decoded schema', () => {
    const decoded = decodeSchema(encodeSchema(sampleIdeSchema()))
    const h = create_endpoint(decoded)
    expect(isSpawnError(h)).toBe(false)
    if (!isSpawnError(h)) expect(getEndpoint(h.endpointId)?.kind).toBe('ide-es')
  })
  it('spawns a doc-es', () => {
    const h = create_endpoint({
      schemaVersion: 1,
      kind: 'doc-es',
      title: 'x',
      lifecycleOwner: 'human',
      programmatic: 'off',
    })
    expect(isSpawnError(h)).toBe(false)
  })
  it('rejects an unknown kind', () => {
    expect(isSpawnError(create_endpoint({ kind: 'whiteboard-es' }))).toBe(true)
  })
  it('rejects an invalid ide-es schema (bad payload cannot spawn)', () => {
    expect(isSpawnError(create_endpoint({ kind: 'ide-es', schemaVersion: 1 }))).toBe(true)
  })
})
