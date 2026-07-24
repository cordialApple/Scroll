import { describe, it, expect, beforeEach } from 'vitest'
import { create_ide_es, create_doc_es, isSpawnError } from './factory'
import { getEndpoint, listEndpoints, pollResult, setResult } from './registry'
import { sampleIdeSchema } from './samples'

beforeEach(() => {
  localStorage.clear()
})

describe('create_ide_es', () => {
  it('rejects an invalid schema without spawning', () => {
    const r = create_ide_es({ kind: 'ide-es', schemaVersion: 1 })
    expect(isSpawnError(r)).toBe(true)
    expect(listEndpoints().length).toBe(0)
  })

  it('spawns a registered endpoint and returns url + resultUrl', () => {
    const r = create_ide_es(sampleIdeSchema(), 42)
    expect(isSpawnError(r)).toBe(false)
    if (isSpawnError(r)) return
    expect(r.url).toBe(`#/es/${r.endpointId}`)
    expect(r.resultUrl).toBe(`#/es/${r.endpointId}/result`)
    const rec = getEndpoint(r.endpointId)
    expect(rec?.kind).toBe('ide-es')
    expect(rec?.createdAt).toBe(42)
  })

  it('result URL is pending until a verdict is recorded, then polls it', () => {
    const r = create_ide_es(sampleIdeSchema(), 1)
    if (isSpawnError(r)) throw new Error('spawn failed')
    expect(pollResult(r.endpointId)).toBeNull()
    setResult(r.endpointId, {
      endpointId: r.endpointId,
      status: 'pass',
      withinBudget: true,
      passed: 4,
      total: 4,
      at: 9,
    })
    expect(pollResult(r.endpointId)?.status).toBe('pass')
  })
})

describe('create_doc_es', () => {
  it('spawns a doc endpoint from a valid schema', () => {
    const r = create_doc_es({
      schemaVersion: 1,
      kind: 'doc-es',
      title: 'notes',
      lifecycleOwner: 'human',
      programmatic: 'off',
    })
    expect(isSpawnError(r)).toBe(false)
    if (!isSpawnError(r)) expect(getEndpoint(r.endpointId)?.kind).toBe('doc-es')
  })
})
