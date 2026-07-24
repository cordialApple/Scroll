import { describe, it, expect } from 'vitest'
import contract from '../../docs/contracts/result-payload.v1.json'
import golden from './result-payload.golden.json'
import { grade, toResultPayload, type ExecOutcome, type Verdict, type ResultPayload } from './grader'
import type { IdeEsSchema } from './schema'

const GOLDEN_AT = 1700000000000
const ENDPOINT = 'ep_golden'

const schema: IdeEsSchema = {
  schemaVersion: 1,
  kind: 'ide-es',
  title: 'Golden',
  lifecycleOwner: 'consumer',
  programmatic: 'on',
  goalCondition: 'g',
  problem: 'p',
  entry: { language: 'javascript', functionName: 'solve' },
  tleBudgetMs: 1000,
  tests: [
    { name: 't1', input: 'a', expectedOutput: 'A', hidden: false },
    { name: 't2', input: 'b', expectedOutput: 'B', hidden: true },
  ],
}

const ok = (stdout: string): ExecOutcome => ({ status: 'ok', stdout, ms: 1 })
const script: Record<ResultPayload['status'], Record<string, ExecOutcome>> = {
  pass: { a: ok('A'), b: ok('B') },
  fail: { a: ok('A'), b: ok('X') },
  tle: { a: ok('A'), b: { status: 'timeout' } },
  error: { a: { status: 'error', message: 'boom' }, b: { status: 'error', message: 'boom' } },
}

const execFor = (status: ResultPayload['status']) => async (_c: string, _f: string, input: string) =>
  script[status][input]

describe('contract-6 ResultPayload golden vectors', () => {
  it('drives every status through grade()->toResultPayload to its pinned golden vector', async () => {
    for (const want of golden as ResultPayload[]) {
      const v = await grade(ENDPOINT, schema, 'code', execFor(want.status), GOLDEN_AT)
      expect(toResultPayload(v)).toEqual(want)
    }
  })

  it('survives the wire (JSON serialize->parse) byte-for-byte per pinned vector', async () => {
    for (const want of golden as ResultPayload[]) {
      const payload = toResultPayload(await grade(ENDPOINT, schema, 'code', execFor(want.status), GOLDEN_AT))
      expect(JSON.parse(JSON.stringify(payload))).toEqual(want)
      expect(JSON.stringify(payload)).toBe(JSON.stringify(want))
    }
  })

  it('emits exactly the contract keys — no more, no fewer', async () => {
    const v = await grade(ENDPOINT, schema, 'code', execFor('pass'), GOLDEN_AT)
    expect(Object.keys(toResultPayload(v)).sort()).toEqual([...contract.required].sort())
  })

  it('pins status precedence: a run that both times out and errors grades tle, not error', async () => {
    const exec = async (_c: string, _f: string, input: string): Promise<ExecOutcome> =>
      input === 'a' ? { status: 'timeout' } : { status: 'error', message: 'boom' }
    const payload = toResultPayload(await grade(ENDPOINT, schema, 'code', exec, GOLDEN_AT))
    expect(payload).toMatchObject({ status: 'tle', withinBudget: false, passed: 0, total: 2 })
  })

  it('drops all Verdict internals (consumer-blind: no per-test detail on the wire)', () => {
    const rich: Verdict = {
      endpointId: ENDPOINT,
      status: 'fail',
      withinBudget: true,
      passed: 1,
      total: 2,
      at: GOLDEN_AT,
      cases: [
        { name: 'secret-oracle', hidden: true, passed: false, timedOut: false, errored: true, message: 'stack trace' },
      ],
    }
    const payload = toResultPayload(rich)
    for (const leaked of ['cases', 'message', 'hidden', 'name', 'timedOut', 'errored']) {
      expect(payload).not.toHaveProperty(leaked)
    }
  })

  it('the golden set covers every status the contract enum allows', () => {
    expect(new Set((golden as ResultPayload[]).map((g) => g.status))).toEqual(
      new Set(contract.properties.status.enum),
    )
  })

  it('every golden vector satisfies the pinned JSON contract shape', () => {
    expect(contract.additionalProperties).toBe(false)
    const p = contract.properties
    for (const g of golden as ResultPayload[]) {
      expect(Object.keys(g).sort()).toEqual([...contract.required].sort())
      expect(p.status.enum).toContain(g.status)
      expect(g.endpointId.length).toBeGreaterThanOrEqual(p.endpointId.minLength)
      expect(Number.isInteger(g.passed)).toBe(true)
      expect(Number.isInteger(g.total)).toBe(true)
      expect(g.total).toBeGreaterThanOrEqual(p.total.minimum)
      expect(g.passed).toBeGreaterThanOrEqual(p.passed.minimum)
      expect(g.passed).toBeLessThanOrEqual(g.total)
      expect(g.withinBudget).toBe(g.status !== 'tle')
      if (g.status === 'pass') expect(g.passed).toBe(g.total)
    }
  })
})
