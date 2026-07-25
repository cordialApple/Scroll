import { describe, it, expect } from 'vitest'
import docContract from '../../docs/contracts/doc-es.v1.json'
import ideContract from '../../docs/contracts/ide-es.v1.json'
import {
  DOC_ES_SCHEMA_VERSION,
  IDE_ES_SCHEMA_VERSION,
  validateDocEsSchema,
  validateIdeEsSchema,
  validateEndpointSchema,
  type DocEsSchema,
  type IdeEsSchema,
} from '../es/schema'

const validDoc: DocEsSchema = {
  schemaVersion: 1,
  kind: 'doc-es',
  title: 'Scratch',
  lifecycleOwner: 'human',
  programmatic: 'off',
}

const validIde: IdeEsSchema = {
  schemaVersion: 1,
  kind: 'ide-es',
  title: 'Two Sum',
  lifecycleOwner: 'consumer',
  programmatic: 'on',
  goalCondition: 'return indices summing to target',
  problem: 'Given nums and target, return the two indices.',
  entry: { language: 'javascript', functionName: 'solve' },
  tests: [
    { input: '2 7 11 15\n9', expectedOutput: '0 1', hidden: false },
    { input: '3 2 4\n6', expectedOutput: '1 2', hidden: true },
  ],
  tleBudgetMs: 1000,
  hints: [{ text: 'use a hash map', afterFailedAttempts: 2 }],
}

describe('endpoint schema versions stay pinned to the JSON contract files', () => {
  it('doc-es code version matches doc-es.v1.json', () => {
    expect(docContract.properties.schemaVersion.const).toBe(DOC_ES_SCHEMA_VERSION)
  })
  it('ide-es code version matches ide-es.v1.json', () => {
    expect(ideContract.properties.schemaVersion.const).toBe(IDE_ES_SCHEMA_VERSION)
  })
})

describe('doc-es validation', () => {
  it('accepts a valid schema', () => {
    expect(validateDocEsSchema(validDoc)).toEqual({ ok: true, value: validDoc })
  })
  it('rejects wrong kind', () => {
    const r = validateDocEsSchema({ ...validDoc, kind: 'ide-es' })
    expect(r.ok).toBe(false)
  })
  it('rejects a bad seed block', () => {
    const r = validateDocEsSchema({ ...validDoc, initialContent: [{ type: 'code', text: 'x' }] })
    expect(r.ok).toBe(false)
  })
  it('rejects resultCallbackUrl — doc-es has no graded result to POST (F-04)', () => {
    const r = validateDocEsSchema({ ...validDoc, resultCallbackUrl: 'https://host/v/x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('resultCallbackUrl')
  })
})

describe('ide-es validation', () => {
  it('accepts a valid schema', () => {
    expect(validateIdeEsSchema(validIde)).toEqual({ ok: true, value: validIde })
  })
  it('rejects a schema with no hidden test (no graded oracle)', () => {
    const r = validateIdeEsSchema({
      ...validIde,
      tests: [{ input: 'a', expectedOutput: 'b', hidden: false }],
    })
    expect(r.ok).toBe(false)
  })
  it('rejects a non-positive TLE budget', () => {
    const r = validateIdeEsSchema({ ...validIde, tleBudgetMs: 0 })
    expect(r.ok).toBe(false)
  })
  it('rejects a missing entry', () => {
    const { entry, ...rest } = validIde
    void entry
    const r = validateIdeEsSchema(rest)
    expect(r.ok).toBe(false)
  })
  it('rejects unknown top-level keys (additionalProperties:false parity)', () => {
    const r = validateIdeEsSchema({ ...validIde, sneaky: true })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('sneaky')
  })
  it('rejects a functionName that is not a valid JS identifier (worker injection guard)', () => {
    const r = validateIdeEsSchema({
      ...validIde,
      entry: { language: 'javascript', functionName: "x};fetch('//evil');({" },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('valid JS identifier')
  })
  it('rejects unknown keys on a nested test object', () => {
    const r = validateIdeEsSchema({
      ...validIde,
      tests: [{ input: 'a', expectedOutput: 'b', hidden: true, weight: 5 }],
    })
    expect(r.ok).toBe(false)
  })
  it('accepts an http(s) resultCallbackUrl (contract-6 notify target)', () => {
    expect(validateIdeEsSchema({ ...validIde, resultCallbackUrl: 'http://127.0.0.1:47113/v/x?k=s' }).ok).toBe(true)
    expect(validateIdeEsSchema({ ...validIde, resultCallbackUrl: 'https://host/v/x' }).ok).toBe(true)
  })
  it('rejects a non-http resultCallbackUrl (no javascript:/data: exfil scheme)', () => {
    const r = validateIdeEsSchema({ ...validIde, resultCallbackUrl: 'javascript:alert(1)' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toContain('resultCallbackUrl')
  })
})

describe('validateEndpointSchema dispatches on kind', () => {
  it('routes ide-es', () => {
    expect(validateEndpointSchema(validIde).ok).toBe(true)
  })
  it('routes doc-es', () => {
    expect(validateEndpointSchema(validDoc).ok).toBe(true)
  })
  it('rejects an unknown kind', () => {
    expect(validateEndpointSchema({ kind: 'whiteboard-es' }).ok).toBe(false)
  })
})
