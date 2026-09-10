import type { IncomingMessage, ServerResponse } from 'node:http'
import * as Y from 'yjs'
import { blockViews, createDoc } from '../../src/doc/model'
import type { DocumentStore } from './store'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
} as const

const MAX_DOCS = 24
const PREVIEW_CHARS = 700

// Reconstruct a doc from its persisted snapshot + append log to derive a title (first non-empty block)
// and a text preview for the picker thumbnail. Bounded to MAX_DOCS newest so the picker never replays
// the whole database.
async function summarize(store: DocumentStore, docId: string): Promise<{ title: string; preview: string }> {
  const loaded = await store.loadDocument(docId)
  const doc = createDoc()
  if (loaded.snapshot) Y.applyUpdate(doc, loaded.snapshot)
  for (const u of loaded.updates) Y.applyUpdate(doc, u)
  const lines = blockViews(doc)
    .map((v) => v.text.trim())
    .filter(Boolean)
  return { title: lines[0] ?? 'Untitled document', preview: lines.join('\n').slice(0, PREVIEW_CHARS) }
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > 8192) reject(new Error('request body too large'))
    })
    request.on('end', () => resolve(data))
    request.on('error', reject)
  })
}

// A read-only HTTP surface riding the same port as the ws relay (Hocuspocus onRequest hook). GET
// /api/documents lists the newest persisted rooms with a title + content preview so the client doc
// picker renders Google-Docs-style thumbnails without a hand-typed room name. Hocuspocus contract (see
// Server.requestHandler): write the response then reject with an EMPTY error to suppress the default
// 200 and stop the hook chain; resolve to let a non-match fall through.
export function createDocumentsApi(store: DocumentStore) {
  return {
    async onRequest({ request, response }: { request: IncomingMessage; response: ServerResponse }) {
      const path = (request.url ?? '').split('?')[0]
      const isCollection = path === '/api/documents'
      const isItem = path.startsWith('/api/documents/')
      if (!isCollection && !isItem) return

      if (request.method === 'OPTIONS') {
        response.writeHead(204, CORS)
        response.end()
        return Promise.reject()
      }

      if (isCollection) {
        if (request.method !== 'GET') return
        const rows = (await store.listDocuments()).slice(0, MAX_DOCS)
        const documents = await Promise.all(
          rows.map(async (r) => {
            const { title, preview } = await summarize(store, r.docId)
            return { docId: r.docId, updatedAt: r.updatedAt, title: r.title?.trim() || title, preview }
          }),
        )
        response.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
        response.end(JSON.stringify({ documents }))
        return Promise.reject()
      }

      const docId = decodeURIComponent(path.slice('/api/documents/'.length))
      if (!docId) return

      if (request.method === 'DELETE') {
        await store.deleteDocument(docId)
        response.writeHead(204, CORS)
        response.end()
        return Promise.reject()
      }

      if (request.method === 'PATCH') {
        let title = ''
        try {
          const body = await readRequestBody(request)
          const parsed = body ? (JSON.parse(body) as { title?: unknown }) : {}
          if (typeof parsed.title === 'string') title = parsed.title
        } catch {
          response.writeHead(400, { 'Content-Type': 'application/json', ...CORS })
          response.end(JSON.stringify({ error: 'invalid json body' }))
          return Promise.reject()
        }
        await store.setTitle(docId, title)
        response.writeHead(200, { 'Content-Type': 'application/json', ...CORS })
        response.end(JSON.stringify({ ok: true }))
        return Promise.reject()
      }

      return
    },
  }
}
