import fc from 'fast-check'

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
export const PBT_SEED = Number(env.PBT_SEED ?? 0x5c0011)
export const PBT_RUNS = Number(env.PBT_RUNS ?? 200)

let idCounter = 0
function deterministicUuid(): string {
  idCounter += 1
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, '0')}`
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type CryptoLike = {
  randomUUID?: () => string
  getRandomValues?: <T extends ArrayBufferView | null>(a: T) => T
}

function defineOwn(o: object, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, configurable: true, writable: true })
}

// neutralizes entropy/timer sources sync property body can reach: Math.random, wall clock, crypto.randomUUID
// (ids.ts), crypto.getRandomValues (Yjs clientID via lib0) — same seed -> same case -> same ids -> same outcome.
// sync only; async fn would run continuations after finally restores globals
export function withDeterminism<T>(fn: () => T): T {
  const crypto = (globalThis as { crypto?: CryptoLike }).crypto
  const had = crypto ? { uuid: 'randomUUID' in crypto, grv: 'getRandomValues' in crypto } : null
  const saved = {
    random: Math.random,
    now: Date.now,
    perf: typeof performance !== 'undefined' ? performance.now : undefined,
    uuid: crypto?.randomUUID,
    grv: crypto?.getRandomValues,
    to: globalThis.setTimeout,
    iv: globalThis.setInterval,
    micro: globalThis.queueMicrotask,
  }

  idCounter = 0
  const prng = mulberry32(0xc0ffee)
  Math.random = prng
  Date.now = () => 1700000000000
  if (typeof performance !== 'undefined') performance.now = () => 0
  if (crypto) {
    defineOwn(crypto, 'randomUUID', deterministicUuid)
    defineOwn(crypto, 'getRandomValues', <A extends ArrayBufferView | null>(a: A): A => {
      if (a && ArrayBuffer.isView(a)) {
        const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
        for (let i = 0; i < u.length; i++) u[i] = (prng() * 256) | 0
      }
      return a
    })
  }
  const ban = (name: string) => () => {
    throw new Error(`PBT determinism: ${name} is banned inside a property body`)
  }
  globalThis.setTimeout = ban('setTimeout') as unknown as typeof setTimeout
  globalThis.setInterval = ban('setInterval') as unknown as typeof setInterval
  globalThis.queueMicrotask = ban('queueMicrotask') as unknown as typeof queueMicrotask

  try {
    const result = fn()
    if (result != null && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('withDeterminism is synchronous-only; fn returned a thenable')
    }
    return result
  } finally {
    Math.random = saved.random
    Date.now = saved.now
    if (saved.perf && typeof performance !== 'undefined') performance.now = saved.perf
    if (crypto && had) {
      if (had.uuid) defineOwn(crypto, 'randomUUID', saved.uuid)
      else delete crypto.randomUUID
      if (had.grv) defineOwn(crypto, 'getRandomValues', saved.grv)
      else delete crypto.getRandomValues
    }
    globalThis.setTimeout = saved.to
    globalThis.setInterval = saved.iv
    globalThis.queueMicrotask = saved.micro
  }
}

export function pbtAssert<Ts>(property: fc.IPropertyWithHooks<Ts>): void {
  withDeterminism(() => fc.assert(property, { seed: PBT_SEED, numRuns: PBT_RUNS }))
}
