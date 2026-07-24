import * as Y from 'yjs'
import type { EndpointSchema, IdeEsSchema, DocEsSchema } from './schema'
import { makeBlock, blocks } from '../doc/model'
import type { Verdict } from './grader'

const META = 'es'
const CODE = 'code'

export function endpointMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(META)
}

export function endpointCode(doc: Y.Doc): Y.Text {
  return doc.getText(CODE)
}

export function readKind(doc: Y.Doc): 'doc-es' | 'ide-es' | null {
  const k = endpointMeta(doc).get('kind')
  return k === 'doc-es' || k === 'ide-es' ? k : null
}

export function readSchema(doc: Y.Doc): EndpointSchema | null {
  const raw = endpointMeta(doc).get('schema')
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as EndpointSchema
  } catch {
    return null
  }
}

export function readAttempts(doc: Y.Doc): number {
  const a = endpointMeta(doc).get('attempts')
  return typeof a === 'number' ? a : 0
}

export function readVerdict(doc: Y.Doc): Verdict | null {
  const raw = endpointMeta(doc).get('verdict')
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as Verdict
  } catch {
    return null
  }
}

export function initEndpoint(doc: Y.Doc, schema: EndpointSchema): void {
  const m = endpointMeta(doc)
  if (m.get('schema') !== undefined) return
  doc.transact(() => {
    m.set('kind', schema.kind)
    m.set('schema', JSON.stringify(schema))
    if (typeof m.get('attempts') !== 'number') m.set('attempts', 0)
    if (schema.kind === 'ide-es') seedCode(doc, schema)
    else seedProse(doc, schema)
  })
}

function seedCode(doc: Y.Doc, schema: IdeEsSchema): void {
  const t = endpointCode(doc)
  if (t.length > 0) return
  t.insert(0, `function ${schema.entry.functionName}(input) {\n  \n}\n`)
}

function seedProse(doc: Y.Doc, schema: DocEsSchema): void {
  const arr = blocks(doc)
  if (arr.length > 0) return
  const seed = schema.initialContent?.length
    ? schema.initialContent.map((b) => makeBlock(b.type, b.text))
    : [makeBlock('heading', schema.title), makeBlock('paragraph', '')]
  arr.push(seed)
}

export function recordVerdict(doc: Y.Doc, verdict: Verdict): void {
  doc.transact(() => {
    const m = endpointMeta(doc)
    m.set('verdict', JSON.stringify(verdict))
    m.set('attempts', readAttempts(doc) + 1)
  })
}
