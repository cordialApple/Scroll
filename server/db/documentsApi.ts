import type { IncomingMessage, ServerResponse } from 'node:http'
import * as Y from 'yjs'
import { blockViews, createDoc, getDocTitle, listTabs, tabBlocksKey } from '../../src/doc/model'
import type { DocumentStore } from './store'

const MAX_DOCS = 24
const PREVIEW_CHARS = 700

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopback(url.hostname)
  } catch {
    return false
  }
}

async function summarize(store: DocumentStore, docId: string): Promise<{ title: string; preview: string }> {
  const loaded = await store.loadDocument(docId)
  const doc = createDoc()
  try {
    if (loaded.snapshot) Y.applyUpdate(doc, loaded.snapshot)
    for (const update of loaded.updates) Y.applyUpdate(doc, update)
    const lines = listTabs(doc).flatMap(tab => blockViews(doc, tabBlocksKey(tab.id)))
      .map(view => view.text.trim()).filter(Boolean)
    return { title: getDocTitle(doc).trim() || lines[0] || 'Untitled document', preview: lines.join('\n').slice(0, PREVIEW_CHARS) }
  } finally {
    doc.destroy()
  }
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 8192) {
        chunks.length = 0
        reject(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
    request.on('aborted', () => reject(new Error('request aborted')))
  })
}

export function createDocumentsApi(store: DocumentStore) {
  return {
    async onRequest({ request, response }: { request: IncomingMessage; response: ServerResponse }) {
      const path = (request.url ?? '').split('?')[0]
      const isCollection = path === '/api/documents'
      if (!isCollection && !path.startsWith('/api/documents/')) return

      const origin = request.headers.origin
      const remote = request.socket.remoteAddress
      const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      const allowed = local && isLocalUrl(`http://${request.headers.host ?? ''}`) &&
        (origin === undefined || isLocalUrl(origin))
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Vary': 'Origin',
        ...(allowed && origin ? { 'Access-Control-Allow-Origin': origin } : {}),
        'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
      function reply(status: number, body?: unknown): Promise<never> {
        response.writeHead(status, headers)
        response.end(body === undefined ? undefined : JSON.stringify(body))
        // Hocuspocus requires empty rejection after a handled HTTP response.
        return Promise.reject()
      }
      if (!allowed) return reply(403, { error: 'local access required' })
      if (request.method === 'OPTIONS') return reply(204)

      if (isCollection) {
        if (request.method !== 'GET') return reply(405)
        try {
          const rows = (await store.listDocuments()).slice(0, MAX_DOCS)
          const documents = await Promise.all(rows.map(async row => {
            const { title, preview } = await summarize(store, row.docId)
            return { docId: row.docId, updatedAt: row.updatedAt, title: row.title?.trim() || title, preview }
          }))
          return reply(200, { documents })
        } catch {
          return reply(503, { error: 'documents unavailable' })
        }
      }

      let docId: string
      try {
        docId = decodeURIComponent(path.slice('/api/documents/'.length))
      } catch {
        return reply(400, { error: 'invalid document id' })
      }
      if (!docId) return reply(400, { error: 'invalid document id' })
      if (request.method !== 'PATCH') return reply(405)
      let title: string
      try {
        const parsed: unknown = JSON.parse(await readRequestBody(request))
        if (!parsed || typeof parsed !== 'object' || !('title' in parsed) || typeof parsed.title !== 'string') {
          return reply(400, { error: 'title must be a string' })
        }
        title = parsed.title
      } catch {
        return reply(400, { error: 'invalid json body' })
      }
      try {
        await store.setTitle(docId, title)
      } catch {
        return reply(503, { error: 'documents unavailable' })
      }
      return reply(200, { ok: true })
    },
  }
}
