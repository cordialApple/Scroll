import { describe, it, expect } from 'vitest'
import { grade, toResultPayload, type Executor, type ExecOutcome } from './grader'
import type { IdeEsSchema } from './schema'

const schema: IdeEsSchema = {
  schemaVersion: 1,
  kind: 'ide-es',
  title: 'sum',
  lifecycleOwner: 'consumer',
  programmatic: 'on',
  goalCondition: 'sum',
  problem: 'sum',
  entry: { language: 'javascript', functionName: 'solve' },
  tleBudgetMs: 100,
  tests: [
    { name: 'sample', input: '1 2', expectedOutput: '3', hidden: false },
    { name: 'hidden-small', input: '4 5', expectedOutput: '9', hidden: true },
    { name: 'hidden-big', input: 'BIG', expectedOutput: '999', hidden: true },
  ],
}

function execFrom(map: Record<string, ExecOutcome>): Executor {
  return (_code, _fn, input) => Promise.resolve(map[input] ?? { status: 'error', message: 'unmapped' })
}

const correct: Record<string, ExecOutcome> = {
  '1 2': { status: 'ok', stdout: '3', ms: 1 },
  '4 5': { status: 'ok', stdout: '9', ms: 1 },
  BIG: { status: 'ok', stdout: '999', ms: 1 },
}

describe('grade', () => {
  it('passes when every test matches and nothing times out', async () => {
    const v = await grade('e1', schema, 'code', execFrom(correct), 1000)
    expect(v.status).toBe('pass')
    expect(v.passed).toBe(3)
    expect(v.total).toBe(3)
    expect(v.withinBudget).toBe(true)
  })

  it('fails on a wrong hidden answer', async () => {
    const v = await grade('e1', schema, 'code', execFrom({ ...correct, BIG: { status: 'ok', stdout: '0', ms: 1 } }), 1000)
    expect(v.status).toBe('fail')
    expect(v.passed).toBe(2)
    expect(v.withinBudget).toBe(true)
  })

  it('reports TLE and over-budget when the adversarial hidden test times out', async () => {
    const v = await grade('e1', schema, 'code', execFrom({ ...correct, BIG: { status: 'timeout' } }), 1000)
    expect(v.status).toBe('tle')
    expect(v.withinBudget).toBe(false)
    expect(v.cases.find((c) => c.name === 'hidden-big')?.timedOut).toBe(true)
  })

  it('reports a runtime error when the function throws or is missing', async () => {
    const v = await grade('e1', schema, 'code', execFrom({ '1 2': { status: 'error', message: 'boom' } }), 1000)
    expect(v.status).toBe('error')
  })
})

describe('toResultPayload', () => {
  it('leaks no per-case input/expected output', async () => {
    const v = await grade('e1', schema, 'code', execFrom(correct), 1000)
    const payload = toResultPayload(v)
    expect(payload).toEqual({
      endpointId: 'e1',
      status: 'pass',
      withinBudget: true,
      passed: 3,
      total: 3,
      at: 1000,
    })
    expect(JSON.stringify(payload)).not.toContain('BIG')
    expect(Object.keys(payload)).not.toContain('cases')
  })
})
