import { isHttpUrl, type EndpointSchema } from './schema'
import type { ResultPayload } from './grader'

const ATTEMPTS = 3
const BACKOFF_BASE_MS = 50
const ATTEMPT_TIMEOUT_MS = 5000

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function notifyResult(schema: EndpointSchema, payload: ResultPayload): Promise<void> {
  const url = schema.resultCallbackUrl
  if (!isHttpUrl(url) || typeof fetch === 'undefined') return
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      })
      if (res.ok) return
    } catch {
      // fire-and-forget: a consumer being unreachable must never surface to the user
    }
    if (i < ATTEMPTS - 1) await delay(BACKOFF_BASE_MS * 2 ** i)
  }
}
