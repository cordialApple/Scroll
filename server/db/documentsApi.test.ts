import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as Y from 'yjs'
import { Hocuspocus } from '@hocuspocus/server'
import { describe, expect, it, vi } from 'vitest'
import { appendBlock, createDoc, createTab, removeTab, setBlockText, setDocTitle, blockOrder, tabBlocksKey } from '../../src/doc/model'
import { createDocumentsApi } from './documentsApi'
import type { DocumentStore } from './store'

function makeStore(overrides: Partial<DocumentStore> = {}): DocumentStore {
  return {
    listDocuments: async () => [],
    loadDocument: async () => ({ docEpoch: 0, snapshot: null, stateVector: null, updates: [] }),
    setTitle: vi.fn(async () => {}),
    deleteDocument: vi.fn(async () => {}),
    acquireLease: async () => 1,
    appendUpdate: async () => '1',
    compact: async () => {},
    ...overrides,
  }
}

async function request(path = '/api/documents', init: RequestInit = {}, overrides: Partial<DocumentStore> = {}) {
  const store = makeStore(overrides)
  const api = createDocumentsApi(store)
  let escapedError: unknown
  const server = createServer((request, response) => {
    void api.onRequest({ request, response }).catch(error => {
      escapedError = error
      if (!response.writableEnded) {
        response.writeHead(500)
        response.end()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, init)
    return { status: response.status, origin: response.headers.get('access-control-allow-origin'), body: await response.text(), store, escapedError }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('local document picker API', () => {
  it('keeps the real Hocuspocus HTTP server alive after a store outage', async () => {
    const listDocuments = vi.fn()
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue([])
    const server = new Hocuspocus({
      port: 0, address: '127.0.0.1', quiet: true,
      extensions: [createDocumentsApi(makeStore({ listDocuments }))],
    })
    await server.listen()
    try {
      const url = `http://127.0.0.1:${server.address.port}/api/documents`
      const unavailable = await fetch(url)
      expect(unavailable.status).toBe(503)
      await unavailable.text()
      const recovered = await fetch(url)
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toEqual({ documents: [] })
    } finally {
      await server.destroy()
    }
  })

  it.each(['listDocuments', 'loadDocument', 'setTitle'] as const)('contains %s failures within the HTTP hook', async method => {
    const result = await request(method === 'setTitle' ? '/api/documents/demo' : undefined,
      method === 'setTitle' ? { method: 'PATCH', body: '{"title":"New title"}' } : {}, {
        listDocuments: async () => [{ docId: 'demo', updatedAt: '2026-09-10', title: null }],
        [method]: async () => { throw new Error('private database connection failure') },
      })
    expect(result.status).toBe(503)
    expect(result.escapedError).toBeUndefined()
    expect(result.body).not.toContain('private database')
  })

  it.each([null, 'Picker override'])('previews visible tabs and honors title precedence with override %s', async override => {
    const doc = createDoc()
    appendBlock(doc, 'paragraph', 'Removed private text')
    const key = tabBlocksKey(createTab(doc, 'Visible'))
    setBlockText(doc, blockOrder(doc, key)[0], 'Visible preview', undefined, undefined, key)
    removeTab(doc, 'main')
    setDocTitle(doc, 'Editor title')
    const snapshot = Y.encodeStateAsUpdate(doc)
    doc.destroy()
    const result = await request(undefined, {}, {
      listDocuments: async () => [{ docId: 'demo', updatedAt: '2026-09-10', title: override }],
      loadDocument: async () => ({ docEpoch: 0, snapshot, stateVector: null, updates: [] }),
    })
    expect(result.status).toBe(200)
    expect(JSON.parse(result.body).documents[0]).toMatchObject({
      title: override ?? 'Editor title', preview: 'Visible preview',
    })
  })

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
