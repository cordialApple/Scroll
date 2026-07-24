import { describe, it, expect, vi, afterEach } from 'vitest'
import { notifyResult } from './notify'
import type { ResultPayload } from './grader'
import type { IdeEsSchema } from './schema'

const payload: ResultPayload = {
  endpointId: 'e1',
  status: 'pass',
  withinBudget: true,
  passed: 3,
  total: 3,
  at: 1,
}

function schemaWith(url: string | undefined): IdeEsSchema {
  return {
    schemaVersion: 1,
    kind: 'ide-es',
    title: 't',
    lifecycleOwner: 'consumer',
    programmatic: 'on',
    goalCondition: 'g',
    problem: 'p',
    entry: { language: 'javascript', functionName: 'solve' },
    tleBudgetMs: 1000,
    tests: [{ input: 'a', expectedOutput: 'b', hidden: true }],
    resultCallbackUrl: url,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('notifyResult (contract-6 fire-and-forget)', () => {
  it('POSTs the payload to an http callback url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await notifyResult(schemaWith('http://127.0.0.1:47113/scroll/verdict/x?k=s'), payload)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('/scroll/verdict/x')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual(payload)
  })

  it('does not POST when the schema has no callback url', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await notifyResult(schemaWith(undefined), payload)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not POST to a non-http url (defense in depth)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)
    await notifyResult(schemaWith('javascript:alert(1)'), payload)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never throws when the consumer is unreachable, retries then gives up', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)
    await expect(notifyResult(schemaWith('http://127.0.0.1:1/x'), payload)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})
