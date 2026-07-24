type Req = { code: string; functionName: string; input: string }

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null
  postMessage: (m: unknown) => void
}

ctx.onmessage = (e) => {
  const { code, functionName, input } = e.data
  try {
    const factory = new Function(
      `"use strict";${code}\n;return typeof ${functionName}==='function'?${functionName}:undefined;`,
    )
    const fn = factory() as ((input: string) => unknown) | undefined
    if (typeof fn !== 'function') {
      ctx.postMessage({ status: 'error', message: `function ${functionName} is not defined` })
      return
    }
    const out = fn(input)
    ctx.postMessage({ status: 'ok', stdout: out == null ? '' : String(out) })
  } catch (err) {
    ctx.postMessage({ status: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
