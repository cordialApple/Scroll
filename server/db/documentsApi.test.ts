import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { createDocumentsApi } from './documentsApi'
import type { DocumentStore } from './store'

async function request(path = '/api/documents', init: RequestInit = {}) {
  const store: DocumentStore = {
    listDocuments: async () => [],
    loadDocument: async () => ({ docEpoch: 0, snapshot: null, stateVector: null, updates: [] }),
    setTitle: vi.fn(async () => {}),
    deleteDocument: vi.fn(async () => {}),
    acquireLease: async () => 1,
    appendUpdate: async () => '1',
    compact: async () => {},
  }
  const api = createDocumentsApi(store)
  const server = createServer((request, response) => {
    void api.onRequest({ request, response }).catch(() => {
      if (!response.writableEnded) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init)
    return { status: response.status, origin: response.headers.get('access-control-allow-origin'), body: await response.text(), store }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('local document picker API', () => {
  it('allows the local editor origin explicitly', async () => {
    const result = await request(undefined, { headers: { Origin: 'http://localhost:5176' } })
    expect(result.status).toBe(200)
    expect(result.origin).toBe('http://localhost:5176')
  })

  it('rejects a foreign website before listing documents', async () => {
    expect((await request(undefined, { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403)
  })

  it('refuses deletion until offline replicas support durable tombstones', async () => {
    const result = await request('/api/documents/demo', { method: 'DELETE' })
    expect(result.status).toBe(405)
    expect(result.store.deleteDocument).not.toHaveBeenCalled()
  })

  it('returns a client error for a malformed document id', async () => {
    expect((await request('/api/documents/%zz', { method: 'PATCH', body: '{}' })).status).toBe(400)
  })

  it('rejects a nonstring title without erasing its previous value', async () => {
    const result = await request('/api/documents/demo', { method: 'PATCH', body: '{"title":42}' })
    expect(result.status).toBe(400)
    expect(result.store.setTitle).not.toHaveBeenCalled()
  })

  it('bounds request bytes rather than JavaScript string length', async () => {
    const result = await request('/api/documents/demo', { method: 'PATCH', body: JSON.stringify({ title: '字'.repeat(3000) }) })
    expect(result.status).toBe(400)
    expect(result.store.setTitle).not.toHaveBeenCalled()
  })

  it('renames an existing document through the store seam', async () => {
    const result = await request('/api/documents/demo', { method: 'PATCH', body: '{"title":"New title"}' })
    expect(result.status).toBe(200)
    expect(result.store.setTitle).toHaveBeenCalledWith('demo', 'New title')
  })
})
