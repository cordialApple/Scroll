import type { IdeEsSchema } from './schema'

export type ExecOutcome =
  | { status: 'ok'; stdout: string; ms: number }
  | { status: 'timeout' }
  | { status: 'error'; message: string }

export type Executor = (
  code: string,
  functionName: string,
  input: string,
  tleMs: number,
) => Promise<ExecOutcome>

export type VerdictStatus = 'pass' | 'fail' | 'tle' | 'error'

export type CaseResult = {
  name: string
  hidden: boolean
  passed: boolean
  timedOut: boolean
  errored: boolean
  message?: string
}

export type Verdict = {
  endpointId: string
  status: VerdictStatus
  withinBudget: boolean
  passed: number
  total: number
  cases: CaseResult[]
  at: number
}

export type ResultPayload = {
  endpointId: string
  status: VerdictStatus
  withinBudget: boolean
  passed: number
  total: number
  at: number
}

export function matchesExpected(got: string, expected: string): boolean {
  return got.replace(/\s+$/gm, '').trim() === expected.replace(/\s+$/gm, '').trim()
}

export async function grade(
  endpointId: string,
  schema: IdeEsSchema,
  code: string,
  exec: Executor,
  now: number,
): Promise<Verdict> {
  const cases: CaseResult[] = []
  let anyTimeout = false
  let anyError = false
  let passed = 0
  for (let i = 0; i < schema.tests.length; i++) {
    const t = schema.tests[i]
    const outcome = await exec(code, schema.entry.functionName, t.input, schema.tleBudgetMs)
    const timedOut = outcome.status === 'timeout'
    const errored = outcome.status === 'error'
    const ok = outcome.status === 'ok' && matchesExpected(outcome.stdout, t.expectedOutput)
    if (timedOut) anyTimeout = true
    if (errored) anyError = true
    if (ok) passed++
    cases.push({
      name: t.name ?? `test-${i + 1}`,
      hidden: t.hidden,
      passed: ok,
      timedOut,
      errored,
      message: outcome.status === 'error' ? outcome.message : undefined,
    })
  }
  const total = schema.tests.length
  const withinBudget = !anyTimeout
  const status: VerdictStatus =
    passed === total && withinBudget ? 'pass' : anyTimeout ? 'tle' : anyError ? 'error' : 'fail'
  return { endpointId, status, withinBudget, passed, total, cases, at: now }
}

export function toResultPayload(v: Verdict): ResultPayload {
  return {
    endpointId: v.endpointId,
    status: v.status,
    withinBudget: v.withinBudget,
    passed: v.passed,
    total: v.total,
    at: v.at,
  }
}
