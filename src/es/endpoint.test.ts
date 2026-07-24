import { describe, it, expect } from 'vitest'
import { createDoc, blockViews } from '../doc/model'
import {
  initEndpoint,
  readKind,
  readSchema,
  readAttempts,
  readVerdict,
  recordVerdict,
  endpointCode,
} from './endpoint'
import { sampleIdeSchema, sampleDocSchema } from './samples'
import type { Verdict } from './grader'

describe('ide-es endpoint doc', () => {
  it('initializes kind, schema, and a code stub on the Y.Doc', () => {
    const doc = createDoc()
    const schema = sampleIdeSchema()
    initEndpoint(doc, schema)
    expect(readKind(doc)).toBe('ide-es')
    expect(readSchema(doc)).toEqual(schema)
    expect(readAttempts(doc)).toBe(0)
    expect(endpointCode(doc).toString()).toContain('function solve(input)')
  })

  it('does not clobber an existing code buffer on re-init', () => {
    const doc = createDoc()
    initEndpoint(doc, sampleIdeSchema())
    const t = endpointCode(doc)
    t.delete(0, t.length)
    t.insert(0, 'function solve(input){return input}')
    initEndpoint(doc, sampleIdeSchema())
    expect(endpointCode(doc).toString()).toBe('function solve(input){return input}')
  })

  it('records a verdict and increments attempts', () => {
    const doc = createDoc()
    initEndpoint(doc, sampleIdeSchema())
    const v: Verdict = {
      endpointId: 'x',
      status: 'pass',
      withinBudget: true,
      passed: 4,
      total: 4,
      cases: [],
      at: 5,
    }
    recordVerdict(doc, v)
    expect(readAttempts(doc)).toBe(1)
    expect(readVerdict(doc)).toEqual(v)
    recordVerdict(doc, v)
    expect(readAttempts(doc)).toBe(2)
  })
})

describe('doc-es endpoint doc', () => {
  it('seeds prose blocks from initialContent', () => {
    const doc = createDoc()
    initEndpoint(doc, sampleDocSchema())
    expect(readKind(doc)).toBe('doc-es')
    const views = blockViews(doc)
    expect(views[0]).toMatchObject({ type: 'heading', text: 'Untitled endpoint' })
    expect(views.length).toBe(2)
  })
})
